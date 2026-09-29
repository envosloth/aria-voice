#!/usr/bin/env node
// Live end-to-end check for desktop context (roadmap P0.3) in the built app,
// against the REAL desktop session (Hyprland/Wayland here) and a mock LLM.
//   - all sources OFF by default: "summarize this" reads nothing;
//   - with Selected text on: a real primary selection (set with wl-copy
//     --primary) reaches the chat model's prompt, the reply shows a chip, and
//     "summarize this" stays on the fast chat path (no agent call);
//   - with Clipboard on and the selection empty: the clipboard is used;
//   - a clipboard holding an API key is withheld (chip says so, never sent);
//   - "what app am I in" reports the last NON-ARIA window from Hyprland focus
//     history, not ARIA itself;
//   - an unrelated utterance ("tell me a joke") reads nothing even with all on;
//   - the header indicator lists enabled sources and opens Settings → Context;
//   - a dropped text file reaches the prompt for that one message only.
// Skips (exit 0, reported) when no Wayland clipboard tools / session exist.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const electron = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasCmd = (c) => { try { execFileSync('sh', ['-c', `command -v ${c}`], { stdio: 'ignore' }); return true; } catch { return false; } };
if (!process.env.WAYLAND_DISPLAY || !hasCmd('wl-copy') || !hasCmd('wl-paste')) {
  console.log('SKIP: needs a Wayland session with wl-clipboard'); process.exit(0);
}
// wl-copy forks a server that keeps the clipboard alive; it inherits stdout, so
// never capture its output or execFileSync waits on that child forever.
const QUIET = { stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 };
const wlCopy = (text, primary) => execFileSync('wl-copy', primary ? ['--primary'] : [], { ...QUIET, input: text });
const wlClear = (primary) => execFileSync('wl-copy', primary ? ['--primary', '--clear'] : ['--clear'], QUIET);
let savedClip = ''; let savedPrimary = '';
try { savedClip = execFileSync('wl-paste', ['--no-newline'], { timeout: 500 }).toString(); } catch {}
try { savedPrimary = execFileSync('wl-paste', ['--primary', '--no-newline'], { timeout: 500 }).toString(); } catch {}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-context-live-'));
const llmReqs = []; const agentReqs = [];
const mk = (sink, reply) => http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = null; try { j = JSON.parse(body); } catch {}
    if (j && j.stream === false) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'chat' } }] })); return; }
    sink.push(j);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
  });
});
const llm = mk(llmReqs, 'Here is the summary.');
const agent = mk(agentReqs, 'Agent reply.');
const sys = (r) => (r && r.messages && r.messages[0] && r.messages[0].content) || '';

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
  const send = (method, params) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const ev = (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 400)); return d.result.result.value; });
  return { ws, ev };
}

(async () => {
  let ok = false; let child = null;
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  await new Promise((r) => agent.listen(0, '127.0.0.1', r));
  try {
    const port = 9700 + Math.floor(Math.random() * 90);
    child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, path.join(root, 'dist', 'main', 'index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData },
    });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    const { ws, ev } = await connect(port);
    await sleep(1500);
    await ev(`(async () => {
      document.querySelectorAll('#onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      const st = document.createElement('style'); st.textContent = '*{transition:none!important}'; document.head.appendChild(st);
      await aria.config.set('llm.endpoint', 'http://127.0.0.1:${llm.address().port}/v1/chat/completions');
      await aria.config.set('llm.model', 'mock');
      await aria.config.set('harness.endpoint', 'http://127.0.0.1:${agent.address().port}/v1/chat/completions');
      await aria.config.set('harness.model', 'mock-agent');
      await aria.config.set('routing.classifier', 'off');
      return true;
    })()`);
    const say = (text) => ev(`(async () => {
      const before = document.querySelectorAll('#conversation .message.assistant').length;
      const input = document.getElementById('text-input');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 100));
        const msgs = [...document.querySelectorAll('#conversation .message.assistant')];
        if (msgs.length > before && msgs[msgs.length - 1].textContent.trim() && !/processing/.test(document.body.dataset.state || '')) {
          const m = msgs[msgs.length - 1];
          return { text: m.textContent.trim(), chips: [...m.querySelectorAll('.context-chip')].map(c => c.textContent) };
        }
      }
      return null;
    })()`);
    const r = {};
    const SEL = 'Ownership is a set of rules that govern how a Rust program manages memory. ZX-SELECTION-MARK';
    wlCopy(SEL, true);
    wlCopy('clipboard text ZX-CLIP-MARK', false);

    let n = llmReqs.length;
    r.off = await say('summarize this');
    r.offSawNothing = llmReqs.length + agentReqs.length > 0 && !/ZX-/.test(JSON.stringify(llmReqs.slice(n).concat(agentReqs)));
    r.offNoChips = r.off && r.off.chips.length === 0;
    r.indicatorHiddenWhenOff = await ev(`document.getElementById('context-indicator').hidden`);

    // Enable via the real Settings checkboxes.
    r.settings = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.getElementById('settings-btn').click(); await wait(300);
      document.getElementById('settings-tab-context').click(); await wait(400);
      const out = {};
      for (const id of ['cfg-context-selection', 'cfg-context-clipboard', 'cfg-context-active-app']) {
        const el = document.getElementById(id);
        out[id] = { disabled: el.disabled, hint: el.parentElement.querySelector('.hint').textContent };
        if (!el.disabled) { el.checked = true; el.dispatchEvent(new Event('change')); }
      }
      await wait(300);
      out.persisted = [await aria.config.get('context.selection'), await aria.config.get('context.clipboard'), await aria.config.get('context.activeApp')];
      document.getElementById('settings-close').click(); await wait(200);
      out.indicator = document.getElementById('context-indicator').textContent;
      out.indicatorShown = !document.getElementById('context-indicator').hidden;
      return out;
    })()`);

    n = llmReqs.length; let a = agentReqs.length;
    r.sel = await say('summarize this');
    r.selPrompt = /ZX-SELECTION-MARK/.test(sys(llmReqs[llmReqs.length - 1])) && llmReqs.length === n + 1;
    r.selStayedOnChat = agentReqs.length === a;
    r.selNotClipboard = !/ZX-CLIP-MARK/.test(sys(llmReqs[llmReqs.length - 1]));
    r.selDataFraming = /not instructions/.test(sys(llmReqs[llmReqs.length - 1]));
    r.selChip = r.sel && r.sel.chips.some((c) => /Selected text/.test(c));
    r.historyClean = !/ZX-SELECTION-MARK/.test(JSON.stringify((llmReqs[llmReqs.length - 1].messages || []).slice(1)));

    wlClear(true);
    n = llmReqs.length;
    r.clip = await say('explain what I copied');
    r.clipPrompt = /ZX-CLIP-MARK/.test(sys(llmReqs[llmReqs.length - 1])) && r.clip && r.clip.chips.some((c) => /Clipboard/.test(c));

    wlCopy('sk-proj-AbCdEf1234567890AbCdEf1234567890', false);
    r.key = await say('explain what I copied');
    r.keyWithheld = !/sk-proj-AbCdEf/.test(JSON.stringify(llmReqs.slice(-1).concat(agentReqs.slice(-1))))
      && r.key && r.key.chips.some((c) => /withheld/.test(c));

    r.app = await say('what app am I in');
    const lastAny = [llmReqs[llmReqs.length - 1], agentReqs[agentReqs.length - 1]].map(sys).join('\n');
    const appLine = (lastAny.match(/Active window: (.*)/) || [])[1] || '';
    r.appLine = appLine;
    r.appNotAria = !!appLine && !/\bARIA\b|electron/i.test(appLine);

    n = llmReqs.length; a = agentReqs.length;
    wlCopy('ZX-SHOULD-NOT-READ', true);
    r.joke = await say('tell me a joke');
    r.jokeReadNothing = !/ZX-SHOULD-NOT-READ/.test(JSON.stringify(llmReqs.slice(n).concat(agentReqs.slice(a)))) && r.joke && r.joke.chips.length === 0;

    // Drop a file on the composer (real DataTransfer through the drop handler).
    r.drop = await ev(`(async () => {
      const dt = new DataTransfer();
      dt.items.add(new File(['# Plan\\nZX-FILE-MARK ship memory'], 'notes.md', { type: 'text/markdown' }));
      const input = document.getElementById('text-input');
      input.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 300));
      return [...document.querySelectorAll('#attached-files .context-chip')].map(c => c.textContent);
    })()`);
    n = llmReqs.length;
    r.fileReply = await say('what is in this file?');
    r.filePrompt = /ZX-FILE-MARK/.test(sys(llmReqs[llmReqs.length - 1] || agentReqs[agentReqs.length - 1]));
    r.fileChipsCleared = await ev(`document.querySelectorAll('#attached-files .context-chip').length === 0`);
    await say('and what else?');
    r.fileOneShot = !/ZX-FILE-MARK/.test(sys(llmReqs[llmReqs.length - 1]) + sys(agentReqs[agentReqs.length - 1]));

    r.indicatorOpensSettings = await ev(`(async () => {
      document.getElementById('context-indicator').click();
      await new Promise(r => setTimeout(r, 300));
      return document.getElementById('settings-overlay').classList.contains('visible')
        && document.getElementById('settings-tab-context').classList.contains('active');
    })()`);
    ws.close();

    console.log(JSON.stringify(r, null, 2));
    const checks = {
      offByDefaultReadsNothing: r.offSawNothing && r.offNoChips && r.indicatorHiddenWhenOff,
      settingsToggleAndPersist: r.settings.persisted.every((v) => v === true) && r.settings.indicatorShown && /selection/.test(r.settings.indicator),
      selectionReachesPrompt: r.selPrompt && r.selNotClipboard && r.selDataFraming,
      textWorkStaysOnChatPath: r.selStayedOnChat,
      contextChipShown: r.selChip,
      contextNotInHistory: r.historyClean,
      clipboardFallback: r.clipPrompt,
      secretWithheld: r.keyWithheld,
      activeAppIsNotAria: r.appNotAria,
      unrelatedReadsNothing: r.jokeReadNothing,
      droppedFileAttached: r.drop.some((c) => /notes\.md/.test(c)) && r.filePrompt && r.fileChipsCleared,
      droppedFileOneMessageOnly: r.fileOneShot,
      indicatorOpensSettings: r.indicatorOpensSettings,
    };
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
  } catch (e) {
    console.error('[context-live] error:', e.message);
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(800); try { child.kill('SIGKILL'); } catch (e) {} }
    llm.close(); agent.close();
    try { savedClip ? wlCopy(savedClip, false) : wlClear(false); } catch {}
    try { savedPrimary ? wlCopy(savedPrimary, true) : wlClear(true); } catch {}
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(`\n=== RESULT: ${ok ? 'PASS' : 'FAIL'} ===`);
  process.exit(ok ? 0 : 1);
})();
