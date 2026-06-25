// Reactive mesh-orb background with a visual state machine.
//
// States (AriaOrb.setState):
//   idle       — calm slow rotation, muted slate. (default)
//   listening  — cyan, gentle steady breathing (NOT audio-reactive).
//   processing — amber, faster shimmer/spin (NOT audio-reactive).
//   speaking   — theme accent, FULL audio-reactive distortion from TTS RMS.
//
// Only `speaking` moves dynamically with the audio; other states convey progress
// through colour + subtle calm motion. Keeping non-speaking states cheap also
// reduces GPU contention with whisper's Vulkan inference while STT is running.
//
// Performance: per-point trig precomputed once; per-frame work uses reused flat
// typed arrays (no allocations); shadow blur gated to the speaking state.

(function (root) {
  const LAT = 18, LON = 32;
  const NPTS = (LAT + 1) * LON;
  const TWO_PI = Math.PI * 2;

  let canvas, ctx, w, h, cx, cy, baseR;
  let t = 0, audio = 0, audioSmooth = 0, raf = null;

  // State machine + colour easing.
  const STATE_COLORS = {
    idle:       [136, 150, 180],
    listening:  [ 80, 200, 230],
    processing: [240, 180,  90],
    speaking:   [233,  69,  96], // overridden by theme accent
  };
  let state = 'idle';
  const col = [136, 150, 180];   // current eased colour
  let target = STATE_COLORS.idle.slice();
  let accent = [233, 69, 96];

  function refreshAccent() {
    try {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent-rgb').trim();
      if (v) accent = v.split(',').map((n) => parseInt(n, 10));
    } catch (e) { /* keep default */ }
    STATE_COLORS.speaking = accent.slice();
    if (state === 'speaking') target = accent.slice();
  }

  function setState(s) {
    if (!STATE_COLORS[s]) return;
    state = s;
    target = (s === 'speaking' ? accent : STATE_COLORS[s]).slice();
    if (s !== 'speaking') audio = 0; // stop dynamic motion outside speaking
  }

  // Precomputed per-point statics.
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

  const px = new Float32Array(NPTS), py = new Float32Array(NPTS);
  const pz = new Float32Array(NPTS), pp = new Float32Array(NPTS);

  const TILT = 0.42, SIN_TILT = Math.sin(TILT), COS_TILT = Math.cos(TILT);
  let gradBucket = -1, gradCache = null, gradColKey = '';

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2; cy = h / 2;
    baseR = Math.min(w, h) * 0.27;
    gradBucket = -1;
  }

  let measuring = false, mFrames = 0, mTime = 0, mLast = 0;

  function render(now) {
    const t0 = measuring ? performance.now() : 0;

    // Ease colour toward the target state colour.
    col[0] += (target[0] - col[0]) * 0.08;
    col[1] += (target[1] - col[1]) * 0.08;
    col[2] += (target[2] - col[2]) * 0.08;
    const cr = col[0] | 0, cg = col[1] | 0, cb = col[2] | 0;

    // Audio drives motion only in the speaking state.
    audioSmooth += (audio - audioSmooth) * 0.15;
    if (state === 'speaking') audio *= 0.94; else audioSmooth *= 0.9;
    const react = state === 'speaking' ? audioSmooth : 0;

    // Per-state calm motion (independent of audio).
    let spin = 0.004, breatheAmp = 0.02, pulse = 0;
    if (state === 'listening') { spin = 0.006; breatheAmp = 0.05; }
    else if (state === 'processing') { spin = 0.022; breatheAmp = 0.03; pulse = 0.03 * Math.sin(t * 5); }
    else if (state === 'speaking') { spin = 0.006 + react * 0.04; breatheAmp = 0.025; }

    t += spin + react * 0.02;
    const rot = t, cosR = Math.cos(rot), sinR = Math.sin(rot);

    ctx.clearRect(0, 0, w, h);

    // Glow gradient — rebuilt when the level bucket or colour shifts notably.
    const activity = Math.max(react, state === 'idle' ? 0.05 : 0.18);
    const bucket = (activity * 12) | 0;
    const colKey = `${cr},${cg},${cb}`;
    if (bucket !== gradBucket || colKey !== gradColKey) {
      gradBucket = bucket; gradColKey = colKey;
      const glowR = baseR * (1.8 + activity * 0.9);
      const g = ctx.createRadialGradient(cx, cy, baseR * 0.1, cx, cy, glowR);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${0.16 + activity * 0.3})`);
      g.addColorStop(0.5, `rgba(${cr},${cg},${cb},${0.05 + activity * 0.12})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      gradCache = g;
    }
    ctx.fillStyle = gradCache;
    ctx.fillRect(0, 0, w, h);

    // Uniform radius: one scale for every point keeps it a true sphere, so the
    // longitude/latitude grid intersections stay perfectly aligned (no lumpy
    // per-vertex distortion). "Speaking" expands the whole sphere with the voice.
    const rScale = 1 + breatheAmp * Math.sin(t * 1.3) + pulse + react * 0.16;
    const r = baseR * rScale;

    let minZ = 1e9, maxZ = -1e9;
    for (let k = 0; k < NPTS; k++) {
      const sp = sinPhi[k];
      const x = r * sp * cosTh[k];
      const y = r * cosPhi[k];
      const z = r * sp * sinTh[k];
      const x2 = x * cosR - z * sinR;
      const z2 = x * sinR + z * cosR;
      const y2 = y * COS_TILT - z2 * SIN_TILT;
      const z3 = y * SIN_TILT + z2 * COS_TILT;
      const persp = 540 / (540 + z3);
      px[k] = cx + x2 * persp; py[k] = cy + y2 * persp;
      pz[k] = z3; pp[k] = persp;
      if (z3 < minZ) minZ = z3; if (z3 > maxZ) maxZ = z3;
    }
    const zRange = (maxZ - minZ) || 1;

    // Bright glowing core — a hot center fading to the orb colour.
    const coreR = baseR * (0.85 * rScale);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    const hot = (c) => Math.min(255, c + 70);
    core.addColorStop(0, `rgba(${hot(cr)},${hot(cg)},${hot(cb)},${0.55 + react * 0.35})`);
    core.addColorStop(0.35, `rgba(${cr},${cg},${cb},${0.30 + react * 0.25})`);
    core.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TWO_PI);
    ctx.fill();

    // Depth-shaded wireframe: front lines brighter/thicker than back.
    if (react > 0.04) { ctx.shadowColor = `rgba(${cr},${cg},${cb},${react})`; ctx.shadowBlur = react * 16; }
    else ctx.shadowBlur = 0;

    // Longitude lines (segment alpha by depth).
    for (let j = 0; j < LON; j++) {
      for (let i = 0; i < LAT; i++) {
        const k = i * LON + j, k2 = k + LON;
        const depth = ((pz[k] + pz[k2]) * 0.5 - minZ) / zRange; // 0 back .. 1 front
        const a = 0.10 + depth * 0.45;
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${a})`;
        ctx.lineWidth = 0.7 + depth * 1.3;
        ctx.beginPath();
        ctx.moveTo(px[k], py[k]); ctx.lineTo(px[k2], py[k2]);
        ctx.stroke();
      }
    }
    // Latitude rings.
    for (let i = 0; i <= LAT; i++) {
      const base = i * LON;
      for (let j = 0; j < LON; j++) {
        const k = base + j, k2 = base + ((j + 1) % LON);
        const depth = ((pz[k] + pz[k2]) * 0.5 - minZ) / zRange;
        const a = 0.08 + depth * 0.38;
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${a})`;
        ctx.lineWidth = 0.7 + depth * 1.1;
        ctx.beginPath();
        ctx.moveTo(px[k], py[k]); ctx.lineTo(px[k2], py[k2]);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;

    // Front vertex dots, brighter with depth + activity.
    for (let k = 0; k < NPTS; k++) {
      if (pz[k] < 0) continue;
      const depth = (pz[k] - minZ) / zRange;
      const r = (0.8 + react * 1.8 + depth * 0.8) * pp[k];
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${0.35 + depth * 0.5})`;
      ctx.beginPath();
      ctx.arc(px[k], py[k], r, 0, TWO_PI);
      ctx.fill();
    }

    if (measuring) {
      mTime += performance.now() - t0; mFrames++;
      if (now - mLast >= 1000) {
        const avg = mTime / mFrames;
        console.log(`[orb] render ${avg.toFixed(2)}ms/frame -> max ${(1000 / avg) | 0} FPS`);
        mFrames = 0; mTime = 0; mLast = now;
      }
    }
  }

  // Frame-rate cap per state. `speaking` runs uncapped (smooth, audio-reactive);
  // other states throttle to ~30 FPS so whisper's Vulkan STT isn't starved of
  // the GPU while listening/processing (the wake->STT lag fix).
  const STATE_MIN_MS = { idle: 33, listening: 33, processing: 33, speaking: 0 };
  let lastRenderAt = 0;

  let fpsVisible = false, fpsCount = 0, fpsLast = 0, fpsValue = 0;
  function loop(now) {
    const minMs = STATE_MIN_MS[state] || 0;
    if (now - lastRenderAt < minMs) { raf = requestAnimationFrame(loop); return; }
    lastRenderAt = now;
    render(now);
    fpsCount++;
    if (now - fpsLast >= 500) { fpsValue = Math.round((fpsCount * 1000) / (now - fpsLast)); fpsCount = 0; fpsLast = now; }
    if (fpsVisible) {
      ctx.save(); ctx.shadowBlur = 0;
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillStyle = fpsValue >= 160 ? '#2ecc71' : fpsValue >= 60 ? '#e0e0e0' : '#f39c12';
      ctx.fillText(`${fpsValue} FPS · ${state}`, 12, 22);
      ctx.restore();
    }
    raf = requestAnimationFrame(loop);
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

  root.AriaOrb = { init, setLevel, setState, measure, benchmark, refreshAccent, toggleFps };
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
