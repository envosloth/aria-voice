#!/usr/bin/env node
/* Routing-invariant regression gate.
 *
 * Enforces the load-bearing correctness invariant: the DIRECT conversational LLM
 * is invoked with ZERO tools at the model level (it never calls tools, including
 * delegation), and the decision to use the tool-capable agent harness is made by
 * the pre-invocation router — NOT by a tool the direct LLM calls mid-reply.
 *
 * This replaces the old smoke-delegate.js (which verified the v2.0.0
 * `delegate_to_agent` tool — the very violation this gate now guards against).
 *
 * Two real headless app runs against mock OpenAI-compatible servers:
 *   Run A (mode=auto): a tool-requiring prompt must route to the HARNESS up front;
 *          the direct LLM must NOT be called at all, and the harness reply reaches
 *          the user woven into a natural answer.
 *   Run B (mode=llm): the direct LLM is forced. It must be sent NO `tools` array
 *          (invariant), the harness must NOT be invoked, and a plain answer comes
 *          back.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); }); }
function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
function listen(s) { return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port))); }

// Direct-LLM mock: records whether ANY request carried a `tools` array (the
// invariant says it must never), and always answers in plain text.
function llmServer(rec) {
  return http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    rec.llmRequests.push({ hasTools });
    sse(res, [{ choices: [{ delta: { content: 'I can answer that directly.' } }] }]);
  });
}

// Harness mock: records the task it received, returns a canned tool-derived reply
// (the harness runs its own tools server-side and weaves the result in itself).
function harnessServer(rec) {
  return http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    rec.harnessTasks.push(lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '');
    sse(res, [{ choices: [{ delta: { content: 'It is 24°C and sunny in Austin.' } }] }]);
  });
}

function runApp(env) {
  return new Promise((resolve) => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-route-'));
    const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
    const child = spawn(electron, ['--no-sandbox', `--user-data-dir=${userDir}`, path.join(__dirname, '..', 'dist', 'main', 'index.js')], {
      env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_ROUTING: '1', ...env },
    });
    let convo = []; let buf = '';
    const onLine = (l) => {
      if (process.env.VERBOSE) console.log(l);
      const m = l.match(/\[ARIA_VERIFY\] routing-convo=(.*)$/);
      if (m) { try { convo = JSON.parse(m[1]); } catch (e) {} }
    };
    const pump = (d) => { buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop(); ls.forEach(onLine); };
    child.stdout.on('data', pump); child.stderr.on('data', pump);
    child.on('exit', () => { try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {} resolve(convo); });
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 30000);
  });
}

async function main() {
  const checks = [];

  // ---- Run A: tool-requiring prompt, mode=auto -> must route to the harness ----
  const recA = { llmRequests: [], harnessTasks: [] };
  const llmA = llmServer(recA);
  const harnessA = harnessServer(recA);
  const lp = await listen(llmA); const hp = await listen(harnessA);
  const convoA = await runApp({
    ARIA_VERIFY_ROUTING_MODE: 'auto',
    ARIA_VERIFY_ROUTING_MSG: 'what is the weather in austin',
    ARIA_VERIFY_LLM_ENDPOINT: `http://127.0.0.1:${lp}/v1/chat/completions`,
    ARIA_VERIFY_HARNESS_ENDPOINT: `http://127.0.0.1:${hp}/v1/chat/completions`,
  });
  llmA.close(); harnessA.close();
  const finalA = (convoA.filter((m) => m.role === 'assistant').pop() || {}).text || '';
  console.log('  [A] final answer:', JSON.stringify(finalA));
  console.log('  [A] llm requests:', JSON.stringify(recA.llmRequests), 'harness tasks:', JSON.stringify(recA.harnessTasks));
  checks.push(['A: direct LLM was NOT called for a tool-requiring prompt (routed to harness)', recA.llmRequests.length === 0]);
  checks.push(['A: the agent harness handled it', recA.harnessTasks.length >= 1]);
  checks.push(['A: harness reply reaches the user woven naturally', /24°C|sunny/i.test(finalA)]);

  // ---- Run B: same prompt forced to the direct LLM (mode=llm) ----
  const recB = { llmRequests: [], harnessTasks: [] };
  const llmB = llmServer(recB);
  const harnessB = harnessServer(recB);
  const lpB = await listen(llmB); const hpB = await listen(harnessB);
  const convoB = await runApp({
    ARIA_VERIFY_ROUTING_MODE: 'llm',
    ARIA_VERIFY_ROUTING_MSG: 'what is the weather in austin',
    ARIA_VERIFY_LLM_ENDPOINT: `http://127.0.0.1:${lpB}/v1/chat/completions`,
    ARIA_VERIFY_HARNESS_ENDPOINT: `http://127.0.0.1:${hpB}/v1/chat/completions`,
  });
  llmB.close(); harnessB.close();
  const finalB = (convoB.filter((m) => m.role === 'assistant').pop() || {}).text || '';
  console.log('  [B] final answer:', JSON.stringify(finalB));
  console.log('  [B] llm requests:', JSON.stringify(recB.llmRequests), 'harness tasks:', JSON.stringify(recB.harnessTasks));
  checks.push(['B: INVARIANT — direct LLM received NO tools array (zero tools at model level)', recB.llmRequests.length >= 1 && recB.llmRequests.every((r) => r.hasTools === false)]);
  checks.push(['B: direct LLM did NOT delegate (harness never invoked)', recB.harnessTasks.length === 0]);
  checks.push(['B: still produced a plain answer (no crash)', /answer that directly/i.test(finalB)]);

  let pass = true;
  console.log('\nChecks:');
  for (const [name, ok] of checks) { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && ok; }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
