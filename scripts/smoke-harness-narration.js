#!/usr/bin/env node
// Harness narration: while the agent harness works with tools, ARIA tells the
// user what it is doing ("I'll search the web for ...") in its own voice.
//  - unit: tool -> spoken phrase mapping, search-query inclusion, internal tools
//    stay silent, no agent/model plumbing words;
//  - stream: Hermes `hermes.tool.progress` frames surface the tool + its label;
//  - live Electron + mock harness: narration is spoken BEFORE the answer, each
//    distinct tool once, never shown in the transcript, generic 5 s filler
//    suppressed; a fast tool-less reply is not narrated; wake word shows Off
//    (not a stuck "Starting…") when disabled, and is on for a fresh profile.
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { spawn } = require('child_process');
const A = require('../src/renderer/audio-utils.js');
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = true;
const check = (name, ok, detail = '') => { if (!ok) pass = false; console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`); };

// ---- unit ----
const N = A.toolNarration;
check('web search names the query', /search the web/i.test(N('web_search', 'weather in Longmont')) && /weather in Longmont/.test(N('web_search', 'weather in Longmont')), N('web_search', 'weather in Longmont'));
check('web search without label', /search the web/i.test(N('web_search')));
check('long query is shortened', N('web_search', 'a b c d e f g h i j k l m n o p').split(/\s+/).length < 18);
check('query url never read', !/https?:|www\./.test(N('web_search', 'https://example.com/x')));
check('page reading', /read/i.test(N('web_extract')) && /read|page|site/i.test(N('browser_navigate')));
check('terminal / code', /run/i.test(N('terminal')) && /run/i.test(N('execute_code')));
check('files', /files/i.test(N('read_file')) && /files/i.test(N('search_files')) && /change/i.test(N('patch')));
check('internal tools stay silent', !N('todo') && !N('skill_view') && !N('memory_internal_probe_') && !N(''));
check('no agent plumbing words', ['web_search', 'delegate_task', 'terminal', 'mcp_github_create_issue', 'vision_analyze'].every((t) => !/agent|harness|model|assistant|tool/i.test(N(t) || '')), ['delegate_task', 'mcp_github_create_issue'].map((t) => N(t)).join(' | '));
check('unknown tools get a generic step line', typeof N('mcp_github_create_issue') === 'string' && N('mcp_github_create_issue').length > 0);

// ---- live ----
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-narration-'));
const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-narration-hh-'));
let harnessMode = 'tools';
const harness = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (o, ev) => res.write((ev ? `event: ${ev}\n` : '') + `data: ${JSON.stringify(o)}\n\n`);
    frame({ choices: [{ delta: { role: 'assistant' } }] });
    if (harnessMode === 'tools') {
      await sleep(400);
      frame({ tool: 'web_search', emoji: '🔎', label: 'weather in Longmont', toolCallId: 't1', status: 'running' }, 'hermes.tool.progress');
      await sleep(1800);
      frame({ tool: 'web_search', toolCallId: 't1', status: 'completed' }, 'hermes.tool.progress');
      frame({ tool: 'web_extract', label: 'weather.gov forecast', toolCallId: 't2', status: 'running' }, 'hermes.tool.progress');
      await sleep(1800);
      frame({ tool: 'todo', label: 'plan', toolCallId: 't3', status: 'running' }, 'hermes.tool.progress');
      await sleep(3600);
    }
    frame({ choices: [{ delta: { content: 'It is 72 degrees and sunny in Longmont.' } }] });
    res.write('data: [DONE]\n\n'); res.end();
  });
});
const llm = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Chat reply.' } }] })}\n\ndata: [DONE]\n\n`); res.end(); });

async function connect(port) {
  let t = null;
  for (let i = 0; i < 80 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(x.url)); } catch (e) {} if (!t) await sleep(250); }
  if (!t) throw new Error('renderer not reachable');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const spoken = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.consoleAPICalled' && d.params.args[0] && d.params.args[0].value === '__TTSPLAY__') spoken.push({ text: d.params.args[1].value, at: Date.now() }); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => Promise.race([new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), sleep(15000).then(() => { throw new Error('CDP timeout ' + method); })]);
  const ev = (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((d) => { if (!d.result || d.result.exceptionDetails) throw new Error(JSON.stringify(d.result && d.result.exceptionDetails || d).slice(0, 400)); return d.result.result.value; });
  return { ws, ev, send, spoken };
}

(async () => {
  let child = null;
  try {
    await new Promise((r) => harness.listen(0, '127.0.0.1', r));
    await new Promise((r) => llm.listen(0, '127.0.0.1', r));
    const port = 9800 + Math.floor(Math.random() * 90);
    child = spawn(require('electron'), ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, path.join(root, 'dist', 'main', 'index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HERMES_HOME: path.join(hermesHome, 'nh'), ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData },
    });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    const { ev, send, spoken } = await connect(port);
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await sleep(1500);
    check('fresh profile has the wake word on', await ev(`aria.config.get('wakeword.enabled')`) === true);
    const toggleWake = (on) => ev(`(async () => {
      document.querySelectorAll('.onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      document.getElementById('settings-btn').click(); await new Promise(r => setTimeout(r, 400));
      document.getElementById('settings-tab-voice').click(); await new Promise(r => setTimeout(r, 300));
      document.getElementById('cfg-ww-enabled').checked = ${on};
      document.getElementById('settings-save').click();
      for (let i = 0; i < 60 && document.getElementById('settings-save').disabled; i++) await new Promise(r => setTimeout(r, 100));
      document.getElementById('settings-close').click(); await new Promise(r => setTimeout(r, 2500));
      return document.getElementById('status-wakeword-text').textContent; })()`);
    const offText = await toggleWake(false);
    check('disabled wake word reads Off, not Starting', offText === 'Off', offText);
    const onText = await toggleWake(true);
    check('re-enabled wake word leaves Off', onText !== 'Off', onText);
    // Logpoint on the single speech funnel: records every spoken request without a test hook.
    await send('Debugger.enable');
    await send('Runtime.enable');
    const src = fs.readFileSync(path.join(root, 'dist/renderer/app.js'), 'utf8').split('\n');
    const line = src.findIndex((l) => /^function ttsPlay\(text, replyId, replyDone\) \{/.test(l));
    await send('Debugger.setBreakpointByUrl', { urlRegex: 'renderer/app\\.js$', lineNumber: line + 1, condition: `console.log('__TTSPLAY__', String(text)), false` });
    await ev(`(async () => {
      document.querySelectorAll('.onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      await aria.config.set('llm.endpoint', 'http://127.0.0.1:${llm.address().port}/v1/chat/completions');
      await aria.config.set('llm.model', 'mock');
      await aria.config.set('harness.endpoint', 'http://127.0.0.1:${harness.address().port}/v1/chat/completions');
      await aria.config.set('harness.model', 'mock-agent');
      await aria.config.set('routing.classifier', 'off');
      await aria.config.set('routing.mode', 'harness');
      return true; })()`);
    const say = (text) => ev(`(async () => {
      const before = document.querySelectorAll('#conversation .message.assistant').length;
      const input = document.getElementById('text-input');
      input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 100));
        const msgs = [...document.querySelectorAll('#conversation .message.assistant')];
        const m = msgs[msgs.length - 1];
        if (msgs.length > before && /72 degrees/.test(m.textContent)) return m.textContent; }
      return null; })()`);

    const t0 = Date.now();
    const shown = await say("what's the weather in my location");
    await sleep(800);
    const texts = spoken.map((s) => s.text);
    const answerAt = texts.findIndex((t) => /72 degrees/.test(t));
    const searchAt = texts.findIndex((t) => /search the web/i.test(t) && /weather in Longmont/.test(t));
    const readAt = texts.findIndex((t) => /read/i.test(t) && !/72 degrees/.test(t));
    check('announces the web search before answering', searchAt >= 0 && answerAt > searchAt, JSON.stringify(texts));
    check('announces the next step too', readAt > searchAt && readAt < answerAt);
    check('first narration is prompt (< 1.5 s after the tool starts)', searchAt >= 0 && spoken[searchAt].at - t0 < 2500, `${searchAt >= 0 ? spoken[searchAt].at - t0 : -1}ms after submit`);
    check('internal tools are not narrated', !texts.some((t) => /todo|plan/i.test(t)));
    check('generic hold-on filler is replaced by real narration', !texts.some((t) => /one moment|let me check the weather/i.test(t)), JSON.stringify(texts));
    check('each tool announced once', texts.filter((t) => /search the web/i.test(t)).length === 1);
    check('narration never enters the transcript', shown && /72 degrees/.test(shown) && !/search the web|reading/i.test(shown), shown);

    harnessMode = 'fast'; spoken.length = 0;
    await say('what is the weather');
    await sleep(600);
    check('fast tool-less reply is not narrated', spoken.length >= 1 && spoken.every((s) => /72 degrees/.test(s.text)), JSON.stringify(spoken.map((s) => s.text)));
  } catch (e) { check('live run', false, e.message); }
  finally {
    if (child) { child.kill('SIGTERM'); await sleep(800); try { child.kill('SIGKILL'); } catch (e) {} }
    harness.close(); llm.close();
    fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(hermesHome, { recursive: true, force: true });
  }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})();
