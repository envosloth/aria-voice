import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import net from 'net';
import fs from 'fs';
import {
  SidecarName,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_RESTART_ATTEMPTS,
  RESTART_BACKOFF_BASE_MS,
  CIRCUIT_RESET_MS,
  RSS_LIMITS_MB,
  MEMORY_CHECK_INTERVAL_MS,
  SOCKET_DIR,
} from '../shared/constants';

interface SidecarState {
  process: ChildProcess | null;
  socket: net.Socket | null;
  server: net.Server | null;
  restartCount: number;
  lastHeartbeat: number;
  circuitOpen: boolean;
  // True while a kill+restart is in flight, so the heartbeat/memory monitors
  // don't re-trigger and burn extra restart attempts for the same failure.
  recovering: boolean;
  // True between start() and stop()/stopAll(): the caller wants this sidecar
  // running. Used to auto-revive it after the circuit breaker's cooldown.
  desiredRunning: boolean;
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

    // Arm a fresh readiness latch for this (re)spawn — the model must reload
    // before the sidecar is usable again, so any pending waitForReady() blocks
    // until the new process emits 'ready'.
    this.resetReadyLatch(state);

    const server = net.createServer((conn) => {
      state.socket = conn;
      conn.on('data', (data) => this.handleSidecarData(name, data));
      conn.on('error', () => { state.socket = null; });
      conn.on('close', () => { state.socket = null; });
    });

    // PCM data channel. The address string handed to the sidecar via --socket
    // encodes the transport: a filesystem path => Unix domain socket (POSIX),
    // a "tcp://host:port" URL => loopback TCP (Windows, which can't listen on a
    // UDS file path through Node's net).
    let socketArg: string;
    if (process.platform === 'win32') {
      // Windows: loopback TCP on an ephemeral port. Bind to 127.0.0.1 only so
      // the channel is never reachable off-host; the kernel assigns the port.
      await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.on('error', reject);
      });
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      socketArg = `tcp://127.0.0.1:${port}`;
    } else {
      // POSIX (Linux/macOS): filesystem Unix domain socket (unchanged).
      const socketPath = path.join(SOCKET_DIR, `${name}.sock`);
      fs.mkdirSync(SOCKET_DIR, { recursive: true });
      try { fs.unlinkSync(socketPath); } catch {}
      await new Promise<void>((resolve, reject) => {
        server.listen(socketPath, () => resolve());
        server.on('error', reject);
      });
      socketArg = socketPath;
    }

    state.server = server;

    const { bin, args: binArgs } = this.resolveSidecarCommand(name);
    const child = spawn(bin, [...binArgs, '--socket', socketArg], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: own process group so killSidecar can tree-kill via negative PID.
      // Windows has no process groups here; taskkill /T walks the tree instead,
      // and detaching would spawn a stray console — so detach POSIX-only.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    child.stdout?.on('data', (data: Buffer) => {
      this.handleStdioMessage(name, data);
    });

    child.stderr?.on('data', (data: Buffer) => {
      this.onStatus(name, 'log', data.toString().trim());
    });

    child.on('exit', (code, signal) => {
      if (this.shuttingDown) return;
      this.onStatus(name, 'exited', `code=${code} signal=${signal}`);
      const st = this.sidecars.get(name);
      // If a monitor already initiated this kill, its killSidecar().then()
      // owns the restart — don't double-handle (which would burn extra
      // restart attempts and trip the circuit breaker prematurely).
      if (st?.recovering) return;
      if (st) st.recovering = true;
      this.handleCrash(name);
    });

    child.on('error', (err) => {
      this.onStatus(name, 'error', err.message);
      this.handleCrash(name);
    });

    state.process = child;
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
    if (state.circuitResetTimer) { clearTimeout(state.circuitResetTimer); state.circuitResetTimer = null; }
    state.recovering = true;
    await this.killSidecar(name, state);
    state.recovering = false;
    state.process = null;
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);

    for (const state of this.sidecars.values()) {
      state.desiredRunning = false;
      if (state.circuitResetTimer) { clearTimeout(state.circuitResetTimer); state.circuitResetTimer = null; }
    }
    const kills = Array.from(this.sidecars.entries()).map(([name, state]) =>
      this.killSidecar(name, state)
    );
    await Promise.allSettled(kills);
  }

  startMonitoring(): void {
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
    this.memoryTimer = setInterval(() => this.checkMemory(), this.memoryCheckMs);
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

  private handleStdioMessage(name: SidecarName, data: Buffer): void {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const state = this.sidecars.get(name);
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
  }

  private async handleCrash(name: SidecarName): Promise<void> {
    const state = this.sidecars.get(name);
    if (!state || this.shuttingDown) return;

    state.process = null;
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
        if (this.shuttingDown) return;
        state.circuitOpen = false;
        state.restartCount = 0;
        this.onStatus(name, 'circuit-reset', 'cooldown elapsed — retrying');
        if (state.desiredRunning) {
          void this.start(name).catch((e) => this.onStatus(name, 'error', (e as Error).message));
        }
      }, CIRCUIT_RESET_MS);
      return;
    }

    const delay = RESTART_BACKOFF_BASE_MS * Math.pow(2, state.restartCount - 1);
    this.onStatus(name, 'restarting', `attempt ${state.restartCount}/${MAX_RESTART_ATTEMPTS} in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));

    // Recovery cycle complete — clear the guard so the monitors resume. A
    // healthy restart will reset restartCount when the sidecar emits 'ready'.
    state.recovering = false;
    if (!this.shuttingDown) {
      await this.start(name);
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const [name, state] of this.sidecars) {
      if (!state.process || state.circuitOpen || state.recovering) continue;
      if (now - state.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.onStatus(name, 'heartbeat-timeout', `${HEARTBEAT_TIMEOUT_MS}ms without heartbeat`);
        state.recovering = true;
        this.killSidecar(name, state).then(() => this.handleCrash(name));
      }
    }
  }

  private checkMemory(): void {
    for (const [name, state] of this.sidecars) {
      if (!state.process?.pid || state.circuitOpen || state.recovering) continue;
      const rssKb = this.getProcessRss(state.process.pid);
      if (rssKb === null) continue;

      const rssMb = rssKb / 1024;
      const limit = this.rssLimitsMb[name];
      if (rssMb > limit) {
        this.onStatus(name, 'memory-exceeded', `RSS ${Math.round(rssMb)}MB > limit ${limit}MB`);
        state.recovering = true;
        this.killSidecar(name, state).then(() => this.handleCrash(name));
      }
    }
  }

  private getProcessRss(pid: number): number | null {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
      return match ? parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }

  private async killSidecar(name: SidecarName, state: SidecarState): Promise<void> {
    if (state.server) {
      state.server.close();
      state.server = null;
    }
    if (state.socket) {
      state.socket.destroy();
      state.socket = null;
    }
    if (!state.process?.pid) return;

    try {
      // Kill the entire process group / tree
      this.killTree(state.process.pid, false);
    } catch {
      try { state.process.kill('SIGKILL'); } catch {}
    }

    await new Promise<void>((resolve) => {
      if (!state.process) return resolve();
      const timeout = setTimeout(() => {
        try { this.killTree(state.process!.pid!, true); } catch {}
        resolve();
      }, 5000);
      state.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    state.process = null;
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
        restartCount: 0,
        lastHeartbeat: 0,
        circuitOpen: false,
        recovering: false,
        desiredRunning: false,
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
    if (!state || state.ready || state.circuitOpen) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      state.readyPromise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
