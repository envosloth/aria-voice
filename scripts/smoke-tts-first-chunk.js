#!/usr/bin/env node
/* Real-sidecar measurement for the first-chunk phrase split (BACKLOG P-TTFA).
 *
 * A long comma-less opening sentence used to be synthesized whole before any
 * audio played. nextTtsCut now cuts it at a phrase boundary. This smoke feeds
 * both first chunks to the real TTS sidecar and compares time-to-first-PCM.
 * Pass: the phrase-split first chunk is what nextTtsCut chooses, and its median
 * time-to-first-audio is at least 20% lower than the whole-sentence chunk.
 * Engine follows ARIA_TTS_ENGINE (default = configured default, kokoro).
 */
const path = require('path');
const { Supervisor } = require('../dist/main/supervisor');
const A = require(path.join(__dirname, '..', 'src', 'renderer', 'audio-utils.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SENTENCE = 'The weather in Longmont today is mostly sunny with a high of seventy two and a light breeze from the west this afternoon.';

async function main() {
  // Replay the reply as the LLM streams it (word by word): the first cut the
  // renderer would take is the phrase boundary, before the period ever arrives.
  let phrase = null;
  const words = SENTENCE.split(' ');
  for (let i = 1; i <= words.length && phrase === null; i++) {
    const buf = words.slice(0, i).join(' ') + (i < words.length ? ' ' : '');
    const cut = A.nextTtsCut(buf, true);
    if (cut > 0) phrase = buf.slice(0, cut).trim();
  }
  let ready = false;
  const inbox = [];
  const sup = new Supervisor((_n, status) => { if (status === 'ready') ready = true; },
    (_n, msg) => inbox.push({ ...msg, at: performance.now() }));
  sup.startMonitoring();
  await sup.start('tts');
  for (let i = 0; i < 150 && !ready; i++) await sleep(200);
  if (!ready) { console.log('FAIL: TTS never ready'); await sup.stopAll(); process.exit(1); }

  const firstAudio = async (text) => {
    inbox.length = 0;
    const t0 = performance.now();
    sup.sendToSidecar('tts', { type: 'synthesize', text });
    const end = Date.now() + 20000;
    let first = null;
    while (Date.now() < end) {
      first = first || inbox.find((m) => m.type === 'tts_chunk');
      if (inbox.find((m) => m.type === 'tts_done')) break;
      await sleep(2);
    }
    return first ? first.at - t0 : Infinity;
  };
  await firstAudio('Warm up.');
  const whole = []; const split = [];
  for (let i = 0; i < 5; i++) { whole.push(await firstAudio(SENTENCE)); split.push(await firstAudio(phrase)); }
  await sup.stopAll();
  const med = (xs) => xs.slice().sort((a, b) => a - b)[2];
  let pass = true;
  const check = (n, c, d) => { if (!c) pass = false; console.log(`[${n}] ${c ? 'PASS' : 'FAIL'}${d ? ' — ' + d : ''}`); };
  check('chunker-picks-phrase', phrase === 'The weather in Longmont today is mostly sunny', JSON.stringify(phrase));
  console.log(`  whole-sentence first audio: ${whole.map((x) => x.toFixed(0)).join(', ')} ms`);
  console.log(`  phrase-split   first audio: ${split.map((x) => x.toFixed(0)).join(', ')} ms`);
  console.log(`  median ${med(whole).toFixed(0)} -> ${med(split).toFixed(0)} ms (saved ${(med(whole) - med(split)).toFixed(0)} ms)`);
  check('phrase-split-faster', med(split) <= med(whole) * 0.8);
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
