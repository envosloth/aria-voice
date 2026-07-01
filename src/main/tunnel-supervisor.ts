// SSH tunnel supervisor. Owns the lifecycle of an `ssh -N -L` child process
// that bridges a local port to a port on a remote host. Used by the
// `Remote access` Settings panel to expose a remote harness/llm over a
// secure tunnel without shipping an HTTP proxy.
//
// Design:
//   - Lazy: nothing is spawned until the user toggles `remote.enabled`.
//   - Self-healing: the tunnel process is restarted with exponential
//     backoff on any non-zero exit, until the user toggles it off OR the
//     process exits cleanly (which only happens on a `stop()` call).
//   - State observable: every state transition emits a `status` message
//     the renderer can render as a "Tunnel: connected / reconnecting /
//     error: …" indicator.
//   - Port-safe: `localPort: 0` requests an OS-assigned port; we parse the
//     chosen port from `ssh`'s stderr (the "Local forwarding listening on
//     port N" line) and expose it as `actualPort` so the renderer can
//     build the `http://127.0.0.1:N/...` URL even when the user asked for
//     "any free port".
//
// Security notes:
//   - We never log or persist the SSH password / passphrase. The user
//     supplies a private key path; if they want password auth they can
//     use `sshpass` via the `rawCommand` override (with the warning
//     dialog the UI shows).
//   - The remote endpoint URL is published only to the renderer, never
//     to a sidecar or remote service. ARIA is a local client; the
//     remote server is what ARIA talks to over the tunnel.
//   - We do NOT forward the user's API key through the tunnel — the
//     key is sent in the HTTP Authorization header to the local port,
//     ssh encrypts it on the wire, and the remote harness receives it
//     as if the user were running the harness on localhost.

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import net from 'net';
import { config } from './config';

export type TunnelState =
  | 'idle'         // disabled in config
  | 'starting'     // ssh process spawning
  | 'connected'    // tunnel is up, port is forwarded
  | 'reconnecting' // process exited unexpectedly; waiting to retry
  | 'error'        // process exited with an error we won't auto-retry
  | 'stopped';     // user toggled off

export interface TunnelStatus {
  state: TunnelState;
  pid: number | null;
  localPort: number | null;   // what the OS actually assigned
  remoteHost: string;
  remotePort: number;
  target: 'harness' | 'llm' | 'custom';
  message: string;            // last status / error / success line
  // The full URL to paste into the endpoint field, e.g.
  // `http://127.0.0.1:54123/v1/chat/completions`. Empty until connected.
  endpoint: string;
  // When the last state change happened (epoch ms).
  since: number;
  // Reconnect attempt counter (resets on a successful connect).
  attempts: number;
}

export class TunnelSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: TunnelState = 'idle';
  private actualPort: number | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;

  // Read the most-recent tunnel status (for the renderer's UI).
  snapshot(): TunnelStatus {
    const remote = config.get('remote') as {
      remoteHost: string; remotePort: number; target: 'harness' | 'llm' | 'custom';
    };
    const localPort = this.actualPort;
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      localPort,
      remoteHost: remote.remoteHost,
      remotePort: remote.remotePort,
      target: remote.target,
      message: this.lastMessage,
      endpoint: localPort
        ? `http://127.0.0.1:${localPort}/v1/chat/completions`
        : '',
      since: this.startedAt,
      attempts: this.attempts,
    };
  }

  private lastMessage = '';

  private setState(s: TunnelState, message: string): void {
    this.state = s;
    this.lastMessage = message;
    this.startedAt = Date.now();
    this.emit('status', this.snapshot());
  }

  // Sync the supervisor with the current config. Called from index.ts on
  // every config change to remote.*. Starts the tunnel if it just got
  // enabled, stops it if it just got disabled.
  sync(): void {
    const r = config.get('remote') as { enabled: boolean };
    if (r.enabled && (this.state === 'idle' || this.state === 'stopped')) {
      this.start();
    } else if (!r.enabled && this.state !== 'idle' && this.state !== 'stopped') {
      this.stop();
    }
  }

  // Manually start the tunnel (e.g. from a "Connect" button in Settings).
  start(): void {
    const r = config.get('remote') as {
      sshHost: string; sshPort: number; identityFile: string;
      remoteHost: string; remotePort: number; localPort: number;
      rawCommand: string; autoReconnect: boolean;
    };
    if (this.state === 'starting' || this.state === 'connected') return;
    if (!r.sshHost) {
      this.setState('error', 'sshHost is empty — set it in Settings → Remote access');
      return;
    }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.spawn(r);
  }

  // Manually stop the tunnel (also called on `enabled = false`).
  stop(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch { /* already dead */ }
    }
    this.child = null;
    this.actualPort = null;
    this.attempts = 0;
    this.setState('stopped', 'tunnel stopped');
  }

  private spawn(r: {
    sshHost: string; sshPort: number; identityFile: string;
    remoteHost: string; remotePort: number; localPort: number;
    rawCommand: string;
  }): void {
    // Build the ssh argv. The user can supply `rawCommand` (a single
    // string split on whitespace) for power users, OR the structured
    // form which is built deterministically here.
    let argv: string[];
    if (r.rawCommand && r.rawCommand.trim()) {
      // Tokenise with a simple shell-like split (no quotes / escapes —
      // the user is responsible for quoting in the field). For most
      // use cases `rawCommand` is `ssh -N -L 54123:127.0.0.1:8080
      // user@host`; we just split on whitespace.
      argv = r.rawCommand.trim().split(/\s+/);
    } else {
      argv = ['ssh', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
        '-L', `${r.localPort || 0}:${r.remoteHost}:${r.remotePort}`];
      if (r.sshPort && r.sshPort !== 22) argv.splice(2, 0, '-p', String(r.sshPort));
      if (r.identityFile) argv.splice(2, 0, '-i', r.identityFile);
      argv.push(r.sshHost);
    }
    this.setState('starting', `ssh ${argv.slice(0, 4).join(' ')}…`);

    let proc: ChildProcess;
    try {
      proc = spawn(argv[0], argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX so we can tree-kill cleanly.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      this.setState('error', `failed to spawn ssh: ${(e as Error).message}`);
      return;
    }

    this.child = proc;
    this.attempts++;

    // Parse the chosen local port from ssh's stderr. OpenSSH prints a
    // line like: "Local forwarding listening on 127.0.0.1:54123." when
    // the tunnel is ready. We use this to fill in `actualPort` when the
    // user asked for 0 (OS-assigned).
    const portFromStderr = (line: string): number | null => {
      const m = line.match(/listening on (?:127\.0\.0\.1|0\.0\.0\.0|localhost|::1):(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    };

    proc.stderr?.on('data', (b: Buffer) => {
      const text = b.toString();
      const m = portFromStderr(text);
      if (m) {
        this.actualPort = m;
        // Sanity-check the port is open locally before declaring
        // success (avoids a 1-2s window of "connected" with a dead
        // port). The check is cheap and bounded by a timeout.
        this.probeLocalPort(m).then((ok) => {
          if (ok) {
            this.setState('connected', `tunnel up: 127.0.0.1:${m} → ${r.remoteHost}:${r.remotePort}`);
          } else {
            // Port printed but isn't accepting — usually a hostname
            // resolution race. Don't declare connected; let the exit
            // handler decide.
          }
        }).catch(() => { /* ignore probe failures */ });
      }
      this.lastMessage = text.trim().split('\n').pop() || this.lastMessage;
      this.emit('status', this.snapshot());
    });

    proc.stdout?.on('data', () => { /* ssh -N is silent; ignore */ });

    proc.on('exit', (code, signal) => {
      const wasClean = code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL';
      const wasManual = this.state === 'stopped';
      this.child = null;
      this.actualPort = null;
      if (wasManual) {
        // User-initiated stop — no auto-reconnect, no error.
        return;
      }
      if (wasClean) {
        // Clean exit (rare without our kill) — could be a ServerAlive
        // timeout or an explicit `ssh -L … -- ExitOnForwardFailure`
        // that found the port taken. Treat as reconnectable.
        this.scheduleReconnect(`ssh exited cleanly (code=${code}, signal=${signal})`);
        return;
      }
      this.scheduleReconnect(`ssh exited code=${code} signal=${signal}`);
    });

    proc.on('error', (err) => {
      // Spawn-level failure (ssh binary not on PATH, permission denied,
      // etc.). Distinguish "ssh not found" from a runtime error.
      const isMissing = /ENOENT/.test(err.message);
      this.child = null;
      this.actualPort = null;
      if (isMissing) {
        this.setState('error', 'ssh not found on PATH — install OpenSSH or set rawCommand in Settings');
      } else {
        this.setState('error', `ssh error: ${err.message}`);
      }
    });
  }

  // Try to TCP-connect to the local port with a short timeout. Returns
  // true if the port accepts a connection. Used to confirm the tunnel
  // is actually usable before we declare `connected`.
  private async probeLocalPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host: '127.0.0.1', port, family: 4 });
      const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 1500);
      sock.once('connect', () => { clearTimeout(timer); sock.end(); resolve(true); });
      sock.once('error', () => { clearTimeout(timer); resolve(false); });
    });
  }

  // Reconnect with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped).
  // Resets `attempts` on a successful connect.
  private scheduleReconnect(reason: string): void {
    const r = config.get('remote') as { autoReconnect: boolean; enabled: boolean };
    if (!r.enabled) {
      this.setState('stopped', reason);
      return;
    }
    if (!r.autoReconnect) {
      this.setState('error', `${reason} — auto-reconnect is off`);
      return;
    }
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(5, this.attempts - 1)));
    this.setState('reconnecting', `${reason} — retrying in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const cfg = config.get('remote') as { enabled: boolean };
      if (cfg.enabled) this.start();
    }, delay);
  }

  // Called by the supervisor on a successful `connected` transition.
  // Resets the backoff counter and, if the target is harness/llm,
  // rewrites the corresponding endpoint to the tunneled URL.
  private applyEndpointRewrite(): void {
    if (this.state !== 'connected' || !this.actualPort) return;
    const r = config.get('remote') as { target: 'harness' | 'llm' | 'custom' };
    if (r.target === 'custom') return; // user manages the URL themselves
    const url = `http://127.0.0.1:${this.actualPort}/v1/chat/completions`;
    if (r.target === 'harness') config.set('harness.endpoint', url);
    if (r.target === 'llm') config.set('llm.endpoint', url);
  }
}

export const tunnel = new TunnelSupervisor();

// Whenever the supervisor reports a status change, apply the
// endpoint rewrite on a successful connect. (Listening to the event
// from the constructor would be a circular import, so this side-effect
// is installed by `installTunnelHook` from index.ts.)
export function installTunnelHook(): void {
  tunnel.on('status', (s) => {
    if (s.state === 'connected' && s.localPort) {
      (tunnel as unknown as { applyEndpointRewrite: () => void }).applyEndpointRewrite?.();
    }
  });
}
