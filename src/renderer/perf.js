// Renderer half of the latency harness (see src/main/perf.ts). Marks made here
// are forwarded to the main process over IPC, where they land in the SAME
// [ARIA_PERF] timeline as the main-side marks — so one `grep ARIA_PERF` over the
// app's stdout shows a full interaction, UI event through audio playback.
//
// OFF by default. `aria.perf.enabled()` is queried once at load; while disabled
// every mark() is a boolean check and an early return. The forward itself is a
// fire-and-forget ipcRenderer.send (never awaited), so instrumenting the hot
// path cannot add latency to it.
//
// Exposed as window.AriaPerf:
//   AriaPerf.newTurn(kind) -> a correlation id shared across processes for a turn
//   AriaPerf.mark(turnId, stage, extra)
//   AriaPerf.isEnabled()
(function () {
  'use strict';
  const aria = window.aria;
  let enabled = false;
  let counter = 0;

  // Query enablement once. Marks fired before this resolves (only the first few
  // ms after load, long before any user interaction) are simply dropped.
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

  function mark(turnId, stage, extra) {
    if (!enabled || !turnId) return;
    try { aria.perf.mark(turnId, stage, extra); } catch (e) { /* never throw on the hot path */ }
  }

  window.AriaPerf = { isEnabled: () => enabled, newTurn, mark };
})();
