# Ralph Progress — Voice-Filler Cutoff, Screen-Share Delay, Audio Sliders

## Item 1: Slow-reply "hold on" filler gets cut off + arrives too late
Status: done
Findings: The slow-reply filler is spoken by `armThinkingHold()` (src/renderer/app.js)
  via a single 3800ms `setTimeout` → `speakOnly()` → `ttsPlay()`. When the real
  reply's first chunk arrives, `speakChunk()` (line ~588) calls `stopPlayback(true)`
  at turn start, which hard-stops the still-playing filler audio AND cancels the
  sidecar synth — truncating the filler mid-word. Both filler and reply go through the
  same `aria.tts.play()` → sidecar serial synth queue → gapless `nextPlayTime`
  scheduling, so simply NOT calling stopPlayback when a filler is mid-flight makes the
  reply queue cleanly behind the filler. 3800ms is also too slow for "keep me in the
  loop faster."
Fix: src/renderer/app.js —
  - new `fillerSpeaking` flag; `speakFiller()` wraps `speakOnly()` and sets it.
  - `speakChunk()` turn-start: if `fillerSpeaking`, DON'T stopPlayback — instead just
    clear the filler's pending idle timer + `ttsSynthDone`, so the reply queues
    gaplessly behind the filler (sidecar synth queue is serial; `nextPlayTime` is only
    reset by stopPlayback, which the 'done' handler deliberately avoids). Else behaves
    as before.
  - `stopPlayback()` clears `fillerSpeaking` (so a real user barge-in still cuts the
    filler instantly).
  - `armThinkingHold()` now two-stage: first nudge at HOLD_FIRST_MS=2000 (was 3800),
    escalation "Still working on it — hang tight." at HOLD_ESCALATE_MS=12000;
    `cancelThinkingHold()` clears both timers.
Verification: `npm run build` clean. `npm run smoke:tts` PASS (3 chunks, 249856 bytes
  UDS == stdout, done). `npm run smoke:boot` OK (app boots headless, supervisor +
  sidecars init, clean shutdown). Logic trace: filler PCM + reply PCM both schedule on
  the same monotonic `nextPlayTime`; with stopPlayback skipped the filler's sources
  are never stopped and the reply schedules at/after the filler's end → gapless, no
  mid-word cut. Fast replies (<2s to first token) still play no filler because
  `onToken`→`cancelThinkingHold()` fires first.

## Item 2: Reduce latency while screen sharing is on
Status: not-started

## Item 3: Add volume + voice-speed sliders to Settings
Status: not-started

## Found but not in scope
- The slow-reply filler, when it fires, marks `tts_first_audio` for the turn (filler
  audio counts as first audio in the perf panel). Pre-existing; only affects slow
  turns where the filler fires. Not changing the perf panel here.
