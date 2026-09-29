#!/usr/bin/env node
const assert = require('node:assert/strict');
const http = require('node:http');
const { streamChat } = require('../dist/main/llm-stream');
const event = choice => `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
const cases = [
  ['partial EOF', 'text/event-stream', event({ delta: { content: 'partial' } }), 'error', /incomplete|completion/i],
  ['empty EOF', 'text/event-stream', '', 'error', /incomplete|completion/i],
  ['JSON body', 'application/json', JSON.stringify({ choices: [{ message: { content: 'hidden' } }] }), 'error', /content.type|event.stream|protocol/i],
  ['HTML body', 'text/html', '<html>proxy login</html>', 'error', /content.type|event.stream|protocol/i],
  ['missing content type', null, event({ delta: { content: 'partial' } }), 'error', /content.type|event.stream|protocol/i],
  ['finish reason at EOF', 'text/event-stream; charset=utf-8', event({ delta: { content: 'complete' }, finish_reason: 'stop' }), 'done', 'complete'],
  ['DONE marker', 'text/event-stream', event({ delta: { content: 'complete' } }) + 'data: [DONE]\n\n', 'done', 'complete'],
  ['trailing finish record', 'text/event-stream', event({ delta: { content: 'complete' } }) + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}', 'done', 'complete'],
];
(async () => {
  let i = 0, failures = 0;
  const server = http.createServer((req, res) => {
    req.resume(); const [, type, body] = cases[i];
    res.writeHead(200, type ? { 'Content-Type': type } : {}); res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    for (; i < cases.length; i++) {
      const [name, , , expected, detail] = cases[i];
      const events = [];
      await new Promise(resolve => streamChat({ endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', overallDeadlineMs: 2000 }, {
        onToken: () => {}, onDone: text => { events.push(['done', text]); resolve(); }, onError: error => { events.push(['error', error]); resolve(); },
      }));
      await new Promise(r => setImmediate(r));
      try {
        assert.equal(events.length, 1); assert.equal(events[0][0], expected);
        if (detail instanceof RegExp) assert.match(events[0][1], detail); else assert.equal(events[0][1], detail);
        console.log(`PASS ${name}`);
      } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
    }
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
