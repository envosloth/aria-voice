#!/usr/bin/env node
/* Item 8 verification: a direct LLM provider knows it can delegate to the agent
 * harness, actually invokes the delegate_to_agent tool for a tool-requiring
 * prompt, and the harness result is woven into the final answer. Also verifies
 * the capability fallback: a model that rejects `tools` still answers (no crash).
 *
 * Two real headless app runs against mock OpenAI-compatible servers.
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

// Direct-LLM mock that does the OpenAI function-calling dance.
function llmServer(rec, opts) {
  return http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const hasTools = Array.isArray(body.tools) && body.tools.some((t) => t.function && t.function.name === 'delegate_to_agent');
    const hasToolResult = (body.messages || []).some((m) => m.role === 'tool');
    rec.llmRequests.push({ hasTools, hasToolResult });
    if (opts.reject400OnTools && hasTools) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'this model does not support tools' }));
      return;
    }
    if (hasTools && !hasToolResult) {
      // First turn: ask to delegate (id+name, then fragmented arguments).
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'delegate_to_agent', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"task":"current weather in Austin"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
      return;
    }
    // Either the post-delegation turn, or a no-tools turn: produce a text answer.
    const answer = hasToolResult
      ? ['Right now in Austin ', 'it is 24°C and sunny.']
      : ['I can answer that directly.'];
    sse(res, answer.map((c) => ({ choices: [{ delta: { content: c } }] })));
  });
}

// Harness mock: records the delegated task, returns a canned tool-derived result.
function harnessServer(rec) {
  return http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    rec.harnessTasks.push(lastUser ? lastUser.content : '');
    sse(res, [{ choices: [{ delta: { content: 'It is 24°C and sunny in Austin.' } }] }]);
  });
}

function runApp(env) {
  return new Promise((resolve) => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-del-'));
    const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
    const child = spawn(electron, ['--no-sandbox', `--user-data-dir=${userDir}`, path.join(__dirname, '..', 'dist', 'main', 'index.js')], {
      env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_DELEGATE: '1', ...env },
    });
    let convo = []; let buf = '';
    const onLine = (l) => {
      if (process.env.VERBOSE) console.log(l);
      const m = l.match(/\[ARIA_VERIFY\] delegate-convo=(.*)$/);
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

  // ---- Run A: delegation happy path ----
  const recA = { llmRequests: [], harnessTasks: [] };
  const llmA = llmServer(recA, {});
  const harnessA = harnessServer(recA);
  const lp = await listen(llmA); const hp = await listen(harnessA);
  const convoA = await runApp({
    ARIA_VERIFY_LLM_ENDPOINT: `http://127.0.0.1:${lp}/v1/chat/completions`,
    ARIA_VERIFY_HARNESS_ENDPOINT: `http://127.0.0.1:${hp}/v1/chat/completions`,
  });
  llmA.close(); harnessA.close();
  const finalA = (convoA.filter((m) => m.role === 'assistant').pop() || {}).text || '';
  console.log('  [A] final answer:', JSON.stringify(finalA));
  console.log('  [A] llm requests:', JSON.stringify(recA.llmRequests), 'harness tasks:', JSON.stringify(recA.harnessTasks));
  checks.push(['A: tools (delegate_to_agent) sent to the direct LLM', recA.llmRequests[0] && recA.llmRequests[0].hasTools === true]);
  checks.push(['A: the model INVOKED the tool -> harness received the task', recA.harnessTasks.length >= 1 && /weather|austin/i.test(recA.harnessTasks[0] || '')]);
  checks.push(['A: follow-up request carried the tool result back to the LLM', recA.llmRequests.some((r) => r.hasToolResult === true)]);
  checks.push(['A: final answer weaves in the harness result (not text-only guess)', /24°C|sunny/i.test(finalA)]);

  // ---- Run B: capability fallback (model rejects tools) ----
  const recB = { llmRequests: [], harnessTasks: [] };
  const llmB = llmServer(recB, { reject400OnTools: true });
  const harnessB = harnessServer(recB);
  const lpB = await listen(llmB); const hpB = await listen(harnessB);
  const convoB = await runApp({
    ARIA_VERIFY_LLM_ENDPOINT: `http://127.0.0.1:${lpB}/v1/chat/completions`,
    ARIA_VERIFY_HARNESS_ENDPOINT: `http://127.0.0.1:${hpB}/v1/chat/completions`,
  });
  llmB.close(); harnessB.close();
  const finalB = (convoB.filter((m) => m.role === 'assistant').pop() || {}).text || '';
  console.log('  [B] final answer:', JSON.stringify(finalB));
  console.log('  [B] llm requests:', JSON.stringify(recB.llmRequests));
  checks.push(['B: tools-unsupported -> retried WITHOUT tools', recB.llmRequests.length >= 2 && recB.llmRequests.some((r) => r.hasTools === false)]);
  checks.push(['B: still produced a plain answer (graceful fallback, no crash)', /answer that directly/i.test(finalB)]);

  let pass = true;
  console.log('\nChecks:');
  for (const [name, ok] of checks) { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && ok; }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
