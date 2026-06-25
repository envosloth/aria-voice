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

  let lastW = -1, lastH = -1, lastDpr = -1;
  function resize() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    // Skip until the canvas has a real layout size — sizing the backing store to
    // 0 (or to a pre-layout value) is what left the mesh looking thin/blurry
    // until a window minimize/restore forced a correct resize.
    if (cw < 2 || ch < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // No-op if nothing actually changed, so a chatty ResizeObserver doesn't clear
    // the canvas every tick (which would flicker).
    if (cw === lastW && ch === lastH && dpr === lastDpr) return;
    lastW = cw; lastH = ch; lastDpr = dpr;
    w = cw; h = ch;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2; cy = h / 2;
    baseR = Math.min(w, h) * 0.27;
    gradBucket = -1;
  }

  let measuring = false, mFrames = 0, mTime = 0, mLast = 0;

  let lastFrameTime = 0;
  function render(now) {
    const t0 = measuring ? performance.now() : 0;
    // Time-based step (normalized to a 60 FPS frame), clamped so a hitch or a
    // 160 Hz refresh both animate at the SAME visual speed — no shake/jitter.
    const dt = lastFrameTime ? Math.min(3, (now - lastFrameTime) / 16.667) : 1;
    lastFrameTime = now;

    // Frame-rate-independent easing: scale each per-60fps-frame factor by dt so
    // an ease feels identical at 60 or 160 Hz. Plain per-frame easing decays more
    // often at high refresh, which is what made the orb shimmer/shake. (Rotation
    // already used dt; the colour/audio filters did not.)
    const ease = (k) => 1 - Math.pow(1 - k, dt);

    // Ease colour toward the target state colour.
    const colK = ease(0.08);
    col[0] += (target[0] - col[0]) * colK;
    col[1] += (target[1] - col[1]) * colK;
    col[2] += (target[2] - col[2]) * colK;
    const cr = col[0] | 0, cg = col[1] | 0, cb = col[2] | 0;

    // Audio drives motion only in the speaking state. Smoothed a bit more (0.12)
    // and dt-scaled so a spiky speech envelope pulses the orb smoothly rather
    // than juddering; attack/decay are dt-scaled too for refresh independence.
    audioSmooth += (audio - audioSmooth) * ease(0.12);
    if (state === 'speaking') audio *= Math.pow(0.94, dt); else audioSmooth *= Math.pow(0.9, dt);
    const react = state === 'speaking' ? audioSmooth : 0;

    // Per-state calm motion (independent of audio).
    let spin = 0.004, breatheAmp = 0.02, pulse = 0;
    if (state === 'listening') { spin = 0.006; breatheAmp = 0.05; }
    else if (state === 'processing') { spin = 0.022; breatheAmp = 0.03; pulse = 0.03 * Math.sin(t * 5); }
    else if (state === 'speaking') { spin = 0.006 + react * 0.04; breatheAmp = 0.025; }

    t += (spin + react * 0.02) * dt;
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

    // "Nearness" is measured by the perspective scale (pp): a larger pp means the
    // point is closer to the viewer. Using pp (not the raw rotated z) removes any
    // sign-convention ambiguity, so the side facing the user is reliably the one
    // drawn thick + bright (fixes "the mesh gets thinner closer to the user").
    let ppMin = 1e9, ppMax = -1e9;
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
      if (persp < ppMin) ppMin = persp; if (persp > ppMax) ppMax = persp;
    }
    const ppRange = (ppMax - ppMin) || 1;

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

    // Depth-shaded wireframe, BATCHED by depth bucket: one stroke per bucket
    // instead of ~1150 individual stroke() calls. This is the main perf win
    // (draw calls dominate 2D-canvas cost). Front buckets are thicker/brighter;
    // the alpha floor is high enough that lines passing behind the sphere stay
    // clearly visible (fixes "back lines barely show"). Thicker + round caps
    // give the mesh more body.
    if (react > 0.04) { ctx.shadowColor = `rgba(${cr},${cg},${cb},${0.6 + react})`; ctx.shadowBlur = 8 + react * 18; }
    else { ctx.shadowColor = `rgba(${cr},${cg},${cb},0.4)`; ctx.shadowBlur = 4; }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const NB = 6;
    for (let b = 0; b < NB; b++) {
      const d0 = b / NB, d1 = (b + 1) / NB;
      const dc = (d0 + d1) * 0.5;            // bucket center nearness (0 back .. 1 front)
      const last = b === NB - 1;
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.20 + dc * 0.65})`; // floor 0.20
      ctx.lineWidth = 1.3 + dc * 2.1;        // ~1.3 (back) .. ~3.3px (front)
      ctx.beginPath();
      // longitude segments
      for (let j = 0; j < LON; j++) {
        for (let i = 0; i < LAT; i++) {
          const k = i * LON + j, k2 = k + LON;
          const front = ((pp[k] + pp[k2]) * 0.5 - ppMin) / ppRange;
          if (front < d0 || (front >= d1 && !last)) continue;
          ctx.moveTo(px[k], py[k]); ctx.lineTo(px[k2], py[k2]);
        }
      }
      // latitude rings
      for (let i = 0; i <= LAT; i++) {
        const base = i * LON;
        for (let j = 0; j < LON; j++) {
          const k = base + j, k2 = base + ((j + 1) % LON);
          const front = ((pp[k] + pp[k2]) * 0.5 - ppMin) / ppRange;
          if (front < d0 || (front >= d1 && !last)) continue;
          ctx.moveTo(px[k], py[k]); ctx.lineTo(px[k2], py[k2]);
        }
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Vertex dots on the near hemisphere (the half facing the user), brighter and
    // larger the closer they are. Batched into 3 nearness buckets (one fill each).
    for (let b = 0; b < 3; b++) {
      const d0 = b / 3, d1 = (b + 1) / 3, dc = (d0 + d1) * 0.5, last = b === 2;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${0.45 + dc * 0.5})`;
      ctx.beginPath();
      for (let k = 0; k < NPTS; k++) {
        const front = (pp[k] - ppMin) / ppRange;
        if (front < 0.5) continue;          // near hemisphere only
        if (front < d0 || (front >= d1 && !last)) continue;
        const rr = (1.0 + react * 1.8 + dc * 1.0) * pp[k];
        ctx.moveTo(px[k] + rr, py[k]);
        ctx.arc(px[k], py[k], rr, 0, TWO_PI);
      }
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
    // A ResizeObserver catches layout-driven size changes the window 'resize'
    // event misses (the real cause of the "thin until you minimize/restore" bug).
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => resize()).observe(canvas);
    }
    // Re-resize when the window is shown again or regains focus / changes DPR
    // (e.g. dragged to another monitor) so the backing store never goes stale.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resize(); });
    window.addEventListener('focus', resize);
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

  root.AriaOrb = { init, setLevel, setState, measure, benchmark, refreshAccent, toggleFps };
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
