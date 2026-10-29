#!/usr/bin/env node
/* Timer/alarm/reminder announcements that fire before the renderer can listen.
 *
 * timers.ts deletes the persisted record the moment it fires, and startup calls
 * initTimers() before the window finishes loading. A reminder that came due while
 * ARIA was closed used to be erased with nowhere to show or speak it: the send
 * went to a null window. Announcements are now queued until the document is live
 * and flushed by did-finish-load.
 *
 * Extracts the real startup delivery code from src/main/index.ts, stubs only the
 * window, and drives the shipped timers module against a throwaway store.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const ts = require('typescript');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-timer-delivery-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => root } };
  return load.call(this, name, ...args);
};

let pass = true;
function check(name, ok, detail = '') {
  if (!ok) pass = false;
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}

// A reminder that came due while the app was closed (within the 1h grace).
fs.writeFileSync(path.join(root, 'timers.json'), JSON.stringify({
  items: [{
    id: 'missed-review', kind: 'reminder', label: 'synthetic reminder',
    fireAt: Date.now() - 1000, createdAt: Date.now() - 5000,
  }],
}));

try {
  const timers = require('../dist/main/timers');

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    .replace(/\r\n/g, '\n');
  const begin = source.indexOf('// Timer/alarm/reminder announcements that fired');
  const end = source.indexOf('function clearRendererUnresponsiveTimer', begin);
  assert.ok(begin > 0 && end > begin, 'timer-delivery slice markers moved in index.ts');

  const code = ts.transpile(`let mainWindow = null;\n${source.slice(begin, end)}`,
    { target: ts.ScriptTarget.ES2022 });
  const sent = [];
  const ctx = vm.createContext({ IPC: { TIMER_FIRED: 'timer:fired' }, console, initTimers: timers.initTimers, sent });
  vm.runInContext(code, ctx);

  // Startup: initTimers fires the missed reminder before any window exists.
  vm.runInContext('initTimers((text) => deliverTimerAnnouncement(text))', ctx);
  check('missed-reminder-is-not-lost-at-startup',
    timers.listTimers().length === 0 && vm.runInContext('pendingTimerAnnouncements.length', ctx) === 1,
    `remaining=${timers.listTimers().length} queued=${vm.runInContext('pendingTimerAnnouncements.length', ctx)}`);
  check('nothing-sent-before-the-renderer-loads', sent.length === 0, JSON.stringify(sent));

  // The window finishes loading: queued announcements are delivered and spoken.
  vm.runInContext('mainWindow = { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }', ctx);
  vm.runInContext('flushTimerAnnouncements()', ctx);
  check('queued-announcement-reaches-the-renderer',
    sent.length === 1 && sent[0][0] === 'timer:fired' && /synthetic reminder/.test(sent[0][1]),
    JSON.stringify(sent));
  check('queue-drains', vm.runInContext('pendingTimerAnnouncements.length', ctx) === 0);

  // Later fires go straight through.
  vm.runInContext('deliverTimerAnnouncement("second")', ctx);
  check('later-announcement-is-immediate', sent.length === 2 && sent[1][1] === 'second', JSON.stringify(sent));

  // A reload starts a fresh renderer: queue again until the next finish.
  vm.runInContext('timerDeliveryReady = false; deliverTimerAnnouncement("during-reload")', ctx);
  check('reload-gap-is-queued', sent.length === 2 && vm.runInContext('pendingTimerAnnouncements.length', ctx) === 1,
    JSON.stringify(sent));
  vm.runInContext('flushTimerAnnouncements()', ctx);
  check('reload-gap-flushed', sent.length === 3 && sent[2][1] === 'during-reload', JSON.stringify(sent));

  // The queue is bounded: the oldest are dropped, never unbounded growth.
  vm.runInContext('timerDeliveryReady = false', ctx);
  for (let i = 0; i < 30; i++) vm.runInContext(`deliverTimerAnnouncement("flood-${i}")`, ctx);
  check('queue-is-bounded',
    vm.runInContext('pendingTimerAnnouncements.length', ctx) ===
    vm.runInContext('MAX_PENDING_TIMER_ANNOUNCEMENTS', ctx),
    String(vm.runInContext('pendingTimerAnnouncements.length', ctx)));
} finally {
  Module._load = load;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
