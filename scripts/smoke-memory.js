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
    { memoryCheckMs: 500 }, // default ceiling until the first real ready
  );
  sup.startMonitoring();

  // A sidecar killed during initialize() must NOT report ready (base_sidecar
  // suppresses ready after SIGTERM), so a ceiling below init RSS would never
  // recover. Reach a genuine ready first, then drop the ceiling to 1 MB so the
  // watchdog trips on a running sidecar, and restore it so the restart can
  // prove a second genuine ready.
  console.log('=== Starting wakeword with default RSS ceiling ===\n');
  await sup.start('wakeword');

  for (let i = 0; i < 60 && !statuses.some(s => s.status === 'ready'); i++) await sleep(200);
  const firstPid = pid;
  console.log(`\nInitial pid=${firstPid}. Lowering ceiling to 1MB; waiting for watchdog...\n`);
  sup.rssLimitsMb.wakeword = 1;

  // Wait for memory-exceeded + restart
  let recovered = false;
  let restored = false;
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (!restored && statuses.some(s => s.status === 'memory-exceeded')) {
      sup.rssLimitsMb.wakeword = 4096;
      restored = true;
    }
    if (restored &&
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
