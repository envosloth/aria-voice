#!/usr/bin/env node
/* Routing-contract regression gate ("one brain").
 *
 * Contract (supersedes the old zero-tools invariant, by user decision 2026-07-09):
 * the pre-invocation router (router.ts) is only a latency FAST-PATH — unmistakable
 * tool/live-data asks skip straight to the agent harness. Everything else goes to
 * the direct LLM, which is the front brain: it is offered exactly ONE tool,
 * `delegate_to_agent`, and decides itself when a turn needs agent mode. The
 * ARIA_AGENT_HANDOFF prose sentinel remains the fallback for models without
 * function calling, and a server that rejects `tools` is retried once without.
 *
 * Three real headless app runs against mock OpenAI-compatible servers:
 *   Run A (mode=auto): a tool-requiring prompt must route to the HARNESS up front;
 *          the direct LLM must NOT be called at all (fast-path preserved).
 *   Run B (mode=llm, tool-capable model): the direct LLM must be sent EXACTLY
 *          [delegate_to_agent] and nothing else; its streamed tool call must run
 *          the harness once; the harness reply reaches the user.
 *   Run C (mode=llm, model/server without tool support): the request with tools
 *          is 400'd; the app must retry once WITHOUT tools; the sentinel reply is
 *          intercepted and the harness runs once; nothing leaks to the user.
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

// Direct-LLM mock. Records every request's tools array. Behavior by `mode`:
//  'toolcall' — a tool-capable model: delegates weather asks via a STREAMED
//               delegate_to_agent tool call (name and argument fragments split
//               across deltas, like real servers).
//  'reject-tools' — a server with no function calling: 400s any request carrying
//               `tools`; without tools it falls back to the sentinel for weather.
function llmServer(rec, mode) {
  return http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const toolNames = hasTools ? body.tools.map((t) => t && t.function && t.function.name).filter(Boolean) : [];
    const messages = body.messages || [];
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    rec.llmRequests.push({ hasTools, toolNames, system, lastUser });
    const isWeather = String(lastUser).toLowerCase().includes('weather');
    if (mode === 'reject-tools' && hasTools) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tools is not supported by this model' } }));
      return;
    }
    if (mode === 'toolcall' && hasTools && isWeather) {
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'delegate_to_agent', arguments: '{"task":"Look up the current ' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'weather in Austin."}' } }] } }] },
      ]);
      return;
    }
    const text = isWeather
      ? 'ARIA_AGENT_HANDOFF: Look up the current weather in Austin and answer naturally.'
      : 'I can answer that directly.';
    sse(res, [{ choices: [{ delta: { content: text } }] }]);
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

// One run: spin up fresh mocks, drive the app, tear down, return everything.
async function drive(llmMode, routingMode) {
  const rec = { llmRequests: [], harnessTasks: [] };
  const llm = llmServer(rec, llmMode);
  const harness = harnessServer(rec);
  const lp = await listen(llm); const hp = await listen(harness);
  const convo = await runApp({
    ARIA_VERIFY_ROUTING_MODE: routingMode,
    ARIA_VERIFY_ROUTING_MSG: 'what is the weather in austin',
    ARIA_VERIFY_LLM_ENDPOINT: `http://127.0.0.1:${lp}/v1/chat/completions`,
    ARIA_VERIFY_HARNESS_ENDPOINT: `http://127.0.0.1:${hp}/v1/chat/completions`,
  });
  llm.close(); harness.close();
  const final = (convo.filter((m) => m.role === 'assistant').pop() || {}).text || '';
  return { rec, final };
}

async function main() {
  const checks = [];

  // ---- Run A: tool-requiring prompt, mode=auto -> fast-path routes to harness ----
  const A = await drive('toolcall', 'auto');
  console.log('  [A] final answer:', JSON.stringify(A.final));
  console.log('  [A] llm requests:', JSON.stringify(A.rec.llmRequests), 'harness tasks:', JSON.stringify(A.rec.harnessTasks));
  checks.push(['A: FAST-PATH — direct LLM not called for an unmistakable tool ask', A.rec.llmRequests.length === 0]);
  checks.push(['A: the agent harness handled it', A.rec.harnessTasks.length >= 1]);
  checks.push(['A: harness reply reaches the user woven naturally', /24°C|sunny/i.test(A.final)]);
  // Voice-output hint: the per-turn user-message nudge must be present in
  // the harness task. This is the most reliable way to prevent the
  // "A circumflex" TTS bug — LLMs follow user-message instructions more
  // reliably than system-prompt rules. The hint includes the literal
  // "[Voice output]" tag so the test can verify it landed.
  const harnessTaskText = (A.rec.harnessTasks[0] || '').toLowerCase();
  checks.push(['A: voice-output hint appended to user message', harnessTaskText.includes('[voice output]')]);
  checks.push(['A: voice-output hint mentions circumflex rule', harnessTaskText.includes('circumflex')]);

  // ---- Run B: forced direct LLM (mode=llm), tool-capable model ----
  // The front brain must be offered exactly the delegate tool and its streamed
  // tool call must hand the turn to the harness once.
  const B = await drive('toolcall', 'llm');
  console.log('  [B] final answer:', JSON.stringify(B.final));
  console.log('  [B] llm requests:', JSON.stringify(B.rec.llmRequests.map((r) => ({ hasTools: r.hasTools, toolNames: r.toolNames }))), 'harness tasks:', JSON.stringify(B.rec.harnessTasks));
  checks.push(['B: CONTRACT — direct LLM offered exactly [delegate_to_agent]',
    B.rec.llmRequests.length >= 1 && B.rec.llmRequests.every((r) => r.hasTools && r.toolNames.length === 1 && r.toolNames[0] === 'delegate_to_agent')]);
  const directPrompt = B.rec.llmRequests[0]?.system || '';
  checks.push(['B: direct LLM prompt names ARIA agent mode + capabilities', /agent mode|agent harness/i.test(directPrompt) && /web search|file system|code|calendar|weather/i.test(directPrompt)]);
  checks.push(['B: direct LLM prompt keeps the sentinel fallback documented', /ARIA_AGENT_HANDOFF/.test(directPrompt)]);
  checks.push(['B: streamed tool call ran the harness exactly once', B.rec.harnessTasks.length === 1]);
  checks.push(['B: harness received the delegated task', /weather in austin/i.test(B.rec.harnessTasks[0] || '')]);
  checks.push(['B: harness reply reaches the user after delegation', /24°C|sunny/i.test(B.final)]);

  // ---- Run C: forced direct LLM (mode=llm), server without tool support ----
  // Capability fallback: 400-on-tools must retry once without tools, and the
  // sentinel reply must still be intercepted into a harness run.
  const C = await drive('reject-tools', 'llm');
  console.log('  [C] final answer:', JSON.stringify(C.final));
  console.log('  [C] llm requests:', JSON.stringify(C.rec.llmRequests.map((r) => ({ hasTools: r.hasTools }))), 'harness tasks:', JSON.stringify(C.rec.harnessTasks));
  checks.push(['C: first attempt carried tools, retry dropped them', C.rec.llmRequests.length === 2 && C.rec.llmRequests[0].hasTools === true && C.rec.llmRequests[1].hasTools === false]);
  checks.push(['C: sentinel handoff was intercepted and harness invoked once', C.rec.harnessTasks.length === 1]);
  checks.push(['C: handoff sentinel was not shown to the user', !/ARIA_AGENT_HANDOFF/i.test(C.final)]);
  checks.push(['C: harness reply reaches the user after sentinel handoff', /24°C|sunny/i.test(C.final)]);

  let pass = true;
  console.log('\nChecks:');
  for (const [name, ok] of checks) { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && ok; }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
