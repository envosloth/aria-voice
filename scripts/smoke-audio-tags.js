#!/usr/bin/env node
/* ElevenLabs v3/v4 expressive audio tags: prompt gating, speech pass-through,
 * on-screen/persisted stripping and chunk integrity. Pure logic, no network. */
const A = require('../src/renderer/audio-utils.js');
const M = require('../dist/main/audio-tags.js');
let pass = true;
const check = (name, cond, detail) => { if (!cond) pass = false; console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`); };
const S = A.sanitizeForSpeech;

for (const [engine, model, on, want] of [
  ['elevenlabs', 'eleven_v4_turbo', true, true], ['elevenlabs', 'eleven_v4', true, true], ['elevenlabs', 'eleven_v3', true, true],
  ['elevenlabs', 'eleven_flash_v2_5', true, false], ['elevenlabs', 'eleven_v4_turbo', false, false],
  ['cartesia', 'sonic-3.6', true, false], ['kokoro', '', true, false]]) {
  check(`supported ${engine}/${model}/${on}`, A.audioTagsActive(engine, model, on) === want && M.audioTagsActive(engine, model, on) === want);
}
const rules = M.expressivePrompt('elevenlabs', 'eleven_v4_turbo', true);
check('prompt teaches bracket tags sparingly', /\[laughs\]/.test(rules) && /\[sighs\]/.test(rules) && /sparingly|at most/i.test(rules), rules.slice(0, 80));
check('prompt forbids sound effects', /sound effect/i.test(rules));
check('no prompt when inactive', M.expressivePrompt('elevenlabs', 'eleven_flash_v2_5', true) === '' && M.expressivePrompt('cartesia', 'sonic-3.6', true) === '');

const txt = '[sighs] Well, that is a VERY long list. [laughs] Fine, I will do it.';
check('speech keeps tags when active', S(txt, { audioTags: true }) === txt, S(txt, { audioTags: true }));
check('speech drops tags when inactive', S(txt) === 'Well, that is a VERY long list. Fine, I will do it.', S(txt));
check('markdown link text is not a tag', S('see [the docs](https://x.io) now', { audioTags: true }) === 'see the docs now');
check('non-tag brackets still stripped', S('array [0] and [x=1]', { audioTags: true }) === 'array 0 and x 1'.replace('x 1', 'x 1'), S('array [0] and [x=1]', { audioTags: true }));
check('overlong bracket is not a tag', !/\[/.test(S('[' + 'a'.repeat(60) + '] ok', { audioTags: true })));

check('display strips tags', A.stripAudioTags(txt) === 'Well, that is a VERY long list. Fine, I will do it.', A.stripAudioTags(txt));
check('display hides a half-streamed tag', A.stripAudioTags('Hello there [whisp', { partial: true }) === 'Hello there', A.stripAudioTags('Hello there [whisp', { partial: true }));
check('persisted history strips tags', M.stripAudioTags(txt) === 'Well, that is a VERY long list. Fine, I will do it.', M.stripAudioTags(txt));
check('display keeps numeric citations', A.stripAudioTags('Source [1] says so.') === 'Source [1] says so.');

const long = 'This sentence is long enough to trigger an early phrase break for speech [whispers';
const cut = A.nextTtsCut(long, true, 5000);
check('chunker never splits inside an open tag', cut < 0 || !long.slice(0, cut).includes('['), `cut=${cut}`);
const later = 'One more sentence here. [laughs] And then another.';
const c2 = A.nextTtsCut(later, false, 0);
check('chunker cuts at sentence before the tag', c2 > 0 && later.slice(0, c2).trim() === 'One more sentence here.', `cut=${c2}`);

// ---- Jev tone director (ElevenLabs TTS setting, independent of routing) ----
const http = require('http');
const J = require('../dist/main/jev-tone.js');
const serve = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const reply = (body) => (req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { lastReq = { body: JSON.parse(b), auth: req.headers.authorization }; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }); };
let lastReq = null;
(async () => {
  for (const mood of ['playful', 'warm', 'calm', 'serious', 'neutral']) {
    const g = M.expressivePrompt('elevenlabs', 'eleven_v4_turbo', true, mood);
    check(`prompt carries ${mood} guidance`, g.includes(rules.trim().slice(0, 40)) && new RegExp(mood === 'neutral' ? 'no audio tags' : mood, 'i').test(g), g.slice(-120));
  }
  check('mood ignored when tags inactive', M.expressivePrompt('elevenlabs', 'eleven_flash_v2_5', true, 'playful') === '');
  const ok = await serve(reply({ answers: { tone: { choice: 'playful', confidence: 0.82 } } }));
  const ep = `http://127.0.0.1:${ok.address().port}/v1/systemone`;
  const t0 = Date.now();
  const v = await J.classifyToneWithJev('tell me a joke about cats', { endpoint: ep, apiKey: 'fixture-key', previousReply: 'Sure.' });
  check('jev returns the tone', v && v.tone === 'playful' && v.confidence === 0.82, JSON.stringify(v));
  check('jev request is one typed choice question', lastReq && lastReq.body.questions && Object.keys(lastReq.body.questions).join() === 'tone'
    && lastReq.body.questions.tone.type === 'choice' && Object.keys(lastReq.body.questions.tone.criteria).sort().join() === 'calm,neutral,playful,serious,warm', JSON.stringify(lastReq && lastReq.body.questions));
  check('jev state is bounded and has no history beyond the last reply', lastReq.body.state.length <= J.JEV_TONE_MAX_STATE_CHARS && /cats/.test(lastReq.body.state), lastReq.body.state);
  check('jev uses bearer key', lastReq.auth === 'Bearer fixture-key');
  check('jev fast path', Date.now() - t0 < 500);
  ok.close();
  const weak = await serve(reply({ answers: { tone: { choice: 'playful', confidence: 0.3 } } }));
  check('weak verdict ignored', await J.classifyToneWithJev('hi', { endpoint: `http://127.0.0.1:${weak.address().port}/x`, apiKey: 'k' }) === null);
  weak.close();
  const bad = await serve(reply({ answers: { tone: { choice: 'furious', confidence: 0.99 } } }));
  check('off-schema tone ignored', await J.classifyToneWithJev('hi', { endpoint: `http://127.0.0.1:${bad.address().port}/x`, apiKey: 'k' }) === null);
  bad.close();
  const slow = await serve(() => {});
  const s0 = Date.now();
  const late = await J.classifyToneWithJev('hi', { endpoint: `http://127.0.0.1:${slow.address().port}/x`, apiKey: 'k', timeoutMs: 200 });
  check('stalled jev gives up within its deadline', late === null && Date.now() - s0 < 700, `${Date.now() - s0}ms`);
  slow.close();
  check('no key, no request', await J.classifyToneWithJev('hi', { endpoint: ep }) === null);
  check('key never sent over remote plaintext', await J.classifyToneWithJev('hi', { endpoint: 'http://example.com/x', apiKey: 'k' }) === null);
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
