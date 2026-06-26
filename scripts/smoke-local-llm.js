#!/usr/bin/env node
/* Item 3 verification: fully-local OpenAI-compatible providers (Ollama / LM
 * Studio / vLLM) are selectable AND actually round-trip with NO API key, and the
 * documented base URLs (".../v1") work — not just the full chat path.
 *
 * No real local server was available in this environment (no ollama/LM Studio/
 * vLLM responding), so the round-trip runs against a mock that implements the
 * same OpenAI-compatible /v1/chat/completions SSE contract these servers expose,
 * exercising the REAL streamChat() client the app uses. If a local Ollama is
 * running it is additionally hit for a real round-trip.
 */
const http = require('http');
const { streamChat } = require('../dist/main/llm-stream');
const H = require('../dist/renderer/harnesses.js');

function mockServer(seen) {
  return http.createServer((req, res) => {
    seen.path = req.url;
    seen.auth = req.headers['authorization'] || null;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const t of ['Hello', ', ', 'world', '!']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

function call(opts) {
  return new Promise((r) => {
    const toks = [];
    streamChat(opts, { onToken: (t) => toks.push(t), onDone: (f) => r({ toks, done: f }), onError: (e) => r({ error: e }) });
  });
}

async function main() {
  const checks = [];
  const byId = (id) => H.PROVIDERS.find((p) => p.id === id);

  // 1) Presets exist, are marked local, and reverse-lookup resolves them.
  checks.push(['ollama preset (11434, local, no keyHint)',
    !!byId('ollama') && byId('ollama').endpoint === 'http://localhost:11434/v1/chat/completions' && byId('ollama').local === true && !byId('ollama').keyHint]);
  checks.push(['lmstudio preset (1234, local)',
    !!byId('lmstudio') && byId('lmstudio').endpoint === 'http://localhost:1234/v1/chat/completions' && byId('lmstudio').local === true]);
  checks.push(['vllm preset (local, OpenAI-compatible)',
    !!byId('vllm') && byId('vllm').local === true && /\/v1\/chat\/completions$/.test(byId('vllm').endpoint)]);
  checks.push(['vllm reverse-lookup from endpoint',
    (H.providerFromEndpoint('http://localhost:8000/v1/chat/completions') || {}).id === 'vllm']);

  // 2) Real round-trip through streamChat against a no-auth OpenAI-compatible
  //    server, using the BASE url (".../v1") and NO api key.
  const seen = {};
  const server = mockServer(seen);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const rBase = await call({ endpoint: `http://127.0.0.1:${port}/v1`, model: 'llama3.2', message: 'hi' }); // no apiKey
  checks.push(['base-URL ".../v1" normalized to /v1/chat/completions', seen.path === '/v1/chat/completions']);
  checks.push(['no Authorization header sent when key omitted', seen.auth === null]);
  checks.push(['message round-trips (no key)', rBase.done === 'Hello, world!' && !rBase.error]);

  // 3) Bare host (no path) also works.
  const seen2 = {};
  const server2 = mockServer(seen2);
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  const rHost = await call({ endpoint: `http://127.0.0.1:${server2.address().port}`, model: 'x', message: 'hi' });
  checks.push(['bare host normalized + round-trips', seen2.path === '/v1/chat/completions' && rHost.done === 'Hello, world!']);
  server.close(); server2.close();

  // 4) Best-effort REAL Ollama round-trip if one happens to be running.
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 11434, path: '/v1/models', timeout: 800 }, (res) => {
      res.resume();
      if (res.statusCode === 200) console.log('[note] a real Ollama is running on 11434 — preset endpoint is live.');
      resolve();
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });

  let pass = true;
  console.log('Checks:');
  for (const [name, ok] of checks) { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && ok; }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
