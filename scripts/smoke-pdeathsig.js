#!/usr/bin/env node
/* Verify the PR_SET_PDEATHSIG backstop: if the parent process is hard-killed
 * (SIGKILL) so it can't run tree-kill cleanup, the sidecar still dies rather
 * than orphaning.
 *
 * We spawn an intermediate "parent" node process that itself spawns the wakeword
 * sidecar (via a tiny supervisor), then SIGKILL the intermediate parent and
 * check the sidecar pid is gone.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

const PARENT_SRC = `
const { Supervisor } = require(${JSON.stringify(path.resolve(__dirname, '../dist/main/supervisor'))});
const sup = new Supervisor((name, status, detail) => {
  if (status === 'started' && detail) {
    const m = detail.match(/pid=(\\d+)/);
    if (m) process.stdout.write('SIDECAR_PID=' + m[1] + '\\n');
  }
});
sup.startMonitoring();
sup.start('wakeword');
setInterval(() => {}, 1000); // stay alive until killed
`;

async function main() {
  const tmp = path.join(os.tmpdir(), `aria-pdeath-${Date.now()}.js`);
  fs.writeFileSync(tmp, PARENT_SRC);

  // IMPORTANT: do not use detached here, so the intermediate parent is the
  // direct parent of the sidecar and PDEATHSIG fires on its death.
  const parent = spawn(process.execPath, [tmp], { stdio: ['ignore', 'pipe', 'inherit'] });

  let sidecarPid = null;
  parent.stdout.on('data', (d) => {
    const m = d.toString().match(/SIDECAR_PID=(\d+)/);
    if (m) sidecarPid = parseInt(m[1], 10);
  });

  // Wait for the sidecar to come up
  for (let i = 0; i < 60 && !sidecarPid; i++) await sleep(200);
  if (!sidecarPid) { console.log('FAIL: sidecar never started'); parent.kill('SIGKILL'); process.exit(1); }
  console.log(`sidecar pid=${sidecarPid}, parent pid=${parent.pid}`);

  // Hard-kill the intermediate parent (no chance to run cleanup/tree-kill)
  console.log('SIGKILL the parent (simulating a hard crash)...');
  process.kill(parent.pid, 'SIGKILL');

  // PDEATHSIG should SIGTERM the sidecar; give it a moment
  let died = false;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (!alive(sidecarPid)) { died = true; break; }
  }

  fs.unlinkSync(tmp);
  if (!died) { try { process.kill(sidecarPid, 'SIGKILL'); } catch {} }

  console.log(`sidecar alive after parent SIGKILL: ${!died} (expect false)`);
  console.log(`\n=== RESULT: ${died ? 'PASS' : 'FAIL'} ===`);
  process.exit(died ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
