#!/usr/bin/env node
// Live check: the "Current conversation" tile is gone, the whole UI renders in
// ONE font family, and Settings → Appearance → Font switches it everywhere
// (presets + custom installed font), rejects unsafe names, and persists.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-font-'));
const electron = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { ws, ev };
}
// Distinct computed font-family values across every visible text element.
const FAMILIES = `(() => {
  const set = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!el.getClientRects().length) continue;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())) continue;
    if (el.closest('.font-preview, #cfg-font')) continue; // the picker previews each font on purpose
    set.add(getComputedStyle(el).fontFamily);
  }
  return [...set];
})()`;

(async () => {
  let ok = false; let child = null;
  try {
    const port1 = 9600 + Math.floor(Math.random() * 150);
    child = boot(port1);
    let { ws, ev } = await connect(port1);
    await sleep(1500);
    const r = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelectorAll('#onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      const out = {};
      out.tileGone = !document.getElementById('current-session-tile') && !/Current conversation\\s*local/.test(document.body.innerText);
      out.familiesMain = ${FAMILIES};
      document.getElementById('settings-btn').click();
      await wait(300);
      document.querySelector('#settings-nav .snav-item[data-tab="appearance"]').click();
      await wait(200);
      out.familiesSettings = ${FAMILIES};
      const sel = document.getElementById('cfg-font');
      out.options = [...sel.options].map(o => o.value);
      // Sidebar header must fit (nothing clipped) under every font preset.
      out.headerOverflow = {};
      for (const f of out.options.filter(v => v !== 'custom')) {
        sel.value = f; sel.dispatchEvent(new Event('change'));
        await wait(120);
        const h = document.getElementById('new-session-btn').parentElement;
        const hr = h.getBoundingClientRect();
        const worst = Math.max(...[...h.children].map(c => c.getBoundingClientRect().right));
        out.headerOverflow[f] = Math.round(Math.max(0, worst - hr.right, h.scrollWidth - h.clientWidth));
      }
      sel.value = 'serif'; sel.dispatchEvent(new Event('change'));
      await wait(300);
      out.serifApplied = /Charter|Georgia|serif/.test(getComputedStyle(document.querySelector('#text-input')).fontFamily)
        && getComputedStyle(document.querySelector('.cap') || document.body).fontFamily === getComputedStyle(document.body).fontFamily;
      out.familiesSerif = ${FAMILIES};
      sel.value = 'custom'; sel.dispatchEvent(new Event('change'));
      await wait(200);
      out.customRowShown = !document.getElementById('cfg-font-custom-row').hidden;
      const inp = document.getElementById('cfg-font-custom');
      inp.value = 'Definitely Not A Font 42'; inp.dispatchEvent(new Event('input'));
      await wait(100);
      out.missingMsg = document.getElementById('cfg-font-custom-status').textContent;
      inp.value = 'DejaVu Sans'; inp.dispatchEvent(new Event('input'));
      await wait(600);
      out.customMsg = document.getElementById('cfg-font-custom-status').textContent;
      out.customApplied = getComputedStyle(document.body).fontFamily;
      out.badNameRejected = await aria.config.set('ui.fontCustom', 'x; } body { display:none').then(() => false, () => true);
      return out;
    })()`);
    ws.close();
    child.kill('SIGTERM'); await sleep(1200); try { child.kill('SIGKILL'); } catch (e) {}

    // Relaunch: the choice must persist and apply before any interaction.
    const port2 = port1 + 200;
    child = boot(port2);
    ({ ws, ev } = await connect(port2));
    await sleep(1500);
    r.afterRestart = await ev(`getComputedStyle(document.body).fontFamily`);
    ws.close();

    console.log(JSON.stringify(r, null, 2));
    const checks = {
      tileGone: r.tileGone,
      sidebarHeaderFitsAllFonts: Object.values(r.headerOverflow).every((px) => px === 0),
      oneFontMain: r.familiesMain.length === 1,
      oneFontSettings: r.familiesSettings.length === 1,
      presetsOffered: ['system', 'sans', 'humanist', 'rounded', 'geometric', 'serif', 'mono', 'readable', 'custom'].every((x) => r.options.includes(x)),
      presetAppliesEverywhere: r.serifApplied && r.familiesSerif.length === 1 && /serif/.test(r.familiesSerif[0]),
      customFlow: r.customRowShown && /isn't installed/.test(r.missingMsg) && /^Using DejaVu Sans\./.test(r.customMsg)
        && /^"DejaVu Sans"/.test(r.customApplied),
      unsafeNameRejected: r.badNameRejected,
      persistsAcrossRestart: /^"DejaVu Sans"/.test(r.afterRestart),
    };
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
  } catch (e) {
    console.error('[font] error:', e.message);
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(800); try { child.kill('SIGKILL'); } catch (e) {} }
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(ok ? 'smoke:font PASS' : 'smoke:font FAIL');
  process.exit(ok ? 0 : 1);
})();
