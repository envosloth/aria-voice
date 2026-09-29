#!/usr/bin/env node
/* Real-sidecar smoke for speculative early endpointing.
 *
 * Streams a known utterance into the real STT sidecar (warm whisper-server),
 * requests a speculative transcript the way the renderer does after ~300ms of
 * pause, then appends silence and requests the final. Passes when:
 *   - the speculation returns the utterance's words as a correlated stt_partial;
 *   - the final over a silent tail reuses it (reused=true, ~0ms);
 *   - and the modelled end-of-speech -> final-text latency with the early
 *     endpoint beats the fixed-hang baseline by at least 300ms.
 *
 * Audio: $TMPDIR/stt_test_16k.wav from scripts/gen-test-audio.sh.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Supervisor } = require('../dist/main/supervisor');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readPcm(wavPath) {
  const buf = fs.readFileSync(wavPath);
  let offset = 12;
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size;
  }
  return buf.subarray(44);
}

const HANG_MS = 850;       // HANDSFREE_ENDPOINT_OPTS.hangMs
const SPEC_AFTER_MS = 300; // SPECULATIVE_ENDPOINT_OPTS.speculateAfterMs
const EARLY_HANG_MS = 500; // SPECULATIVE_ENDPOINT_OPTS.earlyHangMs

async function main() {
  const wavPath = path.join(os.tmpdir(), 'stt_test_16k.wav');
  if (!fs.existsSync(wavPath)) { console.log('FAIL: test audio missing; run scripts/gen-test-audio.sh'); process.exit(1); }
  const speech = readPcm(wavPath);
  const silence = (ms) => Buffer.alloc(Math.round(ms * 32) & ~1);

  let ready = false;
  const inbox = [];
  const sup = new Supervisor(
    (name, status) => { if (status === 'ready') ready = true; },
    (_name, msg) => inbox.push({ ...msg, at: performance.now() }),
  );
  sup.startMonitoring();
  await sup.start('stt');
  for (let i = 0; i < 100 && !ready; i++) await sleep(200);
  if (!ready) { console.log('FAIL: STT never ready'); await sup.stopAll(); process.exit(1); }

  const waitFor = async (pred, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = inbox.find(pred); if (m) return m; await sleep(5); }
    return null;
  };
  const stream = (buf) => { for (let o = 0; o < buf.length; o += 8192) sup.sendPcm('stt', buf.subarray(o, Math.min(o + 8192, buf.length))); };

  // Warm-up turn so the first measured inference is not a cold GPU/CPU pass.
  const runTurn = async (id, mode) => {
    inbox.length = 0;
    sup.sendToSidecar('stt', { type: 'start', utterance_id: id });
    if (!await waitFor((m) => m.type === 'stt_started' && m.utterance_id === id)) return null;
    const pause = silence(SPEC_AFTER_MS);
    stream(speech); stream(pause);
    let partial = null; let specMs = 0;
    let sent = speech.length + pause.length;
    if (mode === 'spec') {
      const t = performance.now();
      sup.sendToSidecar('stt', { type: 'speculate', utterance_id: id, audio_bytes: sent });
      partial = await waitFor((m) => m.type === 'stt_partial' && m.utterance_id === id);
      specMs = partial ? partial.at - t : -1;
    }
    const tail = silence((mode === 'spec' ? EARLY_HANG_MS : HANG_MS) - SPEC_AFTER_MS);
    stream(tail); sent += tail.length;
    const t0 = performance.now();
    sup.sendToSidecar('stt', { type: 'transcribe', utterance_id: id, audio_bytes: sent });
    const result = await waitFor((m) => m.type === 'stt_result' && m.utterance_id === id);
    return { partial, specMs, result, finalMs: result ? result.at - t0 : -1 };
  };

  await runTurn('warm', 'base');
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const base = await runTurn(`base-${i}`, 'base');
    const spec = await runTurn(`spec-${i}`, 'spec');
    samples.push({ base, spec });
  }
  await sup.stopAll();
  await sleep(500);

  let pass = true;
  const check = (name, cond, detail) => { if (!cond) pass = false; console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`); };
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const s0 = samples[0].spec;
  const words = (t) => (t || '').toLowerCase();
  check('speculation-returns-words', !!s0.partial && /test/.test(words(s0.partial.text)), JSON.stringify(s0.partial && s0.partial.text));
  check('final-reuses-speculation', samples.every((s) => s.spec.result && s.spec.result.reused === true),
    samples.map((s) => s.spec.result && s.spec.result.transcribe_ms).join(','));
  check('reused-text-matches-baseline', samples.every((s) => s.spec.result && s.base.result
    && words(s.spec.result.text) === words(s.base.result.text)));

  // End-of-speech -> final text. Baseline waits the full hang then transcribes.
  // Speculative waits the early hang; its speculation ran inside that window,
  // so it only adds latency if whisper was slower than the remaining pause.
  const baseLat = median(samples.map((s) => HANG_MS + s.base.finalMs));
  const specLat = median(samples.map((s) => Math.max(EARLY_HANG_MS, SPEC_AFTER_MS + s.spec.specMs) + s.spec.finalMs));
  console.log(`  whisper per-pass median: ${median(samples.map((s) => s.base.finalMs)).toFixed(0)}ms; speculation median: ${median(samples.map((s) => s.spec.specMs)).toFixed(0)}ms`);
  console.log(`  end-of-speech -> final text: baseline ${baseLat.toFixed(0)}ms, speculative ${specLat.toFixed(0)}ms (saved ${(baseLat - specLat).toFixed(0)}ms)`);
  check('speculative-saves-300ms', baseLat - specLat >= 300);

  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
