#!/usr/bin/env node
// Real filesystem tests; never read or write the user's store.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-store-recovery-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => root } };
  return load.call(this, name, ...args);
};
const { JsonStore } = require('../dist/main/json-store');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
}
try {
  check('corrupt store is preserved and set/delete fail closed', () => {
    const file = path.join(root, 'broken.json');
    const original = '{"sessions":[{"id":"recover-me"}';
    fs.writeFileSync(file, original);
    const store = new JsonStore('broken', { sessions: [] });
    assert.throws(() => store.set('sessions', []), /refusing|recover|unreadable/i);
    assert.throws(() => store.delete('sessions'), /refusing|recover|unreadable/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
  check('unreadable store is not treated as missing', () => {
    const file = path.join(root, 'denied.json'); fs.writeFileSync(file, '{"value":4}');
    const read = fs.readFileSync;
    let store;
    try {
      fs.readFileSync = function (p, ...args) {
        if (p === file) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        return read.call(this, p, ...args);
      };
      store = new JsonStore('denied', { value: 0 });
    } finally { fs.readFileSync = read; }
    assert.throws(() => store.set('value', 5), /refusing|recover|unreadable/i);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"value":4}');
  });
  check('invalid root shape cannot be silently replaced', () => {
    for (const [i, raw] of ['[]', 'null', '42'].entries()) {
      const file = path.join(root, `shape${i}.json`); fs.writeFileSync(file, raw);
      const store = new JsonStore(`shape${i}`, {});
      assert.throws(() => store.set('value', 1));
      assert.equal(fs.readFileSync(file, 'utf8'), raw);
    }
  });
  check('parse errors do not disclose file contents in logs', () => {
    fs.writeFileSync(path.join(root, 'private.json'), 'SENSITIVE_FIXTURE');
    const messages = [], original = console.error;
    try { console.error = (...args) => messages.push(args.join(' ')); new JsonStore('private', {}); }
    finally { console.error = original; }
    assert.ok(messages.length > 0, 'failed load must be reported');
    assert.ok(!messages.join('').includes('SENSITIVE_FIXTURE'), 'parser snippets must not leak');
  });
  check('missing store initializes and keeps one last-good backup', () => {
    const store = new JsonStore('healthy', { value: 0 });
    store.set('value', 1); store.set('value', 2); store.set('value', 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'healthy.json'))).value, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'healthy.json.bak'))).value, 2);
    assert.equal(fs.readdirSync(root).filter(n => n.startsWith('healthy')).length, 2);
  });
  check('backup failure preserves the previous primary file', () => {
    const store = new JsonStore('backup-fail', { value: 0 }); store.set('value', 1);
    fs.mkdirSync(path.join(root, 'backup-fail.json.bak.tmp'));
    assert.throws(() => store.set('value', 2));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'backup-fail.json'))).value, 1);
  });
} finally { fs.rmSync(root, { recursive: true, force: true }); }
process.exitCode = failures ? 1 : 0;
