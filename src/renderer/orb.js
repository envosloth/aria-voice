// The Glass Observatory orb — a 1:1 port of the Claude Design project's
// canvas orb ("ember sphere": seeded star-dust core + volume dots, 8 debris
// rings of arc segments at random 3D orientations, additive blending, and a
// pulsing white-hot flare), wrapped in ARIA's state machine + infra.
//
// States (AriaOrb.setState), palettes exactly as the design's state strip:
//   idle       — blue,   dim embers, slow swirl. (default)
//   listening  — amber,  rings spin up (the design's "tools" look).
//   processing — violet, swirl accelerates ("thinking").
//   speaking   — cyan,   core flares — boosted live by the TTS voice (RMS).
//
// Transitions are smooth: palette + motion params (speed/brightness/flare)
// are dt-eased, and ring angles come from ONE accumulated phase, so a speed
// change bends the motion instead of snapping it.
//
// Performance: particles precomputed once (seeded, deterministic); additive
// squares + a handful of strokes per frame, no shadow blur, no per-frame
// allocation beyond two cached gradients.

(function (root) {
  const TAU = Math.PI * 2;

  // ── Design constants (verbatim from the design's _drawOrb) ──
  // Per-state motion: spd = swirl speed, amp = ember brightness, flare = core.
  const MODES = {
    idle:       { spd: 0.45, amp: 0.55, flare: 0.55 },
    listening:  { spd: 2.1,  amp: 0.95, flare: 0.85 }, // design "tools"
    processing: { spd: 1.6,  amp: 0.85, flare: 0.8  }, // design "thinking"
    speaking:   { spd: 1,    amp: 1,    flare: 1.15 },
  };
  // Per-state palette: e = ember colour, hh = hot/highlight colour.
  const PALS = {
    idle:       { e: [ 70, 120, 235], hh: [225, 240, 255] },
    listening:  { e: [255, 120,  15], hh: [255, 246, 220] }, // design "tools"
    processing: { e: [150,  80, 255], hh: [242, 232, 255] }, // design "thinking"
    speaking:   { e: [  0, 170, 210], hh: [220, 250, 255] },
  };
  // Design reference size: parts are built for a 250px orb (R0 = 125) and the
  // whole draw is uniformly scaled to ARIA's baseR at render time.
  const SIZE0 = 250, R0 = SIZE0 / 2;

  let canvas, ctx, w, h, cx, cy, baseR;
  let audio = 0, audioSmooth = 0, raf = null;
  let tSec = 0;      // design clock (seconds at 60fps normalization)
  let phase = 0;     // accumulated swirl phase = ∫ spd dt (smooth speed changes)

  let state = 'idle';
  // Eased palette (6ch: e then hh) and motion params.
  const pal = [...PALS.idle.e, ...PALS.idle.hh];
  let palTgt = pal.slice();
  const mot = { ...MODES.idle };
  let motTgt = { ...MODES.idle };
  let accent = [233, 69, 96];

  // Render-quality profiles, selected from the host's hardware tier + the GPU
  // usage cap (see src/main/hardware.ts, applied via AriaOrb.setQuality).
  // Lower tiers cap the frame rate, which bounds GPU/CPU work while the motion
  // still reads. (The ember orb has no shadow blur; the shadows/blurMax fields
  // are kept for profile compatibility but unused.)
  //   stateMs: min ms between frames per state (higher = fewer FPS = less GPU)
  const QUALITY = {
    // High tier: render every rAF -> native refresh; activeMs throttles to
    // ~60 FPS while a Vulkan STT transcription is in flight (see beginStt).
    high:   { stateMs: { idle: 4, listening: 4, processing: 4, speaking: 4 }, activeMs: 16, shadows: true,  blurMax: 26 },
    medium: { stateMs: { idle: 40, listening: 40, processing: 40, speaking: 28 }, activeMs: 40, shadows: true,  blurMax: 8 },
    low:    { stateMs: { idle: 66, listening: 66, processing: 66, speaking: 40 }, activeMs: 66, shadows: false, blurMax: 0 },
  };
  let quality = 'high';
  function setQuality(q) {
    if (!QUALITY[q] || q === quality) return;
    quality = q;
    // Re-apply the backing-store resolution cap for the new quality (forces a
    // real resize even though the element size didn't change).
    if (canvas && ctx) { lastBw = -1; resize(); }
  }

  let lightTheme = false;
  function refreshThemeMode() {
    try {
      lightTheme = document.documentElement.getAttribute('data-theme') === 'light';
    } catch (e) { lightTheme = false; }
  }

  function refreshAccent() {
    refreshThemeMode();
    // State palettes are fixed by the design; this only keeps `accent` current
    // for any other consumer.
    try {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent-rgb').trim();
      if (v) accent = v.split(',').map((n) => parseInt(n, 10));
    } catch (e) { /* keep default */ }
  }

  // Pure: compute one colour stop for the current theme. The dark themes use the
  // design's luminous palette directly. Light theme needs a contrast pass: the
  // same pale highlight colours were being composited over white glass, making
  // the orb appear to disappear. Darken the RGBs, boost alpha, and keep the state
  // hue so the four-state colour convention remains recognizable.
  function themeRampColor(channels, q, a, forceLight) {
    const wq = Math.min(1, q) * Math.min(1, q);
    let r = Math.round(channels[0] + (channels[3] - channels[0]) * wq);
    let g = Math.round(channels[1] + (channels[4] - channels[1]) * wq);
    let b = Math.round(channels[2] + (channels[5] - channels[2]) * wq);
    let alpha = Math.min(1, a);
    if (forceLight) {
      r = Math.round(r * 0.55);
      g = Math.round(g * 0.58);
      b = Math.round(b * 0.68);
      alpha = alpha > 0 ? Math.min(1, alpha * 1.75) : 0;
    }
    return { r, g, b, a: alpha };
  }

  function setState(s) {
    if (!MODES[s]) return;
    state = s;
    palTgt = [...PALS[s].e, ...PALS[s].hh];
    motTgt = { ...MODES[s] };
    if (s !== 'speaking') audio = 0; // voice only drives the speaking flare
  }

  // ── Particles (verbatim port of the design's _makeParts, seed "aria") ──
  // Deterministic: identical orb every boot, no Math.random.
  const parts = (function makeParts(size, seedStr) {
    let s = 2166136261;
    for (let i = 0; i < seedStr.length; i++) s = ((s ^ seedStr.charCodeAt(i)) * 16777619) >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const R = size / 2;
    const dots = [];
    // Hot star-dust core.
    const nCore = Math.round(size * 0.5);
    for (let i = 0; i < nCore; i++) {
      const r = R * (0.02 + 0.17 * Math.pow(rnd(), 1.5));
      const th = rnd() * TAU, ph = Math.acos(2 * rnd() - 1);
      dots.push({ x: r * Math.sin(ph) * Math.cos(th), y: r * Math.cos(ph) * 0.8, z: r * Math.sin(ph) * Math.sin(th), s: 0.7 + rnd() * 1.7, h: 0.72 + rnd() * 0.28, tw: rnd() * TAU, w: 0.7 + rnd() * 0.8 });
    }
    // Dimmer volume dust filling the sphere.
    const nVol = Math.round(size * 0.85);
    for (let i = 0; i < nVol; i++) {
      const r = R * (0.24 + 0.72 * Math.pow(rnd(), 0.65));
      const th = rnd() * TAU, ph = Math.acos(2 * rnd() - 1);
      dots.push({ x: r * Math.sin(ph) * Math.cos(th), y: r * Math.cos(ph) * 0.88, z: r * Math.sin(ph) * Math.sin(th), s: 0.5 + rnd() * 1.3, h: 0.25 + rnd() * 0.5, tw: rnd() * TAU, w: 0.5 + rnd() * 1.2 });
    }
    // Debris rings: random 3D orientation (front-biased normal), each carrying
    // a few glowing arc segments and loose debris scattered along them.
    const rings = [];
    const nR = 8;
    for (let b = 0; b < nR; b++) {
      const rb = R * (0.38 + 0.6 * (b + rnd() * 0.7) / nR);
      const nx = (rnd() - 0.5) * 1.3, ny = (rnd() - 0.5) * 1.3, nz = 0.75 + rnd() * 0.7;
      const nl = Math.hypot(nx, ny, nz);
      const n = [nx / nl, ny / nl, nz / nl];
      const axv = Math.abs(n[0]) > 0.8 ? [0, 1, 0] : [1, 0, 0];
      let u = [n[1] * axv[2] - n[2] * axv[1], n[2] * axv[0] - n[0] * axv[2], n[0] * axv[1] - n[1] * axv[0]];
      const ul = Math.hypot(u[0], u[1], u[2]);
      u = [u[0] / ul, u[1] / ul, u[2] / ul];
      const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      const ring = { rb, u, v, w: (0.1 + rnd() * 0.35) * (rnd() < 0.45 ? -1 : 1), h: 0.35 + rnd() * 0.45, lw: 0.5 + rnd() * 1.1, segs: [], deb: [] };
      const nSeg = 2 + Math.floor(rnd() * 4);
      for (let g = 0; g < nSeg; g++) ring.segs.push({ a0: rnd() * TAU, len: 0.2 + rnd() * 1.3, al: 0.1 + rnd() * 0.3 });
      const nDeb = Math.round(size * 0.16 + rnd() * size * 0.1);
      for (let g = 0; g < nDeb; g++) {
        const sg = ring.segs[Math.floor(rnd() * nSeg)];
        ring.deb.push({ a: sg.a0 + rnd() * sg.len * 1.3 - sg.len * 0.15, rr: rb + (rnd() - 0.5) * R * 0.07, s: 0.5 + rnd() * 1.4, h: 0.35 + rnd() * 0.55, tw: rnd() * TAU, w: 0.8 + rnd() * 1.6 });
      }
      rings.push(ring);
    }
    return { dots, rings };
  })(SIZE0, 'aria');

  // Backing-store long-edge cap (device px) per quality. Earlier caps kept the
  // full-window canvas cheap, but they also made a 4K/native-fullscreen window
  // upscale the orb (the user-visible "fullscreen looks low resolution" bug).
  // The orb draw itself is small and bounded by the ops slot; only STT/GPU relief
  // drops lower. High now preserves native 4K, medium preserves 1440p+.
  const MAX_BACKING = { low: 1600, medium: 3072, high: 4096 };
  // GPU-relief mode: while a Vulkan STT transcription is in flight (and while the
  // adaptive pressure detector trips), the orb's own GPU cost is cut HARD so it
  // doesn't contend with STT/TTS on the GPU — the documented crash combo. This
  // caps the 2D-canvas backing store far below the quality cap (backing-store
  // pixels are the dominant GPU cost) and, in the loop, honours a real FPS cap
  // instead of the focus floor. Restored the instant relief clears, so idle
  // latency/quality are untouched.
  const RELIEF_BACKING = 1024; // device-px long edge while under relief
  let gpuRelief = false;
  function setRelief(on) {
    if (on === gpuRelief) return;
    gpuRelief = on;
    if (canvas && ctx) { lastBw = -1; resize(); } // re-apply the (relief) backing cap
  }
  // Pure: the effective device-pixel-ratio so the longest backing-store edge
  // never exceeds the current quality's cap. Exported for tests.
  function effectiveDpr(cw, ch, rawDpr) {
    const cap = (gpuRelief ? RELIEF_BACKING : MAX_BACKING[quality]) || 1920;
    const longEdge = Math.max(cw, ch) * rawDpr;
    return longEdge > cap ? rawDpr * (cap / longEdge) : rawDpr;
  }
  // Pure: integer backing-store dimensions + EXACT axis scales mapping the
  // drawing space onto them (kills right/bottom edge shimmer at fractional
  // DPR). Exported for tests.
  function backingFor(cw, ch, rawDpr) {
    const dpr = effectiveDpr(cw, ch, rawDpr);
    const bw = Math.max(1, Math.round(cw * dpr));
    const bh = Math.max(1, Math.round(ch * dpr));
    return { bw, bh, sx: bw / cw, sy: bh / ch };
  }
  let lastW = -1, lastH = -1, lastBw = -1, lastBh = -1;
  function resize() {
    const realDpr = window.devicePixelRatio || 1;
    // Available CSS size = the viewport (the canvas is position:fixed inset:0).
    const availW = window.innerWidth || (canvas.clientWidth), availH = window.innerHeight || (canvas.clientHeight);
    if (!availW || !availH || availW < 2 || availH < 2) return;
    // Snap the element to a WHOLE number of device pixels (edge-jitter fix at
    // fractional devicePixelRatio).
    const devW = Math.round(availW * realDpr), devH = Math.round(availH * realDpr);
    const cw = devW / realDpr, ch = devH / realDpr;
    const rawDpr = Math.min(realDpr, 2);
    const { bw, bh, sx, sy } = backingFor(cw, ch, rawDpr);
    // No-op if nothing changed, so a chatty ResizeObserver doesn't clear the
    // canvas every tick (which flickers).
    if (cw === lastW && ch === lastH && bw === lastBw && bh === lastBh) return;
    lastW = cw; lastH = ch; lastBw = bw; lastBh = bh;
    w = cw; h = ch;
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    canvas.width = bw; canvas.height = bh;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    dprX = sx; dprY = sy;
    cx = w / 2; cy = h / 2;
    baseR = Math.min(w, h) * 0.27;
    // If the layout provides an orb anchor (the ops-rail slot in the glass UI),
    // center the orb there instead of the viewport, sized to fit the slot.
    // Falls back to viewport-center when the anchor is absent or hidden
    // (narrow windows hide the ops rail via media query — which always comes
    // with a window resize, so this re-runs and the fallback kicks in).
    const anchor = document.getElementById('orb-anchor');
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) {
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
        baseR = Math.min(r.width, r.height) * 0.30;
      }
    }
  }
  let dprX = 1, dprY = 1;

  let measuring = false, mFrames = 0, mTime = 0, mLast = 0;

  // Fixed viewing tilt (design: 0.33 rad).
  const CT = Math.cos(0.33), ST = Math.sin(0.33);

  let lastFrameTime = 0;
  function render(now) {
    const t0m = measuring ? performance.now() : 0;
    // Time-based step (normalized to a 60 FPS frame), clamped so a hitch or a
    // 160 Hz refresh both animate at the SAME visual speed.
    const dt = lastFrameTime ? Math.min(3, (now - lastFrameTime) / 16.667) : 1;
    lastFrameTime = now;
    const ease = (k) => 1 - Math.pow(1 - k, dt);

    // Ease palette + motion params toward the state targets (~0.8s cross-fade)
    // so state switches blend instead of snapping.
    const k5 = ease(0.05);
    for (let i = 0; i < 6; i++) pal[i] += (palTgt[i] - pal[i]) * k5;
    mot.spd += (motTgt.spd - mot.spd) * k5;
    mot.amp += (motTgt.amp - mot.amp) * k5;
    mot.flare += (motTgt.flare - mot.flare) * k5;

    // Voice level: only 'speaking' feeds new audio in; the smoothed level eases
    // out on a barge-in instead of snapping.
    if (state !== 'speaking') audio = 0;
    audioSmooth += (audio - audioSmooth) * ease(0.15);
    if (state === 'speaking') audio *= Math.pow(0.92, dt); else audioSmooth *= Math.pow(0.9, dt);
    const react = Math.min(1, audioSmooth);

    // Two clocks: tSec runs at constant rate (flicker/pulse), phase integrates
    // the eased state speed (swirl) — smooth across speed changes.
    tSec += dt / 60;
    phase += (dt / 60) * mot.spd;

    // Voice boosts brightness + core flare while speaking (the design's hero
    // orb reacting to the agent's voice).
    const amp = mot.amp * (1 + react * 0.35);
    const flare = mot.flare + react * 0.9;

    // Design colour ramp: ember -> hot, quadratic in q.
    const ramp = (q, a) => {
      const c = themeRampColor(pal, q, a, lightTheme);
      return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + Math.min(1, c.a).toFixed(3) + ')';
    };

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    // Center the design-space orb (built around R0,R0) on ARIA's (cx,cy) and
    // scale the whole draw so it fills the ops-rail slot (or ~54% of the
    // viewport's short edge in the fallback).
    const k = (baseR * 1.55) / R0;
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    ctx.translate(-R0, -R0);
    ctx.globalCompositeOperation = lightTheme ? 'source-over' : 'lighter';

    const R = R0;
    const ay = phase * 0.45;                    // global yaw (design: t*0.45*spd)
    const ca = Math.cos(ay), sa = Math.sin(ay);
    const PX = [0, 0, 0, 0];
    const proj = (x, y, z) => {
      const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
      const y2 = y * CT - z1 * ST, z2 = y * ST + z1 * CT;
      const pr = 1 / (1 - z2 / (R * 3.2));
      PX[0] = R + x1 * pr; PX[1] = R + y2 * pr; PX[2] = z2; PX[3] = pr;
      return PX;
    };

    // Debris rings: glowing arc segments + loose debris squares.
    for (let ri = 0; ri < parts.rings.length; ri++) {
      const rg = parts.rings[ri];
      const a = rg.w * phase;                   // design: rg.w * t * spd
      const u = rg.u, v = rg.v;
      for (let gi = 0; gi < rg.segs.length; gi++) {
        const sg = rg.segs[gi];
        const CH = 3, NS = 5;
        for (let ci = 0; ci < CH; ci++) {
          ctx.beginPath();
          let zsum = 0, prsum = 0;
          for (let si = 0; si <= NS; si++) {
            const th = sg.a0 + a + sg.len * (ci + si / NS) / CH;
            const c1 = Math.cos(th), s1 = Math.sin(th);
            const p = proj(rg.rb * (u[0] * c1 + v[0] * s1), rg.rb * (u[1] * c1 + v[1] * s1), rg.rb * (u[2] * c1 + v[2] * s1));
            if (si === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
            zsum += p[2]; prsum += p[3];
          }
          const shade = 0.25 + 0.75 * ((zsum / (NS + 1)) / rg.rb + 1) * 0.5;
          ctx.strokeStyle = ramp(rg.h, sg.al * amp * shade);
          ctx.lineWidth = rg.lw * (prsum / (NS + 1));
          ctx.stroke();
        }
      }
      for (let di = 0; di < rg.deb.length; di++) {
        const d = rg.deb[di];
        const th = d.a + a;
        const c1 = Math.cos(th), s1 = Math.sin(th);
        const p = proj(d.rr * (u[0] * c1 + v[0] * s1), d.rr * (u[1] * c1 + v[1] * s1), d.rr * (u[2] * c1 + v[2] * s1));
        const shade = 0.25 + 0.75 * (p[2] / d.rr + 1) * 0.5;
        const fl = 0.5 + 0.5 * Math.sin(tSec * 2.4 * d.w + d.tw);
        const ss = Math.max(0.4, d.s * p[3]);
        ctx.fillStyle = ramp(d.h, (0.2 + 0.6 * fl) * amp * shade);
        ctx.fillRect(p[0] - ss / 2, p[1] - ss / 2, ss, ss);
      }
    }

    // Core + volume dust.
    for (let i = 0; i < parts.dots.length; i++) {
      const d = parts.dots[i];
      const p = proj(d.x, d.y, d.z);
      const rr = Math.hypot(d.x, d.y, d.z) || 1;
      const shade = 0.3 + 0.7 * (p[2] / rr + 1) * 0.5;
      const fl = 0.55 + 0.45 * Math.sin(tSec * 2 * d.w + d.tw);
      const ss = Math.max(0.4, d.s * p[3]);
      ctx.fillStyle = ramp(d.h, Math.min(1, (0.3 + 0.7 * fl) * shade * amp));
      ctx.fillRect(p[0] - ss / 2, p[1] - ss / 2, ss, ss);
    }

    // White-hot core flare (pulses; flares harder with the voice) + soft
    // ambient sphere.
    const pulse = (1 + 0.1 * Math.sin(tSec * 3.1) + 0.05 * Math.sin(tSec * 7.7)) * flare;
    const cr2 = R * 0.5 * Math.max(0.3, pulse);
    let g = ctx.createRadialGradient(R, R, 0, R, R, cr2);
    g.addColorStop(0, ramp(1, 0.9));
    g.addColorStop(0.35, ramp(0.62, 0.4));
    g.addColorStop(0.7, ramp(0.3, 0.13));
    g.addColorStop(1, ramp(0.2, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(R, R, cr2, 0, TAU); ctx.fill();
    g = ctx.createRadialGradient(R, R, R * 0.55, R, R, R);
    g.addColorStop(0, ramp(0.35, 0.05));
    g.addColorStop(1, ramp(0.3, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(R, R, R, 0, TAU); ctx.fill();

    ctx.restore();

    if (measuring) {
      mTime += performance.now() - t0m; mFrames++;
      if (now - mLast >= 1000) {
        const avg = mTime / mFrames;
        console.log(`[orb] render ${avg.toFixed(2)}ms/frame -> max ${(1000 / avg) | 0} FPS`);
        mFrames = 0; mTime = 0; mLast = now;
      }
    }
  }

  // Frame-rate cap per state (bounds CPU/GPU; the swirl is dt-scaled so slow
  // caps keep the same angular speed, just fewer frames).
  const STATE_MIN_MS = { idle: 33, listening: 33, processing: 33, speaking: 22 };
  // Throttled cap while an STT transcription is in flight (orb + Vulkan STT
  // together uncapped was the "crash on balanced+" symptom). There is only ever
  // ONE transcription at a time, so this is a boolean, not a refcount: a refcount
  // LEAKED when a barge-in abandoned a transcription whose result never arrived
  // (endStt missed), pinning the orb at the low relief resolution until restart —
  // the "orb goes low-res sometimes and stays there" report. The watchdog is the
  // backstop: STT can't outrun the 8s utterance hard cap + compute, so relief
  // self-clears well before 12s even if endStt is somehow missed.
  let sttActive = false;
  let sttReliefTimer = null;
  const RELIEF_MS = 33; // ~30 FPS cap for the orb while under GPU relief
  // Relief has two sources: an explicit STT transcription (beginStt/endStt) and
  // the adaptive pressure detector below. gpuRelief is the OR of the two.
  let pressureRelief = false;
  function updateRelief() { setRelief(sttActive || pressureRelief); }
  function beginStt() {
    sttActive = true;
    endSttCompute();           // entering listening: clear any stuck compute freeze
    clearTimeout(sttReliefTimer);
    sttReliefTimer = setTimeout(endStt, 12000); // failsafe: never stick low-res
    updateRelief();
  }
  function endStt() {
    clearTimeout(sttReliefTimer); sttReliefTimer = null;
    sttActive = false;
    updateRelief();
  }

  // Hard GPU quiesce for the transcription COMPUTE window (stt-end -> stt-result).
  // The 30fps relief above only REDUCES concurrent GPU submission; on the AMD
  // amdgpu/RDNA4 driver, whisper's Vulkan COMPUTE queue contending with the orb's
  // graphics submission AT ALL can trip a GPU ring-timeout/reset — the crash on
  // 'auto'/'balanced' (power-saver never hits it: it runs STT on the CPU, so there
  // is no Vulkan compute to contend with). During the brief compute window we
  // submit ZERO orb frames, so the two GPU queues never overlap. Costs no STT
  // latency (the orb just holds its last frame ~0.3-1s) and can't stick frozen:
  // beginStt clears it on the next listen and a failsafe timer auto-clears it.
  let computeFreeze = false;
  let computeFreezeTimer = null;
  function beginSttCompute() {
    computeFreeze = true;
    clearTimeout(computeFreezeTimer);
    computeFreezeTimer = setTimeout(endSttCompute, 6000); // failsafe: never stick frozen
  }
  function endSttCompute() {
    clearTimeout(computeFreezeTimer); computeFreezeTimer = null;
    computeFreeze = false;
    lastRenderAt = 0; // resume painting immediately, don't wait out the frame cap
  }
  // Exported so scripts/smoke-orb.js can assert the freeze state machine.
  function isComputeFrozen() { return computeFreeze; }

  // Adaptive GPU-pressure detector. When the orb is rendering at full speed but
  // frames keep landing far later than asked (the GPU/compositor is saturated —
  // e.g. a heavy app is sharing the GPU), engage relief to shed the orb's own
  // GPU cost. After a cooldown we drop relief and re-measure ("probe"): if the
  // system recovered we stay full-speed, else we re-engage. Idle/unloaded runs
  // never trip it, so latency and quality are untouched when there's headroom.
  const SLOW_MS = 45;      // a frame this late (while wanting ~16ms) is dropped
  const ENGAGE_N = 20;     // consecutive slow frames before relief kicks in
  const PROBE_MS = 6000;   // stay relieved this long, then re-measure at full speed
  let slowCount = 0, reliefUntil = 0;
  // Pure: should the pressure detector ENGAGE given the running slow-frame count?
  function pressureShouldEngage(slow, n) { return slow && n + 1 >= ENGAGE_N; }
  function trackPressure(now, dt) {
    if (pressureRelief) {
      if (now >= reliefUntil) { pressureRelief = false; slowCount = 0; updateRelief(); } // probe
      return;
    }
    if (gpuRelief) { slowCount = 0; return; } // STT relief active — don't measure
    const slow = dt > SLOW_MS;
    if (pressureShouldEngage(slow, slowCount)) {
      pressureRelief = true; slowCount = 0; reliefUntil = now + PROBE_MS; updateRelief();
    } else {
      slowCount = slow ? slowCount + 1 : 0;
    }
  }
  // Background (visible but unfocused) throttle: ~5 FPS, nobody's watching.
  const BLUR_MIN_MS = 200;
  // Focused floor: at least ~60 FPS so low-tier caps don't read as choppy while
  // the user is actually looking at the orb.
  const FOCUS_SMOOTH_MS = 16;
  let windowFocused = (typeof document === 'undefined') || document.hasFocus();
  let lastRenderAt = 0;

  let fpsVisible = false, fpsCount = 0, fpsLast = 0, fpsValue = 0;
  let renderWarned = false;
  function loop(now) {
    // Hard freeze during the STT compute window: submit no frames at all so the
    // orb's GPU graphics can't contend with whisper's Vulkan compute (the crash
    // combo on auto/balanced). rAF keeps spinning (cheap, no GPU) so we resume the
    // instant the freeze clears.
    if (computeFreeze) { raf = requestAnimationFrame(loop); return; }
    // Throttle to ~5 FPS in the background, EXCEPT while speaking — the voice
    // flare is the signature visual and speaking is short-lived.
    const blurred = !windowFocused && state !== 'speaking';
    const q = QUALITY[quality];
    const stateMs = (q && q.stateMs[state]) || STATE_MIN_MS[state] || 33;
    const activeMs = (q && q.activeMs) || stateMs;
    const capMs = sttActive ? Math.max(stateMs, activeMs) : stateMs;
    // Under GPU relief, honour a real ~30 FPS cap (the focus floor below would
    // otherwise force ~60 FPS during a Vulkan STT transcription — the throttle
    // that beginStt is supposed to apply was being defeated by that floor).
    const minMs = blurred ? BLUR_MIN_MS
      : gpuRelief ? Math.max(capMs, RELIEF_MS)
      : Math.min(capMs, FOCUS_SMOOTH_MS);
    if (now - lastRenderAt >= minMs) {
      const dt = now - lastRenderAt; // actual interval since the last render
      lastRenderAt = now;
      if (!blurred) trackPressure(now, dt); // adaptive GPU-pressure backoff
      // A single bad frame must never throw out of the rAF loop — that would
      // freeze the orb permanently. Catch, log once, keep animating.
      try {
        render(now);
        fpsCount++;
        if (now - fpsLast >= 500) { fpsValue = Math.round((fpsCount * 1000) / (now - fpsLast)); fpsCount = 0; fpsLast = now; }
        if (fpsVisible) {
          ctx.save();
          ctx.font = '600 13px system-ui, sans-serif';
          ctx.fillStyle = fpsValue >= 160 ? '#2ecc71' : fpsValue >= 60 ? '#e0e0e0' : '#f39c12';
          ctx.fillText(`${fpsValue} FPS · ${state}`, 12, 22);
          ctx.restore();
        }
      } catch (e) {
        if (!renderWarned) { console.error('[orb] render error (continuing):', e); renderWarned = true; }
      }
    }
    raf = requestAnimationFrame(loop);
  }

  function init() {
    canvas = document.getElementById('orb-canvas');
    if (!canvas) return;
    // NOT desynchronized: the desync path tears/jitters on some Linux
    // compositors; an ambient orb doesn't need the latency win.
    ctx = canvas.getContext('2d', { alpha: true });
    refreshAccent();
    resize();
    window.addEventListener('resize', resize);
    // A ResizeObserver catches layout-driven size changes the window 'resize'
    // event misses (the real cause of the "thin until you minimize/restore" bug).
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => resize()).observe(canvas);
    }
    // Re-resize on show/focus/DPR changes so the backing store never goes stale.
    document.addEventListener('visibilitychange', () => {
      windowFocused = !document.hidden && document.hasFocus();
      if (!document.hidden) resize();
    });
    document.addEventListener('fullscreenchange', () => { lastBw = -1; resize(); });
    window.addEventListener('focus', () => { windowFocused = true; resize(); });
    window.addEventListener('blur', () => { windowFocused = false; });
    window.addEventListener('pageshow', resize);
    // Settle initial sizing across a couple of frames in case layout isn't final.
    requestAnimationFrame(resize);
    setTimeout(resize, 120);
    setTimeout(resize, 500);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // Feed an audio level (0..1). Only has visible effect in the speaking state.
  function setLevel(v) { if (v > audio) audio = Math.min(1, v); }
  function measure() { measuring = true; mLast = performance.now(); mFrames = 0; mTime = 0; }
  function benchmark(n) {
    n = n || 300;
    setState('speaking');
    for (let i = 0; i < 30; i++) { audio = 0.6; render(performance.now()); }
    const start = performance.now();
    for (let i = 0; i < n; i++) { audio = 0.6; render(performance.now()); }
    const avg = (performance.now() - start) / n;
    setState('idle');
    return { avgMs: +avg.toFixed(3), maxFps: Math.round(1000 / avg), n };
  }
  function toggleFps() { fpsVisible = !fpsVisible; return fpsVisible; }

  // Synchronously advance the animation by `frames` (~16.7ms each) in the
  // current state — used by headless screenshot/boot tests where rAF throttles.
  function pump(frames) {
    frames = frames || 60;
    let now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (let i = 0; i < frames; i++) { now += 16.67; try { render(now); } catch (e) {} }
  }

  root.AriaOrb = { init, setLevel, setState, setQuality, beginStt, endStt, beginSttCompute, endSttCompute, isComputeFrozen, effectiveDpr, backingFor, measure, benchmark, refreshAccent, themeRampColor, toggleFps, pump, MAX_BACKING, pressureShouldEngage };
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
