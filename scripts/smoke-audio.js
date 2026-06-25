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

// 9. VadEndpointer: fires only once
const vad3 = new A.VadEndpointer({ threshold: 0.1, hangMs: 40, frameMs: 20 });
vad3.pushRms(0.5);
let fires = 0;
for (let i = 0; i < 10; i++) if (vad3.pushRms(0)) fires++;
check('vad-fires-once', fires === 1, `fired ${fires} times`);

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
