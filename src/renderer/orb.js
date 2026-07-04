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

  // Render-quality profiles, selected from the host's hardware tier + the GPU
  // usage cap (see src/main/hardware.ts, applied via AriaOrb.setQuality). The orb
  // is the renderer's one continuous GPU consumer, and the shadow-blur pass is by
  // far its most expensive GPU op — on a weak GPU, full-quality blur at the
  // speaking frame rate is what pushes the compositor toward 100% and can freeze
  // the desktop. Lower tiers cap the frame rate and the blur radius (or drop
  // shadows entirely), which keeps GPU work bounded while the motion still reads.
  //   stateMs: min ms between frames per state (higher = fewer FPS = less GPU)
  //   shadows: whether to draw the GPU-costly shadow blur at all
  //   blurMax: ceiling on shadowBlur radius when shadows are on
  const QUALITY = {
    // High tier (capable GPU, focused window): render every rAF -> native display
    // refresh (160/165/240 Hz), so the orb is buttery, not visibly capped. 4ms is a
    // ~250 FPS ceiling that no real panel hits, so in practice it's one render per
    // refresh. Background windows still drop to BLUR_MIN_MS (~5 FPS) in loop().
    // The 'activeMs' is the throttled cap when an STT transcription is in flight
    // (set by AriaOrb.beginStt/endStt from the renderer when the LLM/stt IPC
    // fires) — 16ms = ~60 FPS, which still reads as smooth but takes the GPU
    // from being pegged by a 240 Hz orb + Vulkan STT + speech playback, which
    // was the "crash on balanced+" symptom.
    high:   { stateMs: { idle: 4, listening: 4, processing: 4, speaking: 4 }, activeMs: 16, shadows: true,  blurMax: 26 },
    medium: { stateMs: { idle: 40, listening: 40, processing: 40, speaking: 28 }, activeMs: 40, shadows: true,  blurMax: 8 },
    low:    { stateMs: { idle: 66, listening: 66, processing: 66, speaking: 40 }, activeMs: 66, shadows: false, blurMax: 0 },
  };
  let quality = 'high';
  function setQuality(q) {
    if (!QUALITY[q] || q === quality) return;
    quality = q;
    // Re-apply the backing-store resolution cap for the new quality (forces a real
    // resize even though the element size didn't change).
    if (canvas && ctx) { lastDpr = -1; resize(); }
  }

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

  // Backing-store long-edge cap (device px) per quality. THIS is the fullscreen-
  // shake fix: a fullscreen / hi-DPI canvas otherwise balloons to millions of
  // pixels (e.g. 5120x2880), making the per-frame whole-canvas glow fills + shadow
  // blur so expensive that frames arrive unevenly. With time-based motion, uneven
  // frame delivery shows up as the orb "shaking"/stuttering — but ONLY at large
  // sizes, which is why it's smooth windowed and shaky fullscreen. Rendering the
  // soft glow at a bounded resolution and letting CSS scale it up to the element
  // is visually identical for a glow, but keeps frame time low + steady so motion
  // stays smooth. Lower quality caps harder (which also bounds GPU work).
  // Caps raised from the first optimization pass (1100/1500/1920): the old 'high'
  // cap of 1920 downsampled a 1440p / 1080p@2x fullscreen canvas and CSS upscaled
  // it, which read as a blurry, "low-resolution" orb. 2560 renders those displays
  // natively crisp and still bounds 4K (3840 -> 2560); the dt-scaled motion + the
  // per-state FPS caps keep frame time steady at the higher resolution, and a weak
  // GPU is already forced to medium/low (which cap harder) by the GPU usage tier.
  const MAX_BACKING = { low: 1280, medium: 1920, high: 2560 };
  // Pure: the effective device-pixel-ratio to use so the longest backing-store
  // edge never exceeds the current quality's cap. On a small window it's a no-op
  // (returns rawDpr); at fullscreen / hi-DPI it scales down. Exported for tests.
  function effectiveDpr(cw, ch, rawDpr) {
    const cap = MAX_BACKING[quality] || 1920;
    const longEdge = Math.max(cw, ch) * rawDpr;
    return longEdge > cap ? rawDpr * (cap / longEdge) : rawDpr;
  }
  // Pure: integer backing-store dimensions for a (cw, ch, rawDpr), plus the EXACT
  // axis scales that map the [0,cw]x[0,ch] drawing space onto [0,bw]x[0,bh]. Using
  // the raw effectiveDpr in setTransform left drawing coord x=cw landing at cw*dpr
  // (e.g. 1920.4) while the backing store was only round(cw*dpr)=1920 wide — so the
  // rightmost fractional strip sampled OUTSIDE the backing store and shimmered. The
  // left/top edges map to 0 exactly, which is why the jitter was right/bottom only.
  // Deriving sx=bw/cw, sy=bh/ch makes the right/bottom edges land exactly on the
  // backing store, killing the edge jitter. Exported for tests.
  function backingFor(cw, ch, rawDpr) {
    const dpr = effectiveDpr(cw, ch, rawDpr);
    const bw = Math.max(1, Math.round(cw * dpr));
    const bh = Math.max(1, Math.round(ch * dpr));
    return { bw, bh, sx: bw / cw, sy: bh / ch };
  }
  let lastW = -1, lastH = -1, lastBw = -1, lastBh = -1;
  function resize() {
    const realDpr = window.devicePixelRatio || 1;
    // Available CSS size = the viewport (the canvas is position:fixed inset:0). Use
    // this, NOT the element's own box — once we set an explicit grid-snapped width
    // below, reading the element back would stop tracking window/fullscreen resizes.
    const availW = window.innerWidth || (canvas.clientWidth), availH = window.innerHeight || (canvas.clientHeight);
    if (!availW || !availH || availW < 2 || availH < 2) return;
    // THE right-edge-jitter fix: snap the element to a WHOLE number of device pixels.
    // At a fractional devicePixelRatio (125%/150% scaling) an integer-CSS-pixel width
    // put the element's right/bottom edge BETWEEN device pixels; the left/top edges
    // are pinned at 0, so only the right/bottom shimmered as the orb animated. Sizing
    // to devW/realDpr lands those edges exactly on the device-pixel grid.
    const devW = Math.round(availW * realDpr), devH = Math.round(availH * realDpr);
    const cw = devW / realDpr, ch = devH / realDpr;
    const rawDpr = Math.min(realDpr, 2);
    const { bw, bh, sx, sy } = backingFor(cw, ch, rawDpr);
    // No-op if neither the (snapped) layout size nor the integer backing changed, so
    // a chatty ResizeObserver doesn't clear the canvas every tick (which flickers).
    if (cw === lastW && ch === lastH && bw === lastBw && bh === lastBh) return;
    lastW = cw; lastH = ch; lastBw = bw; lastBh = bh;
    w = cw; h = ch;
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    canvas.width = bw; canvas.height = bh;
    // Exact per-axis scale (≈dpr) so the drawing space fills the backing store with
    // no fractional overhang on the right/bottom edge — see backingFor().
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
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

    // Audio drives the speaking-state surface deformation — never rotation speed
    // or overall size. Only 'speaking' FEEDS new audio in; other states let the
    // residual decay out. Crucially we DON'T hard-zero react when leaving
    // speaking: the smoothed level eases down, so a barge-in (speaking ->
    // listening) makes the orb un-deform GRADUALLY while its colour cross-fades,
    // instead of snapping flat. In a steady non-speaking state audioSmooth ~= 0,
    // so there's no residual deformation.
    if (state !== 'speaking') audio = 0;
    audioSmooth += (audio - audioSmooth) * ease(0.15);
    if (state === 'speaking') audio *= Math.pow(0.92, dt); else audioSmooth *= Math.pow(0.9, dt);
    const react = Math.min(1, audioSmooth);

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
    // Speaking deformation amplitude. Tracks the (eased) voice level, so it
    // ramps in when speaking and eases back out on a barge-in. Higher than the
    // first pass — the deformation was too subtle — but the waves are smooth +
    // low-frequency so it stays a rounded blob, not spikes.
    const dAmp = react * 0.24;

    // Organic ambient drift — independent of the audio-reactive wobble so the orb
    // reads as alive even when it's NOT speaking. Three coupled sine waves at
    // quasi-commensurate frequencies produce a non-repeating gentle tide. Cheap
    // (3 sin per frame, NOT per-vertex); uniform radial scale so neighbouring
    // vertices stay together — preserves the blob reading, no spikes.
    const drift =
      0.012 * Math.sin(t * 0.27) +
      0.008 * Math.sin(t * 0.41 + 1.3) +
      0.005 * Math.sin(t * 0.71 + 2.6);

    // "Nearness" is measured by the perspective scale (pp): a larger pp means the
    // point is closer to the viewer. Using pp (not the raw rotated z) removes any
    // sign-convention ambiguity, so the side facing the user is reliably the one
    // drawn thick + bright (fixes "the mesh gets thinner closer to the user").
    let ppMin = 1e9, ppMax = -1e9;
    for (let k = 0; k < NPTS; k++) {
      const sp = sinPhi[k];
      // Speaking-only surface deformation. The design goal: a NATURAL-looking
      // bulge that "breathes" with the voice, like a soft balloon being
      // gently squeezed on one side. Earlier iterations stacked 7+ wave
      // components with per-vertex jitter — that produced a "rippled" or
      // "cellular" surface that read as a glitch, not a living thing. The
      // fix is fewer components, lower frequencies, and NO per-vertex
      // jitter — vertices with the same (phi, theta) move the same amount,
      // so neighbours stay phase-aligned and the surface stays smooth.
      //
      // Components:
      //   1) One slow equatorial bulge (one full wave around theta, polar-
      //      damped so the poles don't move). This is the primary
      //      "swelling" that visibly responds to the voice.
      //   2) One slow pole-to-pole undulation (one wave from north to south
      //      pole, animated out of phase with #1). Adds variety in the
      //      orthogonal direction so the bulge isn't a uniform ring.
      //   3) One slow "breathing" — a uniform radial pulse with a
      //      separate time multiplier. The whole orb gently inflates and
      //      deflates a few percent, separate from the directional
      //      bulges. Reads as the orb "breathing" with the speaker.
      //
      // dAmp is 0 outside speaking, so other states stay perfectly round.
      let rk = r;
      if (dAmp > 0.0005) {
        const ph = phiArr[k], th = thArr[k];
        const sp = sinPhi[k];
        // Three slow components. No per-vertex jitter — by design. The
        // goal is SMOOTH surface motion, not high-frequency texture.
        //   Component 1: equatorial bulge, polar-damped, time t * 0.55.
        //     One cycle around theta -> exactly one bump on the visible
        //     hemisphere. As t advances, the bump slowly rotates around
        //     the orb (because the phase advances), but stays at most one
        //     bump wide so the surface reads as "one part of it is bigger".
        //   Component 2: pole-to-pole undulation, time t * 0.35. One wave
        //     from south pole to north pole, animated at a different rate
        //     so the two don't synchronise. Adds variation in the
        //     orthogonal direction without making the surface rippled.
        //   Component 3: global breath, time t * 0.9 (faster than the
        //     bulges so it feels like a separate rhythm). Uniform radial
        //     pulse — every vertex moves in/out the same small amount.
        const wob =
            // Equatorial bulge: single wave around the orb's waist.
            Math.sin(th + t * 0.55) * sp * 0.8
            // Pole-to-pole undulation: single wave top-to-bottom.
          + Math.cos(ph * 2 + t * 0.35) * 0.4
            // Global breath: every vertex pulses in/out together.
          + Math.sin(t * 0.9) * 0.3;
        // Gentle saturation. Three components with small amplitudes sum to
        // at most ~±1.5 raw, but in practice the bulges cancel each other
        // most of the time so the actual peak is ~±1.0. tanh keeps the
        // surface smooth at the extremes (no hard clamp that would flatten
        // the bulges into a uniform ring) and guarantees |wo| < 0.45,
        // which after dAmp * 0.55 gives at most ~25% radial deviation —
        // well within the "blob" reading.
        const wo = Math.tanh(wob) * 0.45;
        rk = r * (1 + dAmp * wo * 0.55);
      }
      // Apply the per-frame ambient drift on top of the audio wobble.
      rk *= 1 + drift;
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
    // Shadow blur is the orb's most GPU-expensive op — gated + capped by the
    // active quality profile so a low GPU cap / weak GPU disables it entirely.
    const q = QUALITY[quality] || QUALITY.high;
    if (q.shadows) {
      if (react > 0.04) { ctx.shadowColor = `rgba(${cr},${cg},${cb},${0.6 + react})`; ctx.shadowBlur = Math.min(q.blurMax, 8 + react * 18); }
      else { ctx.shadowColor = `rgba(${cr},${cg},${cb},0.4)`; ctx.shadowBlur = Math.min(q.blurMax, 4); }
    } else {
      ctx.shadowBlur = 0;
    }
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
        const rr = (1.0 + react * 0.9 + dc * 1.0) * pp[k];
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

  // Frame-rate cap per state. Every state is capped now: running the heavy mesh
  // render UNCAPPED at the display's native refresh (144/165/240 Hz) pegged a CPU
  // core at 80-100% and could crash the app — and a slow constant rotation looks
  // identical at 30 FPS because the spin is dt-scaled (same angular speed, just
  // fewer frames). speaking gets a higher cap so the voice-driven surface ripple
  // stays smooth. The rotation no longer needs native refresh to look right.
  const STATE_MIN_MS = { idle: 33, listening: 33, processing: 33, speaking: 22 };
  // The active profile's per-state caps (see QUALITY) override the defaults above
  // so a lower GPU cap throttles the orb's frame rate. Falls back to STATE_MIN_MS.
  function stateMinMs(s) {
    const q = QUALITY[quality];
    return (q && q.stateMs[s]) || STATE_MIN_MS[s] || 33;
  }
  // The throttled cap while an STT transcription is in flight (the GPU STT path
  // is the other continuous GPU consumer alongside the orb; allowing both to
  // run uncapped on a 240 Hz monitor is the "crash on balanced+" symptom).
  // Refcounted so concurrent STT streams (or rapid re-fires) don't un-throttle
  // prematurely. Defaults to the full-speed per-state cap when no STT is active.
  let sttActive = 0;
  function beginStt() { sttActive++; }
  function endStt() { sttActive = Math.max(0, sttActive - 1); }
  // When the window isn't focused (ARIA living in the background, common for a
  // voice assistant) drop to ~5 FPS regardless of state — nobody's watching the
  // orb, so there's no reason to burn CPU repainting it. document.hidden already
  // makes rAF stop, but a VISIBLE-but-unfocused window keeps animating at full
  // rate; this is what catches that case.
  const BLUR_MIN_MS = 200;
  // While the window IS focused the user is actually watching the orb, so it must
  // look smooth even under a power preset (power-saver maps to the 'low' tier,
  // whose per-state caps are ~15 FPS — visibly choppy). The per-tier caps exist to
  // bound GPU WORK, but the costly part is the shadow blur + backing-store
  // resolution (both still gated by the quality profile in render()), NOT the
  // frame cadence. So a focused window renders at AT LEAST ~60 FPS regardless of
  // tier — and faster on the 'high' tier, whose 4ms cap already means native
  // refresh. Power is still saved where it matters: a backgrounded window throttles
  // to BLUR_MIN_MS. 60 FPS is well short of the uncapped native-refresh rate that
  // used to peg a CPU core, so this stays safe on weak hardware.
  const FOCUS_SMOOTH_MS = 16;
  let windowFocused = (typeof document === 'undefined') || document.hasFocus();
  let lastRenderAt = 0;

  let fpsVisible = false, fpsCount = 0, fpsLast = 0, fpsValue = 0;
  let renderWarned = false;
  function loop(now) {
    // Throttle to ~5 FPS in the background, EXCEPT while speaking — the
    // voice-driven ripple is the signature visual and speaking is short-lived, so
    // keep it smooth even if the window isn't focused. Idle/listening/processing
    // in the background (the always-on drain) drop to 5 FPS.
    const blurred = !windowFocused && state !== 'speaking';
    // When an STT transcription is in flight on a high-tier host, swap in the
    // throttled cap so the orb doesn't pin the GPU alongside Vulkan STT. The
    // per-state cap still wins when no STT is active.
    const q = QUALITY[quality];
    const stateMs = (q && q.stateMs[state]) || STATE_MIN_MS[state] || 33;
    const activeMs = (q && q.activeMs) || stateMs;
    const capMs = sttActive > 0 ? Math.max(stateMs, activeMs) : stateMs;
    // Focused -> smooth (>=60 FPS, native on the high tier); backgrounded -> ~5 FPS.
    const minMs = blurred ? BLUR_MIN_MS : Math.min(capMs, FOCUS_SMOOTH_MS);
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
    // NOT desynchronized: the low-latency desync path tears/jitters on the right &
    // bottom edges on some Linux compositors, and raising the orb to native refresh
    // made that shimmer visible again. The vsync'd path is tear-free; an ambient orb
    // doesn't need the latency win.
    ctx = canvas.getContext('2d', { alpha: true });
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
    document.addEventListener('visibilitychange', () => {
      windowFocused = !document.hidden && document.hasFocus();
      if (!document.hidden) resize();
    });
    // Track focus so the loop can throttle to ~5 FPS in the background. Resize on
    // focus regain too (DPR/monitor may have changed while hidden).
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

  // Synchronously advance the animation by `frames` (~16.7ms each) in the current
  // state, so colour easing + motion settle deterministically. Used by headless
  // screenshot/boot tests where the window is hidden and rAF is throttled.
  function pump(frames) {
    frames = frames || 60;
    let now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (let i = 0; i < frames; i++) { now += 16.67; try { render(now); } catch (e) {} }
  }

  root.AriaOrb = { init, setLevel, setState, setQuality, beginStt, endStt, effectiveDpr, backingFor, measure, benchmark, refreshAccent, toggleFps, pump, MAX_BACKING };
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
