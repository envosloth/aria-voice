#!/usr/bin/env node
/* Unit test for the LLM SSE streamer (streamChat) against a local mock
 * OpenAI-compatible endpoint. Covers normal SSE aggregation plus terminal
 * failure modes that must settle exactly once.
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

    if (req.url === '/trailing') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // No final newline/event separator: a compliant client must still parse
      // the trailing record when the response ends.
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`);
      return;
    }

    if (req.url === '/abort') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Length': 1024 });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
      setTimeout(() => res.socket.destroy(), 10);
      return;
    }

    if (req.url === '/stall') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return;
    }

    if (req.url === '/dribble') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const timer = setInterval(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '.' } }] })}\n\n`);
      }, 5);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (req.url === '/large-response') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('x'.repeat(4096));
      return;
    }

    if (req.url === '/large-record') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${'x'.repeat(4096)}\n\n`);
      return;
    }

    if (req.url === '/long-completion') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(128) } }] })}\n\n`);
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

    // Streams tokens, then an include_usage-style final chunk (empty choices +
    // usage) before [DONE] — proves streamChat parses usage and fires onUsage.
    const withUsage = req.url === '/usage';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const tokens = ['Hello', ', ', 'world', '!'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < tokens.length) {
        const chunk = { choices: [{ delta: { content: tokens[i] } }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        i++;
      } else {
        if (withUsage) {
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\n`);
        }
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
    let usage = null;
    let terminalCalls = 0;
    streamChat(opts, {
      onToken: (t) => tokens.push(t),
      onTool: (info) => tools.push(info),
      onUsage: (u) => { usage = u; },
      onDone: (full) => { done = full; terminalCalls++; setTimeout(() => resolve({ name, tokens, tools, done, error, usage, terminalCalls }), 30); },
      onError: (e) => { error = e; terminalCalls++; setTimeout(() => resolve({ name, tokens, tools, done, error, usage, terminalCalls }), 30); },
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

  // Case 6: include_usage final chunk parsed and surfaced via onUsage
  const c6 = await runCase('usage', { endpoint: `${base}/usage`, model: 'mock', message: 'hi' });
  const c6ok = c6.done === 'Hello, world!' && c6.usage &&
    c6.usage.prompt === 12 && c6.usage.completion === 5 && c6.usage.total === 17;
  console.log(`[usage]     usage=${JSON.stringify(c6.usage)} -> ${c6ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c6ok;

  // Case 7: an SSE record without a final blank line still contributes text.
  const c7 = await runCase('trailing-record', { endpoint: `${base}/trailing`, model: 'mock', message: 'hi' });
  const c7ok = c7.done === 'tail' && c7.terminalCalls === 1;
  console.log(`[trailing]  done="${c7.done}" terminalCalls=${c7.terminalCalls} -> ${c7ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c7ok;

  // Case 8: a dropped response resolves through exactly one terminal error.
  const c8 = await runCase('aborted-response', { endpoint: `${base}/abort`, model: 'mock', message: 'hi', timeoutMs: 100 });
  const c8ok = !!c8.error && c8.terminalCalls === 1 && !c8.done;
  console.log(`[aborted]   error=${JSON.stringify(c8.error)} calls=${c8.terminalCalls} -> ${c8ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c8ok;

  // Case 9: a response that never produces data is bounded by the response timeout.
  const c9 = await runCase('stalled-response', { endpoint: `${base}/stall`, model: 'mock', message: 'hi', timeoutMs: 40, overallDeadlineMs: 120 });
  const c9ok = !!c9.error && /timed out/i.test(c9.error) && c9.terminalCalls === 1;
  console.log(`[stalled]   error=${JSON.stringify(c9.error)} calls=${c9.terminalCalls} -> ${c9ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c9ok;

  // Cases 10-11: unbounded records and completions must be rejected before use.
  const c10 = await runCase('large-record', { endpoint: `${base}/large-record`, model: 'mock', message: 'hi', maxSseRecordBytes: 128 });
  const c10ok = !!c10.error && /SSE record/i.test(c10.error) && c10.terminalCalls === 1;
  console.log(`[record-cap] error=${JSON.stringify(c10.error)} -> ${c10ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c10ok;

  const c11 = await runCase('completion-cap', { endpoint: `${base}/long-completion`, model: 'mock', message: 'hi', maxCompletionChars: 32 });
  const c11ok = !!c11.error && /completion/i.test(c11.error) && c11.terminalCalls === 1;
  console.log(`[text-cap]   error=${JSON.stringify(c11.error)} -> ${c11ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c11ok;

  // Case 12: credentials may cross HTTP only to a loopback endpoint.
  const c12 = await runCase('remote-http-credentials', { endpoint: 'http://example.invalid/v1', model: 'mock', message: 'hi', apiKey: 'secret' });
  const c12ok = !!c12.error && /HTTPS/i.test(c12.error) && c12.terminalCalls === 1;
  console.log(`[https-guard] error=${JSON.stringify(c12.error)} -> ${c12ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c12ok;

  // Cases 13-14: byte-dribbling cannot bypass the total deadline or response cap.
  const c13 = await runCase('overall-deadline', { endpoint: `${base}/dribble`, model: 'mock', message: 'hi', timeoutMs: 80, overallDeadlineMs: 45 });
  const c13ok = !!c13.error && /overall deadline/i.test(c13.error) && c13.terminalCalls === 1;
  console.log(`[deadline]  error=${JSON.stringify(c13.error)} -> ${c13ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c13ok;

  const c14 = await runCase('response-cap', { endpoint: `${base}/large-response`, model: 'mock', message: 'hi', maxResponseBytes: 128, maxSseRecordBytes: 8192 });
  const c14ok = !!c14.error && /response exceeded/i.test(c14.error) && c14.terminalCalls === 1;
  console.log(`[response-cap] error=${JSON.stringify(c14.error)} -> ${c14ok ? 'PASS' : 'FAIL'}`);
  pass = pass && c14ok;

  server.close();
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
