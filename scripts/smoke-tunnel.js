#!/usr/bin/env node
/* Unit test for the SSH tunnel argv/port-parse helpers (src/main/tunnel-args.ts).
 * These are the two spots that broke "remote connect":
 *   1) the default localPort=0 produced `-L 0:host:port`, which OpenSSH rejects
 *      ("Bad local forwarding specification") — the tunnel could never start;
 *   2) the port was parsed from an ssh "listening on IP:PORT" line OpenSSH never
 *      prints (it emits "IP port N", and only under -v).
 *
 * NOTE: the previous version of this test REPLICATED the (buggy) builder inline
 * and asserted the argv contained `0:127.0.0.1:8080` — locking in the exact bug.
 * It now imports the REAL compiled helper so it tests what actually ships. Build
 * first (smoke:tunnel runs `npm run build` before this). */
const { buildTunnelArgv, parseForwardPort } = require('../dist/main/tunnel-args.js');

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL' + (detail ? ' -> ' + detail : '')}`);
}

const base = { sshHost: 'user@box', sshPort: 22, identityFile: '', remoteHost: '127.0.0.1', remotePort: 8080 };

// --- The core regression: a concrete port yields a valid -L spec, NEVER `0:`. ---
const a = buildTunnelArgv(base, 54123);
const spec = a[a.indexOf('-L') + 1];
check('argv.hasForward', a.includes('-L') && spec === '54123:127.0.0.1:8080', spec);
check('argv.noZeroPort', !a.some((t) => /^0:/.test(t)), a.join(' '));
check('argv.hostLast', a[a.length - 1] === 'user@box', a.join(' '));
check('argv.batchMode', a.includes('BatchMode=yes'));
check('argv.exitOnForwardFailure', a.includes('ExitOnForwardFailure=yes'));

// port 0 / bad ports MUST throw — the guard that stops the old bug reappearing.
for (const bad of [0, -1, 1.5, NaN]) {
  let threw = false;
  try { buildTunnelArgv(base, bad); } catch { threw = true; }
  check(`argv.rejects(${bad})`, threw);
}

// -i / -p only when meaningful.
const withKeyPort = buildTunnelArgv({ ...base, sshPort: 2222, identityFile: '/home/u/.ssh/id_ed25519' }, 60000);
check('argv.identity', withKeyPort.includes('-i') && withKeyPort.includes('/home/u/.ssh/id_ed25519'));
check('argv.sshPort', withKeyPort.includes('-p') && withKeyPort.includes('2222'));
check('argv.noKeyByDefault', !a.includes('-i') && !a.includes('-p'));

// --- Port parsing: must handle the REAL OpenSSH format (space "port" N), the
// colon form, IPv6, and reject noise. ---
check('parse.opensshRealFormat', parseForwardPort('debug1: Local forwarding listening on 127.0.0.1 port 54123.') === 54123);
check('parse.colonForm', parseForwardPort('Local forwarding listening on 127.0.0.1:54123') === 54123);
check('parse.ipv6', parseForwardPort('listening on ::1 port 7000') === 7000);
check('parse.noise', parseForwardPort('debug1: Authenticating to box:22 as user') === null);
check('parse.empty', parseForwardPort('') === null);

// Config default localPort stays 0 ("OS-assigned" intent) — the supervisor turns
// that into a real free port; it must NOT reach ssh as a literal 0.
const fs = require('fs');
const path = require('path');
const cfgText = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.ts'), 'utf8');
check('config.localPortDefault0', /localPort:\s*0/.test(cfgText));

// Remote Hermes should be a first-class, low-friction path: picking Hermes should
// use the API-server model name ARIA's setup guide asks users to configure, the
// Remote tab should have a one-click preset for the SSH fields, and the tunnel
// supervisor must verify the forwarded HTTP service actually answers before
// saying "connected" (a bare TCP connect to ssh's local listener can succeed even
// when the remote 127.0.0.1:8642 service is down).
const harnessText = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'harnesses.js'), 'utf8');
check('hermes.defaultModel', /id:\s*'hermes'[\s\S]*defaultModel:\s*'hermes-agent'/.test(harnessText));

const htmlText = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
check('remote.hermesQuickButton', /id="remote-hermes-defaults"/.test(htmlText));
check('remote.rawCommandBlankHint', /Leave blank unless you need custom SSH flags/.test(htmlText));

const appText = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
check('remote.hermesDefaultsFunction', /function\s+applyRemoteHermesDefaults\s*\(/.test(appText));
check('remote.hermesPort8642', /remoteRemotePort\.value\s*=\s*'8642'/.test(appText));
check('remote.connectEnablesToggle', /remoteEnabled\.checked\s*=\s*true/.test(appText));

const tunnelText = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tunnel-supervisor.ts'), 'utf8');
check('tunnel.httpProbeBeforeConnected', /probeHttpLikePort/.test(tunnelText) && /GET \/health HTTP\/1\.1/.test(tunnelText));

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
