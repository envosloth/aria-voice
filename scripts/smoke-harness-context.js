#!/usr/bin/env node
// One assistant, one thread, across the chat model and the agent harness.
// Replays the Giza trip conversation against a mock chat model and a mock
// Hermes harness that (like the real one) ignores body history when a session
// id is pinned. Checks the harness request carries the turns it never saw,
// that the go-ahead reaches the harness, and that turns it already saw are not
// resent.
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { spawn } = require('child_process');
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = true;
const check = (name, ok, detail = '') => { if (!ok) pass = false; console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`); };

const chatReplies = [
  "Sure — that's mostly flights, hotel, and the site tickets, and I'd need to check live prices for those. Want me to price it out? Just tell me what city you'd be flying from, and how many of you are going.",
];
const chatReqs = []; const harnessReqs = [];
const sse = (res, text) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`); res.end(); };
const llm = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
  const j = JSON.parse(b); if (j.stream === false) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'chat' } }] })); return; }
  chatReqs.push(j); sse(res, chatReplies[Math.min(chatReqs.length - 1, chatReplies.length - 1)]); }); });
const harness = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
  harnessReqs.push({ body: JSON.parse(b), sid: req.headers['x-hermes-session-id'] });
  sse(res, harnessReqs.length === 1 ? 'Round trip Denver to Cairo is about $1,150 each; three of you come to roughly $6,900 with the hotel and tickets.' : 'Done.'); }); });
const lastUser = (r) => { const m = r.body.messages.filter((x) => x.role === 'user'); return String(m[m.length - 1].content || ''); };

async function connect(port) {
  let t = null;
  for (let i = 0; i < 80 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(x.url)); } catch (e) {} if (!t) await sleep(250); }
  if (!t) throw new Error('renderer not reachable');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => Promise.race([new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), sleep(20000).then(() => { throw new Error('CDP timeout ' + method); })]);
  return (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((d) => { if (!d.result || d.result.exceptionDetails) throw new Error(JSON.stringify(d.result && d.result.exceptionDetails || d).slice(0, 300)); return d.result.result.value; });
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-ctx-'));
  const hh = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-ctx-hh-'));
  let child = null;
  try {
    await new Promise((r) => llm.listen(0, '127.0.0.1', r)); await new Promise((r) => harness.listen(0, '127.0.0.1', r));
    const port = 9890 + Math.floor(Math.random() * 90);
    child = spawn(require('electron'), ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, path.join(root, 'dist', 'main', 'index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HERMES_HOME: path.join(hh, 'nh'), ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData } });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    const ev = await connect(port);
    await sleep(1500);
    await ev(`(async () => {
      document.querySelectorAll('.onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      await aria.config.set('llm.endpoint', 'http://127.0.0.1:${llm.address().port}/v1/chat/completions');
      await aria.config.set('llm.model', 'mock');
      await aria.config.set('harness.endpoint', 'http://127.0.0.1:${harness.address().port}/v1/chat/completions');
      await aria.config.set('harness.model', 'mock-agent');
      await aria.config.set('routing.classifier', 'off');
      return true; })()`);
    const say = (text) => ev(`(async () => {
      const before = document.querySelectorAll('#conversation .message.assistant').length;
      const input = document.getElementById('text-input');
      input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 100));
        const msgs = [...document.querySelectorAll('#conversation .message.assistant')];
        if (msgs.length > before && msgs[msgs.length - 1].textContent.trim() && document.body.dataset.state !== 'processing') { await new Promise(r => setTimeout(r, 300)); return msgs[msgs.length - 1].textContent; } }
      return null; })()`);

    await say('how much would it cost if i wanted to visit the pyramids of Giza from october 31 to november 15');
    check('trip question is answered by the chat model', chatReqs.length === 1 && harnessReqs.length === 0);
    const reply = await say('okay from longmont colorado and its going to be me and two other friends');
    check('details for the live-price offer go to the harness', harnessReqs.length === 1, `chat=${chatReqs.length} harness=${harnessReqs.length}`);
    const first = harnessReqs[0] ? lastUser(harnessReqs[0]) : '';
    check('harness is pinned to a Hermes session', harnessReqs[0] && /^aria-/.test(harnessReqs[0].sid || ''));
    check('harness sees the trip it never heard', /pyramids of Giza/.test(first) && /october 31/i.test(first) && /price it out/.test(first), first.slice(0, 300));
    check('catch-up labels speakers and keeps the current ask last', /User: how much would it cost/.test(first) && /\[Current request\]\nokay from longmont/.test(first));
    check('the priced answer reaches the user', /\$6,900/.test(reply || ''), reply);
    await say('great, and can you check the flight baggage rules too');
    const second = harnessReqs[1] ? lastUser(harnessReqs[1]) : '';
    check('turns the harness already holds are not resent', harnessReqs.length === 2 && !/pyramids of Giza/.test(second) && !/Conversation so far/.test(second), second.slice(0, 200));
    check('same Hermes session across turns', harnessReqs[1] && harnessReqs[1].sid === harnessReqs[0].sid);
    const sys = String(chatReqs[0].messages[0].content);
    check('chat model is told not to promise actions it cannot take', /never say you are doing it or about to/.test(sys));
  } catch (e) { check('live run', false, e.message); }
  finally {
    if (child) { child.kill('SIGTERM'); await sleep(800); try { child.kill('SIGKILL'); } catch (e) {} }
    llm.close(); harness.close();
    fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(hh, { recursive: true, force: true });
  }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})();
