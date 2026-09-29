#!/usr/bin/env node
/* Renderer contract for ARIA's procedural particle orb.
 *
 * The orb is a Fibonacci-sphere particle field drawn on a 2D canvas. Its motion
 * is pure math over time — expansion sweep, travelling ripples, speech rings,
 * and a staggered consolidation — so it can follow the voice lifecycle exactly.
 * The render loop is the historical crash surface (GPU contention with Vulkan
 * STT, uncapped rAF pegging a core), so this smoke drives the real adapter with
 * a fake canvas/rAF/clock and asserts the gating as behavior, not source text.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const orbSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'orb.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
const copier = fs.readFileSync(path.join(root, 'scripts', 'copy-renderer.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const smokeProfilePath = path.join(root, 'src', 'main', 'smoke-user-data.ts');
const smokeLauncherPath = path.join(root, 'scripts', 'smoke-electron.js');
const smokeProfile = fs.existsSync(smokeProfilePath) ? fs.readFileSync(smokeProfilePath, 'utf8') : '';
const smokeLauncher = fs.existsSync(smokeLauncherPath) ? fs.readFileSync(smokeLauncherPath, 'utf8') : '';

let pass = true;
function check(name, condition, detail = '') {
  if (!condition) pass = false;
  console.log(`[${name}] ${condition ? 'PASS' : `FAIL${detail ? ` -> ${detail}` : ''}`}`);
}

// ── Static contract ────────────────────────────────────────────────────────
check('markup.canvas',
  /<canvas id="orb-canvas"[^>]*aria-hidden="true"/.test(html),
  'the orb must be a decorative, screen-reader-hidden canvas');
check('markup.noVideo', !/id="orb-animation"/.test(html) && !/aria-orb\.webm/.test(html),
  'the retired pre-rendered video must be gone');
check('styles.stateFeedback',
  /body\[data-state="listening"\]\s+\.orb-slot/.test(html)
    && /body\[data-state="processing"\]\s+\.orb-slot/.test(html)
    && /body\[data-state="speaking"\]\s+\.orb-slot/.test(html),
  'voice states must keep distinct surrounding glow');
check('styles.dotTokens', /--orb-dot:/.test(html) && /html\[data-theme="light"\][^{]*\{[^}]*--orb-dot:/.test(html),
  'dot colour must come from theme tokens, with a light-theme value');
check('styles.noCanvasFilter', !/#orb-canvas\s*\{[^}]*filter\s*:/.test(html),
  'a per-frame CSS filter on the canvas would re-rasterise on the GPU every frame');
check('renderer.noInterval', !/setInterval/.test(orbSrc), 'no free-running interval timers');
check('build.noOrbMedia',
  !/aria-orb\.webm/.test(copier) && !/aria-orb-compact\.png/.test(copier)
    && /fs\.rmSync\([^\n]*outAssetsDir/.test(copier),
  'the build must not ship retired media and must clear stale copies');
check('capture.isolatesUserDataBeforeConfig',
  /^import ['"]\.\/smoke-user-data['"];/.test(main)
    && /app\.setPath\(['"]userData['"]/.test(smokeProfile)
    && main.indexOf("import './smoke-user-data';") < main.indexOf("import { config } from './config';"),
  'smoke userData must be selected before persistent stores are imported');
check('capture.launcherUsesDisposableProfile',
  /mkdtempSync/.test(smokeLauncher) && /ARIA_SMOKE_USER_DATA/.test(smokeLauncher)
    && /rmSync\([^\n]*recursive:\s*true/.test(smokeLauncher)
    && packageJson.scripts['smoke:boot'] === 'npm run build && node scripts/smoke-electron.js',
  'the official Electron smoke launcher must create and remove a disposable profile');
check('capture.verifiesRequestedState',
  /AriaOrb\.getState\(\)[\s\S]*document\.body\.dataset\.state[\s\S]*AriaOrb\.getPhase\(\)/.test(main)
    && /orb state verified/.test(main),
  'a PNG alone must not count as proof that the requested state rendered');
check('capture.failClosed',
  /screenshot failed:[^\n]*[\s\S]*smokeFailed\s*=\s*true/.test(main)
    && /app\.exit\(smokeFailed\s*\?\s*1\s*:\s*0\)/.test(main),
  'invalid state or capture failures must return a non-zero exit');

// ── Behavioral harness: fake canvas, rAF queue, clock, timers ─────────────
let now = 0;
let rafQueue = new Map();
let rafId = 0;
let rects = 0;
let fills = 0;
let fillStyles = [];
const ctx = {
  setTransform() {}, clearRect() {}, beginPath() {},
  rect() { rects++; }, fill() { fills++; },
  set fillStyle(v) { fillStyles.push(v); }, get fillStyle() { return fillStyles[fillStyles.length - 1]; },
  globalAlpha: 1,
};
const canvas = {
  dataset: {}, hidden: false, width: 0, height: 0,
  clientWidth: 260, clientHeight: 260,
  style: { setProperty() {} },
  getContext: (kind) => (kind === '2d' ? ctx : null),
  getBoundingClientRect: () => ({ width: 260, height: 260 }),
};
const slot = { style: { props: new Map(), setProperty(k, v) { this.props.set(k, v); } } };
const docListeners = new Map();
let cssDot = '#e8eef8';
const timers = new Map();
let timerId = 0;
global.setTimeout = (cb, ms) => { const id = ++timerId; timers.set(id, { cb, ms }); return id; };
global.clearTimeout = (id) => timers.delete(id);
global.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
global.self = global.window;
global.performance = { now: () => now };
global.requestAnimationFrame = (cb) => { const id = ++rafId; rafQueue.set(id, cb); return id; };
global.cancelAnimationFrame = (id) => rafQueue.delete(id);
global.getComputedStyle = () => ({ getPropertyValue: (k) => (k === '--orb-dot' ? cssDot : '') });
global.document = {
  readyState: 'complete', hidden: false,
  body: { dataset: {} },
  getElementById: (id) => (id === 'orb-canvas' ? canvas : id === 'orb-anchor' ? slot : null),
  addEventListener: (name, cb) => { if (!docListeners.has(name)) docListeners.set(name, []); docListeners.get(name).push(cb); },
};

/** Run the rAF loop for `ms` of wall time at a `stepMs` display refresh. */
function run(ms, stepMs = 1000 / 60) {
  const end = now + ms;
  let draws = 0;
  while (now < end) {
    now += stepMs;
    const pending = [...rafQueue.entries()];
    rafQueue = new Map();
    const before = fills;
    for (const [, cb] of pending) cb(now);
    if (fills > before) draws++;
  }
  return draws;
}

require(path.join(root, 'src', 'renderer', 'orb.js'));
const Orb = global.window.AriaOrb;
const m = () => Orb.getMetrics();

check('adapter.exists', !!Orb && typeof Orb.setState === 'function' && typeof Orb.getMetrics === 'function');
check('adapter.initializesCompact',
  Orb.getState() === 'idle' && Orb.getPhase() === 'consolidated' && Math.abs(m().meanRadius - 1) < 0.04,
  JSON.stringify(m()));
check('adapter.drawsOnInit', rects >= m().particles && m().particles >= 600,
  `rects=${rects} particles=${m().particles}`);

// Idle is alive but frugal: slow motion at a low frame cap.
const idleDraws = run(1000);
check('loop.idleCapped', idleDraws > 0 && idleDraws <= 31, `idle drew ${idleDraws} frames/s`);

// Processing: expansion sweep, then continuing ripples.
Orb.setState('processing');
check('adapter.thinkingPhase', Orb.getPhase() === 'thinking' && document.body.dataset.state === 'processing');
run(2500);
const t1 = m();
check('motion.thinkingExpands', t1.expansion > 0.9 && t1.meanRadius > 1.15, JSON.stringify(t1));
run(400);
const t2 = m();
check('motion.thinkingRipples', Math.abs(t2.signature - t1.signature) > 1e-3,
  'the dispersed shell must keep moving while thinking');

// Speaking: speech level visibly drives the particle field.
Orb.setState('speaking');
Orb.setLevel(0);
run(1500);
const quiet = m();
Orb.setLevel(1);
run(600);
const loud = m();
check('motion.speakingReactsToLevel', loud.spread > quiet.spread * 1.15 && Orb.getLevel() === 1,
  `quiet=${quiet.spread.toFixed(3)} loud=${loud.spread.toFixed(3)}`);
check('adapter.speakingPhase', Orb.getPhase() === 'speaking');

// Leaving speech consolidates back to the compact sphere.
Orb.setState('idle');
check('adapter.speechEndConsolidates', Orb.getPhase() === 'consolidating' && Orb.getLevel() === 0);
run(3000);
check('adapter.consolidationCompletes',
  Orb.getPhase() === 'consolidated' && Math.abs(m().meanRadius - 1) < 0.04, JSON.stringify(m()));

// speaking → listening (conversation mode / barge-in) keeps its return tail.
Orb.setState('speaking'); run(1200);
Orb.setState('listening');
check('adapter.speakingToListeningConsolidates', Orb.getPhase() === 'consolidating');
run(200);
Orb.setState('listening');
check('adapter.listeningKeepsActiveTail', Orb.getPhase() === 'consolidating');
run(3000);
check('adapter.listeningFinishesCompact', Orb.getState() === 'listening' && Orb.getPhase() === 'consolidated');

Orb.setState('processing'); run(1500);
Orb.setState('listening');
check('adapter.processingToListeningConsolidates', Orb.getPhase() === 'consolidating');
run(3000);
check('adapter.processingToListeningFinishesCompact', Orb.getPhase() === 'consolidated');

// Active frame caps per quality tier, at a 240 Hz display.
Orb.setQuality('low');
Orb.setState('processing');
const lowDraws = run(1000, 1000 / 240);
check('loop.lowCapped', lowDraws >= 18 && lowDraws <= 25, `low drew ${lowDraws}/s`);
const lowParticles = m().particles;
Orb.setQuality('high');
const highDraws = run(1000, 1000 / 240);
check('loop.highCapped', highDraws >= 50 && highDraws <= 61, `high drew ${highDraws}/s`);
check('quality.scalesParticles', m().particles > lowParticles, `${lowParticles} -> ${m().particles}`);
check('quality.rejectsUnknown', Orb.setQuality('ultra') === 'high');

// Vulkan STT: stop drawing AND hide; failsafe restores; CPU never freezes.
Orb.setSttBackend('cpu');
Orb.beginSttCompute();
check('compute.cpuUnfrozen', !Orb.isComputeFrozen() && !canvas.hidden);
Orb.setSttBackend('vulkan');
Orb.beginSttCompute();
const frozenDraws = run(500);
check('compute.quiesces', Orb.isComputeFrozen() && canvas.hidden && frozenDraws === 0 && rafQueue.size === 0,
  `draws=${frozenDraws} pending=${rafQueue.size}`);
const failsafe = [...timers.values()].find((t) => t.ms === 6000);
check('compute.failsafeScheduled', !!failsafe);
if (failsafe) failsafe.cb();
check('compute.failsafeRecovers', !Orb.isComputeFrozen() && !canvas.hidden && run(200) > 0);
Orb.beginSttCompute();
Orb.beginStt();
check('compute.newListenClearsFreeze', !Orb.isComputeFrozen() && !canvas.hidden);
Orb.endStt();

// Hidden window (closed to tray): no frames at all.
document.hidden = true;
(docListeners.get('visibilitychange') || []).forEach((cb) => cb());
check('loop.hiddenStops', run(500) === 0 && rafQueue.size === 0);
document.hidden = false;
(docListeners.get('visibilitychange') || []).forEach((cb) => cb());
check('loop.visibleResumes', run(200) > 0);

// Reduced motion: once settled at idle, the loop stops entirely.
window.matchMedia = () => ({ matches: true });
Orb.refreshAccent();
Orb.setState('idle');
run(3500);
check('loop.reducedMotionSettles', Orb.getPhase() === 'consolidated' && run(1000) === 0 && rafQueue.size === 0);
window.matchMedia = () => ({ matches: false });
Orb.refreshAccent();

// Theme colour comes from the CSS token.
cssDot = '#1d2433';
Orb.refreshAccent();
fillStyles = [];
run(200);
check('theme.usesDotToken', fillStyles.some((s) => /rgb\(\s*(2[0-9]|3[0-9]|4[0-9]|5[0-9])\b/.test(String(s))),
  `fillStyles=${[...new Set(fillStyles)].slice(0, 3)}`);

// Deterministic snapshot hook used by the Electron capture path.
Orb.setState('processing');
Orb.settle();
check('adapter.settleJumpsToTarget', m().expansion > 0.99 && Orb.getPhase() === 'thinking');

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
