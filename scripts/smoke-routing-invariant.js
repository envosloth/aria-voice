#!/usr/bin/env node
/* Router-only routing contract.
 *
 * The conversational LLM is never offered delegation tools or a prose escape
 * hatch. The router chooses the agent harness before any request is sent when
 * a turn needs live data or an action. A forced `llm` mode remains a deliberate
 * user override, not an implicit handoff mechanism.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}
function sse(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function llmServer(rec, classifierSays = 'agent', llmReply = null) {
  return http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const messages = body.messages || [];
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    // A non-streaming request on this endpoint is the routing tiebreaker: answer
    // with its single word instead of a streamed chat reply.
    if (body.stream === false) {
      rec.classifyRequests = (rec.classifyRequests || []);
      rec.classifyRequests.push({ lastUser, tools: body.tools, historyLen: messages.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: classifierSays } }] }));
      return;
    }
    rec.llmRequests.push({ tools: body.tools, system, lastUser });
    if (llmReply) { sse(res, llmReply(lastUser)); return; }
    sse(res, String(lastUser).toLowerCase().includes('weather')
      ? 'Forced direct mode answer.'
      : 'A direct explanation from the conversational model.');
  });
}

function harnessServer(rec) {
  return http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    rec.harnessTasks.push(lastUser ? String(lastUser.content || '') : '');
    rec.harnessHistories = rec.harnessHistories || [];
    rec.harnessHistories.push((body.messages || []).filter((m) => m.role !== 'system').map((m) => `${m.role}: ${String(m.content || '').slice(0, 120)}`));
    sse(res, 'It is 24°C and sunny in Austin.');
  });
}

function runApp(env) {
  return new Promise((resolve) => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-route-'));
    const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
    const child = spawn(electron, ['--no-sandbox', `--user-data-dir=${userDir}`, path.join(__dirname, '..', 'dist', 'main', 'index.js')], {
      env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_ROUTING: '1', ...env },
    });
    let convo = []; let buffer = '';
    const onLine = (line) => {
      if (process.env.VERBOSE) console.log(line);
      const match = line.match(/\[ARIA_VERIFY\] routing-convo=(.*)$/);
      if (match) { try { convo = JSON.parse(match[1]); } catch { /* ignore malformed diagnostic */ } }
    };
    const pump = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(onLine);
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('exit', () => {
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve(convo);
    });
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 30000);
  });
}

async function drive(message, mode, classifierSays = 'agent', llmReply = null) {
  const rec = { llmRequests: [], harnessTasks: [], classifyRequests: [] };
  const llm = llmServer(rec, classifierSays, llmReply);
  const harness = harnessServer(rec);
  const llmPort = await listen(llm);
  const harnessPort = await listen(harness);
  const convo = await runApp({
    ARIA_VERIFY_ROUTING_MODE: mode,
    ...(Array.isArray(message) ? { ARIA_VERIFY_ROUTING_MSGS: JSON.stringify(message) } : { ARIA_VERIFY_ROUTING_MSG: message }),
    ARIA_VERIFY_LLM_ENDPOINT: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
    ARIA_VERIFY_HARNESS_ENDPOINT: `http://127.0.0.1:${harnessPort}/v1/chat/completions`,
  });
  llm.close();
  harness.close();
  const final = (convo.filter((m) => m.role === 'assistant').pop() || {}).text || '';
  return { rec, final };
}

function check(checks, name, condition) {
  checks.push([name, condition]);
}

async function main() {
  const checks = [];
  const gotchas = fs.readFileSync(path.join(__dirname, '..', 'collaboration', 'gotchas.md'), 'utf8');
  const routingDocs = (gotchas.split('## LLM / coordinator')[1] || '').split('\n## ')[0] || '';
  check(checks, 'routing documentation matches executable invariant',
    /router\.ts[^\n]*chooses|router-time dispatch|before invocation/i.test(routingDocs)
      && /direct (?:conversational )?LLM[^\n]*(?:no tools|receives no tools)/i.test(routingDocs)
      && !/delegate_to_agent|ARIA_AGENT_HANDOFF/i.test(routingDocs));

  const live = await drive('what is the weather in austin', 'auto');
  check(checks, 'auto live-data request bypasses conversational LLM', live.rec.llmRequests.length === 0);
  check(checks, 'auto live-data request reaches harness once', live.rec.harnessTasks.length === 1);
  check(checks, 'harness response reaches user', /24°C|sunny/i.test(live.final));

  const chat = await drive('explain why the sky looks blue', 'auto');
  const request = chat.rec.llmRequests[0] || {};
  check(checks, 'pure conversation reaches direct LLM once', chat.rec.llmRequests.length === 1 && chat.rec.harnessTasks.length === 0);
  check(checks, 'direct LLM request has no tools field', request.tools === undefined);
  check(checks, 'direct prompt contains no delegation sentinel or tool',
    !/ARIA_AGENT_HANDOFF|delegate_to_agent/i.test(String(request.system || '')));
  check(checks, 'direct response reaches user', /direct explanation/i.test(chat.final));

  // The two upstream complaints, end to end in the real app: a knowledge
  // question that merely CONTAINS tool nouns must reach the chat model, and a
  // deictic reference to something on screen must reach the agent (only it can
  // see or touch the screen).
  const advice = await drive('what is the best way to back up my files', 'auto');
  check(checks, 'advice question with tool nouns stays on the chat model',
    advice.rec.llmRequests.length === 1 && advice.rec.harnessTasks.length === 0);
  check(checks, 'advice answer reaches the user', /direct explanation/i.test(advice.final));

  // A hard on-screen cue is the agent's job (only it can see the screen). The
  // softer "I'm looking at" phrasing deliberately stays with the chat model
  // unless the sentence asks for an ACTION on it — see router.ts rule 3.
  const onScreen = await drive('what is on my screen', 'auto');
  check(checks, 'on-screen reference goes to the agent, not the chat model',
    onScreen.rec.harnessTasks.length === 1 && onScreen.rec.llmRequests.length === 0);

  // The rules cannot classify this on their own (no cue, no keyword), so the
  // chat model is asked, answers 'agent', and the request reaches the harness.
  const tiebreakAgent = await drive('how many miles is it to the airport from here', 'auto', 'agent');
  check(checks, 'unclassifiable request asks the chat model once',
    (tiebreakAgent.rec.classifyRequests || []).length === 1);
  check(checks, 'classifier request carries no tools and no history',
    tiebreakAgent.rec.classifyRequests[0]?.tools === undefined && tiebreakAgent.rec.classifyRequests[0]?.historyLen === 2);
  check(checks, 'classifier answer routes to the agent',
    tiebreakAgent.rec.harnessTasks.length === 1 && tiebreakAgent.rec.llmRequests.length === 0);

  const tiebreakChat = await drive('zibble wobble fram', 'auto', 'chat');
  check(checks, 'classifier answer routes to the chat model',
    tiebreakChat.rec.llmRequests.length === 1 && tiebreakChat.rec.harnessTasks.length === 0);

  const sure = await drive('run the tests', 'auto', 'chat');
  check(checks, 'a message with a clear cue never asks the classifier',
    (sure.rec.classifyRequests || []).length === 0 && sure.rec.harnessTasks.length === 1);

  // One assistant, one thread (the real Longmont transcript, 2026-09). The STT
  // homophone "the whether" must reach the tools; and even if the chat model
  // answers first and asks for the city, the city goes to the tools WITH the
  // earlier turns — never a second "I can't check the weather" from chat.
  const garbled = await drive("Can you give me the whether it's the long, long, all right?", 'auto');
  check(checks, 'STT homophone "the whether" reaches the tools',
    garbled.rec.harnessTasks.length === 1 && garbled.rec.llmRequests.length === 0);
  const slot = await drive(['I want to know the forecast, which city should I say?', 'Longmont, Colorado'], 'auto', 'chat',
    () => "Sure, for the forecast — what's the location?");
  // Turn 1 is ambiguous for the rules; whichever target answers it, turn 2 must
  // land on the tools and see turn 1.
  const slotHist = (slot.rec.harnessHistories || []).pop() || [];
  check(checks, 'answer to a clarifying question goes to the tools',
    slot.rec.harnessTasks.includes('Longmont, Colorado') || slot.rec.harnessTasks.some((t) => /Longmont/.test(t)));
  check(checks, 'the tools see the earlier turns of the same thread',
    slotHist.some((l) => /forecast/.test(l)));
  check(checks, 'chat prompt never mentions modes, agents, or harnesses to the model as a handoff',
    chat.rec.llmRequests.every((r) => !/agent mode can|ask the agent|harness can/i.test(String(r.system || ''))));

  const forced = await drive('what is the weather in austin', 'llm');
  const forcedRequest = forced.rec.llmRequests[0] || {};
  check(checks, 'forced LLM mode remains direct without a harness handoff',
    forced.rec.llmRequests.length === 1 && forced.rec.harnessTasks.length === 0);
  check(checks, 'forced direct request has no delegation tool', forcedRequest.tools === undefined);
  check(checks, 'forced direct response reaches user', /forced direct/i.test(forced.final));

  let pass = true;
  console.log('Checks:');
  for (const [name, ok] of checks) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
    pass = pass && ok;
  }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
