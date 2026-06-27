#!/usr/bin/env node
/* Unit test for the orb's backing-store resolution cap (src/renderer/orb.js
 * effectiveDpr) — the P3 fullscreen-shake fix. A fullscreen / hi-DPI canvas must
 * be rendered at a bounded resolution (per quality) so per-frame fill cost stays
 * flat and frames arrive evenly; otherwise the time-based motion "shakes".
 *
 * Loads orb.js with a minimal window/document stub (init() bails because there's
 * no #orb-canvas, so no rAF/ResizeObserver runs). */
global.window = { devicePixelRatio: 1, addEventListener: () => {} };
global.self = global.window;
global.document = {
  readyState: 'complete', hidden: false,
  getElementById: () => null, addEventListener: () => {}, hasFocus: () => true,
};
require('../src/renderer/orb.js');
const Orb = global.self.AriaOrb;

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL' + (detail ? ' -> ' + detail : '')}`);
}

check('orb.loaded', !!Orb && typeof Orb.effectiveDpr === 'function');
const MAX = Orb.MAX_BACKING;
check('caps.ordered', MAX.low < MAX.medium && MAX.medium <= MAX.high, JSON.stringify(MAX));

// backing dims for a (cw,ch,rawDpr) at the current quality
function dims(cw, ch, rawDpr) {
  const d = Orb.effectiveDpr(cw, ch, rawDpr);
  return { w: Math.round(cw * d), h: Math.round(ch * d), longEdge: Math.round(Math.max(cw, ch) * d) };
}

// Default quality is 'high'.
check('windowed.untouched', dims(800, 600, 1).longEdge === 800, JSON.stringify(dims(800, 600, 1)));
check('fullHD.high.bounded', dims(1920, 1080, 1).longEdge <= MAX.high + 1, JSON.stringify(dims(1920, 1080, 1)));
check('1440p.high.capped', dims(2560, 1440, 1).longEdge <= MAX.high + 1, JSON.stringify(dims(2560, 1440, 1)));
check('4K.high.capped', dims(3840, 2160, 1).longEdge <= MAX.high + 1, JSON.stringify(dims(3840, 2160, 1)));
check('hiDPI.high.capped', dims(1920, 1080, 2).longEdge <= MAX.high + 1, JSON.stringify(dims(1920, 1080, 2)));

// Lower quality caps harder — and a quality change re-applies the cap.
Orb.setQuality('medium');
check('1440p.medium.capped', dims(2560, 1440, 1).longEdge <= MAX.medium + 1, JSON.stringify(dims(2560, 1440, 1)));
Orb.setQuality('low');
const low4k = dims(3840, 2160, 1);
check('4K.low.capped', low4k.longEdge <= MAX.low + 1, JSON.stringify(low4k));
check('low.harder.than.high', MAX.low < MAX.high);
// A small window is never upscaled (cap only ever scales DOWN).
Orb.setQuality('high');
check('tiny.never.upscaled', dims(400, 300, 1).longEdge === 400, JSON.stringify(dims(400, 300, 1)));

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
