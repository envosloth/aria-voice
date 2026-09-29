// ARIA's procedural particle orb.
//
// A Fibonacci-sphere of dots drawn on a 2D canvas, reconstructed mathematically
// from the original particle GIF: a compact dotted sphere that, when ARIA thinks,
// bursts outward in a sweep from the upper-right, becomes a rippling shell, and
// sweeps back into the sphere when done. Because it is math rather than video,
// every state has its own motion and speech drives it live:
//
//   idle        compact sphere, slow rotation, faint breathing
//   listening   compact, brighter, slightly quicker rotation and surface shimmer
//   processing  staggered expansion sweep, then travelling ripples over the shell
//   speaking    half-open shell; the TTS level pushes rings out from the centre
//
// Crash-surface rules (see collaboration/gotchas.md): the rAF loop is FPS-capped
// per quality tier, stops while the window is hidden, stops entirely when idle
// and settled under prefers-reduced-motion, and stops and hides the canvas during
// Vulkan STT compute with a 6 s failsafe.
(function (root) {
  const STATES = new Set(['idle', 'listening', 'processing', 'speaking']);
  const TAU = Math.PI * 2;
  const COMPUTE_FREEZE_TIMEOUT_MS = 6000;

  // Per quality tier: particle count, device-pixel cap, active/idle frame caps.
  const TIERS = {
    low: { particles: 900, dpr: 1, fps: 24, idleFps: 12 },
    medium: { particles: 1400, dpr: 1.5, fps: 30, idleFps: 20 },
    high: { particles: 2000, dpr: 2, fps: 60, idleFps: 30 },
  };

  // Target expansion (0 = compact sphere, 1 = fully dispersed shell), rotation
  // speed (rad/s) and state tint. Tints match the state badge colours.
  const STATE_PARAMS = {
    idle: { expand: 0, spin: 0.14, breathe: 0.012, shimmer: 0, tint: [122, 162, 255], tintMix: 0.18, bright: 0.82 },
    listening: { expand: 0, spin: 0.24, breathe: 0.018, shimmer: 0.022, tint: [255, 171, 77], tintMix: 0.42, bright: 1 },
    processing: { expand: 1, spin: 0.34, breathe: 0, shimmer: 0, tint: [185, 139, 255], tintMix: 0.38, bright: 0.95 },
    speaking: { expand: 0.5, spin: 0.26, breathe: 0, shimmer: 0, tint: [63, 200, 232], tintMix: 0.42, bright: 1 },
  };

  const EXPAND_RATE = 1.35; // 1/s — opening takes ~2 s with the sweep stagger
  const CONTRACT_RATE = 2.2; // 1/s — the return is a little quicker
  const SETTLED = 0.004;
  const TILT = 0.38; // rad — fixed pitch so the poles read as a sphere
  const PERSPECTIVE = 4.2; // camera distance in sphere radii
  const ALPHA_BUCKETS = 6;
  // Sweep origin in object space: the original bursts from the upper right.
  const SWEEP = normalize([0.62, 0.64, 0.46]);

  let state = 'idle';
  let level = 0;
  let levelSmooth = 0;
  let quality = 'high';
  let sttBackend = 'vulkan';
  let sttActive = false;
  let computeFrozen = false;
  let computeFreezeTimer = null;
  let reducedMotion = false;

  let canvas = null;
  let ctx = null;
  let slot = null;
  let rafHandle = 0;
  let lastFrame = 0;
  let frames = 0;

  // Simulation state.
  let time = 0; // s, drives ripples
  let yaw = 0; // rad, accumulated so speed changes never jump
  let spin = STATE_PARAMS.idle.spin;
  let expansion = 0;
  let breathe = STATE_PARAMS.idle.breathe;
  let shimmer = 0;
  let bright = STATE_PARAMS.idle.bright;
  let baseRgb = [232, 238, 248];
  let rgb = mixRgb(baseRgb, STATE_PARAMS.idle.tint, STATE_PARAMS.idle.tintMix);

  // Particle buffers.
  let count = 0;
  let px, py, pz, noise, phase, delay;
  let sx, sy, ss, sb; // projected x, y, size, alpha bucket
  let metrics = { meanRadius: 1, spread: 0, signature: 0 };

  function normalize(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function mixRgb(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function smoothstep(x) {
    const t = x < 0 ? 0 : x > 1 ? 1 : x;
    return t * t * (3 - 2 * t);
  }
  function approach(current, target, rate, dt) {
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  }
  // Small deterministic PRNG so the dot pattern is identical every launch.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fibonacci lattice: evenly spaced points on the unit sphere, the even dotted
  // surface of the source animation's compact frame.
  function buildParticles(n) {
    const rand = mulberry32(0xa51a);
    const golden = Math.PI * (3 - Math.sqrt(5));
    count = n;
    px = new Float32Array(n); py = new Float32Array(n); pz = new Float32Array(n);
    noise = new Float32Array(n); phase = new Float32Array(n); delay = new Float32Array(n);
    sx = new Float32Array(n); sy = new Float32Array(n); ss = new Float32Array(n);
    sb = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      const a = golden * i;
      px[i] = Math.cos(a) * r; py[i] = y; pz[i] = Math.sin(a) * r;
      // Displacement is skewed: most dots form a shell just outside the sphere,
      // a few fly further out — the loose scatter at the source's edges.
      noise[i] = Math.pow(rand(), 1.8);
      phase[i] = rand() * TAU;
      // Sweep stagger: dots facing the burst origin move first.
      const facing = px[i] * SWEEP[0] + py[i] * SWEEP[1] + pz[i] * SWEEP[2];
      delay[i] = Math.min(1, Math.max(0, (1 - facing) / 2 + (rand() - 0.5) * 0.12));
    }
  }

  function tier() { return TIERS[quality] || TIERS.high; }
  function params() { return STATE_PARAMS[state]; }

  function targetExpansion() {
    if (state === 'speaking') return Math.min(1, params().expand + levelSmooth * 0.45);
    return params().expand;
  }

  // ── Simulation ───────────────────────────────────────────────────────────
  function step(dt) {
    const p = params();
    time += dt;
    levelSmooth = approach(levelSmooth, state === 'speaking' ? level : 0, 14, dt);
    const target = targetExpansion();
    expansion = approach(expansion, target, target > expansion ? EXPAND_RATE : CONTRACT_RATE, dt);
    if (Math.abs(expansion - target) < SETTLED) expansion = target;
    // Reduced motion keeps state changes but drops the continuous rotation.
    spin = approach(spin, reducedMotion ? 0 : p.spin + levelSmooth * 0.2, 2, dt);
    yaw = (yaw + spin * dt) % TAU;
    breathe = approach(breathe, p.breathe, 3, dt);
    shimmer = approach(shimmer, p.shimmer, 3, dt);
    bright = approach(bright, p.bright + levelSmooth * 0.25, 5, dt);
    rgb = [0, 1, 2].map((k) => approach(rgb[k], mixRgb(baseRgb, p.tint, p.tintMix)[k], 4, dt));
  }

  // Position every particle for the current time and project it to the canvas.
  function layout(width, height) {
    const cx = width / 2;
    const cy = height / 2;
    // The shell reaches ~1.55 R at full dispersal: fit that inside the slot.
    const R = Math.min(width, height) * 0.32;
    const dotScale = Math.max(0.6, R / 95);
    const cyaw = Math.cos(yaw); const syaw = Math.sin(yaw);
    const ctil = Math.cos(TILT); const stil = Math.sin(TILT);
    // Ripple direction drifts slowly so waves wander over the shell.
    const w = normalize([Math.cos(time * 0.37), 0.55 * Math.sin(time * 0.29), Math.sin(time * 0.37)]);
    const E = expansion;
    const speech = levelSmooth;
    const breath = 1 + breathe * Math.sin(time * 1.7);
    let sumR = 0; let sumR2 = 0; let sig = 0;

    for (let i = 0; i < count; i++) {
      // Staggered local expansion: dots near the sweep origin lead.
      const e = smoothstep(E * 1.7 - delay[i] * 0.7);
      const n = noise[i];
      const ph = phase[i];
      const along = px[i] * w[0] + py[i] * w[1] + pz[i] * w[2];

      // Dispersed state is a hollow shell (~1.3 R) with a loose outer fringe,
      // so the projected rim reads denser than the centre, as in the source.
      let r = breath + e * (0.24 + 0.26 * n);
      // Travelling ripples over the dispersed shell (thinking and speaking).
      r += e * 0.055 * Math.sin(7 * along - 3.1 * time + ph * 0.25);
      r += e * 0.03 * Math.sin(4 * along + 2.3 * time);
      // Listening shimmer: a fine, fast surface tremor on the compact sphere.
      r += shimmer * Math.sin(ph + time * 6.5);

      // Rotate: yaw about Y, then fixed tilt about X.
      const x1 = px[i] * cyaw + pz[i] * syaw;
      const z1 = -px[i] * syaw + pz[i] * cyaw;
      const y2 = py[i] * ctil - z1 * stil;
      const z2 = py[i] * stil + z1 * ctil;

      // Speech rings radiate from the centre of the visible face.
      if (speech > 0.001) {
        const ring = Math.sin(11 * (1 - z2) - 7.5 * time);
        r += speech * (0.05 + 0.09 * e) * ring * (0.6 + 0.4 * n);
      }

      // Loose dots drift tangentially so the shell never looks frozen.
      const drift = e * (0.035 + 0.06 * n);
      const X = x1 * r + drift * Math.sin(ph + time * 1.3);
      const Y = y2 * r + drift * Math.cos(ph * 1.7 + time * 1.1);
      const Z = z2 * r;

      const persp = PERSPECTIVE / (PERSPECTIVE - Z);
      sx[i] = cx + X * R * persp;
      sy[i] = cy - Y * R * persp;
      const depth = (z2 + 1) / 2; // 0 back … 1 front
      ss[i] = (0.8 + 0.7 * depth + e * n * 0.35) * dotScale * persp;
      const alpha = Math.min(1, (0.16 + 0.7 * Math.pow(depth, 1.25) + e * 0.12) * bright);
      sb[i] = Math.min(ALPHA_BUCKETS - 1, Math.floor(alpha * ALPHA_BUCKETS));

      sumR += r; sumR2 += r * r; sig += r * (i % 7 + 1) + X * 0.5;
    }
    const mean = sumR / count;
    metrics = {
      meanRadius: mean,
      spread: Math.sqrt(Math.max(0, sumR2 / count - mean * mean)),
      signature: sig / count,
    };
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function ensureCanvas() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!canvas && doc && typeof doc.getElementById === 'function') {
      canvas = doc.getElementById('orb-canvas');
      slot = doc.getElementById('orb-anchor');
      ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    }
    return !!ctx;
  }

  function resize() {
    const dpr = Math.min(tier().dpr, (root.devicePixelRatio || 1));
    const w = Math.max(1, Math.round((canvas.clientWidth || 260) * dpr));
    const h = Math.max(1, Math.round((canvas.clientHeight || 260) * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  function draw() {
    if (!ensureCanvas() || computeFrozen) return;
    resize();
    const W = canvas.width; const H = canvas.height;
    layout(W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
    // One path per alpha bucket: ~6 fills per frame instead of one per dot.
    for (let b = 0; b < ALPHA_BUCKETS; b++) {
      ctx.globalAlpha = (b + 0.5) / ALPHA_BUCKETS;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        if (sb[i] !== b) continue;
        const s = ss[i];
        ctx.rect(sx[i] - s / 2, sy[i] - s / 2, s, s);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    frames++;
    applyDom();
  }

  function applyDom() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (doc && doc.body && doc.body.dataset) doc.body.dataset.state = state;
    if (canvas) {
      canvas.dataset.state = state;
      canvas.dataset.phase = getPhase();
      canvas.hidden = computeFrozen;
    }
    if (slot && slot.style) slot.style.setProperty('--orb-energy', levelSmooth.toFixed(3));
  }

  // ── Loop gating ──────────────────────────────────────────────────────────
  function isSettled() {
    return Math.abs(expansion - targetExpansion()) < SETTLED && levelSmooth < 0.002;
  }
  function wantsLoop() {
    if (computeFrozen || !ctx) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (reducedMotion && state === 'idle' && isSettled()) return false;
    return true;
  }
  function frameInterval() {
    const t = tier();
    const calm = (state === 'idle' || state === 'listening') && isSettled();
    return 1000 / (calm ? t.idleFps : t.fps);
  }

  function frame(now) {
    rafHandle = 0;
    if (!wantsLoop()) return;
    schedule();
    const interval = frameInterval();
    // 1 ms tolerance so a 60 Hz display is not halved by timestamp jitter.
    if (lastFrame && now - lastFrame < interval - 1) return;
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
    lastFrame = now;
    step(dt);
    draw();
  }

  function schedule() {
    if (rafHandle || typeof root.requestAnimationFrame !== 'function' && typeof requestAnimationFrame !== 'function') return;
    const raf = typeof root.requestAnimationFrame === 'function' ? root.requestAnimationFrame : requestAnimationFrame;
    rafHandle = raf(frame);
  }
  function stopLoop() {
    if (!rafHandle) return;
    const caf = typeof root.cancelAnimationFrame === 'function' ? root.cancelAnimationFrame
      : typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;
    if (caf) caf(rafHandle);
    rafHandle = 0;
  }
  function kick() {
    if (wantsLoop()) {
      if (!rafHandle) lastFrame = 0;
      schedule();
    } else {
      stopLoop();
    }
  }

  // ── Public API (unchanged surface for app.js) ────────────────────────────
  function getPhase() {
    if (state === 'processing') return 'thinking';
    if (state === 'speaking') return 'speaking';
    return expansion > SETTLED ? 'consolidating' : 'consolidated';
  }

  function readTheme() {
    const mq = typeof root.matchMedia === 'function' ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    reducedMotion = !!(mq && mq.matches);
    if (!canvas) return;
    const gcs = typeof root.getComputedStyle === 'function' ? root.getComputedStyle
      : typeof getComputedStyle === 'function' ? getComputedStyle : null;
    const raw = gcs ? String(gcs(canvas).getPropertyValue('--orb-dot') || '').trim() : '';
    const m = /^#?([0-9a-f]{6})$/i.exec(raw);
    if (m) {
      const v = parseInt(m[1], 16);
      baseRgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
      const p = params();
      rgb = mixRgb(baseRgb, p.tint, p.tintMix); // theme switches apply instantly
    }
  }

  function init() {
    if (!ensureCanvas()) return false;
    if (count !== tier().particles) buildParticles(tier().particles);
    readTheme();
    const doc = typeof document !== 'undefined' ? document : null;
    if (doc && typeof doc.addEventListener === 'function' && !init.bound) {
      doc.addEventListener('visibilitychange', kick);
      init.bound = true;
    }
    draw();
    kick();
    return true;
  }

  function setState(next) {
    if (!STATES.has(next)) return false;
    if (next !== state) {
      state = next;
      if (state !== 'speaking') level = 0;
    }
    applyDom();
    kick();
    return true;
  }

  // Normalised 0..1 TTS RMS envelope; smoothed inside the simulation.
  function setLevel(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return level;
    level = Math.max(0, Math.min(1, n));
    if (state === 'speaking') kick();
    return level;
  }

  function setQuality(next) {
    if (next === 'low' || next === 'medium' || next === 'high') {
      quality = next;
      if (ctx && count !== tier().particles) buildParticles(tier().particles);
      if (ctx) draw();
      kick();
    }
    return quality;
  }

  function setSttBackend(backend) {
    sttBackend = backend === 'cpu' ? 'cpu' : 'vulkan';
    if (sttBackend === 'cpu') endSttCompute();
    return sttBackend;
  }
  function beginStt() { sttActive = true; endSttCompute(); }
  function endStt() { sttActive = false; endSttCompute(); }

  // Vulkan transcription saturates the GPU; stop drawing and remove the canvas
  // from compositing until the result lands, the next listen, or the failsafe.
  function beginSttCompute() {
    if (sttBackend !== 'vulkan') return endSttCompute();
    computeFrozen = true;
    stopLoop();
    clearTimeout(computeFreezeTimer);
    computeFreezeTimer = setTimeout(endSttCompute, COMPUTE_FREEZE_TIMEOUT_MS);
    applyDom();
  }
  function endSttCompute() {
    clearTimeout(computeFreezeTimer);
    computeFreezeTimer = null;
    if (!computeFrozen) return;
    computeFrozen = false;
    applyDom();
    kick();
  }

  // Jump the simulation to the current state's resting target and redraw once.
  // Used by the Electron screenshot smoke for deterministic captures.
  function settle() {
    levelSmooth = state === 'speaking' ? level : 0;
    expansion = targetExpansion();
    const p = params();
    spin = p.spin; breathe = p.breathe; shimmer = p.shimmer; bright = p.bright;
    rgb = mixRgb(baseRgb, p.tint, p.tintMix);
    draw();
    return getPhase();
  }

  root.AriaOrb = {
    init, setState, setLevel, setQuality, setSttBackend,
    beginStt, endStt, beginSttCompute, endSttCompute, settle,
    isComputeFrozen: () => computeFrozen,
    isSttActive: () => sttActive,
    refreshAccent: () => { readTheme(); if (ctx) draw(); kick(); },
    getState: () => state,
    getLevel: () => level,
    getPhase,
    getMetrics: () => ({
      particles: count, expansion, frames, running: !!rafHandle,
      meanRadius: metrics.meanRadius, spread: metrics.spread, signature: metrics.signature,
    }),
  };

  const doc = typeof document !== 'undefined' ? document : null;
  if (doc && doc.readyState !== 'loading') init();
  else if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
