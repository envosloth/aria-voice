#!/usr/bin/env node
// Execute production renderer functions with deterministic IPC/DOM boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['submitUserMessage', 'bargeIn', 'abandonVoiceTurn', 'startNewSession', 'reopenSession',
  'beginUtterance', 'endUtterance', 'startPushToTalk', 'endPushToTalk', 'startMicCapture']);
const selected = [];
function visit(s) {
  if ((ts.isFunctionDeclaration(s) && names.has(s.name.text)) ||
    (ts.isExpressionStatement(s) && /^aria\.stt\.on(Result|Partial|State)\(/.test(s.getText(ast)))) {
    selected.push(s.getText(ast));
  } else ts.forEachChild(s, visit);
}
visit(ast);
const code = selected.join('\n');
const { SttDiscardGate } = require('../src/renderer/audio-utils');
const { MicStartupGate } = require('../src/renderer/mic-lifecycle');
function harness() {
  let serial = 0;
  const calls = { sent: [], stopped: 0, starts: [], ends: [] };
  const callbacks = {};
  const ctx = {
    console, setTimeout: () => 1, clearTimeout() {},
    currentTurnId: null, currentVoiceTurnId: null, currentGenerationId: 0, currentReplyId: null,
    listening: false, pttActive: false, utteranceStartGeneration: 0,
    micStarted: true, micLifecycle: new MicStartupGate(), createMicGraph: async () => () => {},
    lastTurnWasVoice: false, vadActive: false, vad: null, vadSafetyTimer: null, noSpeechTimer: null,
    FOLLOWUP_NO_SPEECH_MS: 6000, sttDiscardGate: new SttDiscardGate(),
    streamBuf: '', streamTextNode: null, currentAssistantMsg: null, currentToolsEl: null, toolChips: null,
    pendingRoute: null, ttsStreamBuf: '', partialEl: { textContent: '' },
    micBtn: { classList: { add() {}, remove() {} }, setAttribute() {} },
    conversationEl: { replaceChildren() {} },
    window: { AriaAudio: { collapseRepeats: (s) => s, HANDSFREE_ENDPOINT_OPTS: {}, VadEndpointer: class {} } },
    aria: {
      llm: { send: (...args) => calls.sent.push(args), cancel() {}, reset() {} },
      stt: { start: (id) => calls.starts.push(id), end: (id) => calls.ends.push(id),
        onResult: (fn) => { callbacks.result = fn; }, onPartial: (fn) => { callbacks.partial = fn; },
        onState: (fn) => { callbacks.state = fn; } },
      sessions: { resume: async () => ({ turns: [] }) },
    },
    perf: { newTurn: () => `turn-${++serial}`, mark() {} },
    resetTurnMarkers() {}, addMessage() {}, handleScreenCommand: async () => false,
    shouldAttachScreen: () => false, captureScreenFrame: async () => null,
    orbState: (s) => { ctx.state = s; }, armThinkingHold() {}, cancelThinkingHold() {},
    stopPlayback() { calls.stopped++; }, resetTtsStream() { ctx.ttsStreamBuf = ''; },
    flushStream() {}, renderSessionList: async () => {}, showError() {}, playDoneListeningChime() {},
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return { ctx, calls, callbacks };
}
async function main() {
  {
    const { ctx, calls } = harness();
    let attempts = 0;
    ctx.micStarted = false;
    ctx.createMicGraph = async () => { if (++attempts === 1) throw new Error('denied'); return () => {}; };
    await ctx.beginUtterance();
    assert.equal(ctx.listening, false, 'failed mic must not open STT');
    await ctx.beginUtterance();
    assert.equal(attempts, 2); assert.equal(calls.starts.length, 1);
    assert.equal(ctx.listening, true);
    ctx.endUtterance();
    await ctx.startPushToTalk();
    assert.equal(ctx.pttActive, true);
    ctx.endPushToTalk();
    assert.equal(ctx.listening, false);
    console.log('PASS microphone failure is retryable without reload and PTT release works');
  }
  for (const cancel of ['endPushToTalk', 'startNewSession']) {
    const { ctx, calls } = harness();
    let ready;
    ctx.micStarted = false;
    ctx.createMicGraph = () => new Promise((r) => { ready = r; });
    const pending = ctx.startPushToTalk();
    await new Promise(setImmediate);
    ctx[cancel]();
    if (ready) ready(() => {});
    await pending;
    assert.equal(calls.starts.length, 0, `${cancel} cancels pending mic startup`);
    assert.equal(ctx.listening, false);
    console.log(`PASS ${cancel} cancels delayed microphone acquisition`);
  }
  for (const transition of ['startNewSession', 'reopenSession']) {
    for (const capturing of [true, false]) {
      const { ctx, calls, callbacks } = harness();
      ctx.currentVoiceTurnId = 'old-voice'; ctx.listening = capturing; ctx.vadActive = capturing;
      ctx.partialEl.textContent = 'old partial';
      await ctx[transition]('another-session');
      callbacks.partial({ turnId: 'old-voice', text: 'late partial' });
      callbacks.result({ turnId: 'old-voice', text: 'old session utterance' });
      callbacks.state({ state: 'stt_failed', turnId: 'old-voice' });
      await new Promise(setImmediate);
      assert.equal(calls.sent.length, 0, `${transition} must discard old STT`);
      assert.equal(ctx.currentVoiceTurnId, null); assert.equal(ctx.listening, false);
      assert.equal(ctx.vadActive, false); assert.equal(ctx.partialEl.textContent, '');
      assert.equal(calls.ends.length, capturing ? 1 : 0);
    }
    console.log(`PASS ${transition} abandons capture and pending transcription`);
  }
  {
    const { ctx, calls } = harness();
    await ctx.submitUserMessage('question A');
    ctx.currentAssistantMsg = { textContent: 'OLD' }; ctx.streamBuf = 'OLD'; ctx.ttsStreamBuf = 'OLD';
    const stops = calls.stopped;
    await ctx.submitUserMessage('question B');
    assert.equal(ctx.currentAssistantMsg, null, 'typed supersession must detach the old assistant bubble');
    assert.equal(ctx.streamBuf, ''); assert.equal(ctx.ttsStreamBuf, '');
    assert.ok(calls.stopped > stops, 'typed supersession must stop prior audio');
    assert.equal(calls.sent.length, 2);
    console.log('PASS typed turns isolate transcript, TTS and playback');
  }
  {
    const { ctx, calls } = harness();
    let release;
    ctx.shouldAttachScreen = () => true;
    ctx.captureScreenFrame = () => new Promise((r) => { release = r; });
    const pending = ctx.submitUserMessage('old screenshot');
    await new Promise(setImmediate);
    ctx.shouldAttachScreen = () => false;
    await ctx.submitUserMessage('new text');
    release('old-image'); await pending;
    assert.equal(calls.sent.length, 1); assert.equal(calls.sent[0][0], 'new text');
    console.log('PASS stale screen capture cannot dispatch');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
