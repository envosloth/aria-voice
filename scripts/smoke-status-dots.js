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
 * table means the test can't drift from the code.
 *
 * The same extraction pattern also drives the sidecar-failure banner copy
 * (friendlyError plus the aria.sidecar.onError wiring): an 'error' report is a
 * failed attempt — nothing restarts — and a 'circuit-open' sidecar is paused. */
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

// ---- Sidecar failures → banner copy ----------------------------------------
// Same failure class as the dots: shipped renderer logic a user reads. An
// 'error' report is a failed attempt (nothing restarts) and a 'circuit-open'
// sidecar is PAUSED — the old copy claimed a restart for both, and dropped the
// status token entirely whenever a detail existed. Extract the real
// friendlyError plus the real aria.sidecar.onError wiring, run them with stubs,
// and pin the sentences end to end.
const feStart = src.indexOf('const SIDECAR_NAMES');
const feEnd = src.indexOf('function messageText(', feStart);
const regStart = src.indexOf('aria.sidecar.onError(({ name, status, detail }) => {');
const regEnd = src.indexOf('(async () => {', regStart);
const slicesOk = feStart > 0 && feEnd > feStart && regStart > 0 && regEnd > regStart;
check('copy.slicesPresent', slicesOk, 'friendlyError or the sidecar.onError wiring moved in app.js');

const vm = require('node:vm');
const shown = [];
const holder = {};
const bctx = {
  openSettingsTab() {},
  retryLastMessage() {},
  lastUserText: '',
  showError: (msg) => shown.push(msg),
  aria: { sidecar: { onError: (cb) => { holder.fire = cb; } } },
};
if (slicesOk) {
  vm.createContext(bctx);
  vm.runInContext(src.slice(feStart, feEnd) + '\n' + src.slice(regStart, regEnd)
    + '\nglobalThis.__friendlyError = friendlyError;', bctx);
}
// What main sends (via the real composition) is what friendlyError reads.
const rawFor = (name, status, detail) => {
  shown.length = 0;
  holder.fire({ name, status, detail });
  return shown[0];
};
const copyFor = (raw) => bctx.__friendlyError(raw);

if (slicesOk) {
  const rejected = rawFor('tts', 'error', 'Cloud TTS provider rejected synthesis; check key, quota, model and voice access');
  check('copy.statusTokenKept',
    rejected === 'tts: error: Cloud TTS provider rejected synthesis; check key, quota, model and voice access',
    `the status token must survive the composition: ${rejected}`);
  const rejectedCopy = copyFor(rejected);
  check('copy.errorNotARestart',
    /couldn't speak that reply/.test(rejectedCopy.text) && !/restart/i.test(rejectedCopy.text),
    `an error report must not read as a restart: ${rejectedCopy.text}`);
  check('copy.errorPointsAtVoiceSettings',
    !!rejectedCopy.action && rejectedCopy.action.label === 'Voice settings',
    'a provider refusal is fixable from Voice settings');

  const transientCopy = copyFor(rawFor('tts', 'error', 'Cloud TTS WebSocket connection failed or audio response interrupted'));
  check('copy.transientSaysRetryLater',
    /next reply will try again/.test(transientCopy.text) && !/restart/i.test(transientCopy.text) && !transientCopy.action,
    `transient failures recover on their own: ${transientCopy.text}`);

  const http401Copy = copyFor(rawFor('tts', 'error', 'Cloud TTS HTTP 401; check provider key, quota, model and format access'));
  check('copy.http401StaysSpeechCopy',
    /couldn't speak that reply/.test(http401Copy.text) && !!http401Copy.action && http401Copy.action.label === 'Voice settings',
    `a speech 401 must not be answered as an LLM key problem: ${http401Copy.text}`);
  const http429Copy = copyFor(rawFor('tts', 'error', 'Cloud TTS HTTP 429; check provider key, quota, model and format access'));
  check('copy.http429StaysSpeechCopy',
    /couldn't speak that reply/.test(http429Copy.text) && !!http429Copy.action && http429Copy.action.label === 'Voice settings',
    `a speech 429 must not be answered as an LLM rate limit: ${http429Copy.text}`);
  const llm401Copy = copyFor('LLM error: HTTP 401 from your AI service');
  check('copy.llm401StillFixKey',
    /rejected the API key/.test(llm401Copy.text) && !!llm401Copy.action && llm401Copy.action.label === 'Fix key',
    `the LLM 401 path must be untouched: ${llm401Copy.text}`);

  const circuitCopy = copyFor(rawFor('tts', 'circuit-open', '5 consecutive failures'));
  check('copy.circuitSaysPaused',
    /kept crashing/.test(circuitCopy.text) && /paused it/.test(circuitCopy.text),
    `circuit-open is a pause, not a restart: ${circuitCopy.text}`);
  check('copy.circuitWithoutDetail',
    /kept crashing/.test(copyFor(rawFor('stt', 'circuit-open', undefined)).text),
    'a bare circuit-open must still read as paused');

  const sttCopy = copyFor(rawFor('stt', 'error', 'control handler: boom'));
  check('copy.sttHonest', /^Speech recognition/.test(sttCopy.text) && !/restart/i.test(sttCopy.text),
    `stt errors must not claim a restart: ${sttCopy.text}`);
  const wakeCopy = copyFor(rawFor('wakeword', 'error', ''));
  check('copy.wakeHonest', /wake word hit a problem/.test(wakeCopy.text) && !/restart/i.test(wakeCopy.text),
    `wake-word errors must not claim a restart: ${wakeCopy.text}`);
  const deathCopy = copyFor(rawFor('tts', 'exited', 'code=1 signal=null'));
  check('copy.deathKeepsRestartSentence',
    /stopped unexpectedly/.test(deathCopy.text) && /restarting it/.test(deathCopy.text),
    `an actual sidecar death keeps the restart sentence: ${deathCopy.text}`);
}

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
