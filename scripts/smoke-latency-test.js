#!/usr/bin/env node
// End-to-end check of Settings → Performance → Test. Real TTS + STT sidecars,
// a mock streaming AI with a known 300 ms time-to-first-token, and the real
// button in the real UI. Verifies the result is real (transcript matches the
// test phrase, AI stage >= 300 ms, parts add up), that nothing was played to
// the speakers, and that no conversation/session was created.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-ttfa-'));
const TTFT = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let aiRequests = 0; let lastUserMsg = '';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    aiRequests++;
    try { const j = JSON.parse(body); lastUserMsg = j.messages[j.messages.length - 1].content; } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const toks = 'Hello there, it is lovely to hear from you today.'.split(' ');
    let i = 0;
    const send = () => {
      if (i < toks.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: toks[i] + ' ' } }] })}\n\n`); i++; setTimeout(send, 20); }
      else { res.write('data: [DONE]\n\n'); res.end(); }
    };
    setTimeout(send, TTFT);
  });
});

(async () => {
  let ok = false; let child = null; let log = '';
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const port = 9500 + Math.floor(Math.random() * 90);
    child = spawn(require('electron'), ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
      path.join(root, 'dist', 'main', 'index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_HOME: path.join(userData, 'nh'), ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1',
        ARIA_SMOKE_USER_DATA: userData, XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
    });
    child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    let t = null;
    for (let i = 0; i < 80 && !t; i++) {
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
    await sleep(1500);
    const script = `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelectorAll('#onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      // Count any audio the renderer is asked to play during the test.
      await aria.config.set('llm.endpoint', "__EP__");
      await aria.config.set('llm.model', 'mock');
      let played = 0; aria.tts.onAudio(() => { played++; });
      document.getElementById('settings-btn').click(); await wait(300);
      document.querySelector('#settings-nav .snav-item[data-tab="performance"]').click(); await wait(200);
      const btn = document.getElementById('perf-test-btn');
      const out = { label: btn.textContent, visible: btn.getClientRects().length > 0 };
      const t0 = performance.now();
      btn.click();
      out.busyLabel = btn.textContent; out.busyDisabled = btn.disabled;
      for (let i = 0; i < 1200 && btn.disabled; i++) await wait(100);
      out.wallMs = Math.round(performance.now() - t0);
      out.status = document.getElementById('perf-test-status').textContent;
      out.firstAudio = document.getElementById('perf-first-audio').textContent;
      out.stt = document.getElementById('perf-stt').textContent;
      out.llm = document.getElementById('perf-llm').textContent;
      out.tts = document.getElementById('perf-tts').textContent;
      out.after = btn.textContent;
      out.played = played;
      out.messages = document.querySelectorAll('#conversation .message').length;
      out.sessions = (await aria.sessions.list()).length;
      out.raw = await aria.perf.latencyTest();   // second run, raw numbers
      return out;
    })()`;
    const r = await ev(script.replace('"__EP__"', JSON.stringify(endpoint)));
    ws.close();
    console.log(JSON.stringify(r, null, 2));
    const ms = (s) => (/s$/.test(s) && !/ms$/.test(s) ? parseFloat(s) * 1000 : parseFloat(s));
    const raw = r.raw || {};
    const checks = {
      buttonShown: r.visible && r.label === 'Test',
      busyState: r.busyLabel === 'Testing…' && r.busyDisabled,
      finished: r.after === 'Test again' && /^Time to first audio: /.test(r.status),
      heardPhrase: /greet me/i.test(r.status) && /greet me/i.test(lastUserMsg),
      numbersShown: [r.firstAudio, r.stt, r.llm, r.tts].every((v) => /\d/.test(v)),
      aiStageRealistic: ms(r.llm) >= TTFT,
      partsAddUp: raw.ok && Math.abs(raw.firstAudioMs - (raw.sttMs + raw.llmMs + raw.ttsMs)) <= 60,
      silent: r.played === 0,
      offTheRecord: r.messages === 0 && r.sessions === 0,
      aiCalledOncePerRun: aiRequests === 2,
    };
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
  } catch (e) {
    console.error('[ttfa] error:', e.message);
    console.error(log.split('\n').slice(-25).join('\n'));
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(1500); try { child.kill('SIGKILL'); } catch (e) {} }
    server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(ok ? 'smoke:latency-test PASS' : 'smoke:latency-test FAIL');
  process.exit(ok ? 0 : 1);
})();
