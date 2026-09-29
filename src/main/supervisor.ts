import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import net from 'net';
import fs from 'fs';
import os from 'os';
import { readProcessMemory, processTreeRss } from './process-memory';
import {
  SidecarName,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_RESTART_ATTEMPTS,
  RESTART_BACKOFF_BASE_MS,
  CIRCUIT_RESET_MS,
  RSS_LIMITS_MB,
  MEMORY_CHECK_INTERVAL_MS,
} from '../shared/constants';

interface SidecarState {
  process: ChildProcess | null;
  socket: net.Socket | null;
  server: net.Server | null;
  socketPath: string | null;
  restartCount: number;
  lastHeartbeat: number;
  circuitOpen: boolean;
  // True while a kill+restart is in flight, so the heartbeat/memory monitors
  // don't re-trigger and burn extra restart attempts for the same failure.
  recovering: boolean;
  // True between start() and stop()/stopAll(): the caller wants this sidecar
  // running. Used to auto-revive it after the circuit breaker's cooldown.
  desiredRunning: boolean;
  // Bumped by intentional stop/restart. A crash backoff remembers its value so
  // it cannot respawn a sidecar the user deliberately stopped in the meantime.
  restartGeneration: number;
  // Pending circuit-breaker cooldown reset (see CIRCUIT_RESET_MS), cleared on
  // any intentional (re)start/stop so it can't revive a sidecar we just stopped.
  circuitResetTimer: ReturnType<typeof setTimeout> | null;
  // Readiness latch: resolves when the sidecar emits 'ready' after (re)start.
  // Callers gate the first control message on this so a 'synthesize'/'transcribe'
  // never reaches the sidecar before its model has finished loading (the
  // first-utterance "'NoneType' object has no attribute 'create'" race).
  ready: boolean;
  readyPromise: Promise<void>;
  readyResolve: () => void;
}

type StatusCallback = (name: SidecarName, status: string, detail?: string) => void;
type MessageCallback = (name: SidecarName, message: Record<string, unknown>) => void;
type BinaryDataCallback = (name: SidecarName, data: Buffer) => void;

export class Supervisor {
  private sidecars = new Map<SidecarName, SidecarState>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private onStatus: StatusCallback;
  private onMessage?: MessageCallback;
  private onData?: BinaryDataCallback;
  private shuttingDown = false;
  private rssLimitsMb: Record<string, number>;
  private memoryCheckMs: number;
  private memoryCheckRunning = false;
  private memoryCheckFailed = false;
  private socketDir: string | null = null;

  constructor(
    onStatus: StatusCallback,
    onMessage?: MessageCallback,
    opts?: { rssLimitsMb?: Partial<Record<SidecarName, number>>; memoryCheckMs?: number },
  ) {
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.rssLimitsMb = { ...RSS_LIMITS_MB, ...(opts?.rssLimitsMb ?? {}) };
    this.memoryCheckMs = opts?.memoryCheckMs ?? MEMORY_CHECK_INTERVAL_MS;
  }

  async start(name: SidecarName): Promise<void> {
    const state = this.getOrCreateState(name);
    state.desiredRunning = true;
    // An intentional start supersedes any pending cooldown revival.
    if (state.circuitResetTimer) { clearTimeout(state.circuitResetTimer); state.circuitResetTimer = null; }
    if (state.circuitOpen) {
      this.onStatus(name, 'circuit-open', `Exceeded ${MAX_RESTART_ATTEMPTS} restart attempts`);
      return;
    }
    // Already running: a second spawn would orphan the live process.
    if (state.process && state.process.exitCode === null && state.process.signalCode === null) return;
    // A start is a new incarnation: it supersedes any pending crash backoff and
    // any earlier start() still awaiting listen(). The generation captured here
    // is re-checked after every await so a stop()/restart() in between wins.
    const generation = ++state.restartGeneration;

    // Arm a fresh readiness latch for this (re)spawn — the model must reload
    // before the sidecar is usable again, so any pending waitForReady() blocks
    // until the new process emits 'ready'.
    this.resetReadyLatch(state);
    // Release the previous incarnation's PCM transport (a crashed process
    // leaves its listener open) before binding a new one.
    this.closeTransport(state);

    const server = net.createServer((conn) => {
      // One sidecar owns one PCM connection. Reject stale/extra clients instead
      // of letting a late old process replace the live sidecar's audio stream.
      if (state.server !== server || !state.process || state.socket) {
        conn.destroy();
        return;
      }
      state.socket = conn;
      conn.on('data', (data) => {
        if (state.socket === conn) this.handleSidecarData(name, data);
      });
      conn.on('error', () => { if (state.socket === conn) state.socket = null; });
      conn.on('close', () => { if (state.socket === conn) state.socket = null; });
    });

    // PCM data channel. The address string handed to the sidecar via --socket
    // encodes the transport: a filesystem path => Unix domain socket (POSIX),
    // a "tcp://host:port" URL => loopback TCP (Windows, which can't listen on a
    // UDS file path through Node's net).
    let socketArg: string;
    let socketPath: string | null = null;
    try {
      if (process.platform === 'win32') {
        // Windows: loopback TCP on an ephemeral port. Bind to 127.0.0.1 only so
        // the channel is never reachable off-host; the kernel assigns the port.
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        socketArg = `tcp://127.0.0.1:${port}`;
      } else {
        // POSIX (Linux/macOS): filesystem Unix domain socket inside a verified
        // private directory (re-verified every start; see getSocketDir()).
        const socketDir = this.getSocketDir();
        socketPath = path.join(socketDir, `${name}.sock`);
        try { fs.unlinkSync(socketPath); } catch {}
        const listenPath = socketPath;
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(listenPath, () => { server.off('error', reject); resolve(); });
        });
        socketArg = socketPath;
      }
    } catch (e) {
      try { server.close(); } catch {}
      if (socketPath) { try { fs.unlinkSync(socketPath); } catch {} }
      throw e;
    }

    // A stop()/restart()/newer start() or shutdown may have happened while we
    // awaited listen(); spawning now would resurrect an unwanted sidecar.
    if (this.shuttingDown || !state.desiredRunning || state.restartGeneration !== generation) {
      try { server.close(); } catch {}
      if (socketPath) { try { fs.unlinkSync(socketPath); } catch {} }
      return;
    }

    state.server = server;
    state.socketPath = socketPath;

    const { bin, args: binArgs } = this.resolveSidecarCommand(name);
    // ARIA is often launched from another Python application (including Hermes).
    // Never let that parent's virtualenv/PYTHONPATH contaminate the sidecar's
    // dedicated interpreter with binary wheels from a different Python version.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONNOUSERSITE: '1' };
    delete childEnv.PYTHONPATH;
    delete childEnv.PYTHONHOME;
    delete childEnv.VIRTUAL_ENV;
    delete childEnv.__PYVENV_LAUNCHER__;
    const child = spawn(bin, [...binArgs, '--socket', socketArg], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: own process group so killSidecar can tree-kill via negative PID.
      // Windows has no process groups here; taskkill /T walks the tree instead,
      // and detaching would spawn a stray console — so detach POSIX-only.
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: childEnv,
    });

    // Every handler below is bound to this exact child. A late event from a
    // previous incarnation (buffered stdout, a delayed 'exit') must never feed
    // the replacement's readiness latch or trigger a crash-restart of it.
    const isCurrent = () => state.process === child;
    // Trailing partial stdout line, owned by this child only. Sidecar stdout is
    // line-framed JSON, but a single line can be split across two chunks (or two
    // rapid messages can share one chunk) — buffer the remainder so a split line
    // still parses instead of being lost.
    let stdoutBuf = '';
    child.stdout?.on('data', (data: Buffer) => {
      if (!isCurrent()) return;
      stdoutBuf = this.handleStdioMessage(name, stdoutBuf, data);
    });

    child.stderr?.on('data', (data: Buffer) => {
      if (!isCurrent()) return;
      this.onStatus(name, 'log', data.toString().trim());
    });

    child.on('exit', (code, signal) => {
      if (this.shuttingDown || !isCurrent()) return;
      this.onStatus(name, 'exited', `code=${code} signal=${signal}`);
      // If a monitor/stop already initiated this kill, it owns what happens
      // next — don't double-handle (which would burn extra restart attempts and
      // trip the circuit breaker prematurely).
      if (state.recovering) return;
      state.recovering = true;
      this.scheduleCrash(name, state.restartGeneration);
    });

    child.on('error', (err) => {
      if (this.shuttingDown || !isCurrent()) return;
      this.onStatus(name, 'error', err.message);
      if (state.recovering) return;
      state.recovering = true;
      this.scheduleCrash(name, state.restartGeneration);
    });

    state.process = child;
    // This incarnation supersedes any failure recovery that was in flight for
    // the previous one (its continuation sees the bumped generation and exits).
    state.recovering = false;
    state.lastHeartbeat = Date.now();
    this.onStatus(name, 'started', `pid=${child.pid}`);
  }

  /**
   * Restart a single sidecar to apply a config change (e.g. a new wake-word
   * model) without restarting the whole app. The intentional kill is shielded
   * from the exit handler's auto-restart, and the circuit breaker is cleared so
   * a manual restart always gets a fresh attempt.
   */
  async restart(name: SidecarName): Promise<void> {
    const state = this.sidecars.get(name);
    if (state) {
      state.recovering = true; // suppress the exit handler's crash-restart
      state.restartGeneration++;
      await this.killSidecar(name, state);
      state.recovering = false;
      state.circuitOpen = false;
      state.restartCount = 0;
    }
    await this.start(name);
  }

  /** Stop a single sidecar and leave it stopped (e.g. wake word disabled). */
  async stop(name: SidecarName): Promise<void> {
    const state = this.sidecars.get(name);
    if (!state) return;
    state.desiredRunning = false;
    state.restartGeneration++;
    if (state.circuitResetTimer) { clearTimeout(state.circuitResetTimer); state.circuitResetTimer = null; }
    state.recovering = true;
    await this.killSidecar(name, state);
    state.recovering = false;
    state.process = null;
    this.resetReadyLatch(state);
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);

    for (const state of this.sidecars.values()) {
      state.desiredRunning = false;
      state.restartGeneration++;
      if (state.circuitResetTimer) { clearTimeout(state.circuitResetTimer); state.circuitResetTimer = null; }
    }
    const kills = Array.from(this.sidecars.entries()).map(([name, state]) =>
      this.killSidecar(name, state)
    );
    await Promise.allSettled(kills);
    if (this.socketDir) {
      try { fs.rmSync(this.socketDir, { recursive: true, force: true }); } catch {}
      this.socketDir = null;
    }
  }

  /**
   * Reversibly stop only sidecars that are live for an update attempt. Unlike
   * stopAll(), this leaves monitoring and the supervisor usable if installation
   * is cancelled or fails.
   */
  async quiesceForUpdate(): Promise<SidecarName[]> {
    // Include sidecars that are wanted but momentarily not live (crash backoff,
    // mid-start, circuit cooldown): otherwise their pending restart would spawn
    // a process during installation, and resume would forget them.
    const running = Array.from(this.sidecars.entries())
      .filter(([, state]) => !!state.process || state.desiredRunning)
      .map(([name]) => name);
    await Promise.allSettled(running.map((name) => this.stop(name)));
    return running;
  }

  /** Restart exactly the sidecars captured by quiesceForUpdate(). */
  async resumeAfterUpdate(names: SidecarName[]): Promise<void> {
    for (const name of names) {
      const state = this.sidecars.get(name);
      if (!state || state.process || this.shuttingDown) continue;
      // Resume is an intentional start: a breaker left open by a pre-update
      // crash burst (whose cooldown timer quiesce cancelled) must not strand it.
      state.circuitOpen = false;
      state.restartCount = 0;
      try { await this.start(name); } catch { /* resume the remaining snapshot */ }
    }
  }

  startMonitoring(): void {
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
    this.memoryTimer = setInterval(() => { void this.checkMemory(); }, this.memoryCheckMs);
  }

  /** Send a JSON control message to a sidecar over its stdin (line-framed). */
  sendToSidecar(name: SidecarName, message: Record<string, unknown>): boolean {
    const state = this.sidecars.get(name);
    const stdin = state?.process?.stdin;
    if (!stdin || stdin.destroyed) return false;

    const payload = JSON.stringify(message) + '\n';
    stdin.write(payload);
    return true;
  }

  /** Stream raw PCM bytes to a sidecar over its UDS socket (STT/wakeword input). */
  sendPcm(name: SidecarName, data: Buffer): boolean {
    const state = this.sidecars.get(name);
    if (!state?.socket || state.socket.destroyed) return false;
    state.socket.write(data);
    return true;
  }

  private handleSidecarData(name: SidecarName, data: Buffer): void {
    const state = this.sidecars.get(name);
    if (state) state.lastHeartbeat = Date.now();
    // Raw binary stream from the sidecar (e.g. TTS PCM output). The matching
    // stdout JSON ({type:tts_chunk,size,sample_rate}) announces each chunk's
    // size, so the consumer can frame the byte stream.
    this.onData?.(name, data);
  }

  onBinaryData(cb: BinaryDataCallback): void {
    this.onData = cb;
  }

  /** Parse framed stdout for one child; returns that child's new partial line. */
  private handleStdioMessage(name: SidecarName, pending: string, data: Buffer): string {
    const state = this.sidecars.get(name);
    // Reassemble line-framed JSON across chunk boundaries: prepend the partial
    // line held from the previous 'data' event, split on '\n', and keep the new
    // trailing partial for next time. Without this a message split across two
    // chunks fails to parse and is lost (same framing as llm-stream.ts's SSE
    // reader). Cap the buffer so a newline-less runaway can't grow unbounded.
    let buffered = pending + data.toString();
    if (buffered.length > 262144 && !buffered.includes('\n')) {
      this.onStatus(name, 'log', buffered.slice(0, 200) + '…(oversized line dropped)');
      buffered = '';
    }
    const lines = buffered.split('\n');
    const remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        // Any structured message counts as liveness, not just heartbeats.
        if (state) state.lastHeartbeat = Date.now();

        if (msg.type === 'heartbeat') {
          continue;
        }
        if (msg.type === 'status') {
          // Surface the sidecar's own status (ready/initialized/error/warning).
          // A 'ready' status clears the restart counter — the sidecar got
          // far enough to be considered healthy — and trips the readiness
          // latch so gated callers (ensureSidecar) can send control messages.
          if (msg.status === 'ready' && state) {
            state.restartCount = 0;
            state.ready = true;
            state.readyResolve();
          }
          this.onStatus(name, msg.status, msg.detail);
        } else {
          // Domain messages (stt_result, tts_chunk, wakeword_detected, ...)
          this.onMessage?.(name, msg);
        }
      } catch {
        this.onStatus(name, 'log', line);
      }
    }
    return remainder;
  }

  /** Fire-and-forget crash handling that can never become an unhandled rejection. */
  private scheduleCrash(name: SidecarName, generation: number): void {
    void this.handleCrash(name, generation).catch((e) => {
      this.onStatus(name, 'error', `crash recovery failed: ${(e as Error).message}`);
    });
  }

  private async handleCrash(name: SidecarName, restartGeneration: number): Promise<void> {
    const state = this.sidecars.get(name);
    if (!state || this.shuttingDown) return;
    // An intentional stop/restart/start since the failure owns the lifecycle now.
    if (state.restartGeneration !== restartGeneration) return;

    state.process = null;
    this.resetReadyLatch(state);
    state.restartCount++;

    if (state.restartCount >= MAX_RESTART_ATTEMPTS) {
      state.circuitOpen = true;
      state.recovering = false;
      this.onStatus(name, 'circuit-open', `${state.restartCount} consecutive failures`);
      // Don't give up forever: after a cooldown, reset the breaker and — if the
      // sidecar is still wanted (e.g. the always-on wake word) — bring it back,
      // so a transient crash burst self-heals instead of needing an app restart.
      if (state.circuitResetTimer) clearTimeout(state.circuitResetTimer);
      state.circuitResetTimer = setTimeout(() => {
        state.circuitResetTimer = null;
        if (this.shuttingDown || !state.desiredRunning || state.restartGeneration !== restartGeneration) return;
        state.circuitOpen = false;
        state.restartCount = 0;
        this.onStatus(name, 'circuit-reset', 'cooldown elapsed — retrying');
        void this.startAfterCrash(name, restartGeneration);
      }, CIRCUIT_RESET_MS);
      return;
    }

    const delay = RESTART_BACKOFF_BASE_MS * Math.pow(2, state.restartCount - 1);
    this.onStatus(name, 'restarting', `attempt ${state.restartCount}/${MAX_RESTART_ATTEMPTS} in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));

    // Recovery cycle complete — clear the guard so the monitors resume. A
    // healthy restart will reset restartCount when the sidecar emits 'ready'.
    if (state.restartGeneration !== restartGeneration) return;
    state.recovering = false;
    if (!this.shuttingDown && state.desiredRunning) {
      await this.startAfterCrash(name, restartGeneration);
    }
  }

  /**
   * Automatic (re)start after a failure. A throwing start() (listen/spawn
   * failure) is reported and counted as another failure, so it re-enters the
   * backoff and eventually the circuit breaker instead of silently stalling.
   */
  private async startAfterCrash(name: SidecarName, restartGeneration: number): Promise<void> {
    const state = this.sidecars.get(name);
    if (!state || this.shuttingDown || !state.desiredRunning || state.restartGeneration !== restartGeneration) return;
    try {
      await this.start(name);
    } catch (e) {
      this.onStatus(name, 'error', `restart failed: ${(e as Error).message}`);
      if (this.shuttingDown || !state.desiredRunning || state.process) return;
      state.recovering = true;
      this.scheduleCrash(name, state.restartGeneration);
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const [name, state] of this.sidecars) {
      if (!state.process || state.circuitOpen || state.recovering) continue;
      if (now - state.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.onStatus(name, 'heartbeat-timeout', `${HEARTBEAT_TIMEOUT_MS}ms without heartbeat`);
        this.killThenRecover(name, state);
      }
    }
  }

  private async checkMemory(): Promise<void> {
    if (this.memoryCheckRunning || this.shuttingDown) return;
    const targets = [...this.sidecars].filter(([, s]) => s.process?.pid && !s.circuitOpen && !s.recovering)
      .map(([name, state]) => ({ name, state, child: state.process!, generation: state.restartGeneration }));
    if (!targets.length) return;
    this.memoryCheckRunning = true;
    try {
      const rows = await readProcessMemory();
      this.memoryCheckFailed = false;
      for (const { name, state, child, generation } of targets) {
        // A stop/restart during the async query owns the new incarnation.
        if (this.shuttingDown || state.process !== child || state.restartGeneration !== generation || state.recovering) continue;
        const rssKb = processTreeRss(rows, child.pid!);
        if (rssKb === null) continue;
        const rssMb = rssKb / 1024;
        const limit = this.rssLimitsMb[name];
        if (rssMb > limit) {
          this.onStatus(name, 'memory-exceeded', `Process-tree RSS ${Math.round(rssMb)}MB > limit ${limit}MB`);
          this.killThenRecover(name, state);
        }
      }
    } catch (error) {
      if (!this.memoryCheckFailed) {
        this.memoryCheckFailed = true;
        for (const { name } of targets) this.onStatus(name, 'warning', `Memory watchdog unavailable: ${(error as Error).message}`);
      }
    } finally {
      this.memoryCheckRunning = false;
    }
  }

  /**
   * Monitor-initiated kill + restart. The generation is captured BEFORE the
   * kill: if stop()/restart()/start() runs while we wait for the process to
   * die, that intentional action owns the sidecar and we must not respawn it.
   */
  private killThenRecover(name: SidecarName, state: SidecarState): void {
    const generation = state.restartGeneration;
    state.recovering = true;
    void this.killSidecar(name, state)
      .then(() => {
        if (state.restartGeneration !== generation || state.process) return;
        return this.handleCrash(name, generation);
      })
      .catch((e) => this.onStatus(name, 'error', `recovery failed: ${(e as Error).message}`));
  }

  private closeTransport(state: SidecarState): void {
    if (state.socket) {
      state.socket.destroy();
      state.socket = null;
    }
    if (state.server) {
      state.server.close();
      state.server = null;
    }
    if (state.socketPath) {
      try { fs.unlinkSync(state.socketPath); } catch {}
      state.socketPath = null;
    }
  }

  private async killSidecar(_name: SidecarName, state: SidecarState): Promise<void> {
    this.closeTransport(state);
    const proc = state.process;
    if (!proc?.pid) return;
    const pid = proc.pid;

    await new Promise<void>((resolve) => {
      // Already dead: 'exit' will not fire again.
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const timeout = setTimeout(() => {
        try { this.killTree(pid, true); } catch {}
        resolve();
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      try {
        // Kill the entire process group / tree
        this.killTree(pid, false);
      } catch {
        try { proc.kill('SIGKILL'); } catch {}
      }
    });

    // Only clear the slot if it still belongs to the process we killed.
    if (state.process === proc) state.process = null;
  }

  /**
   * Kill a sidecar's whole process tree, cross-platform.
   * POSIX: signal the detached process group via negative PID (SIGTERM, then
   * SIGKILL when `force`). Windows: `taskkill /T` walks the child tree by PID;
   * it has no graceful signal, so it always terminates (the /F force flag is
   * harmless for the non-force call and required for stuck processes).
   */
  private killTree(pid: number, force: boolean): void {
    if (process.platform === 'win32') {
      try {
        const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        tk.unref();
      } catch { /* best-effort; child.kill() in the caller is the fallback */ }
      return;
    }
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  }

  private resolveSidecarCommand(name: SidecarName): { bin: string; args: string[] } {
    // Frozen-binary dirs to check, in priority order: an explicit override
    // (for testing packaged binaries pre-install), then the bundled resources
    // path used in the shipped AppImage/.deb.
    const frozenDirs = [
      process.env.ARIA_SIDECAR_DIR,
      process.resourcesPath ? path.join(process.resourcesPath, 'sidecars') : undefined,
    ].filter(Boolean) as string[];

    // PyInstaller names the onedir entry binary with the platform's exe suffix.
    const exe = process.platform === 'win32' ? '.exe' : '';
    for (const dir of frozenDirs) {
      const frozen = path.join(dir, name, name + exe);
      if (fs.existsSync(frozen)) {
        return { bin: frozen, args: [] };
      }
    }

    // Dev: run main.py with the sidecar's own venv Python if it exists,
    // otherwise fall back to the system Python. venv layout + interpreter name
    // differ on Windows (Scripts/python.exe vs bin/python; `python` vs `python3`).
    const sidecarDir = path.join(__dirname, '..', '..', 'sidecars', name);
    const devPath = path.join(sidecarDir, 'main.py');
    const venvPython = process.platform === 'win32'
      ? path.join(sidecarDir, 'venv', 'Scripts', 'python.exe')
      : path.join(sidecarDir, 'venv', 'bin', 'python');
    const bin = fs.existsSync(venvPython)
      ? venvPython
      : (process.platform === 'win32' ? 'python' : 'python3');
    return { bin, args: [devPath] };
  }

  private getOrCreateState(name: SidecarName): SidecarState {
    let state = this.sidecars.get(name);
    if (!state) {
      state = {
        process: null,
        socket: null,
        server: null,
        socketPath: null,
        restartCount: 0,
        lastHeartbeat: 0,
        circuitOpen: false,
        recovering: false,
        desiredRunning: false,
        restartGeneration: 0,
        circuitResetTimer: null,
        ready: false,
        readyPromise: Promise.resolve(),
        readyResolve: () => {},
      };
      this.resetReadyLatch(state);
      this.sidecars.set(name, state);
    }
    return state;
  }

  /** (Re)arm the readiness latch: a fresh unresolved promise + ready=false. */
  private resetReadyLatch(state: SidecarState): void {
    state.ready = false;
    state.readyPromise = new Promise<void>((resolve) => {
      state.readyResolve = resolve;
    });
  }

  /**
   * Resolve once the sidecar has emitted 'ready' (model loaded) for its current
   * process, or after `timeoutMs` as a safety cap so a stuck load never hangs
   * the caller forever. Returns immediately if already ready or circuit-open.
   */
  async waitForReady(name: SidecarName, timeoutMs = 20000): Promise<void> {
    const state = this.sidecars.get(name);
    if (!state) throw new Error(`${name} sidecar has not been started`);
    if (!state.desiredRunning && !state.process) throw new Error(`${name} sidecar is stopped`);
    if (state.circuitOpen) throw new Error(`${name} sidecar circuit is open`);
    if (state.ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      state.readyPromise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} sidecar did not become ready within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Private directory for this supervisor's Unix sockets. Never a fixed,
   * predictable shared path: another local user could pre-create it. Prefer
   * $XDG_RUNTIME_DIR (per-user 0700 tmpfs) when it verifies as ours; otherwise
   * mkdtemp directly under the sticky system temp dir (random name, created
   * 0700 by us, so it cannot be pre-created or replaced by someone else).
   * Re-verified on every start because tmp cleaners may remove it.
   */
  private getSocketDir(): string {
    if (this.socketDir && Supervisor.isPrivateDir(this.socketDir)) return this.socketDir;
    this.socketDir = null; // missing (tmp cleaner) or no longer trustworthy
    const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
    const xdg = process.env.XDG_RUNTIME_DIR;
    const parent = xdg && path.isAbsolute(xdg) && Supervisor.isPrivateDir(xdg) ? xdg : os.tmpdir();
    const dir = fs.mkdtempSync(path.join(parent, `aria-${uid}-`));
    try { fs.chmodSync(dir, 0o700); } catch { /* verified below */ }
    if (!Supervisor.isPrivateDir(dir)) {
      throw new Error(`Refusing to use socket directory ${dir}: not a private directory owned by this user`);
    }
    this.socketDir = dir;
    return dir;
  }

  /** Real (non-symlink) directory owned by us with no group/other access. */
  static isPrivateDir(dir: string): boolean {
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return false;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
      return (st.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }
}
