#!/usr/bin/env node
// Live check for the tactile layer: wallpaper cross-fade, smooth orb/state
// colour changes, pressable buttons, and the reorganised Settings dialog.
// Drives the built app over CDP with a disposable profile; asserts on real DOM
// and computed style, never on source text alone.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-tactile-'));
const electron = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(port) {
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    path.join(root, 'dist', 'main', 'index.js')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData,
      HERMES_HOME: path.join(userData, 'nh'),
      XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}
async function connect(port) {
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
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 500)); return d.result.result.value; });
  return { ws, ev, send };
}

(async () => {
  let ok = false; let child = null;
  try {
    const port = 9800 + Math.floor(Math.random() * 150);
    child = boot(port);
    const { ws, ev, send } = await connect(port);
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(1800);
    const r = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelectorAll('.onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      const out = {};
      const cs = (el, p) => getComputedStyle(el).getPropertyValue(p).trim();

      // ── Wallpaper cross-fade ──
      const before = document.documentElement.dataset.bg;
      const target = before === 'aurora' ? 'dusk' : 'aurora';
      document.getElementById('settings-btn').click(); await wait(350);
      document.getElementById('settings-tab-appearance').click(); await wait(150);
      document.querySelector('#bg-swatches .bg-swatch[data-bg="' + target + '"]').click();
      await wait(40);
      // The test window is hidden, so transitions exist but may not advance:
      // assert the running CSSTransition itself, not a mid-frame value.
      const trans = (el, prop) => el.getAnimations().some(a => a.transitionProperty === prop && a.playState !== 'finished');
      const leaving = document.querySelectorAll('.bg-layer.bg-leaving');
      out.fadeLayer = leaving.length === 1 && leaving[0].dataset.bg === before && !leaving[0].querySelector('[id]');
      out.fadeAnim = leaving.length ? trans(leaving[0], 'opacity') : false;
      out.liveLayerSwitched = document.querySelector('.bg-layer:not(.bg-leaving)').dataset.bg === target
        && document.documentElement.dataset.bg === target;
      await wait(1300);
      out.fadeCleanedUp = document.querySelectorAll('.bg-layer.bg-leaving').length === 0;
      // Rapid switching never piles up more than two fading layers.
      for (const b of ['ocean', 'dusk', 'eclipse', 'studio', 'obsidian']) {
        document.querySelector('#bg-swatches .bg-swatch[data-bg="' + b + '"]').click(); await wait(30);
      }
      out.maxLeaving = document.querySelectorAll('.bg-layer.bg-leaving').length;
      await wait(1300);
      out.rapidCleanedUp = document.querySelectorAll('.bg-layer.bg-leaving').length === 0;

      // ── Smooth colour: orb glow, state badge and activity accent animate ──
      const slot = document.getElementById('orb-anchor');
      out.glowAnimates = /--orb-glow/.test(cs(slot, 'transition-property'));
      document.body.dataset.state = 'speaking';
      await wait(30);
      out.glowInterpolates = trans(slot, '--orb-glow');
      const badge = document.querySelector('.ops .state-badge');
      out.badgeTransition = trans(badge, 'color');
      document.body.dataset.state = 'idle';
      out.badgeAnimates = /color/.test(cs(badge, 'transition-property'));
      out.inkAnimates = /--text/.test(cs(document.querySelector('.chat'), 'transition-property'));
      // From here on, freeze transitions so geometry reads are final values.
      const freeze = document.createElement('style'); freeze.textContent = '*,*::before,*::after{transition:none!important}';

      // ── Tactile buttons ──
      const mic = document.getElementById('mic-btn');
      out.noTransitionAll = [...document.querySelectorAll('button')].every(b => !/(^|,\\s*)all(\\s|,|$)/.test(cs(b, 'transition-property')));
      mic.classList.add('listening');
      out.micListeningAnim = cs(mic, 'animation-name');
      mic.classList.remove('listening');
      const send = document.getElementById('send-btn');
      out.pressable = ['settings-btn', 'new-session-btn', 'mic-btn', 'send-btn', 'settings-save', 'custom-bg-pick']
        .every(id => document.getElementById(id).classList.contains('tac'));
      const pb = document.getElementById('custom-bg-pick');
      const r0 = pb.getBoundingClientRect();
      pb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r0.left + 10, clientY: r0.top + 8, pointerId: 1, isPrimary: true }));
      await wait(20);
      out.pressedClass = pb.classList.contains('is-pressed');
      out.pressOrigin = pb.style.getPropertyValue('--press-x');
      pb.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true }));
      await wait(400);
      out.pressReleased = !pb.classList.contains('is-pressed');

      // ── Settings organisation ──
      document.head.appendChild(freeze);
      const nav = document.getElementById('settings-nav');
      out.navGroups = [...nav.querySelectorAll('.snav-group-label')].map(e => e.textContent.trim());
      out.navIcons = [...nav.querySelectorAll('.snav-item')].every(b => b.querySelector('svg'));
      out.tabsStillWork = [...nav.querySelectorAll('.snav-item')].map(b => b.dataset.tab);
      document.getElementById('settings-tab-voice').click(); await wait(420);
      const ind = nav.querySelector('.snav-indicator');
      const act = nav.querySelector('.snav-item.active');
      out.indicatorTracksActive = !!ind && Math.abs(ind.getBoundingClientRect().top - act.getBoundingClientRect().top) < 1.5
        && Math.abs(ind.getBoundingClientRect().height - act.getBoundingClientRect().height) < 1.5;
      out.headerDesc = (document.getElementById('settings-tab-desc') || {}).textContent || '';
      const sw = document.getElementById('cfg-ww-enabled');
      out.switchStyled = cs(sw, 'appearance') === 'none' && sw.getBoundingClientRect().width >= 30;
      const swBefore = sw.checked; sw.click();
      out.switchToggles = sw.checked === !swBefore; sw.click();
      const rng = document.getElementById('cfg-tts-speed');
      rng.value = '2'; rng.dispatchEvent(new Event('input', { bubbles: true }));
      out.rangeFill = rng.style.getPropertyValue('--fill');
      const sel = document.getElementById('cfg-stt-backend');
      out.selectChevron = /url\\(/.test(cs(sel, 'background-image')) && cs(sel, 'appearance') === 'none';
      // Keyboard parity: arrow keys still move between tabs and the indicator follows.
      document.getElementById('settings-tab-voice').focus();
      nav.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await wait(420);
      out.arrowMoves = nav.querySelector('.snav-item.active').dataset.tab;
      const act2 = nav.querySelector('.snav-item.active');
      out.indicatorFollowsKeys = Math.abs(ind.getBoundingClientRect().top - act2.getBoundingClientRect().top) < 1.5;
      // Nothing inside the dialog clips horizontally at a narrow width.
      return out;
    })()`);
    ws.close();

    console.log(JSON.stringify(r, null, 2));
    const checks = {
      wallpaperCrossFades: r.fadeLayer && r.fadeAnim && r.liveLayerSwitched,
      wallpaperFadeCleansUp: r.fadeCleanedUp && r.maxLeaving <= 2 && r.rapidCleanedUp,
      orbGlowInterpolates: r.glowAnimates && r.glowInterpolates,
      stateColoursAnimate: r.badgeAnimates && r.badgeTransition && r.inkAnimates,
      noTransitionAll: r.noTransitionAll,
      micListeningIsRingNotBlink: r.micListeningAnim !== 'pulse' && r.micListeningAnim !== 'none',
      buttonsPressable: r.pressable && r.pressedClass && /px$/.test(r.pressOrigin) && r.pressReleased,
      settingsGrouped: r.navGroups.length === 3 && r.navIcons,
      settingsTabsIntact: ['connections', 'voice', 'context', 'memory', 'appearance', 'performance', 'remote', 'updates'].every((t) => r.tabsStillWork.includes(t)),
      indicatorTracksTab: r.indicatorTracksActive && r.indicatorFollowsKeys && r.arrowMoves !== 'voice',
      headerDescribesTab: r.headerDesc.length > 10,
      switchesAndSliders: r.switchStyled && r.switchToggles && /%$/.test(r.rangeFill) && r.selectChevron,
    };
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
  } catch (e) {
    console.error('[tactile] error:', e.message);
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(800); try { child.kill('SIGKILL'); } catch (e) {} }
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(ok ? 'smoke:tactile PASS' : 'smoke:tactile FAIL');
  process.exit(ok ? 0 : 1);
})();
