#!/usr/bin/env node
/* End-to-end integration test: chains the real STT and TTS sidecars with a mock
 * LLM through the supervisor, exercising the full local voice loop and measuring
 * the spec's §7 latency budget (local stages broken out from the LLM segment).
 *
 *   speech PCM --(socket)--> STT --(text)--> mock LLM --(SSE)--> TTS --(PCM)
 *
 * Reports STT, LLM, and TTS-first-chunk timings separately, per the spec's
 * two-SLO recommendation (local pipeline vs. remote LLM).
 */

const fs = require('fs');
const http = require('http');
const { Supervisor } = require('../dist/main/supervisor');
const { streamChat } = require('../dist/main/llm-stream');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

// Mock LLM that echoes a canned reply as SSE tokens
function makeLlmServer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const reply = 'I heard you say the test numbers. All systems are working correctly.';
    const words = reply.split(' ');
    let i = 0;
    const timer = setInterval(() => {
      if (i < words.length) {
        const tok = (i === 0 ? '' : ' ') + words[i];
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tok } }] })}\n\n`);
        i++;
      } else {
        res.write('data: [DONE]\n\n');
        clearInterval(timer);
        res.end();
      }
    }, 8);
  });
}

async function main() {
  const wavPath = '/tmp/stt_test_16k.wav';
  if (!fs.existsSync(wavPath)) { console.log('FAIL: run gen-test-audio.sh first'); process.exit(1); }
  const pcm = readPcm(wavPath);

  const llmServer = makeLlmServer();
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
  const llmPort = llmServer.address().port;

  const ready = new Set();
  let transcription = null;
  let utteranceStarted = false;
  const utteranceId = 'smoke-e2e-1';
  let ttsChunks = 0;
  let ttsBytes = 0;
  let ttsFirstChunkAt = 0;
  let ttsDone = false;

  const sup = new Supervisor(
    (name, status) => { if (status === 'ready') ready.add(name); },
    (name, msg) => {
      if (msg.type === 'stt_started' && msg.utterance_id === utteranceId) utteranceStarted = true;
      if (msg.type === 'stt_result') transcription = msg.text;
      if (msg.type === 'tts_chunk') {
        if (ttsChunks === 0) ttsFirstChunkAt = Date.now();
        ttsChunks++; ttsBytes += msg.size || 0;
      }
      if (msg.type === 'tts_done') ttsDone = true;
    },
  );
  sup.startMonitoring();

  console.log('=== Starting STT + TTS sidecars ===');
  await sup.start('stt');
  await sup.start('tts');
  for (let i = 0; i < 60 && ready.size < 2; i++) await sleep(200);
  if (ready.size < 2) { console.log('FAIL: sidecars not ready'); await sup.stopAll(); process.exit(1); }

  // --- Stage 1: STT ---
  console.log('\n[1] STT: streaming speech PCM -> transcribe');
  const tStt = Date.now();
  sup.sendToSidecar('stt', { type: 'start', utterance_id: utteranceId });
  for (let i = 0; i < 50 && !utteranceStarted; i++) await sleep(20);
  if (!utteranceStarted) { console.log('FAIL: STT start was not acknowledged'); await sup.stopAll(); process.exit(1); }
  const CH = 8192;
  for (let o = 0; o < pcm.length; o += CH) sup.sendPcm('stt', pcm.subarray(o, Math.min(o + CH, pcm.length)));
  sup.sendToSidecar('stt', { type: 'transcribe', utterance_id: utteranceId, audio_bytes: pcm.length });
  for (let i = 0; i < 150 && transcription === null; i++) await sleep(50);
  const sttMs = Date.now() - tStt;
  console.log(`    -> "${transcription}" (${sttMs}ms)`);

  // --- Stage 2: LLM (mock, network segment) ---
  console.log('\n[2] LLM: transcription -> streamed reply (mock)');
  const tLlm = Date.now();
  let llmFirstTokenAt = 0;
  const llmReply = await new Promise((resolve) => {
    let full = '';
    streamChat(
      { endpoint: `http://127.0.0.1:${llmPort}/v1/chat/completions`, model: 'mock', message: transcription },
      {
        onToken: (t) => { if (!llmFirstTokenAt) llmFirstTokenAt = Date.now(); full += t; },
        onDone: (f) => resolve(f || full),
        onError: (e) => resolve(`[error: ${e}]`),
      },
    );
  });
  const llmFirstMs = llmFirstTokenAt - tLlm;
  const llmTotalMs = Date.now() - tLlm;
  console.log(`    -> "${llmReply}" (first token ${llmFirstMs}ms, total ${llmTotalMs}ms)`);

  // --- Stage 3: TTS ---
  console.log('\n[3] TTS: reply -> PCM audio');
  const tTts = Date.now();
  sup.sendToSidecar('tts', { type: 'synthesize', text: llmReply });
  for (let i = 0; i < 150 && !ttsDone; i++) await sleep(50);
  const ttsFirstMs = ttsFirstChunkAt - tTts;
  const ttsTotalMs = Date.now() - tTts;
  const audioSec = ttsBytes / (22050 * 2);
  console.log(`    -> ${ttsChunks} chunks, ${audioSec.toFixed(2)}s audio (first chunk ${ttsFirstMs}ms, total ${ttsTotalMs}ms)`);

  await sup.stopAll();
  llmServer.close();
  await sleep(800);

  // --- Latency summary (spec §7) ---
  // The budget is engine-aware: Kokoro (the default) is intentionally chosen for
  // markedly more natural, less-robotic speech, which costs ~0.5-0.8s to
  // synthesize the first sentence on CPU; Piper is faster but more robotic. The
  // user-perceived delay is far lower than this raw figure because the app now
  // streams audio sentence-by-sentence as the reply generates (incremental TTS),
  // overlapping synthesis with generation — this stage just bounds the worst-case
  // first-audio floor for the chosen engine.
  const ttsEngine = (process.env.ARIA_TTS_ENGINE || 'piper').toLowerCase();
  const LOCAL_BUDGET_MS = ttsEngine === 'piper' ? 900 : 1300;
  console.log('\n=== Latency (spec §7 budget) ===');
  const localFirstAudio = sttMs + ttsFirstMs; // local stages we control
  console.log(`  STT:                 ${sttMs}ms`);
  console.log(`  TTS first chunk:     ${ttsFirstMs}ms  (engine=${ttsEngine})`);
  console.log(`  LOCAL (STT+TTS-1st): ${localFirstAudio}ms  ${localFirstAudio < LOCAL_BUDGET_MS ? `(< ${LOCAL_BUDGET_MS}ms target OK)` : '(OVER budget)'}`);
  console.log(`  LLM first token:     ${llmFirstMs}ms  (remote, excluded from local SLO)`);

  const ok = transcription && /test/i.test(transcription) &&
             llmReply.includes('working') && ttsDone && ttsChunks > 0 &&
             localFirstAudio < LOCAL_BUDGET_MS;
  console.log(`\n=== RESULT: ${ok ? 'PASS' : 'FAIL'} ===`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
