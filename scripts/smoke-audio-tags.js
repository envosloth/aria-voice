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

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
