#!/usr/bin/env node
const assert = require('node:assert/strict');
const { scripts } = require('../package.json');
const fs = require('node:fs'), path = require('node:path');
const names = ['store-recovery', 'stream-completion', 'ipv6', 'latency-lifecycle', 'process-memory', 'stt-cleanup',
  'core-security', 'routing-invariant', 'mic-lifecycle', 'voice-lifecycle', 'supervisor-lifecycle', 'update-quiesce',
  'release-packaging', 'session-import', 'sidebar', 'latency-test', 'sidecar-lifecycle'];
function expanded(name, seen = new Set()) {
  assert.ok(!seen.has(name), `recursive script: ${name}`); seen.add(name);
  const command = scripts[name]; assert.equal(typeof command, 'string', `missing script ${name}`);
  return command.replace(/npm run ([\w:-]+)/g, (_all, sub) => expanded(sub, new Set(seen)));
}
const all = expanded('smoke:all');
for (const name of names) {
  const ext = ['stt-cleanup', 'sidecar-lifecycle'].includes(name) ? 'py' : 'js';
  assert.ok(all.includes(`scripts/smoke-${name}.${ext}`), `smoke:all omits ${name}`);
}
for (const file of ['scripts/gen-test-audio.sh', 'scripts/smoke-stt.js', 'scripts/smoke-e2e.js']) {
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', file), 'utf8').includes('/tmp/stt_test'), `${file} uses shared absolute temporary fixture`);
}
console.log('PASS complete audit gate wiring and private temporary fixtures');
