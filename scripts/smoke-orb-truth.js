#!/usr/bin/env node
// The orb label must match reality: 'speaking' only while TTS audio is actually
// playing; 'processing' (THINKING) while synthesizing or while a filler has
// ended but the agent is still working. Executes the production functions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const fnNames = new Set(['enterSpeech', 'markAudioStarted', 'markAudioGap', 'armIdleAtAudioEnd']);
const picked = [];
function visit(s) {
  if (ts.isFunctionDeclaration(s) && s.name && fnNames.has(s.name.text)) picked.push(s.getText(ast));
  else ts.forEachChild(s, visit);
}
visit(ast);
assert.equal(picked.length, fnNames.size, 'all speech-state functions found');
const constMatch = source.match(/const SPEECH_GAP_MS = \d+;/);
assert.ok(constMatch, 'SPEECH_GAP_MS present');

function harness() {
  const timers = [];
  const ctx = {
    speechActive: false, speechGapTimer: null, ttsSources: [], orbStateName: 'idle',
    ttsSynthDone: false, awaitingFirstToken: false, idleTimer: null, audioCtx: null, nextPlayTime: 0,
    softBarge: null,
    conversationMode: false, lastTurnWasVoice: false, currentTurnId: 't',
    perf: { mark() {} }, maybeStartFollowup() {},
    states: [],
    orbState(s) { ctx.orbStateName = s; ctx.states.push(s); },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout(id) { if (id && timers[id - 1]) timers[id - 1].fn = null; },
    Math,
  };
  ctx.flush = () => { while (timers.length) { const t = timers.shift(); if (t.fn) t.fn(); } };
  // timers array is index-addressed; keep entries, only null them out
  ctx.flush = () => { for (let i = 0; i < timers.length; i++) { const f = timers[i].fn; timers[i].fn = null; if (f) f(); } };
  vm.createContext(ctx);
  vm.runInContext(`${constMatch[0]}\n${picked.join('\n')}\nthis.api={enterSpeech,markAudioStarted,markAudioGap,armIdleAtAudioEnd};`
    .replace(/\blet\b/g, 'var'), ctx);
  return ctx;
}

let pass = true;
function check(name, fn) {
  try { fn(); console.log(`[${name}] PASS`); } catch (e) { pass = false; console.log(`[${name}] FAIL -> ${e.message}`); }
}

check('synthesizing.isThinking', () => {
  const c = harness();
  c.orbState('processing');
  c.api.enterSpeech();
  assert.equal(c.orbStateName, 'processing', 'no audio yet -> must not claim speaking');
});

check('firstAudio.flipsToSpeaking', () => {
  const c = harness();
  c.api.enterSpeech();
  c.ttsSources.push({});
  c.api.markAudioStarted(0);
  assert.equal(c.orbStateName, 'speaking');
});

check('fillerEnded.agentStillWorking.backToThinking', () => {
  const c = harness();
  c.awaitingFirstToken = true;
  c.api.enterSpeech(); c.ttsSources.push({}); c.api.markAudioStarted(0);
  c.ttsSources.pop(); c.api.markAudioGap(); c.flush();
  assert.equal(c.orbStateName, 'processing');
});

check('interSentenceGap.cancelledByNextChunk', () => {
  const c = harness();
  c.api.enterSpeech(); c.ttsSources.push({}); c.api.markAudioStarted(0);
  c.ttsSources.pop(); c.api.markAudioGap();
  c.ttsSources.push({}); c.api.markAudioStarted(0); // next chunk arrives before the gap timer
  c.flush();
  assert.equal(c.orbStateName, 'speaking');
});

check('listening.neverOverwritten', () => {
  const c = harness();
  c.orbState('listening');
  c.api.enterSpeech(); c.ttsSources.push({}); c.api.markAudioStarted(0); c.flush();
  assert.equal(c.orbStateName, 'listening');
});

check('endOfReply.settlesIdle', () => {
  const c = harness();
  c.api.enterSpeech(); c.ttsSources.push({}); c.api.markAudioStarted(0);
  c.ttsSources.pop(); c.ttsSynthDone = true; c.api.markAudioGap(); c.api.armIdleAtAudioEnd(); c.flush();
  assert.equal(c.orbStateName, 'idle');
  assert.equal(c.speechActive, false);
});

console.log(pass ? 'smoke:orb-truth PASS' : 'smoke:orb-truth FAIL');
process.exit(pass ? 0 : 1);
