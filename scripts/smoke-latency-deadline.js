#!/usr/bin/env node
const assert = require('assert');
const { performance } = require('perf_hooks');
const { runLatencyTest, firstSpeakable } = require('../dist/main/latency-test');
const A = require('../src/renderer/audio-utils.js');
const prefix = 'A healthy daily routine provides lasting benefits ';
assert.strictEqual(firstSpeakable(prefix, 250), prefix.trim(), 'diagnostics must use the shipped first-chunk deadline');
for (const buf of [prefix, 'Hello there, it is lovely today.', 'Short answer.', 'Six little words must remain with ', 'The weather in Longmont today is mostly sunny with ']) {
  for (const elapsed of [0, 249, 250, 1000]) {
    const cut = A.nextTtsCut(buf, true, elapsed);
    assert.strictEqual(firstSpeakable(buf, elapsed), cut > 0 ? buf.slice(0, cut).trim() : null, 'diagnostic and playback cuts must agree');
  }
}
(async()=>{
  let replyRequested = 0, firstToken = 0;
  const r = await runLatencyTest({
    now: () => performance.now(),
    synthesize: async (text,id) => {
      const t = performance.now();
      if(id.endsWith(':reply')) { replyRequested=t;assert.strictEqual(text,prefix.trim()); }
      return {chunks:[Buffer.alloc(32000)],sampleRate:16000,requestedAt:t,firstChunkAt:t+1};
    },
    transcribe: async (pcm,id,onSent) => {onSent(performance.now());return 'test';},
    chat: async (text,onToken,signal) => {
      firstToken=performance.now();onToken(prefix);
      await new Promise(r=>setTimeout(r,650));
      assert.ok(!signal.aborted);
      return {target:'llm',text:prefix+'with enough detail.'};
    },
  },'deadline');
  assert.ok(r.ok,JSON.stringify(r));
  assert.ok(replyRequested-firstToken >= 230 && replyRequested-firstToken < 450,'synthesis must start during an SSE pause, not at EOF');
  console.log('PASS shared chunker and diagnostic deadline during stalled SSE');
})().catch(e=>{console.error(e);process.exitCode=1;});
