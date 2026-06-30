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
Status: done
Findings: The capture/send path is ALREADY well optimized by prior sessions —
  `captureScreenFrame()` returns a background-refreshed cached frame instantly (no
  send-path block except a bounded 600ms grab on the very first share-turn), frame is
  downscaled to 768px @ 0.45 JPEG, and `shouldAttachScreen()` skips the vision path for
  clearly non-visual asks. The remaining (untaken) dominant lever is the OpenAI-vision
  `image_url.detail` field: it was unset, so every screen-share turn paid for "high"
  detail (the model tiles the image into 512px tiles = many vision tokens = slow TTFT),
  even for a simple "what's on my screen" glance.
Fix:
  - src/main/router.ts: new pure `visionDetailFor(message)` — returns 'low' for glance
    asks (what's on my screen / what am I looking at / what app / describe my screen…)
    and 'high' otherwise, so reading tasks (errors, code, summarize) keep full detail
    (no legibility regression) while glances get a fast single low-res pass.
  - src/main/coordinator.ts: attach `detail: visionDetailFor(userMessage)` to the
    screen frame's image_url.
  - src/renderer/app.js: centralized the frame size/quality as named calibration knobs
    (SCREEN_FRAME_MAX_W=768, SCREEN_FRAME_QUALITY=0.45) — drop width toward 512 to
    halve vision tiles if screen-share replies still drag (documented in-comment).
Verification: `npm run build` clean. `npm run smoke:router` PASS incl. 8 new
  visionDetailFor cases (glance→low, reading→high). `npm run smoke:boot` OK.
  Non-image turns are unaffected (detail only added when a frame is attached).
  NOTE: the actual vision-TTFT reduction from detail:low needs a live vision endpoint
  to benchmark numerically — can't be measured in this headless env without a model.
  The change is a no-regression speedup: glance asks get materially cheaper vision
  processing; reading asks are unchanged.

## Item 3: Add volume + voice-speed sliders to Settings
Status: not-started

## Found but not in scope
- The slow-reply filler, when it fires, marks `tts_first_audio` for the turn (filler
  audio counts as first audio in the perf panel). Pre-existing; only affects slow
  turns where the filler fires. Not changing the perf panel here.
