#!/usr/bin/env node
/* Functional smoke test for the STT sidecar: feed known 16kHz mono PCM speech
 * over the UDS control channel and verify the transcription comes back over
 * stdout JSON with the expected words.
 *
 * Audio is pre-generated at /tmp/stt_test_16k.wav (Piper TTS of a known phrase,
 * resampled to 16kHz). Run scripts that create it before this test.
 */

const fs = require('fs');
const { Supervisor } = require('../dist/main/supervisor');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Strip the 44-byte WAV header to get raw PCM s16le
function readPcm(wavPath) {
  const buf = fs.readFileSync(wavPath);
  // Find 'data' chunk
  let offset = 12;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return buf.subarray(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize;
  }
  return buf.subarray(44); // fallback
}

async function main() {
  const wavPath = '/tmp/stt_test_16k.wav';
  if (!fs.existsSync(wavPath)) {
    console.log('FAIL: test audio not found at', wavPath);
    process.exit(1);
  }

  const pcm = readPcm(wavPath);
  console.log(`Loaded PCM: ${pcm.length} bytes (${(pcm.length / 32000).toFixed(2)}s @ 16kHz)`);

  let result = null;
  let ready = false;

  const sup = new Supervisor(
    (name, status, detail) => {
      console.log(`[${name}] ${status}${detail ? ': ' + detail.slice(0, 70) : ''}`);
      if (status === 'ready') ready = true;
    },
    (name, msg) => {
      if (msg.type === 'stt_result') {
        result = msg.text;
        console.log(`  <- stt_result: "${msg.text}"`);
      }
    },
  );
  sup.startMonitoring();

  console.log('\n=== Starting STT sidecar ===');
  await sup.start('stt');
  for (let i = 0; i < 50 && !ready; i++) await sleep(200);
  if (!ready) { console.log('FAIL: never ready'); await sup.stopAll(); process.exit(1); }

  console.log('\n=== Streaming PCM over socket, then transcribe control over stdin ===');
  const t0 = Date.now();
  // Stream PCM in chunks over the socket (simulating mic capture)
  const CHUNK = 8192;
  for (let off = 0; off < pcm.length; off += CHUNK) {
    sup.sendPcm('stt', pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
  }
  await sleep(100); // let socket drain
  sup.sendToSidecar('stt', { type: 'transcribe' });

  for (let i = 0; i < 150 && result === null; i++) await sleep(100);
  const elapsed = Date.now() - t0;

  console.log('\n=== Results ===');
  console.log(`  transcription: "${result}"`);
  console.log(`  elapsed: ${elapsed}ms`);

  await sup.stopAll();
  await sleep(1000);

  // Pass: transcription contains the numbers 1-5 (whisper may emit digits or words)
  const text = (result || '').toLowerCase();
  const expected = [
    ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ];
  const found = expected.filter(([w, d]) => text.includes(w) || text.includes(d));
  const labels = found.map(([w]) => w);
  console.log(`  expected numbers found: ${found.length}/${expected.length} [${labels.join(', ')}]`);
  const hasTesting = text.includes('testing') || text.includes('test');
  console.log(`  contains "testing": ${hasTesting}`);

  const pass = result !== null && found.length >= 3 && hasTesting;
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
