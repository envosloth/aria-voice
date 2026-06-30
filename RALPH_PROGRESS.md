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
Status: done
Findings: TTS sidecar already supported speed (self.speed from ARIA_TTS_SPEED) but
  only applied it for Kokoro — Piper's _emit_piper ignored it. No runtime speed
  control existed (env read only at spawn). No volume control existed; the renderer
  TTS graph was source -> analyser -> destination with no master gain.
Fix:
  - src/main/config.ts: added tts.speed (default 1.0) and audio.volume (default 1.0).
  - sidecars/tts/main.py: new on_control 'set_speed' (clamped 0.5..2.0, atomic float
    assign, applies to next utterance, no reload); _emit_piper now passes
    SynthesisConfig(length_scale=1/speed) (Piper's inverse-of-speed knob) — at speed
    1.0 syn_config=None, byte-for-byte identical to before.
  - src/main/index.ts: refreshSidecarEnv sets ARIA_TTS_SPEED; CONFIG_SET 'tts.speed'
    sends a live set_speed control to the running sidecar (+ updates env for next
    spawn). audio.volume is renderer-only (no main handling needed).
  - src/renderer/app.js: master ttsGain node inserted AFTER the analyser (so the orb
    still reacts to the speech envelope and volume isn't clobbered by stopPlayback's
    source-level muting); setOutputVolume() rides it live mid-playback; volume loaded
    at startup; both sliders loaded in loadSettings; live listeners (input=apply/label,
    change=persist) independent of the Save button.
  - src/renderer/index.html: two <input type="range"> rows in the TTS section + range
    CSS. Speed 0.5..2.0 step 0.05; Volume 0..1 step 0.05; current value shown.
Verification: `npm run build` clean. `npm run smoke:tts` PASS incl. a new live
  set_speed guard (normal 249856 -> slow@0.6 445440 bytes; slower => more audio).
  Direct end-to-end probe: normal=233472, slow(0.6)=394240, fast(1.6)=139264 bytes.
  `npm run smoke:boot` OK (renderer loads the new sliders + gain node without error).
  `npm run smoke:perf-panel` PASS (Settings panel + loadSettings exercise the new
  rows). `npm run smoke:router` PASS. Piper speed path not runnable here (no Piper
  voice model downloaded) but the default path is unchanged (syn_config=None) and the
  SynthesisConfig(length_scale=...) API is confirmed in the installed piper.
  Volume = renderer master gain, instant + mid-stream; persists across restart (config).

## Found but not in scope
- The slow-reply filler, when it fires, marks `tts_first_audio` for the turn (filler
  audio counts as first audio in the perf panel). Pre-existing; only affects slow
  turns where the filler fires. Not changing the perf panel here.
- smoke:e2e FAILS the spec §7 LOCAL latency budget (1300ms): measured 1366-1514ms,
  driven by Kokoro TTS first chunk (~815-861ms) + STT (~550-650ms) on this loaded dev
  box. PRE-EXISTING + environmental (documented prior): not a regression — none of the
  3 items touch the STT/TTS-first-chunk synth path, and e2e never loads the renderer
  nor hits set_speed. Confirmed it fails the same way without the Item-3 changes.
- FIXED as closely-related cleanup (was failing smoke:perf-panel, pre-existing):
  the v2.8.2 Piper-voice change to en_GB-alan-medium (hardware.ts presets) had not
  been propagated to the Settings voice dropdown (still en_US-lessac-medium) or the
  perf-panel test assertion, so the dropdown couldn't display the preset/default Piper
  voice. Aligned both to en_GB-alan-medium. (Note: smoke:models still references
  en_US-lessac-medium in its manifest unit test — left as-is; the model-manager
  downloads any piper voice dynamically, so both voices work.)
