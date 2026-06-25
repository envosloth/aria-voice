// Reactive mesh-orb background. A wireframe sphere on a full-window Canvas
// behind the UI: idles with gentle rotation + breathing, and when the agent is
// talking it spins faster, distorts, and glows — amplitude from AriaOrb.setLevel
// (called from the TTS audio handler). Canvas 2D, no deps.
//
// Performance: per-point spherical trig is precomputed once; per-frame work
// reuses flat typed arrays (no allocations), shadow blur is gated to active
// frames, and the glow gradient is rebuilt only when the level bucket changes —
// keeping frame render time well under the 6.25 ms needed for 160 FPS.

(function (root) {
  const LAT = 13;
  const LON = 24;
  const NPTS = (LAT + 1) * LON;
  const TWO_PI = Math.PI * 2;

  let canvas, ctx, w, h, cx, cy, baseR;
  let t = 0, level = 0, smooth = 0, raf = null;

  // Theme accent (r,g,b), refreshed from CSS so the orb matches the theme.
  let accent = [233, 69, 96];
  function refreshAccent() {
    try {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent-rgb').trim();
      if (v) accent = v.split(',').map((n) => parseInt(n, 10));
    } catch (e) { /* keep default */ }
  }

  // Precomputed per-point statics: sin/cos of phi & theta, and a phase seed.
  const sinPhi = new Float32Array(NPTS), cosPhi = new Float32Array(NPTS);
  const sinTh = new Float32Array(NPTS), cosTh = new Float32Array(NPTS);
  const phiArr = new Float32Array(NPTS), thArr = new Float32Array(NPTS);
  const seed = new Float32Array(NPTS);
  (function build() {
    let k = 0;
    for (let i = 0; i <= LAT; i++) {
      const phi = (i / LAT) * Math.PI;
      for (let j = 0; j < LON; j++, k++) {
        const theta = (j / LON) * TWO_PI;
        phiArr[k] = phi; thArr[k] = theta;
        sinPhi[k] = Math.sin(phi); cosPhi[k] = Math.cos(phi);
        sinTh[k] = Math.sin(theta); cosTh[k] = Math.cos(theta);
        seed[k] = Math.sin(i * 12.9 + j * 78.2);
      }
    }
  })();

  // Reused per-frame buffers.
  const px = new Float32Array(NPTS), py = new Float32Array(NPTS);
  const pz = new Float32Array(NPTS), pp = new Float32Array(NPTS);

  const TILT = 0.42, SIN_TILT = Math.sin(TILT), COS_TILT = Math.cos(TILT);

  let gradLevelBucket = -1, gradCache = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2; cy = h / 2;
    baseR = Math.min(w, h) * 0.26;
    gradLevelBucket = -1; // force gradient rebuild
  }

  // FPS / frame-time measurement (enabled via AriaOrb.measure()).
  let measuring = false, mFrames = 0, mTime = 0, mLast = 0;

  let fpsVisible = false, fpsCount = 0, fpsLast = 0, fpsValue = 0;
  function loop(now) {
    render(now);
    // Live FPS (actual rAF rate — reflects the display/compositor).
    fpsCount++;
    if (now - fpsLast >= 500) {
      fpsValue = Math.round((fpsCount * 1000) / (now - fpsLast));
      fpsCount = 0; fpsLast = now;
    }
    if (fpsVisible) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillStyle = fpsValue >= 160 ? '#2ecc71' : fpsValue >= 60 ? '#e0e0e0' : '#f39c12';
      ctx.fillText(`${fpsValue} FPS`, 12, 22);
      ctx.restore();
    }
    raf = requestAnimationFrame(loop);
  }

  function render(now) {
    const t0 = measuring ? performance.now() : 0;

    smooth += (level - smooth) * 0.12;
    level *= 0.94;
    const active = smooth;
    t += 0.006 + active * 0.03;
    const rot = t, cosR = Math.cos(rot), sinR = Math.sin(rot);

    ctx.clearRect(0, 0, w, h);

    // Glow gradient — rebuilt only when the level bucket changes.
    const bucket = (active * 12) | 0;
    if (bucket !== gradLevelBucket) {
      gradLevelBucket = bucket;
      const glowR = baseR * (1.7 + active * 0.8);
      const g = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, glowR);
      const a = 0.10 + active * 0.35;
      g.addColorStop(0, `rgba(${accent[0]},${accent[1]},${accent[2]},${a})`);
      g.addColorStop(1, `rgba(${accent[0]},${accent[1]},${accent[2]},0)`);
      gradCache = g;
    }
    ctx.fillStyle = gradCache;
    ctx.fillRect(0, 0, w, h);

    // Project all points into the reused buffers.
    for (let k = 0; k < NPTS; k++) {
      const breathe = 0.03 * Math.sin(t * 1.3 + phiArr[k] * 3);
      const reactive = active * 0.22 * Math.sin(t * 6 + seed[k] * 6 + thArr[k] * 4);
      const r = baseR * (1 + breathe + reactive);
      const sp = sinPhi[k];
      const x = r * sp * cosTh[k];
      const y = r * cosPhi[k];
      const z = r * sp * sinTh[k];
      const x2 = x * cosR - z * sinR;
      const z2 = x * sinR + z * cosR;
      const y2 = y * COS_TILT - z2 * SIN_TILT;
      const z3 = y * SIN_TILT + z2 * COS_TILT;
      const persp = 520 / (520 + z3);
      px[k] = cx + x2 * persp; py[k] = cy + y2 * persp;
      pz[k] = z3; pp[k] = persp;
    }

    // Line color eases muted-slate -> accent with activity.
    const lr = Math.round(136 + active * (accent[0] - 136));
    const lg = Math.round(136 + active * (accent[1] - 136));
    const lb = Math.round(170 + active * (accent[2] - 170));

    ctx.lineWidth = 1;
    if (active > 0.02) {
      ctx.shadowColor = `rgba(${accent[0]},${accent[1]},${accent[2]},${active})`;
      ctx.shadowBlur = active * 14;
    } else {
      ctx.shadowBlur = 0;
    }

    // Longitude lines
    ctx.strokeStyle = `rgba(${lr},${lg},${lb},0.22)`;
    for (let j = 0; j < LON; j++) {
      ctx.beginPath();
      for (let i = 0; i <= LAT; i++) {
        const k = i * LON + j;
        if (i === 0) ctx.moveTo(px[k], py[k]); else ctx.lineTo(px[k], py[k]);
      }
      ctx.stroke();
    }
    // Latitude rings
    ctx.strokeStyle = `rgba(${lr},${lg},${lb},0.18)`;
    for (let i = 0; i <= LAT; i++) {
      ctx.beginPath();
      const base = i * LON;
      ctx.moveTo(px[base], py[base]);
      for (let j = 1; j < LON; j++) ctx.lineTo(px[base + j], py[base + j]);
      ctx.lineTo(px[base], py[base]);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Front-facing vertex dots.
    ctx.fillStyle = `rgba(${lr},${lg},${lb},0.5)`;
    for (let k = 0; k < NPTS; k++) {
      if (pz[k] < 0) continue;
      const r = (0.6 + active * 1.6) * pp[k];
      ctx.beginPath();
      ctx.arc(px[k], py[k], r, 0, TWO_PI);
      ctx.fill();
    }

    if (measuring) {
      mTime += performance.now() - t0; mFrames++;
      if (now - mLast >= 1000) {
        const avg = mTime / mFrames;
        console.log(`[orb] render ${avg.toFixed(2)}ms/frame -> max ${(1000 / avg) | 0} FPS, ${mFrames} frames/s`);
        mFrames = 0; mTime = 0; mLast = now;
      }
    }
  }

  function init() {
    canvas = document.getElementById('orb-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    refreshAccent();
    resize();
    window.addEventListener('resize', resize);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function setLevel(v) { if (v > level) level = Math.min(1, v); }
  function measure() { measuring = true; mLast = performance.now(); mFrames = 0; mTime = 0; }

  // Throttle-independent render benchmark: time `n` renders without rAF.
  // Returns avg ms/frame and the FPS that render budget could sustain.
  function benchmark(n) {
    n = n || 300;
    // warm up
    for (let i = 0; i < 30; i++) { level = 0.6; render(performance.now()); }
    const start = performance.now();
    for (let i = 0; i < n; i++) { level = 0.6; render(performance.now()); }
    const total = performance.now() - start;
    const avg = total / n;
    return { avgMs: +avg.toFixed(3), maxFps: Math.round(1000 / avg), n };
  }

  function toggleFps() { fpsVisible = !fpsVisible; return fpsVisible; }
  root.AriaOrb = { init, setLevel, measure, benchmark, refreshAccent, toggleFps };
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
