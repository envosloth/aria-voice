// Ember-sphere orb (the Glass Observatory GUI's orb): debris rings at mixed
// 3D orientations swirling around a white-hot core, with a visual state
// machine. Matches the ops-rail state badge colours:
//   idle       — blue,   dim embers, slow swirl. (default)
//   listening  — cyan,   brighter, slightly faster.
//   processing — violet, swirl accelerates ("thinking").
//   speaking   — teal-cyan, core FLARES with the TTS voice level (RMS).
//
// Transitions are smooth by construction: colour, swirl speed and the voice
// level are all eased (dt-scaled), and ring angles come from one accumulated
// phase — changing speed bends the motion, never snaps it.
//
// Performance: per-particle statics precomputed once; per-frame work uses
// reused flat typed arrays (no allocations); no shadow blur (dots are cheap).

(function (root) {
  const TWO_PI = Math.PI * 2;
  // Base swirl speed (radians/60fps-frame); per-state multipliers ease on top.
  const SPIN = 0.006;
  // Gentle, constant "alive" breathing amplitude (NOT audio-driven).
  const BREATHE = 0.018;

  // Debris rings: tilt/roll give each ring a distinct 3D orientation, rf its
  // radius (× baseR), speed its angular rate (sign = direction), n particles.
  const RINGS = [
    { tilt:  1.15, roll:  0.00, rf: 1.00, speed:  1.00, n: 90 },
    { tilt: -0.70, roll:  0.90, rf: 0.78, speed: -1.35, n: 70 },
    { tilt:  0.35, roll: -0.60, rf: 1.18, speed:  0.70, n: 60 },
  ];
  const NPTS = RINGS.reduce((s, r) => s + r.n, 0);

  let canvas, ctx, w, h, cx, cy, baseR;
  let t = 0, audio = 0, audioSmooth = 0, raf = null;
  let phase = 0;                 // accumulated swirl phase (smooth across speed changes)
  let spinCur = 0.5;             // eased state speed multiplier

  // State colours — same family as the ops-rail badge so orb + badge always agree.
  const STATE_COLORS = {
    idle:       [122, 162, 255], // blue
    listening:  [ 77, 214, 255], // cyan
    processing: [185, 139, 255], // violet
    speaking:   [ 77, 224, 192], // teal-cyan
  };
  // Swirl speed multiplier per state ("swirl accelerates" while thinking).
  const STATE_SPIN = { idle: 0.5, listening: 0.85, processing: 1.9, speaking: 1.1 };
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

  // Precomputed per-particle statics: base angle on its ring, radial jitter
  // (debris, not a perfect circle), plane-thickness offset, size, twinkle
  // phase, and the ring's precomputed orientation trig.
  const pa = new Float32Array(NPTS), pr = new Float32Array(NPTS);
  const pt = new Float32Array(NPTS), ps = new Float32Array(NPTS);
  const pw = new Float32Array(NPTS), ring = new Uint8Array(NPTS);
  const ringTrig = RINGS.map((r) => ({
    st: Math.sin(r.tilt), ct: Math.cos(r.tilt),
    sr: Math.sin(r.roll), cr: Math.cos(r.roll),
    rf: r.rf, speed: r.speed,
  }));
  (function build() {
    // Deterministic pseudo-random (no Math.random: identical orb every boot).
    let s = 42;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    let k = 0;
    RINGS.forEach((r, ri) => {
      for (let j = 0; j < r.n; j++, k++) {
        ring[k] = ri;
        pa[k] = (j / r.n) * TWO_PI + rnd() * 0.35;
        pr[k] = 1 + (rnd() - 0.5) * 0.14;     // ±7% radial scatter
        pt[k] = (rnd() - 0.5) * 0.10;         // ring-plane thickness
        ps[k] = 0.6 + rnd() * 1.1;            // dot size seed
        pw[k] = rnd() * TWO_PI;               // twinkle phase
      }
    });
  })();

  const px = new Float32Array(NPTS), py = new Float32Array(NPTS);
  const pz = new Float32Array(NPTS), pp = new Float32Array(NPTS);

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

    // Swirl speed eases toward the state's multiplier (thinking accelerates,
    // idle settles) and speaking adds a voice-driven kick. The eased multiplier
    // feeds ONE accumulated phase, so speed changes bend the motion smoothly —
    // ring angles never jump.
    const spinTarget = (STATE_SPIN[state] || 1) + (state === 'speaking' ? react * 1.4 : 0);
    spinCur += (spinTarget - spinCur) * ease(0.06);
    t += SPIN * dt;                    // slow clock for breathing/twinkle/yaw
    phase += SPIN * spinCur * dt;      // swirl phase (state-speed dependent)
    // Slow global yaw so the whole ring shell precesses.
    const yaw = t * 0.3, cosY = Math.cos(yaw), sinY = Math.sin(yaw);

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

    // Steady overall size: gentle constant breathing only — the voice shows as
    // the CORE flaring + a swirl kick, never as the whole shell ballooning.
    const rScale = 1 + BREATHE * Math.sin(t * 1.3);
    const R = baseR * rScale;

    // Project every debris particle: ring-local circle -> ring orientation
    // (tilt around X, then roll around Z) -> slow global yaw (Y) -> perspective.
    // The tiny radial "shimmer" per particle keeps the debris feeling loose
    // without any per-frame allocation.
    for (let k = 0; k < NPTS; k++) {
      const g = ringTrig[ring[k]];
      const ang = pa[k] + phase * g.speed;
      const rr = R * g.rf * pr[k] * (1 + 0.02 * Math.sin(t * 0.9 + pw[k]));
      const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr, y = pt[k] * rr;
      let y1 = y * g.ct - z * g.st; const z1 = y * g.st + z * g.ct;   // tilt
      const x1 = x * g.cr - y1 * g.sr; y1 = x * g.sr + y1 * g.cr;    // roll
      const x2 = x1 * cosY + z1 * sinY, z2 = -x1 * sinY + z1 * cosY; // yaw
      const persp = 540 / (540 + z2);
      px[k] = cx + x2 * persp; py[k] = cy + y1 * persp;
      pz[k] = z2; pp[k] = persp;
    }

    // Ember passes, painter's order: far half (dim, small) -> core -> near half
    // (bright, larger). One fillStyle per pass keeps it at 2 draw batches.
    // Brightness rises with state activity; sizes flare slightly with the voice.
    const emberPass = (near) => {
      ctx.fillStyle = near
        ? `rgba(${Math.min(255, cr + 40)},${Math.min(255, cg + 40)},${Math.min(255, cb + 40)},${Math.min(1, 0.55 + activity * 0.45)})`
        : `rgba(${cr},${cg},${cb},${0.22 + activity * 0.2})`;
      ctx.beginPath();
      for (let k = 0; k < NPTS; k++) {
        if (near ? pz[k] > 0 : pz[k] <= 0) continue;
        // Twinkle via size (not alpha) so passes stay single-fill batches.
        const tw = 0.75 + 0.25 * Math.sin(t * 2 + pw[k]);
        const dot = ps[k] * tw * pp[k] * (near ? 1.25 : 0.85) * (1 + react * 0.7);
        ctx.moveTo(px[k] + dot, py[k]);
        ctx.arc(px[k], py[k], dot, 0, TWO_PI);
      }
      ctx.fill();
    };
    emberPass(false);

    // White-hot core: flares with the voice (radius + brightness track react),
    // fading out through the state colour.
    const coreR = baseR * (0.42 + react * 0.2) * rScale;
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    const hot = (c) => Math.min(255, c + 90);
    core.addColorStop(0, `rgba(255,255,255,${0.8 + react * 0.2})`);
    core.addColorStop(0.3, `rgba(${hot(cr)},${hot(cg)},${hot(cb)},${0.5 + react * 0.35})`);
    core.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TWO_PI);
    ctx.fill();

    emberPass(true);

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
