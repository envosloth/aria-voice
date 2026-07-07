// Pure helpers for the SSH tunnel supervisor. Kept in their own dependency-free
// module (no electron/config imports) so the argv/port-parsing logic — the part
// that had the connect-breaking bugs — is unit-testable in plain node
// (scripts/smoke-tunnel.js).

export interface TunnelArgs {
  sshHost: string;
  sshPort: number;
  identityFile: string;
  remoteHost: string;
  remotePort: number;
}

// Build the `ssh -N -L …` argv for a KNOWN local port.
//
// IMPORTANT: `port` must be a concrete, non-zero port. OpenSSH rejects a `-L`
// spec whose local port is 0 ("Bad local forwarding specification '0:host:port'")
// — it does NOT treat 0 as "pick a free port" the way bind(0) does. That was the
// default-config bug: `localPort: 0` produced `-L 0:…` and every spawn died at
// argument parsing before connecting. The supervisor now allocates a real free
// port (net bind 0) and passes it here, so ssh always gets a valid spec.
export function buildTunnelArgv(r: TunnelArgs, port: number): string[] {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`buildTunnelArgv: local port must be a positive integer, got ${port}`);
  }
  const argv = [
    'ssh', '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', `${port}:${r.remoteHost}:${r.remotePort}`,
  ];
  // Insert -i / -p right after `ssh -N` (before the -o flags is also fine; order
  // among options doesn't matter to ssh). splice(2, 0, …) keeps them grouped.
  if (r.sshPort && r.sshPort !== 22) argv.splice(2, 0, '-p', String(r.sshPort));
  if (r.identityFile) argv.splice(2, 0, '-i', r.identityFile);
  argv.push(r.sshHost);
  return argv;
}

// Parse the local port from an OpenSSH forwarding-status line. Only used for the
// rawCommand path (where the supervisor doesn't know the port up front). Handles
// BOTH the real OpenSSH `-v` format ("Local forwarding listening on 127.0.0.1
// port 54123.") and the colon form some tools print ("… 127.0.0.1:54123"). The
// old regex only matched the colon form, which OpenSSH never emits.
export function parseForwardPort(line: string): number | null {
  const m = line.match(
    /listening on (?:127\.0\.0\.1|0\.0\.0\.0|localhost|::1|\[::1\])(?::|\s+port\s+)(\d+)/i,
  );
  return m ? parseInt(m[1], 10) : null;
}
