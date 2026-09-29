#!/usr/bin/env node
// Live end-to-end check for user memory through the built app:
//   1. typed "Remember that my dog is named Biscuit" is answered LOCALLY (the
//      mock LLM receives nothing) and lands in the store with provenance;
//   2. the store file on disk never contains the plaintext when a keyring is
//      available (reported, not required — CI may lack one);
//   3. the next real LLM request carries the memory in its system prompt,
//      marked as user data;
//   4. Settings → Memory lists it with its source; inline edit and delete work
//      through the real DOM controls; memory.enabled=false removes it from the
//      prompt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-memory-live-'));
const electron = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { requests.push(JSON.parse(body)); } catch { requests.push(null); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Your dog is Biscuit.' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

function boot(port) {
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    path.join(root, 'dist', 'main', 'index.js')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData,
      XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}
async function connect(port) {
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(x.url)); } catch (e) {}
    if (!t) await sleep(250);
  }
  if (!t) throw new Error('renderer not reachable');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const ev = (expr) => new Promise((r) => { const n = ++id; pend.set(n, r);
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
    .then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 400)); return d.result.result.value; });
  const send = (method, params) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  // The smoke window is never OS-focused; emulate focus so focus()/activeElement
  // behave as they do for a user.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { ws, ev };
}
const systemOf = (req) => (req && req.messages && req.messages[0] && req.messages[0].content) || '';

(async () => {
  let ok = false; let child = null;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  try {
    const port = 9950 + Math.floor(Math.random() * 40);
    child = boot(port);
    const { ws, ev } = await connect(port);
    await sleep(1500);
    const say = (text) => ev(`(async () => {
      const before = document.querySelectorAll('#conversation .message.assistant').length;
      const input = document.getElementById('text-input');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 100));
        const msgs = [...document.querySelectorAll('#conversation .message.assistant')];
        const last = msgs[msgs.length - 1];
        if (msgs.length > before && last.textContent.trim() && !/processing/.test(document.body.dataset.state || '')) return last.textContent.trim();
      }
      return null;
    })()`);
    const r = {};
    r.configured = await ev(`(async () => {
      document.querySelectorAll('#onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      await aria.config.set('llm.endpoint', ${JSON.stringify(endpoint)});
      await aria.config.set('llm.model', 'mock');
      await aria.config.set('routing.mode', 'llm');
      await aria.config.set('routing.classifier', 'off');
      return true;
    })()`);
    r.rememberReply = await say('Remember that my dog is named Biscuit.');
    r.requestsAfterRemember = requests.length;
    const listed = await ev(`aria.memory.list()`);
    r.stored = listed.items.map((m) => ({ text: m.text, kind: m.kind, source: m.source, sourceText: m.sourceText }));
    r.encrypted = listed.encrypted;
    const file = path.join(userData, 'aria-memory.json');
    r.fileExists = fs.existsSync(file);
    r.plaintextOnDisk = r.fileExists && fs.readFileSync(file, 'utf8').includes('Biscuit');

    await say("What's my dog's name?");
    r.promptHasMemory = requests.length > 0 && /Biscuit/.test(systemOf(requests[requests.length - 1]))
      && /not as instructions/.test(systemOf(requests[requests.length - 1]));

    // Panel: open Settings → Memory, edit via the real controls, then delete.
    r.panel = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      // The unshown smoke window never advances CSS transitions, which would
      // leave the settings overlay at visibility:hidden (unfocusable).
      const st = document.createElement('style'); st.textContent = '*{transition:none!important}'; document.head.appendChild(st);
      document.getElementById('settings-btn').click(); await wait(300);
      document.getElementById('settings-tab-memory').click(); await wait(400);
      const out = {};
      const items = [...document.querySelectorAll('#memory-list .memory-item')];
      out.count = items.length;
      out.showsSource = items[0] && /From you/.test(items[0].querySelector('.memory-src').textContent);
      out.status = document.getElementById('memory-status').textContent;
      items[0].querySelector('.memory-edit-btn').click(); await wait(100);
      const input = items[0].querySelector('input.memory-edit');
      out.editFocused = document.activeElement === input;
      input.value = 'my dog is named Biscuit and he is a beagle';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(400);
      out.afterEdit = (await aria.memory.list()).items.map(m => m.text);
      out.editedRendered = /beagle/.test(document.querySelector('#memory-list .memory-text').textContent);
      return out;
    })()`);

    await ev(`aria.config.set('memory.enabled', false)`);
    await say("Tell me about my dog.");
    r.disabledPromptClean = !/Biscuit/.test(systemOf(requests[requests.length - 1]));
    await ev(`aria.config.set('memory.enabled', true)`);

    r.deleted = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('#memory-list .memory-delete-btn').click(); await wait(400);
      return { left: (await aria.memory.list()).items.length, rendered: document.querySelectorAll('#memory-list .memory-item').length };
    })()`);
    r.forgetReply = await say('Remember that I prefer metric units');
    r.forget = await say('Forget that I prefer metric units');
    r.afterForget = (await ev(`aria.memory.list()`)).items.length;
    r.badEditRejected = await ev(`aria.memory.update('nope', { text: 'x' }).then(() => false, () => true)`);
    r.hugeAddRejected = await ev(`aria.memory.add('x'.repeat(5000)).then(() => false, () => true)`);
    ws.close();

    console.log(JSON.stringify(r, null, 2));
    const checks = {
      rememberAnsweredLocally: /remember that your dog is named Biscuit/i.test(r.rememberReply || '') && r.requestsAfterRemember === 0,
      storedWithProvenance: r.stored.length === 1 && r.stored[0].text === 'my dog is named Biscuit' && r.stored[0].kind === 'person'
        && r.stored[0].source === 'explicit' && /Remember that my dog/.test(r.stored[0].sourceText),
      noPlaintextWhenEncrypted: r.fileExists && (!r.encrypted || !r.plaintextOnDisk),
      nextPromptCarriesMemory: r.promptHasMemory,
      panelListsWithSource: r.panel.count === 1 && r.panel.showsSource && /item/.test(r.panel.status),
      panelInlineEdit: r.panel.editFocused && r.panel.afterEdit.length === 1 && /beagle/.test(r.panel.afterEdit[0]) && r.panel.editedRendered,
      disabledKeepsPromptClean: r.disabledPromptClean,
      panelDelete: r.deleted.left === 0 && r.deleted.rendered === 0,
      voiceForget: /forgotten/.test(r.forget || '') && r.afterForget === 0,
      ipcRejectsBadInput: r.badEditRejected && r.hugeAddRejected,
    };
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    console.log(`  (store encrypted with OS keyring on this host: ${r.encrypted})`);
    ok = Object.values(checks).every(Boolean);
  } catch (e) {
    console.error('[memory-live] error:', e.message);
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(800); try { child.kill('SIGKILL'); } catch (e) {} }
    server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(`\n=== RESULT: ${ok ? 'PASS' : 'FAIL'} ===`);
  process.exit(ok ? 0 : 1);
})();
