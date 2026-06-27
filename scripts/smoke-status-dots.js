#!/usr/bin/env node
/* Unit test for the renderer status-dot logic (src/renderer/app.js).
 *
 * Regression guard for "the green online dots stop working after I talk to the
 * agent": the supervisor forwards every sidecar stdout line as status 'log', and
 * the old handler blanked the dot on ANY status — so the first transcription log
 * turned the STT dot dark and it never recovered. The fix repaints the dot ONLY
 * on a recognized lifecycle status and leaves it untouched otherwise.
 *
 * app.js is a browser-global script (not requireable), so we extract the shipped
 * DOT_CLASS_FOR_STATUS table straight from source and simulate the handler over
 * the full status vocabulary the supervisor actually emits. Testing the real
 * table means the test can't drift from the code. */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL' + (detail ? ' -> ' + detail : '')}`);
}

// Pull the shipped mapping object literal out of source and evaluate just it.
const m = src.match(/const DOT_CLASS_FOR_STATUS = (\{[\s\S]*?\});/);
check('map.present', !!m, 'DOT_CLASS_FOR_STATUS table not found in app.js');
const MAP = m ? Function('return ' + m[1])() : {};

// The shipped guard that protects a healthy dot from non-lifecycle statuses.
check('guard.present', /const cls = DOT_CLASS_FOR_STATUS\[status\];\s*\n\s*if \(!cls\) return;/.test(src),
  'handler must early-return when the status is not a recognized lifecycle change');

// Replicates the handler: a recognized status sets 'status-dot <cls>', anything
// else (log/heartbeat/unknown) leaves the dot's className untouched.
function applyStatus(prevClass, status) {
  const cls = MAP[status];
  if (!cls) return prevClass; // not a state change — keep as-is
  return 'status-dot ' + cls;
}

// Lifecycle transitions repaint correctly.
check('ready->active', applyStatus('status-dot', 'ready') === 'status-dot active');
check('started->active', applyStatus('status-dot', 'started') === 'status-dot active');
check('error->error', applyStatus('status-dot active', 'error') === 'status-dot error');
check('circuit-open->error', applyStatus('status-dot active', 'circuit-open') === 'status-dot error');
check('exited->error', applyStatus('status-dot active', 'exited') === 'status-dot error');
check('memory-exceeded->error', applyStatus('status-dot active', 'memory-exceeded') === 'status-dot error');
check('restarting->loading', applyStatus('status-dot active', 'restarting') === 'status-dot loading');

// THE regression: a 'log' (and any unknown) must NOT disturb an already-green dot.
check('log.keeps.active', applyStatus('status-dot active', 'log') === 'status-dot active');
check('heartbeat.keeps.active', applyStatus('status-dot active', 'heartbeat') === 'status-dot active');
check('unknown.keeps.active', applyStatus('status-dot active', 'whatever') === 'status-dot active');
check('log.not.in.map', MAP.log === undefined, JSON.stringify(MAP));

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
