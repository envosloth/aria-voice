#!/usr/bin/env node
// Live renderer check for the UX layer: boots the real built app (ARIA_SMOKE),
// attaches over CDP, and exercises the error banner mapping + fix button, the
// per-message actions, and the orb 'speaking' truth in a real DOM.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-ux-live-'));
const port = 9400 + Math.floor(Math.random() * 400);
const electron = require('electron');
const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
  path.join(root, 'dist', 'main', 'index.js')], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ARIA_IMPORT_HOME: userData, HERMES_HOME: path.join(userData, 'no-hermes'), ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData,
    XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const t = list.find((x) => x.type === 'page' && /index\.html/.test(x.url));
      if (t) return t;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('renderer not reachable over CDP');
}

(async () => {
  let ok = false;
  try {
    const t = await target();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const evaluate = (expr) => new Promise((r) => {
      const n = ++id; pending.set(n, r);
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    }).then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 400)); return d.result.result.value; });

    await sleep(1500);
    const out = await evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelectorAll('#onboard-overlay,#settings-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      const r = {};
      r.cssLoaded = [...document.styleSheets].some(s => /ux\\.css$/.test(s.href || ''));
      // Real path: typed message -> IPC -> coordinator with nothing configured.
      // First-run auto-connect may have found a local Hermes gateway; clear it
      // so this deterministically exercises the not-connected error.
      // Wait for auto-connect to settle (it may set harness.endpoint late).
      for (let i = 0; i < 40; i++) {
        if (await aria.config.get('harness.endpoint') || await aria.config.get('ui.onboarded')) break;
        await wait(100);
      }
      await wait(500);
      for (const k of ['llm.endpoint', 'harness.endpoint']) await aria.config.set(k, '');
      await wait(200); document.getElementById('error-dismiss').click();
      r.endpointsCleared = !(await aria.config.get('harness.endpoint')) && !(await aria.config.get('llm.endpoint'));
      const ti = document.getElementById('text-input');
      ti.value = 'what is the weather';
      ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 40 && !document.getElementById('error-banner').classList.contains('visible'); i++) await wait(100);
      r.bannerText = document.getElementById('error-text').textContent;
      r.bannerTitle = document.getElementById('error-text').title;
      const btn = document.querySelector('.error-banner .error-action');
      r.actionLabel = btn && !btn.hidden ? btn.textContent : null;
      const u = document.querySelector('#conversation .message.user');
      r.userActions = u ? [...u.querySelectorAll('.msg-action')].map(b => b.dataset.act) : [];
      r.userTextUnpolluted = u ? u.textContent === 'what is the weather' : false;
      r.actionsHiddenAtRest = u ? getComputedStyle(u.querySelector('.msg-actions')).opacity === '0' : false;
      if (u) u.querySelector('[data-act=edit]').click();
      r.editFilled = ti.value; ti.value = '';
      const a = document.querySelector('#conversation .message.assistant');
      r.assistantActions = a ? [...a.querySelectorAll('.msg-action')].map(b => b.dataset.act) : null;
      if (btn) btn.click();
      await wait(300);
      r.fixOpensSettings = document.getElementById('settings-overlay').classList.contains('visible');
      r.bannerClearedAfterFix = !document.getElementById('error-banner').classList.contains('visible');
      r.reducedMotionRule = [...document.styleSheets].filter(s => /ux\\.css$/.test(s.href || ''))
        .some(s => [...s.cssRules].some(x => x.media && /prefers-reduced-motion/.test(x.media.mediaText)));
      return r;
    })()`);
    console.log(JSON.stringify(out, null, 2));
    const checks = {
      cssLoaded: out.cssLoaded,
      plainNotConnected: out.bannerText === 'ARIA is not connected to an AI yet.',
      rawKeptAsTooltip: /^Details: No LLM or agent harness configured/.test(out.bannerTitle),
      fixButton: out.actionLabel === 'Connect',
      fixOpensSettings: out.fixOpensSettings && out.bannerClearedAfterFix,
      userActions: out.userActions.join() === 'copy,edit,retry',
      textUnpolluted: out.userTextUnpolluted,
      editFills: out.editFilled === 'what is the weather',
      hiddenAtRest: out.actionsHiddenAtRest,
      reducedMotionRule: out.reducedMotionRule,
    };
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
    ws.close();
  } catch (e) {
    console.error('[ux-live] error:', e.message);
    console.error(log.split('\n').slice(-20).join('\n'));
  } finally {
    child.kill('SIGTERM');
    await sleep(800);
    try { child.kill('SIGKILL'); } catch (e) {}
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(ok ? 'smoke:ux-live PASS' : 'smoke:ux-live FAIL');
  process.exit(ok ? 0 : 1);
})();
