#!/usr/bin/env node
/* Item 5 measurement: where does the direct-LLM response delay actually go?
 *
 * Uses the real streamChat() client against mocks to measure the boundaries
 * Item 5 calls out (request construction -> first token -> completion), plus two
 * things only a real provider would expose: connection reuse and proxy buffering.
 *
 * Findings are printed AND asserted so this doubles as a regression guard.
 */
const http = require('http');
const { streamChat } = require('../dist/main/llm-stream');

function call(opts, onFirstTok) {
  const t0 = Date.now();
  let tFirst = null;
  return new Promise((r) => {
    streamChat(opts, {
      onToken: () => { if (tFirst === null) { tFirst = Date.now(); if (onFirstTok) onFirstTok(); } },
      onDone: (full) => r({ ttft: (tFirst || Date.now()) - t0, total: Date.now() - t0, full }),
      onError: (e) => r({ error: e }),
    });
  });
}

// Mock 1: realistic streaming provider (tunable TTFT + inter-token gap).
function streamingServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const ttft = Number(u.searchParams.get('ttft') || 60);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const toks = 'The answer to your question is right here streaming in.'.split(' ');
    let i = 0;
    const send = () => {
      if (i < toks.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: toks[i] + ' ' } }] })}\n\n`); i++; setTimeout(send, 15); }
      else { res.write('data: [DONE]\n\n'); res.end(); }
    };
    setTimeout(send, ttft);
  });
}

// Mock 2: a proxy that ONLY streams incrementally when the client advertises
// SSE via `Accept: text/event-stream`. Otherwise it buffers the full reply and
// flushes it all at the end — the silent streaming->batch degradation.
function bufferingProxy() {
  return http.createServer((req, res) => {
    const wantsSse = (req.headers['accept'] || '').includes('text/event-stream');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const toks = 'one two three four five six seven eight nine ten'.split(' ');
    if (wantsSse) {
      let i = 0;
      const send = () => { if (i < toks.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: toks[i] + ' ' } }] })}\n\n`); i++; setTimeout(send, 30); } else { res.write('data: [DONE]\n\n'); res.end(); } };
      setTimeout(send, 20);
    } else {
      // Buffer: wait the whole generation, then dump everything at once.
      setTimeout(() => {
        for (const t of toks) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t + ' ' } }] })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();
      }, toks.length * 30 + 20);
    }
  });
}

async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; }

async function main() {
  const checks = [];

  // (A) Stage breakdown vs a realistic streaming provider.
  const s1 = streamingServer();
  const p1 = await listen(s1);
  console.log('=== (A) direct-LLM stage breakdown (streamChat) ===');
  for (const ttft of [60, 350]) {
    const r = await call({ endpoint: `http://127.0.0.1:${p1}/v1/chat/completions?ttft=${ttft}`, model: 'm', message: 'hi' });
    console.log(`  mock TTFT ${ttft}ms -> req->first-token ${r.ttft}ms, first-token->done ${r.total - r.ttft}ms, total ${r.total}ms`);
  }
  // first token must arrive ~TTFT, well before completion (proves streaming, not buffering)
  const rStream = await call({ endpoint: `http://127.0.0.1:${p1}/v1/chat/completions?ttft=60`, model: 'm', message: 'hi' });
  checks.push(['streams: first token arrives well before completion', rStream.ttft < rStream.total - 50]);

  // (B) Connection + handshake reuse across turns (no per-turn handshake).
  let conns = 0;
  s1.on('connection', () => conns++);
  conns = 0;
  for (let i = 0; i < 5; i++) await call({ endpoint: `http://127.0.0.1:${p1}/v1/chat/completions?ttft=10`, model: 'm', message: 'hi' });
  console.log(`\n=== (B) connection reuse: 5 sequential turns opened ${conns} TCP connection(s) ===`);
  checks.push(['connections reused across turns (<=1 new for 5 turns)', conns <= 1]);
  s1.close();

  // (C) Buffering-proxy before/after: the Accept header is what keeps streaming
  //     from degrading into a wait-for-everything batch.
  const s2 = bufferingProxy();
  const p2 = await listen(s2);
  const ep2 = `http://127.0.0.1:${p2}/v1/chat/completions`;
  // "after" = streamChat (now sends Accept: text/event-stream)
  const after = await call({ endpoint: ep2, model: 'm', message: 'hi' });
  // "before" = same server but request WITHOUT the Accept header (raw), to show
  //            the degradation the header prevents.
  const before = await new Promise((resolve) => {
    const t0 = Date.now(); let tFirst = null;
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const req = http.request({ host: '127.0.0.1', port: p2, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.on('data', (c) => { if (tFirst === null && /data:/.test(c.toString())) tFirst = Date.now(); });
      res.on('end', () => resolve({ ttft: (tFirst || Date.now()) - t0, total: Date.now() - t0 }));
    });
    req.end(body);
  });
  console.log('\n=== (C) buffering proxy: Accept: text/event-stream before/after ===');
  console.log(`  before (no Accept header): first token at ${before.ttft}ms of ${before.total}ms total (buffered to the end)`);
  console.log(`  after  (streamChat sends Accept): first token at ${after.ttft}ms of ${after.total}ms total`);
  checks.push(['Accept header makes first token arrive early (not buffered)', after.ttft < after.total / 2]);
  checks.push(['without header the proxy buffers to the end (confirms the cause)', before.ttft >= before.total - 30]);
  s2.close();

  let pass = true;
  console.log('\nChecks:');
  for (const [name, ok] of checks) { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && ok; }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
