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
const { classifyTarget, classifyTurn, parseClassifierReply, CLASSIFIER_SYSTEM_PROMPT, CLASSIFIER_MAX_MESSAGE_CHARS } = require('../dist/main/turn-classifier');
const { classifyTargetWithJev, parseJevReply, JEV_DEFAULT_ENDPOINT, JEV_DEFAULT_MODEL, JEV_CONFIDENCE_FLOOR } = require('../dist/main/jev-classifier');

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

  // ---- Jev (TypeSafe) coordinator ----
  // The mock mirrors the published API reference: state + model + questions, and
  // answers typed per question key.
  const jevReply = (choice, confidence, extra = {}) => JSON.stringify({
    model: 'jev-1.13.0',
    answers: { target: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence }, ...extra } },
    usage: { input_tokens: 300, output_tokens: 20 },
  });

  let jevBody = null;
  let jevAuth = null;
  const jevServer = (payload, status = 200) => server((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      jevBody = JSON.parse(body);
      jevAuth = req.headers.authorization;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });

  const jevOk = await jevServer(jevReply('agent', 0.92));
  const verdict = await classifyTargetWithJev('how many miles is it to the airport from here', { endpoint: url(jevOk), apiKey: 'jev-key' });
  check('jev-maps-agent-to-harness', verdict && verdict.target === 'harness' && verdict.confidence === 0.92);
  check('jev-request-shape', jevBody.state === 'how many miles is it to the airport from here'
    && jevBody.model === JEV_DEFAULT_MODEL
    && jevBody.questions.target.type === 'choice'
    && !!jevBody.questions.target.criteria.chat && !!jevBody.questions.target.criteria.agent,
    JSON.stringify({ model: jevBody.model, type: jevBody.questions.target.type }));
  check('jev-sends-bearer-key', jevAuth === 'Bearer jev-key');
  check('jev-sends-no-tools-or-history', jevBody.tools === undefined && jevBody.messages === undefined && Object.keys(jevBody).sort().join(',') === 'model,questions,state');
  const longState = 'y'.repeat(4000);
  await classifyTargetWithJev(longState, { endpoint: url(jevOk) });
  check('jev-state-is-bounded', jevBody.state.length <= 1000, `${jevBody.state.length}`);

  const jevChat = await jevServer(jevReply('chat', 0.8));
  check('jev-maps-chat-to-llm', (await classifyTargetWithJev('what is the capital of france', { endpoint: url(jevChat) }))?.target === 'llm');

  // A typed choice cannot go off-schema, but a weak or missing confidence can
  // still make the answer unusable — the rules are a better bet than a coin flip.
  const jevUnsure = await jevServer(jevReply('agent', 0.51));
  check('jev-below-confidence-floor-is-null', (await classifyTargetWithJev('x', { endpoint: url(jevUnsure) })) === null);
  check('jev-floor-is-configurable', (await classifyTargetWithJev('x', { endpoint: url(jevUnsure), confidenceFloor: 0.5 }))?.target === 'harness');
  const jevNoConfidence = await jevServer(JSON.stringify({ answers: { target: { type: 'choice', choice: 'agent', probabilities: { agent: 0.9, chat: 0.1 } } } }));
  check('jev-falls-back-to-probabilities', (await classifyTargetWithJev('x', { endpoint: url(jevNoConfidence) }))?.target === 'harness');
  const jevOffSchema = await jevServer(JSON.stringify({ answers: { target: { choice: 'maybe', confidence: 0.99 } } }));
  check('jev-off-schema-is-null', (await classifyTargetWithJev('x', { endpoint: url(jevOffSchema) })) === null);
  const jevNoAnswer = await jevServer(JSON.stringify({ answers: {} }));
  check('jev-missing-answer-is-null', (await classifyTargetWithJev('x', { endpoint: url(jevNoAnswer) })) === null);
  const jevUnauthorized = await jevServer('{}', 401);
  check('jev-401-is-null', (await classifyTargetWithJev('x', { endpoint: url(jevUnauthorized), apiKey: 'bad' })) === null);
  const jevSlow = await server(() => { /* never answers */ });
  const jt0 = Date.now();
  check('jev-timeout-is-null-and-bounded', (await classifyTargetWithJev('x', { endpoint: url(jevSlow), timeoutMs: 300 })) === null && Date.now() - jt0 < 1500, `${Date.now() - jt0}ms`);
  const jevRefused = await classifyTargetWithJev('x', { endpoint: 'http://192.0.2.10:1/v1/systemone', apiKey: 'secret', timeoutMs: 300 });
  check('jev-refuses-plaintext-remote-key', jevRefused === null);
  check('jev-default-endpoint-is-typesafe-https', JEV_DEFAULT_ENDPOINT === 'https://api.typesafe.ai/v1/systemone');
  check('jev-parse-tolerates-junk', parseJevReply(null) === null && parseJevReply({ answers: { target: { choice: 'agent', confidence: 'high' } } }) === null);

  // ---- the coordinator the app actually calls ----
  const coordJev = await classifyTurn('how many miles is it to the airport', {
    coordinator: 'jev', timeoutMs: 500,
    jev: { endpoint: url(jevOk), apiKey: 'jev-key' },
    llm: { endpoint: url(good) },
  });
  check('coordinator-jev-uses-jev', coordJev?.by === 'jev' && coordJev.target === 'harness', JSON.stringify(coordJev));

  const coordFallback = await classifyTurn('how many miles is it to the airport', {
    coordinator: 'jev', timeoutMs: 500,
    jev: { endpoint: 'http://127.0.0.1:1/v1/systemone', apiKey: 'k' },
    llm: { endpoint: url(good) },
  });
  check('coordinator-jev-falls-back-to-chat-model', coordFallback?.by === 'builtin' && coordFallback.target === 'harness', JSON.stringify(coordFallback));

  const coordBuiltin = await classifyTurn('how many miles is it to the airport', {
    coordinator: 'builtin', timeoutMs: 500,
    llm: { endpoint: url(good) },
    jev: { endpoint: url(jevUnsure), apiKey: 'k' },
  });
  check('coordinator-builtin-ignores-jev', coordBuiltin?.by === 'builtin');

  const coordNothing = await classifyTurn('x', { coordinator: 'jev', timeoutMs: 300, jev: { endpoint: 'http://127.0.0.1:1/v1/systemone' } });
  check('coordinator-returns-null-when-nobody-answers', coordNothing === null);
  check('confidence-floor-is-documented', JEV_CONFIDENCE_FLOOR > 0.5 && JEV_CONFIDENCE_FLOOR < 0.9, String(JEV_CONFIDENCE_FLOOR));

  for (const s of [good, authServer, fiveHundred, garbage, rambling, broken, slow, remoteish, jevOk, jevChat, jevUnsure, jevNoConfidence, jevOffSchema, jevNoAnswer, jevUnauthorized, jevSlow]) { s.closeAllConnections?.(); s.close(); }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
