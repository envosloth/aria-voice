#!/usr/bin/env node
/* Unit test for the LLM SSE streamer (streamChat) against a local mock
 * OpenAI-compatible endpoint. Covers: token streaming + onDone aggregation,
 * non-2xx error surfacing, and connection failure.
 */

const http = require('http');
const { streamChat } = require('../dist/main/llm-stream');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Mock SSE server that streams a few tokens like OpenAI /chat/completions
function makeServer() {
  return http.createServer((req, res) => {
    if (req.url === '/error') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid api key' }));
      return;
    }

    // Streams OpenAI-style tool_calls: a tool's name arrives in its first delta,
    // then its argument fragments stream across later deltas, then content.
    if (req.url === '/tools') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'web_search', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"weather"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'open_url', arguments: '' } }] } }] },
        { choices: [{ delta: { content: 'The ' } }] },
        { choices: [{ delta: { content: 'weather is sunny.' } }] },
      ];
      let j = 0;
      const t2 = setInterval(() => {
        if (j < events.length) { res.write(`data: ${JSON.stringify(events[j])}\n\n`); j++; }
        else { res.write('data: [DONE]\n\n'); clearInterval(t2); res.end(); }
      }, 10);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const tokens = ['Hello', ', ', 'world', '!'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < tokens.length) {
        const chunk = { choices: [{ delta: { content: tokens[i] } }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        i++;
      } else {
        res.write('data: [DONE]\n\n');
        clearInterval(timer);
        res.end();
      }
    }, 10);
  });
}

function runCase(name, opts) {
  return new Promise((resolve) => {
    const tokens = [];
    const tools = [];
    let done = null;
    let error = null;
    streamChat(opts, {
      onToken: (t) => tokens.push(t),
      onTool: (info) => tools.push(info),
      onDone: (full) => { done = full; resolve({ name, tokens, tools, done, error }); },
      onError: (e) => { error = e; resolve({ name, tokens, tools, done, error }); },
    });
  });
}

async function main() {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  let pass = true;

  // Case 1: happy path streaming
  const c1 = await runCase('stream', { endpoint: `${base}/v1/chat/completions`, model: 'mock', message: 'hi' });
  const c1ok = c1.done === 'Hello, world!' && c1.tokens.length === 4 && !c1.error;
  console.log(`[stream]    tokens=${JSON.stringify(c1.tokens)} done="${c1.done}" -> ${c1ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c1ok;

  // Case 2: non-2xx error surfaced
  const c2 = await runCase('http-error', { endpoint: `${base}/error`, model: 'mock', message: 'hi' });
  const c2ok = !!c2.error && c2.error.includes('401');
  console.log(`[http-error] error="${c2.error}" -> ${c2ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c2ok;

  // Case 3: connection failure (dead port)
  const c3 = await runCase('conn-fail', { endpoint: 'http://127.0.0.1:1/v1', model: 'm', message: 'hi' });
  const c3ok = !!c3.error && c3.error.toLowerCase().includes('connection failed');
  console.log(`[conn-fail]  error="${c3.error}" -> ${c3ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c3ok;

  // Case 4: empty endpoint
  const c4 = await runCase('no-endpoint', { endpoint: '', model: 'm', message: 'hi' });
  const c4ok = !!c4.error && c4.error.includes('No LLM endpoint');
  console.log(`[no-endpoint] error="${c4.error}" -> ${c4ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c4ok;

  // Case 5: tool_calls surfaced once per distinct call, content still aggregates
  const c5 = await runCase('tools', { endpoint: `${base}/tools`, model: 'mock', message: 'weather?' });
  const names = c5.tools.map((t) => t.name);
  const c5ok = c5.done === 'The weather is sunny.' && names.length === 2 &&
    names[0] === 'web_search' && names[1] === 'open_url' && !c5.error;
  console.log(`[tools]     tools=${JSON.stringify(names)} done="${c5.done}" -> ${c5ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c5ok;

  server.close();
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
