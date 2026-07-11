#!/usr/bin/env node
/* Unit test for the mic-capture audio helpers (downsample + int16 conversion). */

const A = require('../src/renderer/audio-utils.js');

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}

// 1. Downsample length math: 48000 -> 16000 is a 3:1 decimation
const src48 = new Float32Array(4800); // 0.1s @ 48k
const ds = A.downsampleTo16k(src48, 48000);
check('downsample-length', ds.length === 1600, `got ${ds.length}, expected 1600`);

// 1b. 48 -> 16 kHz must low-pass each 3-sample source interval instead of
// selecting every third sample. Straight decimation aliases ultrasonic/noisy mic
// energy into Whisper's speech band; interval averaging improves recognition
// without buffering another frame or adding user-visible latency.
const aliasedImpulse = A.downsampleTo16k(new Float32Array([1, 0, 0, 0, 0, 0]), 48000);
check('downsample-antialiases', aliasedImpulse.length === 2 && Math.abs(aliasedImpulse[0] - (1 / 3)) < 1e-6,
  `got ${Array.from(aliasedImpulse).join(', ')}`);

// 2. Passthrough when already 16k
const at16 = new Float32Array(1600);
check('passthrough-16k', A.downsampleTo16k(at16, 16000).length === 1600);

// 3. int16 conversion + clamping
const f = new Float32Array([0, 1, -1, 0.5, 2, -2]);
const pcm = new Int16Array(A.floatToInt16(f));
check('int16-zero', pcm[0] === 0);
check('int16-full+', pcm[1] === 32767, `got ${pcm[1]}`);
check('int16-full-', pcm[2] === -32768, `got ${pcm[2]}`);
check('int16-clamp+', pcm[4] === 32767, `clamped >1 -> ${pcm[4]}`);
check('int16-clamp-', pcm[5] === -32768, `clamped <-1 -> ${pcm[5]}`);

// 4. Frequency preservation: a 440Hz sine at 48k, downsampled to 16k, should
//    still have its zero-crossings spaced for ~440Hz (period ~36.4 samples@16k).
const rate = 48000, freq = 440, dur = 0.5;
const n = Math.floor(rate * dur);
const sine = new Float32Array(n);
for (let i = 0; i < n; i++) sine[i] = Math.sin(2 * Math.PI * freq * i / rate);
const sine16 = A.downsampleTo16k(sine, rate);
// count zero crossings (negative -> positive)
let crossings = 0;
for (let i = 1; i < sine16.length; i++) {
  if (sine16[i - 1] < 0 && sine16[i] >= 0) crossings++;
}
const measuredHz = crossings / dur;
check('freq-preserved', Math.abs(measuredHz - freq) < 15, `measured ~${measuredHz.toFixed(0)}Hz (expected ${freq})`);

// 5. Full pipeline returns an ArrayBuffer of the right byte length
const out = A.micFrameToPcm16k(src48, 48000);
check('pipeline-bytes', out.byteLength === 1600 * 2, `got ${out.byteLength}`);

// 6. rms: silence ~0, full-scale ~1
check('rms-silence', A.rms(new Float32Array(100)) === 0);
const loud = new Float32Array(100).fill(0.5);
check('rms-level', Math.abs(A.rms(loud) - 0.5) < 1e-6, `got ${A.rms(loud)}`);

// 7. VadEndpointer: ends after hangMs of silence following speech, not before
const vad = new A.VadEndpointer({ threshold: 0.1, hangMs: 100, frameMs: 20 });
let endedFrame = -1;
const seq = [0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0]; // speech then silence
for (let i = 0; i < seq.length; i++) {
  if (vad.pushRms(seq[i]) && endedFrame < 0) endedFrame = i;
}
// speech ends at index 2; silence frames 3,4,5,6,7 -> 100ms reached at the 5th
// silent frame (index 7: 20,40,60,80,100). Allow index 7.
check('vad-ends-on-silence', endedFrame === 7, `ended at frame ${endedFrame}`);

// 8. VadEndpointer: never ends if no speech seen (pure silence)
const vad2 = new A.VadEndpointer({ threshold: 0.1, hangMs: 100, frameMs: 20 });
let firedNoSpeech = false;
for (let i = 0; i < 50; i++) if (vad2.pushRms(0)) firedNoSpeech = true;
check('vad-no-speech-no-end', !firedNoSpeech);

// 9. VadEndpointer: fires only once (two loud frames = 40ms, the default
//    minSpeechMs, so this is also the minimal qualifying utterance)
const vad3 = new A.VadEndpointer({ threshold: 0.1, hangMs: 40, frameMs: 20 });
vad3.pushRms(0.5); vad3.pushRms(0.5);
let fires = 0;
for (let i = 0; i < 10; i++) if (vad3.pushRms(0)) fires++;
check('vad-fires-once', fires === 1, `fired ${fires} times`);

// 9b. VadEndpointer: a single-frame transient (door slam / key click) is NOT
//     speech — minSpeechMs requires sustained energy.
const vadT = new A.VadEndpointer({ threshold: 0.1, hangMs: 100, frameMs: 20 });
vadT.pushRms(0.5); // one 20ms spike
for (let i = 0; i < 20; i++) vadT.pushRms(0);
check('vad-transient-not-speech', !vadT.hasSpeech());

// 9c. Once speech has qualified, a resumed word clears the endpoint timer
// immediately. It must not wait through the full follow-up qualification gate
// again, or a natural mid-sentence pause would end the turn early.
const vadR = new A.VadEndpointer({ threshold: 0.1, hangMs: 100, frameMs: 20, minSpeechMs: 60 });
for (let i = 0; i < 3; i++) vadR.pushRms(0.5); // qualify speech
for (let i = 0; i < 2; i++) vadR.pushRms(0); // 40ms pause
vadR.pushRms(0.5); // resumed speech must clear that pause immediately
let endedEarly = false;
for (let i = 0; i < 3; i++) endedEarly = vadR.pushRms(0) || endedEarly;
check('vad-resumed-speech-clears-pause', !endedEarly);
check('vad-resumed-speech-still-ends-after-full-hang', vadR.pushRms(0) === false && vadR.pushRms(0) === true);

// 9d. VadEndpointer follow-up gate: 240ms sustained energy required, and a
//     low-level adaptive floor makes steady ambience read as silence. A noisy room
//     (RMS 0.05, well over the 0.012 base threshold) never counts as speech…
const vadF = new A.VadEndpointer({ frameMs: 20, hangMs: 100, minSpeechMs: 240, seedFloor: true });
for (let i = 0; i < 100; i++) vadF.pushRms(0.05);
check('vad-followup-ignores-noise', !vadF.hasSpeech());
// …but the user speaking OVER that noise (RMS 0.3 > 3x floor) still does.
for (let i = 0; i < 13; i++) vadF.pushRms(0.3); // 260ms of real speech
check('vad-followup-hears-speech-over-noise', vadF.hasSpeech());

// 9e. The first follow-up frame is not guaranteed to be ambient: a user can
//     begin speaking as soon as the prior response ends. That first speech frame
//     must not inflate the floor and discard the entire turn.
const vadImmediate = new A.VadEndpointer({ frameMs: 20, hangMs: 100, minSpeechMs: 240, seedFloor: true });
for (let i = 0; i < 12; i++) vadImmediate.pushRms(0.3);
check('vad-followup-hears-immediate-speech', vadImmediate.hasSpeech());

// 9f. A silent first frame must not make constant background noise qualify
//     before the adaptive floor has had time to rise.
const vadDelayedNoise = new A.VadEndpointer({ frameMs: 20, hangMs: 100, minSpeechMs: 240, seedFloor: true });
vadDelayedNoise.pushRms(0);
for (let i = 0; i < 100; i++) vadDelayedNoise.pushRms(0.05);
check('vad-followup-ignores-noise-after-silence', !vadDelayedNoise.hasSpeech());

// 9g. collapseRepeats: whisper repetition loops collapse to one phrase; normal
//     sentences (incl. internal repeats) pass through untouched.
const C = A.collapseRepeats;
check('rep-triple', C("what's the weather what's the weather what's the weather") === "what's the weather", `got "${C("what's the weather what's the weather what's the weather")}"`);
check('rep-punct-case', C("What's the weather? what's the weather. What's the weather") === "What's the weather?", `got "${C("What's the weather? what's the weather. What's the weather")}"`);
check('rep-normal-sentence', C('is it going to rain today or tomorrow') === 'is it going to rain today or tomorrow');
check('rep-internal-repeat-kept', C('that is very very good news today') === 'that is very very good news today');
check('rep-short-kept', C('no no no') === 'no no no');
check('rep-partial-tail-kept', C('set a timer set a timer set a') === 'set a timer set a timer set a');
check('rep-emphatic-no-kept', C('no no no no') === 'no no no no');
check('rep-emphatic-yes-kept', C('yes yes yes yes') === 'yes yes yes yes');
check('rep-two-part-kept', C('one two one two') === 'one two one two');
check('rep-single-token-loop-kept', C('you you you you you you') === 'you you you you you you');
check('rep-empty', C('') === '' && C(null) === '');

// 9h. Silent follow-up discard state is turn-correlated. If follow-up A is
// superseded before its stale result arrives, beginning B must clear A's discard
// marker so B's valid transcription is never treated as "the next result to drop".
const discardGate = new A.SttDiscardGate();
discardGate.begin('turn-a');
discardGate.markDiscard('turn-a');
discardGate.begin('turn-b');
check('discard-stale-followup-does-not-drop-next-turn', discardGate.consume('turn-b') === false);
check('discard-old-turn-cleared-on-new-begin', discardGate.consume('turn-a') === false);
discardGate.markDiscard('turn-b');
check('discard-matching-silent-turn-once', discardGate.consume('turn-b') === true && discardGate.consume('turn-b') === false);

// 10. sanitizeForSpeech: strips markup/links/emoji but keeps the words so the
//     voice never reads "asterisk" or spells out a URL.
const S = A.sanitizeForSpeech;
check('san-bold', S('This is **really** important') === 'This is really important', `got "${S('This is **really** important')}"`);
check('san-italic-underscore', S('a _word_ here') === 'a word here', `got "${S('a _word_ here')}"`);
check('san-inline-code', S('run `npm test` now') === 'run npm test now', `got "${S('run `npm test` now')}"`);
check('san-bare-url', S('see https://example.com/x?y=1 for more') === 'see link for more', `got "${S('see https://example.com/x?y=1 for more')}"`);
check('san-md-link', S('click [the docs](https://x.io) please') === 'click the docs please', `got "${S('click [the docs](https://x.io) please')}"`);
check('san-heading-bullets', S('# Title\n- one\n- two') === 'Title one two', `got "${S('# Title\n- one\n- two')}"`);
const fenced = 'Here:\n```\nx=1\n```\ndone';
check('san-code-fence', S(fenced) === 'Here: done', `got "${S(fenced)}"`);
check('san-emoji', S('great job 🎉🔥 done') === 'great job done', `got "${S('great job 🎉🔥 done')}"`);
check('san-keeps-punct', S('Wait — is it 3.5 or 4? Yes!') === 'Wait — is it 3.5 or 4? Yes!', `got "${S('Wait — is it 3.5 or 4? Yes!')}"`);
check('san-url-only-empty', S('https://only-a-link.com').trim() === 'link', `got "${S('https://only-a-link.com')}"`);
check('san-stars-only-empty', S('***').trim() === '', `got "${S('***')}"`);
check('san-empty', S('') === '' && S(null) === '' && S(undefined) === '');

// 11. Word filter regression: stray carets and shell-style symbols used to make
//     the TTS read "A circumflex" or "circumflex accent" out loud. They must be
//     dropped (not translated to the symbol's spoken name).
check('san-caret', !/\bcircumflex\b/i.test(S('press Ctrl+^ to toggle')), `got "${S('press Ctrl+^ to toggle')}"`);
check('san-trailing-ctrl-plus', !/\b(ctrl|control)\s+plus\b/i.test(S('the chord Ctrl+^')), `got "${S('the chord Ctrl+^')}"`);
check('san-math', !/[±×÷≈]/.test(S('value ± 5%')), `got "${S('value ± 5%')}"`);
check('san-degree', !/\bdegree\b/i.test(S('heat to 90°')), `got "${S('heat to 90°')}"`);
check('san-section', !/\bsection\b/i.test(S('see § 4.2 for details')), `got "${S('see § 4.2 for details')}"`);
check('san-keeps-unicode-words', S('café déjà vu') === 'café déjà vu', `got "${S('café déjà vu')}"`);

// 12. Symbol-name phrase strip: the LLM sometimes explains a stray character
//     ("a circumflex", "called a caret", "the tilde means"). The voice should
//     not read those explanations. The strip has TWO layers:
//       (a) ALWAYS-STRIP — words that NEVER appear in normal English (the
//           "A circumflex" reported bug). Unconditional strip.
//       (b) CONTEXT-STRIP — words that are common English but also have a
//           symbol meaning. Only stripped in definitional context.
check('san-defn-circumflex', !/\bcircumflex\b/i.test(S('that symbol, called a circumflex, marks a vowel')), `got "${S('that symbol, called a circumflex, marks a vowel')}"`);
check('san-defn-caret', !/\bcaret\b/i.test(S('the symbol, known as caret, points up')), `got "${S('the symbol, known as caret, points up')}"`);
check('san-defn-tilde', !/\btilde\b/i.test(S('a tilde means "approximately"')), `got "${S('a tilde means \"approximately\"')}"`);
check('san-defn-backtick-caret', !/\bcaret\b/i.test(S('use `(caret)` for the cursor')), `got "${S('use \`(caret)\` for the cursor')}"`);
// Layer (a): always-strip — "A circumflex" is THE reported bug. These words
// are NEVER in normal English, so unconditional stripping is safe.
check('san-always-circumflex', !/\bcircumflex\b/i.test(S('a circumflex is the answer')), `got "${S('a circumflex is the answer')}"`);
check('san-always-the-circumflex', !/\bcircumflex\b/i.test(S('the circumflex is above')), `got "${S('the circumflex is above')}"`);
check('san-always-umlaut', !/\bumlaut\b/i.test(S('an umlaut appears on the vowel')), `got "${S('an umlaut appears on the vowel')}"`);
check('san-always-cedilla', !/\bcedilla\b/i.test(S('the cedilla is under the c')), `got "${S('the cedilla is under the c')}"`);
check('san-always-macron', !/\bmacron\b/i.test(S('a macron is over the letter')), `got "${S('a macron is over the letter')}"`);
check('san-always-dieresis', !/\bdiaeresis\b/i.test(S('a diaeresis goes on the second vowel')), `got "${S('a diaeresis goes on the second vowel')}"`);
// Negative cases: common English must survive.
check('san-keeps-ring', S('give me a ring when you arrive') === 'give me a ring when you arrive', `got "${S('give me a ring when you arrive')}"`);
check('san-keeps-stroke', S('he had a stroke yesterday') === 'he had a stroke yesterday', `got "${S('he had a stroke yesterday')}"`);
check('san-keeps-pipe-down', S('pipe down please') === 'pipe down please', `got "${S('pipe down please')}"`);
check('san-keeps-hash-browns', S('the hash browns are ready') === 'the hash browns are ready', `got "${S('the hash browns are ready')}"`);
check('san-keeps-grave-concern', S('I have grave concerns') === 'I have grave concerns', `got "${S('I have grave concerns')}"`);
check('san-keeps-acute-pain', S('an acute pain in her side') === 'an acute pain in her side', `got "${S('an acute pain in her side')}"`);
check('san-keeps-ring-fire', S('the ring of fire is beautiful') === 'the ring of fire is beautiful', `got "${S('the ring of fire is beautiful')}"`);
// Context-stripped words in NON-definitional use must survive (the LLM might
// genuinely use "caret" in a sentence without it being a definition). Here
// "caret" is part of the user's actual ask and should be kept.
check('san-keeps-caret-standalone', /\bcaret\b/i.test(S('put the caret at the end of the line')), `got "${S('put the caret at the end of the line')}"`);

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
