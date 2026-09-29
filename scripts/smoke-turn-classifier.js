#!/usr/bin/env node
/* Turn-classifier contract: the one-shot tiebreaker for messages the heuristic
 * router cannot classify confidently.
 *
 * Checks: reply parsing, the fallback path on every failure mode (timeout, 5xx,
 * garbage, unreachable, insecure remote plaintext endpoint), and the privacy
 * shape of the request (one tiny message, no history, no tools, bounded size).
 * Plain Node against a local mock server (needs `npm run build`). */
const http = require('http');
const path = require('path');
const { classifyTarget, parseClassifierReply, CLASSIFIER_SYSTEM_PROMPT, CLASSIFIER_MAX_MESSAGE_CHARS } = require('../dist/main/turn-classifier');

let pass = true;
const check = (name, ok, detail = '') => {
  if (!ok) pass = false;
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
};

function server(handler) {
  const s = http.createServer(handler);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
const url = (s) => `http://127.0.0.1:${s.address().port}/v1/chat/completions`;

let lastBody = null;
async function main() {
  // ---- parsing ----
  check('parse-agent', parseClassifierReply('agent') === 'harness');
  check('parse-chat', parseClassifierReply('chat') === 'llm');
  check('parse-harness', parseClassifierReply('harness') === 'harness');
  check('parse-upper-and-space', parseClassifierReply('  Chat\n') === 'llm');
  check('parse-first-decisive-word', parseClassifierReply('chat. The user is asking for an explanation, not the agent.') === 'llm');
  check('parse-rejects-garbage', parseClassifierReply('maybe?') === null && parseClassifierReply('') === null && parseClassifierReply(undefined) === null);

  // ---- a good reply, and the request shape ----
  const good = await server((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'agent' } }] }));
    });
  });
  check('classify-returns-agent', (await classifyTarget('how many miles is it to the airport from here', { endpoint: url(good) })) === 'harness');
  check('request-is-non-streaming', lastBody.stream === false && lastBody.max_tokens <= 8, JSON.stringify({ stream: lastBody.stream, max_tokens: lastBody.max_tokens }));
  check('request-has-no-tools', lastBody.tools === undefined && lastBody.tool_choice === undefined);
  check('request-has-no-history', Array.isArray(lastBody.messages) && lastBody.messages.length === 2 && lastBody.messages[0].content === CLASSIFIER_SYSTEM_PROMPT, `messages=${lastBody.messages && lastBody.messages.length}`);
  check('system-prompt-is-one-liner-sized', CLASSIFIER_SYSTEM_PROMPT.length < 600, `${CLASSIFIER_SYSTEM_PROMPT.length} chars`);
  const long = 'x'.repeat(5000);
  await classifyTarget(long, { endpoint: url(good) });
  check('message-is-bounded', lastBody.messages[1].content.length <= CLASSIFIER_MAX_MESSAGE_CHARS, `${lastBody.messages[1].content.length}`);

  // ---- auth header only when a key is supplied ----
  const authServer = await server((req, res) => {
    lastBody = { auth: req.headers.authorization };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'chat' } }] }));
  });
  await classifyTarget('hello', { endpoint: url(authServer) });
  check('no-key-no-auth-header', lastBody.auth === undefined);
  await classifyTarget('hello', { endpoint: url(authServer), apiKey: 'k-123' });
  check('key-becomes-bearer', lastBody.auth === 'Bearer k-123');

  // ---- failure modes fall back to null (caller keeps the heuristic) ----
  const fiveHundred = await server((req, res) => { res.writeHead(500); res.end('nope'); });
  check('http-error-is-null', (await classifyTarget('x', { endpoint: url(fiveHundred) })) === null);

  const garbage = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'I am not sure what you mean.' } }] }));
  });
  check('unparseable-is-null', (await classifyTarget('x', { endpoint: url(garbage) })) === null);

  // A rambling answer that still names a target is read from its first
  // decisive word (and a trailing "the agent" must not flip a chat verdict).
  const rambling = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'chat. The user wants an explanation, not the agent.' } }] }));
  });
  check('rambling-answer-reads-first-word', (await classifyTarget('x', { endpoint: url(rambling) })) === 'llm');

  const broken = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not json');
  });
  check('invalid-json-is-null', (await classifyTarget('x', { endpoint: url(broken) })) === null);

  const slow = await server(() => { /* never answers */ });
  const t0 = Date.now();
  check('timeout-is-null-and-bounded', (await classifyTarget('x', { endpoint: url(slow), timeoutMs: 300 })) === null && Date.now() - t0 < 1500, `${Date.now() - t0}ms`);

  const deadServer = await server(() => {});
  const deadUrl = url(deadServer);
  await new Promise((r) => deadServer.close(r));
  check('unreachable-is-null', (await classifyTarget('x', { endpoint: deadUrl, timeoutMs: 300 })) === null);

  check('bad-endpoint-is-null', (await classifyTarget('x', { endpoint: 'not a url' })) === null);
  check('no-message-is-null', (await classifyTarget('   ', { endpoint: url(good) })) === null);

  // ---- never send a credential over plaintext to a non-loopback host ----
  let contacted = false;
  const remoteish = await server((req, res) => { contacted = true; res.end('{}'); });
  const remoteUrl = `http://192.0.2.10:${remoteish.address().port}/v1/chat/completions`;
  const t1 = Date.now();
  check('remote-plaintext-key-refused',
    (await classifyTarget('x', { endpoint: remoteUrl, apiKey: 'secret', timeoutMs: 500 })) === null && !contacted && Date.now() - t1 < 300,
    `${Date.now() - t1}ms`);

  for (const s of [good, authServer, fiveHundred, garbage, rambling, broken, slow, remoteish]) { s.closeAllConnections?.(); s.close(); }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
