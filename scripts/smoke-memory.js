#!/usr/bin/env node
/* Memory-watchdog test: start a sidecar with an artificially tiny RSS ceiling
 * (1 MB) and a fast check interval, then verify the supervisor detects the
 * breach, emits 'memory-exceeded', kills it, and restarts it.
 */

const { Supervisor } = require('../dist/main/supervisor');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const statuses = [];
  let pid = null;

  const sup = new Supervisor(
    (name, status, detail) => {
      statuses.push({ status, detail });
      console.log(`[${name}] ${status}${detail ? ': ' + detail.slice(0, 60) : ''}`);
      if (status === 'started' && detail) {
        const m = detail.match(/pid=(\d+)/);
        if (m) pid = parseInt(m[1], 10);
      }
    },
    undefined,
    { rssLimitsMb: { wakeword: 1 }, memoryCheckMs: 500 }, // 1 MB ceiling, check every 0.5s
  );
  sup.startMonitoring();

  console.log('=== Starting wakeword with 1MB RSS ceiling ===\n');
  await sup.start('wakeword');

  for (let i = 0; i < 40 && !statuses.some(s => s.status === 'ready'); i++) await sleep(200);
  const firstPid = pid;
  console.log(`\nInitial pid=${firstPid}. Waiting for watchdog to trip...\n`);

  // Wait for memory-exceeded + restart
  let recovered = false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (statuses.some(s => s.status === 'memory-exceeded') &&
        statuses.filter(s => s.status === 'ready').length >= 2 &&
        pid !== firstPid) {
      recovered = true;
      break;
    }
  }

  const sawExceeded = statuses.some(s => s.status === 'memory-exceeded');
  console.log(`\n  saw 'memory-exceeded': ${sawExceeded}`);
  console.log(`  restarted with new pid: ${pid !== firstPid} (${firstPid} -> ${pid})`);

  await sup.stopAll();
  await sleep(1000);

  const pass = sawExceeded && recovered && pid !== firstPid;
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
