#!/usr/bin/env node
// Guard the native release environment and test delayed frozen startup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
let failures = 0;
function check(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message.slice(0, 180)}`); } }
check('Linux uses Python with available tflite-runtime wheels', () => {
  assert.match(workflow, /platform: linux[\s\S]*?python: '3\.11'/);
  assert.ok(workflow.includes("matrix.python || '3.12'"));
});
check('macOS provisions modern Bash and GNU checksums', () => {
  assert.match(workflow, /brew install bash coreutils/);
  assert.ok(workflow.includes('$(brew --prefix bash)/bin'));
  assert.ok(workflow.includes('$(brew --prefix coreutils)/libexec/gnubin'));
});
async function probe(readyAt) {
  let now = 0, status, alive = false, exitCode;
  class Supervisor {
    constructor(cb) { status = cb; }
    startMonitoring() {}
    async start() { alive = true; status('wakeword', 'started', 'pid=123'); }
    sendToSidecar() { return true; }
    async stopAll() { alive = false; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/smoke-supervisor.js'), 'utf8'), {
    require: () => ({ Supervisor }), console: { log() {}, error() {} },
    process: { argv: ['node', 'smoke', 'wakeword'], env: { ARIA_SMOKE_READY_TIMEOUT_MS: '60000' },
      kill() { if (!alive) throw new Error('gone'); }, exit(code) { exitCode = code; } },
    Date: { now: () => now },
    setTimeout(fn, ms) { const before = now; now += ms; if (alive && before < readyAt && now >= readyAt) { status('wakeword', 'initialized'); status('wakeword', 'ready'); } queueMicrotask(fn); },
  });
  for (let i = 0; i < 1000 && exitCode === undefined; i++) await new Promise(r => setImmediate(r));
  return { exitCode, now, alive };
}
(async () => {
  const slow = await probe(10000);
  check('frozen startup may take longer than eight seconds', () => { assert.equal(slow.exitCode, 0); assert.equal(slow.alive, false); });
  const stuck = await probe(Infinity);
  check('startup deadline still fails and cleans up', () => { assert.equal(stuck.exitCode, 1); assert.equal(stuck.alive, false); assert.ok(stuck.now <= 65000); });
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
