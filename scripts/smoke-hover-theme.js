#!/usr/bin/env node
// Live check, real mouse over the real window:
//  (1) hovering a bubble shows its actions, and the pointer can travel from the
//      bubble onto Copy / Regenerate and click them (they must not vanish on
//      the way); Copy puts the text on the clipboard; Regenerate resends;
//  (2) themes recolour text: switching theme changes the text of bubbles, the
//      sidebar, the status strip, the composer and Settings, and every one
//      still reads at >= 4.5:1 on what is actually behind it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-hover-theme-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = true;
const check = (name, ok, detail = '') => { if (!ok) pass = false; console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`); };

(async () => {
  let child = null;
  try {
    const now = Date.now();
    const turns = [['user', 'how far is the moon'], ['assistant', 'About 384,400 kilometres on average.'],
      ['user', 'and the sun'], ['assistant', 'About 150 million kilometres, which light covers in roughly eight minutes.']]
      .map(([role, content], i) => ({ role, content, ts: now + i }));
    fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify({ sessions: [{ id: 'seed', title: 'Seed', startedAt: now, updatedAt: now, turns }] }));
    const port = 9300 + Math.floor(Math.random() * 90);
    child = spawn(require('electron'), ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, path.join(root, 'dist', 'main', 'index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_HOME: path.join(userData, 'nh'), ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_SHOW: '1', ARIA_SMOKE_USER_DATA: userData,
        XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
    });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let t = null;
    for (let i = 0; i < 80 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(x.url)); } catch (e) {} if (!t) await sleep(250); }
    if (!t) throw new Error('renderer not reachable');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
    const send = (method, params = {}) => Promise.race([new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), sleep(10000).then(() => { throw new Error('CDP timeout ' + method); })]);
    const ev = async (expr) => { const d = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (!d.result || d.result.exceptionDetails) throw new Error(JSON.stringify(d.result && d.result.exceptionDetails || d).slice(0, 300)); return d.result.result.value; };
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    await ev(`(async () => {
      document.querySelectorAll('.onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      // First-run auto-connect can find the user's real local agent; a test must
      // never send it anything. Let it settle, then blank both endpoints.
      await new Promise(r => setTimeout(r, 1500));
      await aria.config.set('llm.endpoint', ''); await aria.config.set('harness.endpoint', '');
      document.querySelector('#session-list .session-open').click();
      for (let i = 0; i < 40 && document.querySelectorAll('#conversation .message').length < 4; i++) await new Promise(r => setTimeout(r, 100));
      return true; })()`);

    // ---- (1) hover, travel, click ----
    const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    const click = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await sleep(60); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); };
    for (const role of ['assistant', 'user']) {
      const geo = await ev(`(() => { const m = [...document.querySelectorAll('#conversation .message.${role}')].pop(); m.scrollIntoView({ block: 'center' });
        return new Promise((res) => setTimeout(() => { const r = m.getBoundingClientRect(); const c = m.querySelector('.msg-action[data-act="copy"]').getBoundingClientRect();
        res({ m: { l: r.left, r: r.right, t: r.top, b: r.bottom }, c: { x: c.left + c.width / 2, y: c.top + c.height / 2, w: c.width } }); }, 300)); })()`);
      if (false) await ev(`(() => { const m = null; const r = {}; const c = {};
        return { m: { l: r.left, r: r.right, t: r.top, b: r.bottom }, c: { x: c.left + c.width / 2, y: c.top + c.height / 2, w: c.width } }; })()`);
      await move(700, 20); await sleep(250);
      const sx = role === 'assistant' ? geo.m.r - 12 : geo.m.l + 12; const sy = geo.m.t + 12;
      await move(sx, sy); await sleep(250);
      const shown = await ev(`getComputedStyle([...document.querySelectorAll('#conversation .message.${role}')].pop().querySelector('.msg-actions')).opacity`);
      check(`${role}: actions appear on hover`, Number(shown) > 0.9, shown + ' under=' + await ev(`(() => { const e = document.elementFromPoint(${sx}, ${sy}); return e ? (e.id || e.className || e.tagName) : null; })()`) + ' geo=' + JSON.stringify(geo.m));
      // Walk the pointer from the bubble to Copy in small steps, as a hand would.
      let vanished = null;
      for (let i = 1; i <= 12; i++) {
        const x = sx + (geo.c.x - sx) * i / 12, y = sy + (geo.c.y - sy) * i / 12;
        await move(x, y); await sleep(25);
        const st = await ev(`(() => { const b = [...document.querySelectorAll('#conversation .message.${role}')].pop().querySelector('.msg-actions'); const s = getComputedStyle(b); return { o: Number(s.opacity), v: s.visibility, p: s.pointerEvents, hit: document.elementFromPoint(${x}, ${y})?.closest('.msg-actions') === b || document.elementFromPoint(${x}, ${y})?.closest('.message') === b.parentElement }; })()`);
        if ((st.o < 0.5 || st.v === 'hidden' || st.p === 'none') && vanished === null) vanished = `step ${i} at (${Math.round(x)},${Math.round(y)}) ${JSON.stringify(st)} under=${await ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? (e.id || e.className || e.tagName) + ' < ' + (e.parentElement && (e.parentElement.id || e.parentElement.className)) : null; })()`)}`;
      }
      if (vanished) console.log('GEO', role, JSON.stringify(await ev(`(() => { const m = [...document.querySelectorAll('#conversation .message.${role}')].pop(); const b = m.querySelector('.msg-actions'); const r = (e) => { const x = e.getBoundingClientRect(); return [Math.round(x.left), Math.round(x.top), Math.round(x.right), Math.round(x.bottom)]; }; return { msg: r(m), bar: r(b), bridge: getComputedStyle(b, '::before').width + ' ' + getComputedStyle(b, '::before').right, copy: r(b.querySelector('[data-act=copy]')) }; })()`)));
      check(`${role}: actions stay while moving onto Copy`, vanished === null, vanished || '');
      const hit = await ev(`document.elementFromPoint(${geo.c.x}, ${geo.c.y})?.dataset?.act || document.elementFromPoint(${geo.c.x}, ${geo.c.y})?.className`);
      check(`${role}: Copy is the element under the pointer`, hit === 'copy', String(hit));
      await ev(`navigator.clipboard.writeText('').catch(() => {})`);
      await click(geo.c.x, geo.c.y); await sleep(250);
      const copied = await ev(`(async () => { const b = [...document.querySelectorAll('#conversation .message.${role}')].pop(); return { done: b.querySelector('.msg-action[data-act="copy"]').classList.contains('done'), clip: await navigator.clipboard.readText().catch((e) => 'ERR ' + e.message) }; })()`);
      check(`${role}: clicking Copy copies the message`, copied.done && /kilometres|and the sun/.test(copied.clip), JSON.stringify(copied).slice(0, 160));
    }
    // Regenerate on the assistant bubble resends the user's question.
    const rg = await ev(`(() => { const m = [...document.querySelectorAll('#conversation .message.assistant')].pop(); const r = m.getBoundingClientRect(); const c = m.querySelector('.msg-action[data-act="retry"]').getBoundingClientRect(); return { sx: r.right - 12, sy: r.top + 12, x: c.left + c.width / 2, y: c.top + c.height / 2 }; })()`);
    await move(rg.sx, rg.sy); await sleep(200);
    for (let i = 1; i <= 10; i++) { await move(rg.sx + (rg.x - rg.sx) * i / 10, rg.sy + (rg.y - rg.sy) * i / 10); await sleep(25); }
    const usersBefore = await ev(`document.querySelectorAll('#conversation .message.user').length`);
    await click(rg.x, rg.y); await sleep(600);
    const after = await ev(`[...document.querySelectorAll('#conversation .message.user')].map((m) => m.firstChild ? m.firstChild.textContent : m.textContent)`);
    check('assistant: Regenerate is clickable', after.length === usersBefore + 1 && /and the sun/.test(after[after.length - 1]), JSON.stringify(after.slice(-2)));
    check('test never reached a real AI endpoint', !(await ev(`aria.config.get('harness.endpoint')`)) && !(await ev(`aria.config.get('llm.endpoint')`)));
    await move(700, 20);

    // ---- (2) themes recolour text ----
    const probes = {
      bubbleUser: `[...document.querySelectorAll('#conversation .message.user')].pop()`,
      bubbleAssistant: `[...document.querySelectorAll('#conversation .message.assistant')].pop()`,
      sessionTitle: `document.querySelector('#session-list .s-title')`,
      activity: `document.getElementById('activity-title')`,
      composer: `document.getElementById('text-input')`,
      sidebarLabel: `document.querySelector('.sidebar .side-cap')`,
      statusText: `document.getElementById('status-stt-text')`,
    };
    const themes = ['midnight', 'nord', 'solarized', 'synthwave', 'forest', 'light'];
    const seen = {};
    for (const th of themes) {
      await ev(`(async () => { await aria.config.set('ui.theme', '${th}'); document.documentElement.dataset.theme = '${th}'; window.AriaAppearance.refreshInk(); await new Promise(r => setTimeout(r, 900)); })()`);
      seen[th] = await ev(`(() => { const out = {}; const P = ${JSON.stringify(probes)}; for (const [k, e] of Object.entries(P)) { const el = eval(e); out[k] = el ? getComputedStyle(el).color : null; } const rep = window.AriaAppearance.refreshInk(); out.contrast = Object.fromEntries(Object.entries(rep).map(([k, v]) => [k, v.contrast])); return out; })()`);
      // Settings text is a floating surface.
      seen[th].settings = await ev(`(async () => { document.getElementById('settings-btn').click(); await new Promise(r => setTimeout(r, 350)); const el = document.querySelector('.settings-panel section h3, .settings-panel h3, .settings-panel label'); const c = el ? getComputedStyle(el).color : null; document.getElementById('settings-close').click(); await new Promise(r => setTimeout(r, 250)); return c; })()`);
    }
    console.log(JSON.stringify(seen, null, 1));
    for (const k of [...Object.keys(probes), 'settings']) {
      const distinct = new Set(themes.map((th) => seen[th][k]).filter(Boolean));
      check(`theme recolours ${k}`, distinct.size >= 4, `${distinct.size} colours across ${themes.length} themes: ${[...distinct].join(' | ')}`);
    }
    const worst = Math.min(...themes.flatMap((th) => Object.values(seen[th].contrast)));
    check('every theme keeps text readable (>= 4.5:1)', worst >= 4.5, `worst ${worst}`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(os.tmpdir(), `aria-theme-${Date.now()}.png`); fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64')); console.log('SCREENSHOT ' + file);
    ws.close();
  } catch (e) { check('live run', false, e.message); }
  finally {
    if (child) { child.kill('SIGTERM'); await sleep(900); try { child.kill('SIGKILL'); } catch (e) {} }
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})();
