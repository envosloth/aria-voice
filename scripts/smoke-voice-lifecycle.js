#!/usr/bin/env node
/* Focused correlation tests for concurrent LLM and streaming TTS lifecycles. */

const { LlmGenerationGate, TtsAudioGate } = require('../dist/main/voice-lifecycle');
const { Supervisor } = require('../dist/main/supervisor');

let pass = true;
function check(name, condition, detail) {
  if (!condition) pass = false;
  console.log(`[${name}] ${condition ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}

// A new LLM request supersedes the old one, while a stale cancel must never
// invalidate the current generation that happens to reuse the same renderer.
const llm = new LlmGenerationGate();
const one = llm.begin('turn-1', 1);
const two = llm.begin('turn-2', 2);
check('llm-new-generation-supersedes-old', !llm.isCurrent(one) && llm.isCurrent(two));
llm.cancel(one);
check('llm-stale-cancel-does-not-cancel-current', llm.isCurrent(two));
llm.cancel(two);
check('llm-current-cancel-invalidates-generation', !llm.isCurrent(two));

// PCM is a byte stream, so stdout metadata is retained until exactly its
// announced byte count is available. The renderer must see one atomic packet,
// never metadata from one chunk paired with bytes from another.
const audio = new TtsAudioGate();
audio.activate('reply-a', 1);
audio.announce({ replyId: 'reply-a', requestId: 'req-a', epoch: 1, size: 4, sampleRate: 22050 });
check('tts-holds-partial-announced-pcm', audio.push(Buffer.from([1, 2])).length === 0);
const packet = audio.push(Buffer.from([3, 4]));
check('tts-delivers-announced-pcm-atomically', packet.length === 1
  && packet[0].replyId === 'reply-a' && packet[0].requestId === 'req-a'
  && packet[0].sampleRate === 22050 && packet[0].pcm.equals(Buffer.from([1, 2, 3, 4])));

// Stdout metadata and socket PCM are independent transports. PCM can reach main
// first even though the sidecar flushed metadata before writing it.
audio.activate('reply-early', 2);
check('tts-buffers-pcm-before-announcement', audio.push(Buffer.from([20, 21])).length === 0);
const early = audio.announce({ replyId: 'reply-early', requestId: 'req-early', epoch: 2, size: 2, sampleRate: 22050 });
check('tts-delivers-pcm-after-late-announcement', early.length === 1 && early[0].pcm.equals(Buffer.from([20, 21])));

// Stop/new-play is an epoch barrier. Old metadata still consumes old socket
// bytes, but cannot leak audio into the active reply. A reply-done event is
// delayed until all of its announced PCM has been delivered.
audio.activate('reply-b', 2);
audio.announce({ replyId: 'reply-a', requestId: 'req-stale', epoch: 1, size: 2, sampleRate: 22050 });
check('tts-stale-bytes-consumed-not-delivered', audio.push(Buffer.from([5, 6])).length === 0);
audio.announce({ replyId: 'reply-b', requestId: 'req-b', epoch: 2, size: 2, sampleRate: 24000 });
audio.markReplyDone('reply-b', 2);
check('tts-reply-done-waits-for-announced-bytes', audio.takeReplyDone().length === 0);
const current = audio.push(Buffer.from([7, 8]));
check('tts-new-epoch-remains-aligned', current.length === 1 && current[0].pcm.equals(Buffer.from([7, 8])));
const replyDone = audio.takeReplyDone();
check('tts-reply-done-is-per-reply', replyDone.length === 1
  && replyDone[0].replyId === 'reply-b' && replyDone[0].epoch === 2);
audio.activate('reply-c', 3);
check('tts-unannounced-bytes-wait-for-metadata', audio.push(Buffer.from([9, 9])).length === 0);
audio.resetTransport();
audio.announce({ replyId: 'reply-c', requestId: 'req-c', epoch: 3, size: 2, sampleRate: 22050 });
const afterTail = audio.push(Buffer.from([10, 11]));
check('tts-transport-reset-prevents-stale-tail-poisoning', afterTail.length === 1 && afterTail[0].pcm.equals(Buffer.from([10, 11])));

// Readiness is a real contract: a missing or timed-out sidecar must reject so
// STT can send a correlated failure instead of silently buffering forever.
(async () => {
  const supervisor = new Supervisor(() => {});
  let rejected = false;
  try { await supervisor.waitForReady('stt', 1); } catch { rejected = true; }
  check('wait-for-ready-rejects-when-unready', rejected);

  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(2); });
