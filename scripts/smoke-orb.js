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

// --- Resolution (item 4): a 1440p / 1080p@2x fullscreen canvas now renders at a
// crisp native-ish resolution rather than the old blurry 1920 cap. ---
check('high.cap.raised', MAX.high >= 2560, JSON.stringify(MAX));
check('1440p.high.native', dims(2560, 1440, 1).longEdge === 2560, JSON.stringify(dims(2560, 1440, 1)));
check('1080p@2x.high.crisper', dims(1920, 1080, 2).longEdge >= 2560, JSON.stringify(dims(1920, 1080, 2)));

// --- Fullscreen edge jitter (item 5): backingFor must map the drawing space onto
// the integer backing store with NO fractional overhang on the right/bottom edge
// (drawing x=cw must land exactly on bw), and be integer + deterministic. ---
check('backingFor.exists', typeof Orb.backingFor === 'function');
function edgeExact(cw, ch, rawDpr) {
  const b = Orb.backingFor(cw, ch, rawDpr);
  const integers = Number.isInteger(b.bw) && Number.isInteger(b.bh);
  const rightExact = Math.abs(b.sx * cw - b.bw) < 1e-9;   // x=cw -> bw exactly
  const bottomExact = Math.abs(b.sy * ch - b.bh) < 1e-9;  // y=ch -> bh exactly
  return { b, integers, rightExact, bottomExact };
}
// Fractional-DPR fullscreen cases (1.25 / 1.5 scaling) are where the old rounding
// left a sub-pixel strip on the right; assert the exact mapping for several.
for (const [cw, ch, dpr] of [[1707, 1067, 1.5], [1536, 864, 1.25], [2560, 1440, 1], [1920, 1080, 2], [3840, 2160, 1.5]]) {
  const r = edgeExact(cw, ch, dpr);
  check(`edge.exact.${cw}x${ch}@${dpr}`, r.integers && r.rightExact && r.bottomExact, JSON.stringify(r));
}
// Deterministic: same input -> identical backing (no per-frame wobble from resize).
const a1 = Orb.backingFor(1707, 1067, 1.5), a2 = Orb.backingFor(1707, 1067, 1.5);
check('backingFor.deterministic', a1.bw === a2.bw && a1.bh === a2.bh && a1.sx === a2.sx);

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
