#!/usr/bin/env node
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-latency-lifecycle-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => home }, safeStorage: { isEncryptionAvailable: () => false } };
  return load.call(this, name, ...args);
};
const stream = require('../dist/main/llm-stream');
const { config } = require('../dist/main/config');
const { oneShotChat } = require('../dist/main/coordinator');
const { runLatencyTest } = require('../dist/main/latency-test');
config.set('llm.endpoint', 'http://127.0.0.1:9/v1');
let failures = 0;
const intervals = new Set(), originalInterval = global.setInterval;
global.setInterval = (...args) => { const t = originalInterval(...args); intervals.add(t); return t; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
  finally { for (const t of intervals) clearInterval(t); intervals.clear(); }
}
function deps(chat, failVoice = false) {
  let t = 0, n = 0;
  return { now: () => ++t, chat,
    synthesize: async () => { if (++n === 2 && failVoice) throw new Error('fixture voice failed'); return { chunks: [Buffer.alloc(32000)], sampleRate: 16000, firstChunkAt: ++t, requestedAt: t - 1 }; },
    transcribe: async (_pcm, _id, sent) => { sent(++t); return 'hello'; },
  };
}
(async () => {
  await check('abort settles once, cancels transport, rejects late tokens', async () => {
    let cancelled = 0, cb, state = 'pending', tokens = '';
    stream.streamChat = (_o, callbacks) => { cb = callbacks; return { cancel: () => cancelled++ }; };
    const c = new AbortController();
    oneShotChat('fixture', t => tokens += t, c.signal).then(() => state = 'done', e => state = e.name);
    await sleep(1); c.abort(); await sleep(150); cb.onToken('late'); cb.onDone('late');
    assert.equal(state, 'AbortError'); assert.equal(cancelled, 1); assert.equal(tokens, '');
  });
  await check('pre-aborted request never starts', async () => {
    let calls = 0; stream.streamChat = () => { calls++; return { cancel() {} }; };
    const c = new AbortController(); c.abort();
    const state = await Promise.race([oneShotChat('fixture', () => {}, c.signal).then(() => 'done', e => e.name), sleep(25).then(() => 'pending')]);
    assert.equal(state, 'AbortError'); assert.equal(calls, 0);
  });
  await check('synchronous failure leaves no polling timer', async () => {
    stream.streamChat = (_o, cb) => { cb.onError('Invalid endpoint'); return { cancel() {} }; };
    await assert.rejects(oneShotChat('fixture', () => {}, new AbortController().signal), /Invalid endpoint/);
    assert.equal(intervals.size, 0);
  });
  await check('voice failure after first phrase aborts AI', async () => {
    let signal;
    const result = await runLatencyTest(deps((_t, token, s) => { signal = s; token('A sufficiently long sentence. '); return new Promise(() => {}); }, true), 'test');
    assert.equal(result.ok, false); assert.match(result.error, /voice failed/); assert.equal(signal.aborted, true);
  });
  await check('late AI failure cannot become a successful partial test', async () => {
    let signal;
    const result = await runLatencyTest(deps((_t, token, s) => { signal = s; token('A sufficiently long sentence. '); return new Promise((_r, reject) => setTimeout(() => reject(new Error('fixture AI failed')), 10)); }), 'test');
    assert.equal(result.ok, false); assert.match(result.error, /AI failed/); assert.equal(signal.aborted, true);
  });
  await check('AI deadline aborts request and reports failure', async () => {
    let signal; const original = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => original(fn, ms === 60000 ? 15 : ms, ...args);
    try {
      const result = await runLatencyTest(deps((_t, _token, s) => { signal = s; return new Promise(() => {}); }), 'test');
      assert.equal(result.ok, false); assert.match(result.error, /longer/); assert.equal(signal.aborted, true);
    } finally { global.setTimeout = original; }
  });
  await check('successful test finalizes ownership too', async () => {
    let signal;
    const result = await runLatencyTest(deps(async (_t, token, s) => { signal = s; token('A sufficiently long sentence. '); return { target: 'fixture', text: 'A sufficiently long sentence.' }; }), 'test');
    assert.equal(result.ok, true); assert.equal(result.target, 'fixture'); assert.equal(signal.aborted, true);
  });
})().catch(e => { failures++; console.error(e); }).finally(() => {
  global.setInterval = originalInterval; fs.rmSync(home, { recursive: true, force: true }); process.exitCode = failures ? 1 : 0;
});
