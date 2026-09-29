#!/usr/bin/env node
// Live check: (1) conversation mode + voice barge-in are ON by default on a
// fresh install; (2) the per-message action bar (copy / edit / regenerate)
// never overlaps any message bubble and is never clipped, at several widths,
// for short and long messages.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-msgbar-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ok = false; let child = null;
  try {
    const port = 9200 + Math.floor(Math.random() * 90);
    child = spawn(require('electron'), ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
      path.join(root, 'dist', 'main', 'index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_HOME: path.join(userData, 'nh'), ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData,
        XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
    });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
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
    const call = (method, params) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (expr) => {
      const d = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 400));
      return d.result.result.value;
    };
    await sleep(1500);
    const defaults = await ev(`(async () => ({ conv: await aria.config.get('conversation.enabled'), barge: await aria.config.get('conversation.voiceBargeIn') }))()`);

    const layout = {};
    // Restart on a seeded transcript (saved session) and open it through the UI.
    ws.close();
    child.kill('SIGKILL'); await sleep(800);
    const sid = 'seed';
    const now = Date.now();
    const turns = [['user', 'hi'], ['assistant', 'Hello! How can I help today?'], ['user', 'lorem ipsum '.repeat(60)],
      ['assistant', 'dolor sit amet '.repeat(80)], ['user', 'ok'], ['assistant', 'Done.']]
      .map(([role, content], i) => ({ role, content, ts: now + i }));
    fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify({ sessions: [{ id: sid, title: 'Seed', startedAt: now, updatedAt: now, turns }] }));
    child = spawn(require('electron'), ['--no-sandbox', `--remote-debugging-port=${port + 100}`, `--user-data-dir=${userData}`,
      path.join(root, 'dist', 'main', 'index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_HOME: path.join(userData, 'nh'), ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData,
        XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
    });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    t = null;
    for (let i = 0; i < 80 && !t; i++) {
      try { t = (await (await fetch(`http://127.0.0.1:${port + 100}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(x.url)); } catch (e) {}
      if (!t) await sleep(250);
    }
    const ws2 = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws2.onopen = r; ws2.onerror = j; });
    const pend2 = new Map(); let id2 = 0;
    ws2.onmessage = (m) => { const d = JSON.parse(m.data); if (pend2.has(d.id)) { pend2.get(d.id)(d); pend2.delete(d.id); } };
    const call2 = (method, params) => new Promise((r) => { const n = ++id2; pend2.set(n, r); ws2.send(JSON.stringify({ id: n, method, params })); });
    const ev2 = async (expr) => {
      const d = await call2('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 400));
      return d.result.result.value;
    };
    await sleep(1500);
    await ev2(`(async () => {
      document.querySelectorAll('#onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      document.querySelector('#session-list .session-open').click();
      for (let i = 0; i < 30 && document.querySelectorAll('#conversation .message').length < 6; i++) await new Promise(r => setTimeout(r, 100));
    })()`);
    for (const w of [1280, 1000, 820]) {
      await call2('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      layout[w] = await ev2(`(() => {
        const conv = document.getElementById('conversation').getBoundingClientRect();
        const msgs = [...document.querySelectorAll('#conversation .message')];
        const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        let overlaps = 0, clipped = 0;
        const detail = [];
        for (const m of msgs) {
          const bar = m.querySelector('.msg-actions');
          bar.style.opacity = '1'; // measure as when hovered
          const b = bar.getBoundingClientRect();
          for (const o of msgs) if (hit(b, o.getBoundingClientRect())) { overlaps++; detail.push(m.className + ' over ' + o.className); }
          if (b.left < conv.left - 0.5 || b.right > conv.right + 0.5) { clipped++; detail.push(m.className + ' clipped ' + Math.round(b.left) + '-' + Math.round(b.right) + ' conv ' + Math.round(conv.left) + '-' + Math.round(conv.right)); }
          bar.style.opacity = '';
        }
        return { n: msgs.length, overlaps, clipped, detail: detail.slice(0, 6) };
      })()`);
    }
    ws2.close();
    console.log(JSON.stringify({ defaults, layout }, null, 2));
    const checks = {
      conversationOnByDefault: defaults.conv === true,
      bargeInOnByDefault: defaults.barge === true,
    };
    for (const w of [1280, 1000, 820]) {
      checks[`w${w}.sixBubbles`] = layout[w].n === 6;
      checks[`w${w}.noOverlap`] = layout[w].overlaps === 0;
      checks[`w${w}.notClipped`] = layout[w].clipped === 0;
    }
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
  } catch (e) {
    console.error('[msgbar] error:', e.message);
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(1000); try { child.kill('SIGKILL'); } catch (e) {} }
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(ok ? 'smoke:message-actions PASS' : 'smoke:message-actions FAIL');
  process.exit(ok ? 0 : 1);
})();
