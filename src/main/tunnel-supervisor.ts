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
import { buildTunnelArgv, parseForwardPort, TunnelStartGate } from './tunnel-args';

// Ask the OS for a free local TCP port (bind 0, read the assigned port, release).
// We hand this concrete port to `ssh -L` instead of letting ssh pick, because
// OpenSSH rejects a `-L 0:…` spec outright. Tiny TOCTOU window (the port could be
// taken before ssh binds it) is self-healing: ExitOnForwardFailure makes ssh exit
// and we retry with a fresh port.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

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
  private connectPollTimer: ReturnType<typeof setTimeout> | null = null;
  private startGate = new TunnelStartGate();
  private startedAt = 0;
  // Last non-empty line ssh wrote to stderr, surfaced in exit/error messages so a
  // failure is diagnosable ("Permission denied (publickey)" = your key; "Could
  // not resolve hostname" = your host typo) — app-bug vs your-side.
  private lastStderr = '';

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
      rawCommand: string; autoReconnect: boolean; target: 'harness' | 'llm' | 'custom';
    };
    if (this.state === 'starting' || this.state === 'connected') return;
    if (!r.sshHost) {
      this.setState('error', 'sshHost is empty — set it in Settings → Remote access');
      return;
    }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const generation = this.startGate.begin();
    if (generation === null) return;
    this.setState('starting', 'allocating local tunnel port…');
    this.spawn(r, generation);
  }

  // Manually stop the tunnel (also called on `enabled = false`).
  stop(): void {
    this.startGate.cancel();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.connectPollTimer) { clearTimeout(this.connectPollTimer); this.connectPollTimer = null; }
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
    rawCommand: string; target: 'harness' | 'llm' | 'custom';
  }, generation: number): void {
    // rawCommand: the user owns the whole argv; we can't inject a port, so we fall
    // back to discovering it from ssh's stderr (the user should add `-v` for that
    // to work). Split on whitespace — the user is responsible for quoting.
    if (r.rawCommand && r.rawCommand.trim()) {
      if (this.startGate.claim(generation)) this.launch(r, r.rawCommand.trim().split(/\s+/), null);
      return;
    }
    // Structured form. Never hand ssh a local port of 0 — OpenSSH rejects
    // `-L 0:host:port` at argument parsing ("Bad local forwarding specification"),
    // which is the default-config bug that stopped the tunnel from ever starting.
    // When the user asked for an OS-assigned port (0), allocate a concrete free
    // port ourselves and hand ssh that.
    if (r.localPort && r.localPort > 0) {
      if (this.startGate.claim(generation)) this.launch(r, buildTunnelArgv(r, r.localPort), r.localPort);
      return;
    }
    freePort().then((port) => {
      // Config may have been toggled off while we were picking a port.
      if (!this.startGate.isCurrent(generation)) return;
      if (!(config.get('remote') as { enabled: boolean }).enabled
        || this.state === 'stopped' || this.state === 'connected') {
        this.startGate.claim(generation);
        return;
      }
      if (!this.startGate.claim(generation)) return;
      this.launch(r, buildTunnelArgv(r, port), port);
    }).catch((e) => {
      if (this.startGate.claim(generation)) {
        this.scheduleReconnect(`could not allocate a local port: ${(e as Error).message}`);
      }
    });
  }

  private launch(
    r: { remoteHost: string; remotePort: number; target: 'harness' | 'llm' | 'custom' },
    argv: string[],
    knownPort: number | null,
  ): void {
    this.setState('starting', `ssh ${argv.slice(0, 4).join(' ')}…`);
    this.lastStderr = '';

    let proc: ChildProcess;
    try {
      proc = spawn(argv[0], argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX so we can tree-kill cleanly.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      this.scheduleReconnect(`failed to spawn ssh: ${(e as Error).message}`);
      return;
    }

    this.child = proc;
    this.attempts++;

    // We know the local port up front (structured form) — poll it directly to
    // decide when the tunnel is actually usable, instead of parsing an ssh
    // "listening" line that ssh only prints under `-v` (and in a format the old
    // regex didn't match). This is what actually flips the state to 'connected'.
    if (knownPort) {
      this.actualPort = knownPort;
      this.pollConnected(knownPort, r);
    }

    proc.stderr?.on('data', (b: Buffer) => {
      const text = b.toString();
      this.lastStderr = text.trim().split('\n').filter(Boolean).pop() || this.lastStderr;
      // rawCommand path only: we don't know the port, so still try to parse it.
      if (!knownPort) {
        const m = parseForwardPort(text);
        if (m) { this.actualPort = m; this.pollConnected(m, r); }
      }
      this.lastMessage = this.lastStderr;
      this.emit('status', this.snapshot());
    });

    proc.stdout?.on('data', () => { /* ssh -N is silent; ignore */ });

    proc.on('exit', (code, signal) => {
      if (this.connectPollTimer) { clearTimeout(this.connectPollTimer); this.connectPollTimer = null; }
      const wasClean = code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL';
      const wasManual = this.state === 'stopped';
      this.child = null;
      this.actualPort = null;
      if (wasManual) return; // user-initiated stop — no auto-reconnect, no error.
      // Surface the real ssh error so the failure is diagnosable (their auth /
      // their host / their remote port vs an app bug).
      const detail = this.lastStderr ? ` — ${this.lastStderr}` : '';
      this.scheduleReconnect(`ssh exited code=${code} signal=${signal}${detail}`);
    });

    proc.on('error', (err) => {
      if (this.connectPollTimer) { clearTimeout(this.connectPollTimer); this.connectPollTimer = null; }
      // Spawn-level failure (ssh binary not on PATH, permission denied, etc.).
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

  // Poll the local port until it accepts a connection (the forward is live), then
  // declare 'connected'. ssh binds the local listener a beat after spawn, so we
  // retry for ~10s. If ssh exits first (bad auth/host/port), the exit handler
  // takes over; if the forward never comes up we simply stop polling and let the
  // ServerAlive/exit path drive the reconnect.
  private pollConnected(port: number, r: { remoteHost: string; remotePort: number; target: 'harness' | 'llm' | 'custom' }): void {
    if (this.connectPollTimer) { clearTimeout(this.connectPollTimer); this.connectPollTimer = null; }
    let tries = 0;
    const giveUp = (): void => {
      if (!this.child) return;
      this.lastStderr = `remote service did not answer on ${r.remoteHost}:${r.remotePort}`;
      try { this.child.kill('SIGTERM'); } catch { /* already dead */ }
    };
    const retryOrGiveUp = (): void => {
      if (++tries < 40 && this.child) {
        this.connectPollTimer = setTimeout(tick, 250);
      } else {
        giveUp();
      }
    };
    const tick = (): void => {
      if (!this.child || this.state === 'connected' || this.state === 'stopped') return;
      this.probeForwardedPort(port, r.target).then((ok) => {
        if (this.state === 'connected' || this.state === 'stopped' || !this.child) return;
        if (ok) {
          // Reset the backoff so a later drop retries from 1s, not the capped 30s.
          this.attempts = 0;
          this.setState('connected', `tunnel up: 127.0.0.1:${port} → ${r.remoteHost}:${r.remotePort}`);
          return;
        }
        retryOrGiveUp();
      }).catch(() => retryOrGiveUp());
    };
    this.connectPollTimer = setTimeout(tick, 200); // let ssh bind the listener first
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

  private async probeForwardedPort(port: number, target: 'harness' | 'llm' | 'custom'): Promise<boolean> {
    if (target === 'custom') return this.probeLocalPort(port);
    return this.probeHttpLikePort(port);
  }

  // A bare TCP connect to ssh's local listener can succeed even when the remote
  // 127.0.0.1:PORT is refusing connections; ssh accepts locally, then prints
  // "channel open failed" and closes the socket. For harness/LLM tunnels, send a
  // tiny HTTP request and require *some* response bytes (200, 401, 404 all prove
  // the remote HTTP service is actually reachable).
  private async probeHttpLikePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let sock: net.Socket | null = null;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { sock?.destroy(); } catch { /* already closed */ }
        resolve(ok);
      };
      sock = net.createConnection({ host: '127.0.0.1', port, family: 4 });
      timer = setTimeout(() => done(false), 1500);
      sock.once('connect', () => {
        sock.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      sock.once('data', () => done(true));
      sock.once('error', () => done(false));
      sock.once('close', () => done(false));
    });
  }

  // Reconnect with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped).
  // `attempts` is reset to 0 on a successful connect (see the stderr probe),
  // so the backoff restarts from 1s after any period of stable connection.
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

  // Called by the supervisor on a successful `connected` transition. If the
  // target is harness/llm, rewrites the corresponding endpoint to the tunneled
  // URL. (The backoff counter is reset at the connect point, not here, so a
  // `custom`-target tunnel still gets its backoff reset.)
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
