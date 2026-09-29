#!/usr/bin/env node
/* Supervisor hardening regressions (no Python/models needed):
 *  - socket dir is private, never a fixed shared /tmp root, re-created if cleaned
 *  - stale child stdout/exit events cannot touch the replacement incarnation
 *  - a monitor kill racing an intentional stop() does not schedule a restart
 *  - a throwing restart is reported and re-enters backoff (no unhandled rejection)
 *  - quiesceForUpdate() includes sidecars in crash backoff and cancels the restart
 *  - stop() during start()'s listen() await prevents the spawn
 * SUPERVISOR_MODULE may point at another compiled supervisor (RED runs). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Supervisor } = require(process.env.SUPERVISOR_MODULE || '../dist/main/supervisor');

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e && e.message || e)));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function check(name, cond, detail) {
  if (!cond) process.exitCode = 1;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return fn();
}

function writeFakeSidecar(root) {
  const dir = path.join(root, 'wakeword');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'wakeword');
  // Emits 'ready' once connected, unless ARIA_FAKE_READY_GATE names a file that
  // must exist first (lets a test hold the new incarnation un-ready).
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const endpoint = process.argv[process.argv.indexOf('--socket') + 1];
const socket = endpoint.startsWith('tcp://')
  ? net.connect({ host: '127.0.0.1', port: Number(endpoint.split(':').pop()) })
  : net.connect(endpoint);
const gate = process.env.ARIA_FAKE_READY_GATE;
socket.on('connect', () => {
  const t = setInterval(() => {
    if (gate && !fs.existsSync(gate)) return;
    clearInterval(t);
    process.stdout.write(JSON.stringify({ type: 'status', status: 'ready' }) + '\\n');
  }, 20);
});
socket.on('error', () => {});
setInterval(() => {}, 1000);
`);
  fs.chmodSync(bin, 0o755);
}

function mk(events) {
  return new Supervisor((_n, status, detail) => events.push({ status, detail }));
}
const count = (events, s) => events.filter((e) => e.status === s).length;

async function socketDirTests(root) {
  const uid = process.getuid();
  const saved = process.env.XDG_RUNTIME_DIR;
  try {
    // Attacker-style pre-created shared root must never be used.
    const shared = path.join(os.tmpdir(), `aria-${uid}`);
    const createdShared = !fs.existsSync(shared);
    if (createdShared) fs.mkdirSync(shared, { mode: 0o777 });
    try { fs.chmodSync(shared, 0o777); } catch {}

    delete process.env.XDG_RUNTIME_DIR;
    let ev = [];
    let sup = mk(ev);
    await sup.start('wakeword');
    await waitFor(() => count(ev, 'ready') > 0);
    let dir = sup.socketDir;
    check('socket-dir-not-under-shared-fixed-root', !!dir && !dir.startsWith(shared + path.sep), dir);
    check('socket-dir-is-private-mkdtemp', !!dir && path.dirname(dir) === os.tmpdir()
      && path.basename(dir).startsWith(`aria-${uid}-`) && (fs.statSync(dir).mode & 0o777) === 0o700, dir);
    // tmp cleaner removes the dir: next start must re-create a private one.
    await sup.stop('wakeword');
    fs.rmSync(dir, { recursive: true, force: true });
    ev.length = 0;
    await sup.start('wakeword');
    const again = await waitFor(() => count(ev, 'ready') > 0);
    check('socket-dir-recreated-after-cleanup', again && !!sup.socketDir && fs.existsSync(sup.socketDir)
      && (fs.statSync(sup.socketDir).mode & 0o777) === 0o700, sup.socketDir);
    await sup.stopAll();
    if (createdShared) fs.rmSync(shared, { recursive: true, force: true });

    // Valid XDG_RUNTIME_DIR is preferred.
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'xdg-test-'));
    fs.chmodSync(xdg, 0o700);
    process.env.XDG_RUNTIME_DIR = xdg;
    ev = []; sup = mk(ev);
    await sup.start('wakeword');
    await waitFor(() => count(ev, 'ready') > 0);
    dir = sup.socketDir;
    check('socket-dir-prefers-valid-xdg-runtime-dir', !!dir && path.dirname(dir) === xdg, dir);
    await sup.stopAll();
    // Group/world-accessible XDG dir is rejected (fall back to mkdtemp in tmp).
    fs.chmodSync(xdg, 0o777);
    ev = []; sup = mk(ev);
    await sup.start('wakeword');
    await waitFor(() => count(ev, 'ready') > 0);
    dir = sup.socketDir;
    check('socket-dir-rejects-insecure-xdg', !!dir && path.dirname(dir) === os.tmpdir(), dir);
    await sup.stopAll();
    fs.rmSync(xdg, { recursive: true, force: true });
  } finally {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved;
  }
}

async function staleChildTests(root) {
  const gate = path.join(root, 'ready-gate');
  fs.writeFileSync(gate, '');
  process.env.ARIA_FAKE_READY_GATE = gate;
  const ev = [];
  const sup = mk(ev);
  await sup.start('wakeword');
  await waitFor(() => count(ev, 'ready') > 0);
  const oldChild = sup.sidecars.get('wakeword').process;
  fs.rmSync(gate);
  await sup.restart('wakeword');
  const state = sup.sidecars.get('wakeword');
  const before = ev.length;
  // Late events from the replaced process must be ignored.
  oldChild.stdout.emit('data', Buffer.from('{"type":"status","status":"ready"}\n'));
  await sleep(30);
  check('stale-stdout-cannot-mark-new-child-ready', state.ready === false,
    JSON.stringify(ev.slice(before).map((e) => e.status)));
  oldChild.emit('exit', 1, null);
  await sleep(50);
  check('stale-exit-cannot-trigger-crash-restart', !ev.slice(before).some((e) => e.status === 'exited' || e.status === 'restarting'),
    JSON.stringify(ev.slice(before).map((e) => e.status)));
  fs.writeFileSync(gate, '');
  check('new-child-becomes-ready', await waitFor(() => state.ready === true));
  await sup.stopAll();
  delete process.env.ARIA_FAKE_READY_GATE;
}

async function heartbeatStopRace() {
  const ev = [];
  const sup = mk(ev);
  await sup.start('wakeword');
  await waitFor(() => count(ev, 'ready') > 0);
  const state = sup.sidecars.get('wakeword');
  const realKill = sup.killSidecar.bind(sup);
  let firstKill = true;
  sup.killSidecar = async (name, st) => {
    if (firstKill) { firstKill = false; await sleep(150); }
    return realKill(name, st);
  };
  state.lastHeartbeat = 0;
  sup.checkHeartbeats();
  await sleep(20);
  await sup.stop('wakeword');
  await sleep(1300);
  check('heartbeat-kill-racing-stop-does-not-restart',
    count(ev, 'restarting') === 0 && count(ev, 'started') === 1,
    JSON.stringify(ev.map((e) => e.status)));
  await sup.stopAll();
}

async function restartFailureIsHandled() {
  const ev = [];
  const sup = mk(ev);
  await sup.start('wakeword');
  await waitFor(() => count(ev, 'ready') > 0);
  const pid = sup.sidecars.get('wakeword').process.pid;
  // Next socket-dir resolution fails -> start() throws inside crash recovery.
  sup.getSocketDir = () => { throw new Error('simulated listen failure'); };
  try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
  await waitFor(() => count(ev, 'restarting') >= 2, 2500);
  check('restart-failure-reported-not-unhandled', unhandled.length === 0 && ev.some((e) => e.status === 'error'),
    `unhandled=${JSON.stringify(unhandled)} statuses=${JSON.stringify(ev.map((e) => e.status))}`);
  check('restart-failure-reenters-backoff', count(ev, 'restarting') >= 2, JSON.stringify(ev.map((e) => e.status)));
  await sup.stopAll();
}

async function quiesceIncludesBackoff() {
  const ev = [];
  const sup = mk(ev);
  await sup.start('wakeword');
  await waitFor(() => count(ev, 'ready') > 0);
  const pid = sup.sidecars.get('wakeword').process.pid;
  try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
  await waitFor(() => count(ev, 'restarting') > 0);
  const snapshot = await sup.quiesceForUpdate();
  await sleep(1300); // longer than the first backoff
  check('quiesce-snapshots-sidecar-in-backoff', JSON.stringify(snapshot) === '["wakeword"]', JSON.stringify(snapshot));
  check('quiesce-cancels-pending-backoff-restart', count(ev, 'started') === 1, JSON.stringify(ev.map((e) => e.status)));
  await sup.resumeAfterUpdate(snapshot);
  check('resume-restarts-backoff-sidecar', await waitFor(() => count(ev, 'ready') >= 2), JSON.stringify(ev.map((e) => e.status)));
  await sup.stopAll();
}

async function stopDuringListen() {
  const ev = [];
  const sup = mk(ev);
  const pending = sup.start('wakeword');
  await sup.stop('wakeword');
  try { await pending; } catch {}
  await sleep(300);
  check('stop-during-listen-prevents-spawn', count(ev, 'started') === 0 && !sup.sidecars.get('wakeword').process,
    JSON.stringify(ev.map((e) => e.status)));
  await sup.stopAll();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-sup-hard-'));
  const prev = process.env.ARIA_SIDECAR_DIR;
  process.env.ARIA_SIDECAR_DIR = root;
  writeFakeSidecar(root);
  try {
    for (const [name, t] of [
      ['socket-dir', () => socketDirTests(root)],
      ['stale-child', () => staleChildTests(root)],
      ['heartbeat-stop-race', heartbeatStopRace],
      ['restart-failure', restartFailureIsHandled],
      ['quiesce-backoff', quiesceIncludesBackoff],
      ['stop-during-listen', stopDuringListen],
    ]) {
      try { await t(); } catch (e) { check(`${name}-threw`, false, (e && e.message) || String(e)); }
    }
  } finally {
    if (prev === undefined) delete process.env.ARIA_SIDECAR_DIR; else process.env.ARIA_SIDECAR_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n=== RESULT: ${process.exitCode ? 'FAIL' : 'PASS'} ===`);
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
