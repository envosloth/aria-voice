#!/usr/bin/env node
/* Functional smoke test for the TTS sidecar: send a synthesize request over
 * the UDS control channel and verify PCM audio streams back over the socket,
 * with stdout {type:tts_chunk} messages framing each chunk.
 */

const { Supervisor } = require('../dist/main/supervisor');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  let pcmBytes = 0;
  let chunkAnnounced = 0;
  let announcedBytes = 0;
  let done = false;
  let ready = false;

  const sup = new Supervisor(
    (name, status, detail) => {
      console.log(`[${name}] ${status}${detail ? ': ' + detail.slice(0, 70) : ''}`);
      if (status === 'ready') ready = true;
    },
    (name, msg) => {
      if (msg.type === 'tts_chunk') {
        chunkAnnounced++;
        announcedBytes += msg.size || 0;
        console.log(`  <- tts_chunk #${msg.index} size=${msg.size} sr=${msg.sample_rate}`);
      } else if (msg.type === 'tts_done') {
        done = true;
        console.log('  <- tts_done');
      }
    },
  );

  sup.onBinaryData((name, data) => { pcmBytes += data.length; });
  sup.startMonitoring();

  console.log('=== Starting TTS sidecar ===');
  await sup.start('tts');

  // Wait for ready
  for (let i = 0; i < 50 && !ready; i++) await sleep(200);
  if (!ready) { console.log('FAIL: never ready'); await sup.stopAll(); process.exit(1); }

  console.log('\n=== Sending synthesize request ===');
  const text = 'Hello from ARIA. This is a multi sentence test. The pipeline works.';
  const t0 = Date.now();
  sup.sendToSidecar('tts', { type: 'synthesize', text });

  // Wait for synthesis to complete
  for (let i = 0; i < 100 && !done; i++) await sleep(100);
  const elapsed = Date.now() - t0;

  console.log('\n=== Results ===');
  console.log(`  chunks announced (stdout): ${chunkAnnounced}`);
  console.log(`  bytes announced (stdout):  ${announcedBytes}`);
  console.log(`  PCM bytes received (UDS):  ${pcmBytes}`);
  console.log(`  tts_done received:         ${done}`);
  console.log(`  elapsed:                   ${elapsed}ms`);

  const audioSec = pcmBytes / (22050 * 2);
  console.log(`  audio duration:            ${audioSec.toFixed(2)}s`);

  await sup.stopAll();
  await sleep(1000);

  // Pass criteria: got PCM, byte counts roughly match, done fired
  const pass = done && pcmBytes > 0 && Math.abs(pcmBytes - announcedBytes) < 100;
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
