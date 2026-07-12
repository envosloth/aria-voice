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

function llmServer(rec) {
  return http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const messages = body.messages || [];
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    rec.llmRequests.push({ tools: body.tools, system, lastUser });
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

async function drive(message, mode) {
  const rec = { llmRequests: [], harnessTasks: [] };
  const llm = llmServer(rec);
  const harness = harnessServer(rec);
  const llmPort = await listen(llm);
  const harnessPort = await listen(harness);
  const convo = await runApp({
    ARIA_VERIFY_ROUTING_MODE: mode,
    ARIA_VERIFY_ROUTING_MSG: message,
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
