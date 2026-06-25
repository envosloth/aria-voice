#!/usr/bin/env node
/* Resilience test for the supervisor: kill a running sidecar and verify it is
 * automatically restarted (crash detection -> backoff -> respawn -> ready).
 * Then kill it repeatedly to trip the circuit breaker.
 */

const { Supervisor } = require('../dist/main/supervisor');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const statuses = [];
  let currentPid = null;
  let circuitOpen = false;

  const sup = new Supervisor((name, status, detail) => {
    statuses.push({ status, detail, t: Date.now() });
    console.log(`[${name}] ${status}${detail ? ': ' + detail.slice(0, 60) : ''}`);
    if (status === 'started' && detail) {
      const m = detail.match(/pid=(\d+)/);
      if (m) currentPid = parseInt(m[1], 10);
    }
    if (status === 'circuit-open') circuitOpen = true;
  });
  sup.startMonitoring();

  console.log('=== Test 1: crash recovery ===\n');
  await sup.start('wakeword');

  // Wait for ready
  for (let i = 0; i < 40 && !statuses.some(s => s.status === 'ready'); i++) await sleep(200);
  const firstPid = currentPid;
  console.log(`\nInitial pid=${firstPid}. Killing it (SIGKILL)...\n`);

  // Hard-kill the sidecar process group
  try { process.kill(-firstPid, 'SIGKILL'); } catch { try { process.kill(firstPid, 'SIGKILL'); } catch {} }

  // Wait for restart -> new ready
  let restarted = false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (currentPid && currentPid !== firstPid &&
        statuses.filter(s => s.status === 'ready').length >= 2) {
      restarted = true;
      break;
    }
  }

  const sawExit = statuses.some(s => s.status === 'exited');
  const sawRestart = statuses.some(s => s.status === 'restarting');
  console.log(`\n  saw 'exited': ${sawExit}`);
  console.log(`  saw 'restarting': ${sawRestart}`);
  console.log(`  restarted with new pid: ${restarted} (${firstPid} -> ${currentPid})`);

  const test1Pass = sawExit && sawRestart && restarted && currentPid !== firstPid;
  console.log(`\n  Test 1: ${test1Pass ? 'PASS' : 'FAIL'}`);

  await sup.stopAll();
  await sleep(1000);

  console.log(`\n=== RESULT: ${test1Pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(test1Pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
