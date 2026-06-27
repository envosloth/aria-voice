// Renderer half of the latency harness (see src/main/perf.ts). Marks made here
// are forwarded to the main process over IPC, where they land in the SAME
// [ARIA_PERF] timeline as the main-side marks — so one `grep ARIA_PERF` over the
// app's stdout shows a full interaction, UI event through audio playback.
//
// Two layers, deliberately separate:
//   1. Verbose IPC forwarding — OFF by default (`aria.perf.enabled()`), so when
//      disabled every forward is skipped and instrumenting the hot path adds
//      nothing measurable to it.
//   2. A lightweight, ALWAYS-ON per-turn timeline collector that records each
//      mark's timestamp locally and derives per-stage durations (STT / LLM /
//      TTS / total). This powers the in-app Latency panel (Settings →
//      Performance) so a user can see where a slow turn spent its time WITHOUT
//      having to set ARIA_PERF=1 and read stdout. It only stores a few numbers
//      per turn and is bounded, so it's effectively free.
//
// Exposed as window.AriaPerf:
//   AriaPerf.newTurn(kind) -> a correlation id shared across processes for a turn
//   AriaPerf.mark(turnId, stage, extra)
//   AriaPerf.isEnabled()
//   AriaPerf.setTurnMeta(turnId, meta)   // attach e.g. {target:'LLM'} to a turn
//   AriaPerf.recentTurns()               // [{turnId, kind, target, stages}], newest last
//   AriaPerf.lastStages()                // per-stage ms for the most recent turn
//   AriaPerf.onUpdate(cb)                // called after each mark (live panel refresh)
(function () {
  'use strict';
  const aria = window.aria;
  let enabled = false;
  let counter = 0;

  // Query enablement once. Marks fired before this resolves (only the first few
  // ms after load, long before any user interaction) are simply dropped from the
  // IPC forward — the local timeline below always records regardless.
  try {
    if (aria && aria.perf && aria.perf.enabled) {
      aria.perf.enabled().then((v) => {
        enabled = !!v;
        if (enabled) console.debug('[ARIA_PERF] renderer instrumentation ENABLED');
      }).catch(() => {});
    }
  } catch (e) { /* perf bridge unavailable -> stays disabled */ }

  // Unique-enough, cheap id. Shared across main/renderer for one interaction.
  function newTurn(kind) {
    counter += 1;
    return (kind || 't') + '-' + Date.now().toString(36) + '-' + counter;
  }

  // ---- Always-on per-turn timeline collector -------------------------------
  // Keyed by turnId; each holds the wall-clock time of every stage we saw plus a
  // little metadata. Bounded so a long session can't grow it without limit.
  const MAX_TURNS = 12;
  const timelines = new Map(); // turnId -> { kind, target, t0, marks:{stage:ms} }
  const order = [];            // turnId insertion order (for eviction + recency)
  const listeners = [];

  function turnKind(turnId) {
    const dash = turnId.indexOf('-');
    return dash > 0 ? turnId.slice(0, dash) : 't';
  }

  function ensureTimeline(turnId) {
    let tl = timelines.get(turnId);
    if (!tl) {
      tl = { kind: turnKind(turnId), target: null, marks: {} };
      timelines.set(turnId, tl);
      order.push(turnId);
      while (order.length > MAX_TURNS) {
        const old = order.shift();
        timelines.delete(old);
      }
    }
    return tl;
  }

  function record(turnId, stage, t) {
    const tl = ensureTimeline(turnId);
    // First write wins per stage so a stage's time reflects when it FIRST
    // happened (e.g. first_token_render must not be overwritten by a later mark).
    if (tl.marks[stage] === undefined) tl.marks[stage] = t;
    for (const cb of listeners) { try { cb(turnId); } catch (e) { /* never throw on the hot path */ } }
  }

  // Derive the user-facing per-stage durations (ms) from one turn's raw marks.
  // Every field is null when its bracketing marks weren't both seen (e.g. STT is
  // null for a typed turn; TTS is null if the reply was never spoken).
  function stagesOf(tl) {
    if (!tl) return null;
    const m = tl.marks;
    const d = (a, b) => (m[a] !== undefined && m[b] !== undefined ? Math.max(0, Math.round(m[b] - m[a])) : null);
    const start = m.audio_start !== undefined ? m.audio_start : m.user_input;
    return {
      // Speech-to-text: end of speech -> transcript rendered (voice turns only).
      stt: d('audio_end', 'stt_result_render'),
      // LLM/agent time-to-first-token: request dispatched -> first token shown.
      llm: d('dispatch', 'first_token_render'),
      // Text-to-speech synthesis only: first synth request -> first audio sample.
      tts: d('tts_first_request', 'tts_first_audio'),
      // THE number the user actually feels: from the start of the turn (end of
      // speech / pressing enter) to the first audible audio. This is the real
      // "how long until I hear something" — NOT the full-turn total below, which
      // keeps running for seconds while the rest of the reply streams + speaks.
      firstAudio: start !== undefined && m.tts_first_audio !== undefined
        ? Math.max(0, Math.round(m.tts_first_audio - start)) : null,
      // Whole turn: first user action -> reply finished streaming (much larger
      // than firstAudio for any multi-sentence reply; shown as a secondary stat).
      total: start !== undefined && m.turn_complete !== undefined
        ? Math.max(0, Math.round(m.turn_complete - start)) : null,
      target: tl.target,
      kind: tl.kind,
    };
  }

  function recentTurns() {
    return order.map((id) => {
      const tl = timelines.get(id);
      return { turnId: id, kind: tl.kind, target: tl.target, stages: stagesOf(tl) };
    });
  }

  // Most recent turn that actually reached an LLM reply (has an llm mark), so the
  // panel shows a meaningful breakdown rather than a half-finished turn.
  function lastStages() {
    for (let i = order.length - 1; i >= 0; i--) {
      const tl = timelines.get(order[i]);
      if (tl && tl.marks.first_token_render !== undefined) return stagesOf(tl);
    }
    const last = order.length ? timelines.get(order[order.length - 1]) : null;
    return stagesOf(last);
  }

  function setTurnMeta(turnId, meta) {
    if (!turnId || !meta) return;
    const tl = ensureTimeline(turnId);
    if (meta.target) tl.target = meta.target;
    for (const cb of listeners) { try { cb(turnId); } catch (e) {} }
  }

  function onUpdate(cb) { if (typeof cb === 'function') listeners.push(cb); }

  // ---- Mark entry point ----------------------------------------------------
  function mark(turnId, stage, extra) {
    if (!turnId) return;
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // Always feed the local timeline (cheap; powers the in-app panel).
    try { record(turnId, stage, t); } catch (e) { /* never throw on the hot path */ }
    // Forward to main's [ARIA_PERF] log only when verbose instrumentation is on.
    if (!enabled) return;
    try { aria.perf.mark(turnId, stage, extra); } catch (e) { /* never throw on the hot path */ }
  }

  window.AriaPerf = {
    isEnabled: () => enabled,
    newTurn, mark, setTurnMeta, recentTurns, lastStages, onUpdate,
  };
})();
