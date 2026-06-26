// Reactive mesh-orb background with a visual state machine.
//
// States (AriaOrb.setState) — each a clearly DISTINCT hue so the state is
// obvious at a glance:
//   idle       — cyan,   calm. (default)
//   listening  — purple, calm.
//   processing — orange, calm ("thinking").
//   speaking   — green,  surface DEFORMS dynamically from the TTS RMS.
//
// Rotation runs at ONE constant speed in every state (it never speeds up when
// the agent talks); the orb keeps a steady size and only its surface ripples
// while speaking. State is conveyed by colour, which cross-fades smoothly
// between states rather than snapping.
//
// Performance: per-point trig precomputed once; per-frame work uses reused flat
// typed arrays (no allocations); shadow blur gated to the speaking state.

(function (root) {
  const LAT = 18, LON = 32;
  const NPTS = (LAT + 1) * LON;
  const TWO_PI = Math.PI * 2;
  // Constant rotation speed (radians/60fps-frame) — identical in every state.
  const SPIN = 0.005;
  // Gentle, constant "alive" breathing amplitude (NOT audio-driven), so the orb
  // never visibly grows/shrinks with the voice.
  const BREATHE = 0.018;

  let canvas, ctx, w, h, cx, cy, baseR;
  let t = 0, audio = 0, audioSmooth = 0, raf = null;

  // State machine + colour easing. Fixed, well-separated hues (cyan / purple /
  // orange / green) so the four states are easy to tell apart — they used to be
  // too similar, and speaking tracked the theme accent.
  const STATE_COLORS = {
    idle:       [ 34, 211, 230], // cyan
    listening:  [167,  92, 255], // purple
    processing: [255, 146,  48], // orange (thinking)
    speaking:   [ 42, 208, 102], // green
  };
  let state = 'idle';
  const col = STATE_COLORS.idle.slice();  // current eased colour
  let target = STATE_COLORS.idle.slice();
  let accent = [233, 69, 96];

  function refreshAccent() {
    // The orb's state colours are now fixed + distinct rather than the theme
    // accent (so states stay easy to tell apart in every theme); this only keeps
    // `accent` current for any other consumer and is otherwise a no-op here.
    try {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent-rgb').trim();
      if (v) accent = v.split(',').map((n) => parseInt(n, 10));
    } catch (e) { /* keep default */ }
  }

  function setState(s) {
    if (!STATE_COLORS[s]) return;
    state = s;
    target = STATE_COLORS[s].slice();
    if (s !== 'speaking') audio = 0; // stop dynamic deformation outside speaking
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

    // Ease colour toward the target state colour. A gentle constant (~0.8s
    // cross-fade) so switching states reads as a smooth blend, never a sudden
    // swap.
    const colK = ease(0.05);
    col[0] += (target[0] - col[0]) * colK;
    col[1] += (target[1] - col[1]) * colK;
    col[2] += (target[2] - col[2]) * colK;
    const cr = col[0] | 0, cg = col[1] | 0, cb = col[2] | 0;

    // Audio drives ONLY the speaking-state surface deformation — never rotation
    // speed or overall size. Forced to 0 outside speaking; smoothed + dt-scaled
    // so a spiky speech envelope ripples the surface smoothly, not jitterily.
    if (state !== 'speaking') audio = 0;
    audioSmooth += (audio - audioSmooth) * ease(0.15);
    if (state === 'speaking') audio *= Math.pow(0.92, dt); else audioSmooth *= Math.pow(0.85, dt);
    const react = state === 'speaking' ? Math.min(1, audioSmooth) : 0;

    // Rotation is CONSTANT in every state — same smooth speed whether idle,
    // listening, thinking, or speaking. (dt-scaled, so the angular speed is
    // identical at 30/60/160 Hz; only smoothness changes.)
    t += SPIN * dt;
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

    // Steady size: only a gentle constant breathing — NO audio size-pulsing — so
    // the orb doesn't grow/shrink when the agent talks. The voice instead shows
    // as per-vertex surface deformation (applied in the projection loop below),
    // which only happens while speaking.
    const rScale = 1 + BREATHE * Math.sin(t * 1.3);
    const r = baseR * rScale;
    // Speaking-only deformation amplitude (0 in every other state).
    const dAmp = react * 0.13;

    // "Nearness" is measured by the perspective scale (pp): a larger pp means the
    // point is closer to the viewer. Using pp (not the raw rotated z) removes any
    // sign-convention ambiguity, so the side facing the user is reliably the one
    // drawn thick + bright (fixes "the mesh gets thinner closer to the user").
    let ppMin = 1e9, ppMax = -1e9;
    for (let k = 0; k < NPTS; k++) {
      const sp = sinPhi[k];
      // Speaking-only surface ripple: two low-frequency travelling waves over the
      // sphere give an organic, non-jittery deformation that tracks the voice.
      // dAmp is 0 outside speaking, so idle/listening/thinking stay perfectly
      // smooth true spheres.
      let rk = r;
      if (dAmp > 0.0005) {
        const wob = Math.sin(phiArr[k] * 3.0 + t * 3.1 + seed[k] * 6.2)
                  + Math.sin(thArr[k] * 2.0 - t * 2.3 + seed[k] * 2.7);
        rk = r * (1 + dAmp * wob * 0.5);
      }
      const x = rk * sp * cosTh[k];
      const y = rk * cosPhi[k];
      const z = rk * sp * sinTh[k];
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

  // Frame-rate cap per state. idle + speaking run uncapped (native refresh, so
  // the constant rotation is buttery smooth); listening/processing cap at ~60
  // FPS — still smooth, but leaves some GPU headroom for whisper's Vulkan STT
  // while it runs. (The old ~30 FPS cap is what made the rotation look choppy.)
  const STATE_MIN_MS = { idle: 0, listening: 16, processing: 16, speaking: 0 };
  let lastRenderAt = 0;

  let fpsVisible = false, fpsCount = 0, fpsLast = 0, fpsValue = 0;
  let renderWarned = false;
  function loop(now) {
    const minMs = STATE_MIN_MS[state] || 0;
    if (now - lastRenderAt >= minMs) {
      lastRenderAt = now;
      // A single bad frame (e.g. a transient state during a resize) must never
      // throw out of the rAF loop — that would freeze the orb permanently. Catch,
      // log once, and keep animating.
      try {
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
      } catch (e) {
        if (!renderWarned) { console.error('[orb] render error (continuing):', e); renderWarned = true; }
      }
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

  // Synchronously advance the animation by `frames` (~16.7ms each) in the current
  // state, so colour easing + motion settle deterministically. Used by headless
  // screenshot/boot tests where the window is hidden and rAF is throttled.
  function pump(frames) {
    frames = frames || 60;
    let now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (let i = 0; i < frames; i++) { now += 16.67; try { render(now); } catch (e) {} }
  }

  root.AriaOrb = { init, setLevel, setState, measure, benchmark, refreshAccent, toggleFps, pump };
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
