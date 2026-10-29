#!/usr/bin/env node
/* Startup order: the wake-word sidecar must not wait on STT/TTS model downloads.
 *
 * Its models ship with the sidecar, and the comment above the block has always
 * said so — but the code awaited ensureModelsReady() first, so a slow or failing
 * multi-GB download kept voice activation off. This extracts the real startup
 * sequence and holds the model promise open to prove the ordering.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
  .replace(/\r\n/g, '\n');
const ready = source.indexOf('app.whenReady().then(async () => {');
const marker = '  applyConfigToEnv();';
const applied = source.indexOf(marker, ready);
const begin = applied + marker.length;
const end = source.indexOf('// Pre-warm STT shortly after startup', begin);
assert.ok(ready > 0 && applied > ready && end > begin, 'startup slice markers moved in index.ts');

let pass = true;
function check(name, ok, detail = '') {
  if (!ok) pass = false;
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  let releaseModels;
  const modelsPending = new Promise((resolve) => { releaseModels = resolve; });
  const started = [];
  const ctx = vm.createContext({
    config: { get: () => true },
    supervisor: { start: async (name) => { started.push(name); } },
    ensureModelsReady: () => modelsPending,
    console,
  });
  const code = ts.transpile(`(async () => {\n${source.slice(begin, end)}\n})()`,
    { target: ts.ScriptTarget.ES2022 });
  const startup = vm.runInContext(code, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  check('wakeword-starts-while-models-are-still-pending',
    started.length === 1 && started[0] === 'wakeword', JSON.stringify(started));

  releaseModels(false); // models unavailable — wake word must still be running
  await startup;
  check('wakeword-still-started-when-models-fail',
    started.length === 1 && started[0] === 'wakeword', JSON.stringify(started));

  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
