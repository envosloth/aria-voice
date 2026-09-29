// Visual timeline for the procedural orb: loads the real orb.js in headless
// Chromium, drives idle → listening → processing → speaking(level) → idle and
// captures frames for a contact sheet. Dev-only; not part of the app build.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = process.argv[2] || path.join(root, 'orb-timeline');
fs.mkdirSync(out, { recursive: true });
const orbJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'orb.js'), 'utf8');

const page = `<!doctype html><html><head><style>
  body { margin: 0; background: #0b0f16; }
  .orb-slot { width: 300px; height: 260px; position: relative; display: grid; place-items: center;
    --orb-glow: rgba(122,162,255,.16); --orb-energy: 0; }
  .orb-slot::before { content: ''; position: absolute; inset: 14%; border-radius: 50%;
    background: radial-gradient(circle, var(--orb-glow), transparent 68%);
    transform: scale(calc(1 + var(--orb-energy) * .18)); }
  #orb-canvas { --orb-dot: #e8eef8; position: relative; z-index: 1; width: 100%; height: 100%; display: block; }
  body[data-state="listening"] .orb-slot { --orb-glow: rgba(255,171,77,.24); }
  body[data-state="processing"] .orb-slot { --orb-glow: rgba(185,139,255,.24); }
  body[data-state="speaking"] .orb-slot { --orb-glow: rgba(63,200,232,.30); }
</style></head><body><div class="orb-slot" id="orb-anchor"><canvas id="orb-canvas" aria-hidden="true"></canvas></div>
<script>${orbJs}</script></body></html>`;

(async () => {
  const exe = process.env.CHROMIUM || '/usr/bin/chromium';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const tab = await browser.newPage({ viewport: { width: 300, height: 260 }, deviceScaleFactor: 2 });
  await tab.setContent(page);
  const errors = [];
  tab.on('pageerror', (e) => errors.push(e.message));
  const plan = [
    ['idle', 0, 600], ['listening', 0, 600],
    ['processing', 0, 400], ['processing', 0, 800], ['processing', 0, 1200], ['processing', 0, 1500],
    ['speaking', 0.2, 800], ['speaking', 0.9, 300], ['speaking', 0.3, 300],
    ['idle', 0, 500], ['idle', 0, 700], ['idle', 0, 1500],
  ];
  let n = 0;
  for (const [state, level, wait] of plan) {
    await tab.evaluate(([s, l]) => { AriaOrb.setState(s); AriaOrb.setLevel(l); }, [state, level]);
    await tab.waitForTimeout(wait);
    const m = await tab.evaluate(() => ({ phase: AriaOrb.getPhase(), ...AriaOrb.getMetrics() }));
    const file = path.join(out, `f${String(n++).padStart(2, '0')}-${state}.png`);
    await tab.screenshot({ path: file });
    console.log(`${path.basename(file)} phase=${m.phase} exp=${m.expansion.toFixed(2)} r=${m.meanRadius.toFixed(3)} frames=${m.frames}`);
  }
  // Measured frame rate while thinking at high quality.
  await tab.evaluate(() => AriaOrb.setState('processing'));
  const fps = await tab.evaluate(() => new Promise((res) => {
    const a = AriaOrb.getMetrics().frames; const t = performance.now();
    setTimeout(() => res((AriaOrb.getMetrics().frames - a) / ((performance.now() - t) / 1000)), 2000);
  }));
  const cost = await tab.evaluate(() => {
    const t = performance.now(); for (let i = 0; i < 60; i++) AriaOrb.settle(); return (performance.now() - t) / 60;
  });
  console.log(`fps=${fps.toFixed(1)} drawMs=${cost.toFixed(2)} errors=${errors.length ? errors.join('; ') : 'none'}`);
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
