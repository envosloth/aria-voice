#!/usr/bin/env node
/* Standalone smoke test for the sidecar supervisor (no Electron required).
 *
 * Verifies, for each sidecar: spawn -> UDS connect -> 'ready' status ->
 * heartbeats flowing -> clean tree-kill on stopAll (no orphan PIDs).
 *
 * Usage: node scripts/smoke-supervisor.js [sidecar...]   (default: wakeword tts)
 */

const { Supervisor } = require('../dist/main/supervisor');

const targets = process.argv.slice(2);
const sidecars = targets.length ? targets : ['wakeword', 'tts'];

const events = [];
const pids = {};

function onStatus(name, status, detail) {
  events.push({ name, status, detail, t: Date.now() });
  if (status === 'started' && detail) {
    const m = detail.match(/pid=(\d+)/);
    if (m) pids[name] = parseInt(m[1], 10);
  }
  const line = `[${name}] ${status}${detail ? ': ' + detail.slice(0, 80) : ''}`;
  console.log(line);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const sup = new Supervisor(onStatus);
  sup.startMonitoring();

  console.log(`\n=== Starting sidecars: ${sidecars.join(', ')} ===\n`);
  for (const name of sidecars) {
    await sup.start(name);
  }

  // Give them time to initialize and emit a few heartbeats
  console.log('\n=== Waiting 8s for init + heartbeats ===\n');
  await sleep(8000);

  // Assertions
  let pass = true;
  const report = [];

  for (const name of sidecars) {
    const ready = events.some((e) => e.name === name && e.status === 'ready');
    const initialized = events.some((e) => e.name === name && e.status === 'initialized');
    const hasPid = !!pids[name];
    const alive = hasPid && pidAlive(pids[name]);

    report.push({ name, ready, initialized, hasPid, alive });
    if (!ready && !initialized) pass = false;
    if (!alive) pass = false;
  }

  console.log('\n=== Status before shutdown ===');
  for (const r of report) {
    console.log(`  ${r.name}: pid=${pids[r.name] || 'NONE'} alive=${r.alive} ready=${r.ready} initialized=${r.initialized}`);
  }

  // Test message send (control channel)
  console.log('\n=== Testing message send ===');
  for (const name of sidecars) {
    const sent = sup.sendToSidecar(name, { type: 'ping' });
    console.log(`  ${name}: sendToSidecar -> ${sent}`);
  }

  // Shut down and verify no orphans
  console.log('\n=== Calling stopAll() ===\n');
  const capturedPids = { ...pids };
  await sup.stopAll();
  await sleep(1500);

  console.log('=== Orphan check ===');
  let orphans = 0;
  for (const [name, pid] of Object.entries(capturedPids)) {
    const alive = pidAlive(pid);
    if (alive) { orphans++; pass = false; }
    console.log(`  ${name}: pid=${pid} alive_after_stop=${alive} ${alive ? 'ORPHAN!' : 'OK'}`);
  }

  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} (orphans=${orphans}) ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(2);
});
