#!/usr/bin/env node
/* Echo-aware barge-in on REAL speech (not synthetic envelopes).
 *
 * ARIA's voice = a Piper utterance. The "mic" = that audio passed through a
 * simulated room: 60 ms output latency, speaker→mic gain, and a 3-tap reverb.
 * The user = a different Piper utterance mixed in at a known time. Frames are
 * 20 ms, the same size the renderer's mic worklet posts.
 *
 * Pass: across speaker gains 0.3–1.2 the detector never fires on echo alone,
 * and fires within 400 ms of the user starting to talk over ARIA.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require(path.join(__dirname, '..', 'src', 'renderer', 'audio-utils.js'));

const ROOT = path.join(__dirname, '..');
const MODELS = process.env.ARIA_MODELS_DIR || path.join(os.homedir(), '.local/share/aria/models');
const PY = path.join(ROOT, 'sidecars/tts/venv/bin/python');
const voice = ['en_US-lessac-medium.onnx', 'en_GB-alan-medium.onnx'].map((v) => path.join(MODELS, v)).find(fs.existsSync);
if (!voice || !fs.existsSync(PY)) { console.log('SKIP-FAIL: Piper voice/venv missing'); process.exit(1); }

function synth(text, name) {
  const wav = path.join(os.tmpdir(), `barge_${name}.wav`);
  if (!fs.existsSync(wav)) execFileSync(PY, ['-m', 'piper', '-m', voice, '-f', wav], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
  const buf = fs.readFileSync(wav);
  let off = 12; let rate = 22050;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
    if (id === 'data') {
      const n = size / 2; const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return { samples: out, rate };
    }
    off += 8 + size;
  }
  throw new Error('bad wav');
}

const aria = synth('The weather in Longmont today is mostly sunny with a high of seventy two degrees and a light breeze from the west, so it is a good afternoon for a walk.', 'aria');
const user = synth('Wait, stop, what about tomorrow?', 'user');
const rate = aria.rate;
const frame = Math.round(rate * 0.02);
const rmsOf = (a, s, n) => { let t = 0; for (let i = s; i < s + n; i++) t += (a[i] || 0) * (a[i] || 0); return Math.sqrt(t / n); };

function run(gain, userAtSec, userGain) {
  const lat = Math.round(rate * 0.06);
  const taps = [[0, 1], [Math.round(rate * 0.023), 0.35], [Math.round(rate * 0.061), 0.15]];
  const len = aria.samples.length + rate;
  const mic = new Float32Array(len);
  let seed = 7; const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 0.004; };
  for (let i = 0; i < len; i++) {
    let e = 0;
    for (const [d, g] of taps) { const j = i - lat - d; if (j >= 0 && j < aria.samples.length) e += aria.samples[j] * g; }
    mic[i] = e * gain + noise();
  }
  const userStart = userAtSec == null ? -1 : Math.round(userAtSec * rate);
  if (userStart >= 0) for (let i = 0; i < user.samples.length && userStart + i < len; i++) mic[userStart + i] += user.samples[i] * userGain;
  // User speech onset = first 20ms frame where the user signal itself is audible.
  let onset = -1;
  if (userStart >= 0) for (let s = 0; s < user.samples.length; s += frame) if (rmsOf(user.samples, s, frame) * userGain > 0.02) { onset = userStart + s; break; }

  const det = new A.EchoAwareBargeDetector({ frameMs: 20 });
  for (let s = 0; s + frame <= aria.samples.length; s += frame) {
    const ref = rmsOf(aria.samples, s, frame); // what ARIA is emitting now (analyser)
    if (det.push(rmsOf(mic, s, frame), ref)) return { firedAt: s, onset };
  }
  return { firedAt: -1, onset };
}

let pass = true;
const check = (n, c, d) => { if (!c) pass = false; console.log(`[${n}] ${c ? 'PASS' : 'FAIL'}${d ? ' — ' + d : ''}`); };
// Measured envelope (energy-only detection; see STATE 2026-09-29): the user must
// reach the mic at >= ~1.6x (+4 dB) ARIA's echo level to interrupt within 400ms.
// Quieter interruptions are missed rather than risking self-interruption — the
// wake word still works for those. Echo alone must NEVER fire, at any gain.
for (const gain of [0.3, 0.6, 0.9, 1.2, 1.6]) {
  const echoOnly = run(gain, null, 0);
  check(`echo-only-gain-${gain}`, echoOnly.firedAt < 0, echoOnly.firedAt >= 0 ? `self-interrupt at ${(echoOnly.firedAt / rate).toFixed(2)}s` : 'no fire');
}
for (const [gain, ug] of [[0.3, 0.5], [0.3, 1.0], [0.6, 1.0], [0.6, 1.5], [0.9, 1.5]]) {
  for (const at of [2.5, 5.0]) {
    const r = run(gain, at, ug);
    const ms = r.firedAt >= 0 ? ((r.firedAt - r.onset) / rate) * 1000 : Infinity;
    check(`user-${ug}-over-echo-${gain}-at-${at}s`, r.firedAt >= r.onset && ms <= 400,
      r.firedAt < 0 ? 'missed' : r.firedAt < r.onset ? 'fired before user spoke' : `fired ${ms.toFixed(0)}ms after onset`);
  }
}
console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
