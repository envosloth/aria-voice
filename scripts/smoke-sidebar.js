#!/usr/bin/env node
// Live check: with many saved conversations the sidebar list fills the column
// down to Settings (no dead space), scrolls instead of overflowing, and
// Settings stays visible — at a normal and a short window height.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-sidebar-'));
// 40 fixture sessions in ARIA's own store.
const now = Date.now();
const sessions = Array.from({ length: 40 }, (_, i) => ({
  id: `s${i}`, title: `Conversation number ${i + 1}`, startedAt: now - i * 3.6e6, updatedAt: now - i * 3.6e6,
  turns: [{ role: 'user', content: 'hi', ts: now }, { role: 'assistant', content: 'hello', ts: now }], pinned: i < 3,
}));
fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify({ sessions }));

const port = 9700 + Math.floor(Math.random() * 90);
const child = spawn(require('electron'), ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
  path.join(root, 'dist', 'main', 'index.js')], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ARIA_IMPORT_HOME: userData, HERMES_HOME: path.join(userData, 'nh'), ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1',
    ARIA_SMOKE_USER_DATA: userData, XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
});
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ok = false;
  try {
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
    const call = (method, params) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    await sleep(1800);
    const measure = `(() => {
      document.querySelectorAll('#onboard-overlay').forEach(e => e.classList.remove('visible'));
      const list = document.getElementById('session-list').getBoundingClientRect();
      const set = document.getElementById('settings-btn').getBoundingClientRect();
      const side = document.querySelector('.sidebar').getBoundingClientRect();
      const el = document.getElementById('session-list');
      return { items: el.querySelectorAll('.session-item').length, gap: Math.round(set.top - list.bottom),
        settingsVisible: set.bottom <= side.bottom + 1 && set.top >= side.top, scrolls: el.scrollHeight > el.clientHeight,
        listH: Math.round(list.height), vh: innerHeight };
    })()`;
    const out = {};
    for (const h of [800, 520]) {
      await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      out[h] = await ev(measure);
    }
    console.log(JSON.stringify(out, null, 2));
    const checks = {};
    for (const h of Object.keys(out)) {
      const m = out[h];
      checks[`h${h}.allListed`] = m.items === 40;
      checks[`h${h}.fillsToSettings`] = m.gap >= 0 && m.gap <= 16;
      checks[`h${h}.settingsVisible`] = m.settingsVisible;
      checks[`h${h}.scrolls`] = m.scrolls;
    }
    checks['usesMoreThanOldCap'] = out[800].listH > 0.34 * 800 + 40;
    // Sorting: default most-recent, pins on top, each order applied, persisted.
    const titles = `[...document.querySelectorAll('#session-list .s-title')].map(e => e.textContent)`;
    const sort = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const sel = document.getElementById('session-sort');
      const r = { present: !!sel, def: sel && sel.value, options: sel ? [...sel.options].map(o => o.value) : [] };
      r.recent = ${titles};
      for (const m of ['oldest', 'az', 'za', 'longest', 'recent', 'oldest']) {
        sel.value = m; sel.dispatchEvent(new Event('change')); await wait(250); r[m] = ${titles};
      }
      r.saved = await aria.config.get('ui.sessionSort');
      sel.value = 'recent'; sel.dispatchEvent(new Event('change')); await wait(200);
      return r;
    })()`);
    const pins = ['Conversation number 1', 'Conversation number 2', 'Conversation number 3'];
    const rest = (a) => a.slice(3);
    const nums = (a) => rest(a).map((t) => Number(t.split(' ').pop()));
    const asc = (a) => a.every((v, i) => !i || a[i - 1] <= v);
    checks['sort.controlPresent'] = sort.present && sort.options.join() === 'recent,oldest,az,za,longest';
    checks['sort.defaultMostRecent'] = sort.def === 'recent' && asc(nums(sort.recent));
    checks['sort.pinsStayOnTop'] = ['recent', 'oldest', 'az', 'za'].every((m) => sort[m].slice(0, 3).every((t) => pins.includes(t)));
    checks['sort.oldestReverses'] = asc(nums(sort.oldest).reverse());
    const byName = (a) => rest(a).every((t, i, arr) => !i || arr[i - 1].localeCompare(t, undefined, { numeric: true, sensitivity: 'base' }) <= 0);
    checks['sort.az'] = byName(sort.az);
    checks['sort.za'] = byName([...sort.za.slice(0, 3), ...rest(sort.za).reverse()]);
    checks['sort.persisted'] = sort.saved === 'oldest';
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
    ws.close();
  } catch (e) {
    console.error('[sidebar] error:', e.message); console.error(log.slice(-1500));
  } finally {
    child.kill('SIGTERM'); await sleep(800); try { child.kill('SIGKILL'); } catch (e) {}
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(ok ? 'smoke:sidebar PASS' : 'smoke:sidebar FAIL');
  process.exit(ok ? 0 : 1);
})();
