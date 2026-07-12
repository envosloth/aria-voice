#!/usr/bin/env node
/* Supervisor-only lifecycle regression: isolated sockets + intentional stop. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Supervisor } = require('../dist/main/supervisor');
const { SOCKET_DIR } = require('../dist/shared/constants');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function check(name, condition, detail) {
  if (!condition) process.exitCode = 1;
  console.log(`[${name}] ${condition ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}

function writeFakeSidecar(root) {
  const dir = path.join(root, 'wakeword');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'wakeword');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const net = require('net');
const at = process.argv.indexOf('--socket');
const endpoint = process.argv[at + 1];
const socket = endpoint.startsWith('tcp://')
  ? net.connect({ host: endpoint.slice(6).split(':')[0], port: Number(endpoint.slice(6).split(':')[1]) })
  : net.connect(endpoint);
socket.on('connect', () => process.stdout.write(JSON.stringify({
  type: 'status', status: 'ready',
  detail: [process.env.PYTHONPATH, process.env.PYTHONHOME, process.env.VIRTUAL_ENV].filter(Boolean).join('|'),
}) + '\\n'));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(bin, 0o755);
}

async function start(supervisor, statuses) {
  await supervisor.start('wakeword');
  for (let i = 0; i < 40 && !statuses.some((s) => s.status === 'ready'); i++) await sleep(25);
  return statuses.some((s) => s.status === 'ready');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-supervisor-'));
  const previous = process.env.ARIA_SIDECAR_DIR;
  process.env.ARIA_SIDECAR_DIR = root;
  const inheritedPythonPath = process.env.PYTHONPATH;
  const inheritedVirtualEnv = process.env.VIRTUAL_ENV;
  process.env.PYTHONPATH = '/contaminating/python/site-packages';
  process.env.VIRTUAL_ENV = '/contaminating/venv';
  writeFakeSidecar(root);
  try {
    const a = [], b = [];
    const first = new Supervisor((_name, status, detail) => a.push({ status, detail }));
    const second = new Supervisor((_name, status, detail) => b.push({ status, detail }));
    check('isolated-supervisors-both-connect', await start(first, a) && await start(second, b));
    check('sidecar-environment-removes-parent-python-state', a.find((event) => event.status === 'ready')?.detail === '');
    const socketRoot = `${SOCKET_DIR}-${process.getuid()}`;
    const socketDirs = fs.existsSync(socketRoot)
      ? fs.readdirSync(socketRoot).map((entry) => path.join(socketRoot, entry)).filter((entry) => fs.statSync(entry).isDirectory())
      : [];
    check('socket directories live under private application root', socketDirs.length >= 2, JSON.stringify(socketDirs));
    check('socket root mode is private', (fs.statSync(socketRoot).mode & 0o777) === 0o700,
      (fs.statSync(socketRoot).mode & 0o777).toString(8));
    check('per-supervisor socket directories are private', socketDirs.every((entry) => (fs.statSync(entry).mode & 0o777) === 0o700));
    await first.stopAll();
    await second.stopAll();

    const events = [];
    const supervisor = new Supervisor((_name, status, detail) => events.push({ status, detail }));
    check('sidecar-ready-before-stop-race', await start(supervisor, events));
    const started = events.find((event) => event.status === 'started');
    const pid = started && Number((started.detail || '').match(/pid=(\d+)/)?.[1]);
    try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    for (let i = 0; i < 40 && !events.some((event) => event.status === 'restarting'); i++) await sleep(25);
    await supervisor.stop('wakeword');
    await sleep(1200); // longer than the first crash backoff
    check('intentional-stop-cancels-pending-restart', events.filter((event) => event.status === 'started').length === 1,
      JSON.stringify(events.map((event) => event.status)));
    await supervisor.stopAll();
  } finally {
    if (previous === undefined) delete process.env.ARIA_SIDECAR_DIR;
    else process.env.ARIA_SIDECAR_DIR = previous;
    if (inheritedPythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = inheritedPythonPath;
    if (inheritedVirtualEnv === undefined) delete process.env.VIRTUAL_ENV;
    else process.env.VIRTUAL_ENV = inheritedVirtualEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n=== RESULT: ${process.exitCode ? 'FAIL' : 'PASS'} ===`);
}

main().catch((error) => { console.error(error); process.exit(2); });
