// State adapter for ARIA's user-supplied particle animation. A normal <img>-hosted
// GIF cannot be paused or sought, so the renderer uses a transparent WebM derived
// from those frames. That lets ARIA keep the orb compact at rest, play only the
// expansion/ripple segment while thinking, keep its dots moving in response to
// speech, and play the supplied consolidation segment when speech ends.
(function (root) {
  const STATES = new Set(['idle', 'listening', 'processing', 'speaking']);

  // Timings measured from the supplied 9-second / 450-frame GIF. The sphere begins
  // expanding around 1 s, is fully dispersed by ~3 s, and starts returning at 6 s.
  const THINK_LOOP_START_SECONDS = 2.75;
  const THINK_LOOP_END_SECONDS = 6.0;
  const CONSOLIDATE_START_SECONDS = 6.0;
  const CONSOLIDATE_END_SECONDS = 8.85;
  const DIRECT_SPEAKING_FRAME_SECONDS = 4.5;
  const COMPUTE_FREEZE_TIMEOUT_MS = 6000;

  const BASE_SCALE = {
    idle: 0.96,
    listening: 0.98,
    processing: 1.0,
    speaking: 1.02,
  };
  const QUALITY_EFFECT = { low: 0.45, medium: 0.72, high: 1 };

  let state = 'idle';
  let phase = 'consolidated';
  let level = 0;
  let quality = 'high';
  let sttBackend = 'vulkan';
  let sttActive = false;
  let computeFrozen = false;
  let computeFreezeTimer = null;
  let video = null;
  let listenersBoundTo = null;
  let playbackRequestId = 0;

  function getDocument() {
    return typeof document !== 'undefined' ? document : null;
  }

  function getVideo() {
    const doc = getDocument();
    if (!video && doc && typeof doc.getElementById === 'function') {
      video = doc.getElementById('orb-animation');
    }
    return video;
  }

  function safePause() {
    const el = getVideo();
    if (!el || typeof el.pause !== 'function') return;
    playbackRequestId++;
    try { el.pause(); } catch (e) { /* video may not have metadata yet */ }
  }

  function safeSeek(seconds) {
    const el = getVideo();
    if (!el) return false;
    try {
      el.currentTime = seconds;
      return true;
    } catch (e) {
      return false;
    }
  }

  function safePlay() {
    const el = getVideo();
    if (!el || computeFrozen || typeof el.play !== 'function') return false;
    const requestId = ++playbackRequestId;
    try {
      const playback = el.play();
      if (playback && typeof playback.catch === 'function') {
        playback.catch(() => {
          // pause() rejects a pending play promise in Chromium. Ignore stale or
          // intentionally interrupted requests; only a current, unexpected
          // rejection means the media genuinely failed to play.
          if (requestId !== playbackRequestId || computeFrozen) return;
          settleCompact();
        });
      }
      return true;
    } catch (e) {
      if (requestId === playbackRequestId && !computeFrozen) settleCompact();
      return false;
    }
  }

  function applyVisuals() {
    const doc = getDocument();
    const el = getVideo();
    if (!el) return;

    if (doc && doc.body && doc.body.dataset) doc.body.dataset.state = state;
    const energy = state === 'speaking' ? level : 0;
    const effect = QUALITY_EFFECT[quality] || QUALITY_EFFECT.high;
    const base = BASE_SCALE[state];
    const scaleX = base + energy * 0.1;
    const scaleY = base + energy * 0.072;
    const brightness = (state === 'speaking' ? 1.08 : 1) + energy * 0.6;
    const shadowBlur = 8 + energy * 22 * effect;
    const glowOpacity = 0.64 + energy * 0.34;

    el.dataset.state = state;
    el.dataset.phase = phase;
    el.hidden = computeFrozen;
    el.playbackRate = 1;
    el.style.setProperty('--orb-energy', energy.toFixed(3));
    el.style.setProperty('--orb-scale-x', scaleX.toFixed(3));
    el.style.setProperty('--orb-scale-y', scaleY.toFixed(3));
    el.style.setProperty('--orb-brightness', brightness.toFixed(3));
    el.style.setProperty('--orb-shadow-blur', `${shadowBlur.toFixed(1)}px`);
    el.style.setProperty('--orb-glow-opacity', glowOpacity.toFixed(3));
  }

  function settleCompact() {
    phase = 'consolidated';
    safePause();
    safeSeek(0);
    applyVisuals();
  }

  function startThinking(restart) {
    phase = 'thinking';
    if (restart) safeSeek(0);
    applyVisuals();
    safePlay();
  }

  function startSpeaking(previousState) {
    phase = 'speaking';
    const el = getVideo();
    // Direct/local announcements can enter speaking without a preceding thinking
    // state. Give those replies an expanded source frame rather than a compact one.
    if (previousState !== 'processing' && el) {
      const time = Number(el.currentTime);
      if (!Number.isFinite(time) || time < THINK_LOOP_START_SECONDS || time >= CONSOLIDATE_START_SECONDS) {
        safeSeek(DIRECT_SPEAKING_FRAME_SECONDS);
      }
    }
    applyVisuals();
    safePause();
  }

  function startConsolidation() {
    phase = 'consolidating';
    level = 0;
    safeSeek(CONSOLIDATE_START_SECONDS);
    applyVisuals();
    safePlay();
  }

  function finishConsolidation() {
    if (state === 'processing') startThinking(true);
    else settleCompact();
  }

  function onTimeUpdate() {
    const el = getVideo();
    if (!el || computeFrozen) return;
    const time = Number(el.currentTime);
    if (!Number.isFinite(time)) return;

    if (state === 'processing' && phase === 'thinking' && time >= THINK_LOOP_END_SECONDS) {
      safeSeek(THINK_LOOP_START_SECONDS);
      safePlay();
      return;
    }
    if (phase === 'consolidating' && time >= CONSOLIDATE_END_SECONDS) finishConsolidation();
  }

  function onEnded() {
    if (phase === 'consolidating') {
      finishConsolidation();
    } else if (state === 'processing' && phase === 'thinking') {
      safeSeek(THINK_LOOP_START_SECONDS);
      safePlay();
    } else if (state === 'speaking' && phase === 'speaking') {
      safePause();
    } else {
      settleCompact();
    }
  }

  function onLoadedMetadata() {
    if (phase === 'consolidated') settleCompact();
    else if (phase === 'thinking') safePlay();
    else if (phase === 'speaking') safePause();
    else if (phase === 'consolidating') {
      safeSeek(CONSOLIDATE_START_SECONDS);
      safePlay();
    } else safePause();
  }

  function init() {
    const el = getVideo();
    if (!el) return false;
    if (listenersBoundTo !== el && typeof el.addEventListener === 'function') {
      el.addEventListener('loadedmetadata', onLoadedMetadata);
      el.addEventListener('timeupdate', onTimeUpdate);
      el.addEventListener('ended', onEnded);
      listenersBoundTo = el;
    }
    if (phase === 'consolidated') settleCompact();
    else applyVisuals();
    return true;
  }

  function setState(next) {
    if (!STATES.has(next)) return false;
    const previous = state;
    if (next === state) {
      applyVisuals();
      return true;
    }

    state = next;
    if (state !== 'speaking') level = 0;

    if (state === 'processing') {
      if (phase === 'consolidating') applyVisuals();
      else if (previous === 'speaking' || phase === 'speaking') startConsolidation();
      else startThinking(true);
    } else if (state === 'speaking') {
      startSpeaking(previous);
    } else if (previous === 'speaking' || previous === 'processing' || phase === 'thinking' || phase === 'speaking') {
      // Conversation mode and barge-in can enter listening immediately. Preserve
      // the user-requested return animation across that state change; onEnded()
      // settles frame zero so the remainder of listening stays compact and still.
      startConsolidation();
    } else if (phase === 'consolidating') {
      applyVisuals();
    } else {
      settleCompact();
    }
    return true;
  }

  // The TTS analyser supplies a normalized 0..1 RMS envelope. It controls the
  // held dispersed shape's scale, brightness, and glow depth; short CSS
  // transitions smooth analyser jitter without replacing real audio feedback.
  function setLevel(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return level;
    const next = Math.max(0, Math.min(1, n));
    if (Math.abs(next - level) < 0.001) return level;
    level = next;
    if (state === 'speaking') applyVisuals();
    return level;
  }

  function setQuality(next) {
    if (next === 'low' || next === 'medium' || next === 'high') {
      quality = next;
      applyVisuals();
    }
    return quality;
  }

  function setSttBackend(backend) {
    sttBackend = backend === 'cpu' ? 'cpu' : 'vulkan';
    if (sttBackend === 'cpu') endSttCompute();
    return sttBackend;
  }

  function beginStt() {
    sttActive = true;
    endSttCompute();
  }

  function endStt() {
    sttActive = false;
    endSttCompute();
  }

  // Pausing matters as much as hiding: a hidden playing video can continue to
  // decode frames. During Vulkan transcription we stop both decode progression and
  // compositing, then resume the phase appropriate to the latest conversation state.
  function beginSttCompute() {
    if (sttBackend !== 'vulkan') return endSttCompute();
    computeFrozen = true;
    safePause();
    clearTimeout(computeFreezeTimer);
    computeFreezeTimer = setTimeout(endSttCompute, COMPUTE_FREEZE_TIMEOUT_MS);
    applyVisuals();
  }

  function endSttCompute() {
    clearTimeout(computeFreezeTimer);
    computeFreezeTimer = null;
    if (!computeFrozen) return;
    computeFrozen = false;
    applyVisuals();
    if (phase === 'thinking' && state === 'processing') safePlay();
    else if (phase === 'speaking' && state === 'speaking') safePause();
    else if (phase === 'consolidating') safePlay();
  }

  function isComputeFrozen() { return computeFrozen; }
  function isSttActive() { return sttActive; }
  function refreshAccent() { applyVisuals(); }

  root.AriaOrb = {
    init, setState, setLevel, setQuality, setSttBackend,
    beginStt, endStt, beginSttCompute, endSttCompute,
    isComputeFrozen, isSttActive, refreshAccent,
    getState: () => state,
    getLevel: () => level,
    getPhase: () => phase,
  };

  const doc = getDocument();
  if (doc && doc.readyState !== 'loading') init();
  else if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
