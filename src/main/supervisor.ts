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
    if (state.circuitOpen) {
      this.onStatus(name, 'circuit-open', `Exceeded ${MAX_RESTART_ATTEMPTS} restart attempts`);
      return;
    }

    const socketPath = path.join(SOCKET_DIR, `${name}.sock`);
    fs.mkdirSync(SOCKET_DIR, { recursive: true });

    try { fs.unlinkSync(socketPath); } catch {}

    const server = net.createServer((conn) => {
      state.socket = conn;
      conn.on('data', (data) => this.handleSidecarData(name, data));
      conn.on('error', () => { state.socket = null; });
      conn.on('close', () => { state.socket = null; });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, () => resolve());
      server.on('error', reject);
    });

    state.server = server;

    const { bin, args: binArgs } = this.resolveSidecarCommand(name);
    const child = spawn(bin, [...binArgs, '--socket', socketPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
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

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);

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
          // far enough to be considered healthy.
          if (msg.status === 'ready' && state) state.restartCount = 0;
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
      // Kill the entire process group
      process.kill(-state.process.pid, 'SIGTERM');
    } catch {
      try { state.process.kill('SIGKILL'); } catch {}
    }

    await new Promise<void>((resolve) => {
      if (!state.process) return resolve();
      const timeout = setTimeout(() => {
        try { process.kill(-state.process!.pid!, 'SIGKILL'); } catch {}
        resolve();
      }, 5000);
      state.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    state.process = null;
  }

  private resolveSidecarCommand(name: SidecarName): { bin: string; args: string[] } {
    // Frozen-binary dirs to check, in priority order: an explicit override
    // (for testing packaged binaries pre-install), then the bundled resources
    // path used in the shipped AppImage/.deb.
    const frozenDirs = [
      process.env.ARIA_SIDECAR_DIR,
      process.resourcesPath ? path.join(process.resourcesPath, 'sidecars') : undefined,
    ].filter(Boolean) as string[];

    for (const dir of frozenDirs) {
      const frozen = path.join(dir, name, name);
      if (fs.existsSync(frozen)) {
        return { bin: frozen, args: [] };
      }
    }

    // Dev: run main.py with the sidecar's own venv Python if it exists,
    // otherwise fall back to the system python3.
    const sidecarDir = path.join(__dirname, '..', '..', 'sidecars', name);
    const devPath = path.join(sidecarDir, 'main.py');
    const venvPython = path.join(sidecarDir, 'venv', 'bin', 'python');
    const bin = fs.existsSync(venvPython) ? venvPython : 'python3';
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
      };
      this.sidecars.set(name, state);
    }
    return state;
  }
}
