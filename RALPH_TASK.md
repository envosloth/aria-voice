# Ralph Loop Task: Fix Voice-Filler Cutoff, Screen-Share Delay, and Add Audio Sliders

You are running in a loop. Each iteration: read this file, read `RALPH_PROGRESS.md` in
the repo root (create it if missing), pick the next unfinished item below in order,
fix it, verify it, update `RALPH_PROGRESS.md` with what you did and how you verified
it, commit, and stop your turn. Do not move to the next item until the current one
is verified. If you get stuck on an item after 3 attempts, write down why in
`RALPH_PROGRESS.md` under a "Blocked" section and move to the next item instead of
looping forever on it.

When every item below is `done` or `blocked` (after its 3 attempts) AND the overall
success bar is met, output the completion promise `RALPH-ARIA-UX-3-ITEMS-VERIFIED-DONE`
to end the loop. Never output it otherwise.

## Standing constraints (apply to every item, every iteration)

This application is a real-time AI desktop assistant. Responsiveness is a core
feature, not a nice-to-have, and these constraints override generic "best practice"
instincts (e.g. "add a debounce", "batch these calls") wherever they'd conflict.

- Target: end-to-end interaction latency under 500ms whenever possible. This is a
  target to steer by, not a hard cliff — but any change that pushes latency higher
  needs a justification written in RALPH_PROGRESS.md, not a silent tradeoff.
- UI interactions must feel instantaneous. Never block the UI/main thread on network
  calls, disk I/O, or LLM/STT/TTS work — push it to a worker/background thread/async
  task and confirm the UI thread isn't waiting on it.
- TTS playback should start as soon as enough audio is available to play, not after
  the full response is synthesized. The incremental TTS path (speak each clause as
  the LLM streams it) must stay intact — do not regress eager first-chunk playback.
- The app must stay responsive with STT, TTS, LLM inference, and background agents
  all running at once — test concurrently, not just each in isolation.
- Linux is the reference platform and must stay byte-for-byte working. Any Windows/Mac
  branches you touch must not change Linux behavior.

Use the EXISTING latency harness — do not build a new one. It is already in the app:
`src/renderer/perf.js` (per-turn stage marks), the Settings → Performance panel, the
`ARIA_VERIFY_PERF` injection path in `src/main/index.ts`, and `npm run smoke:perf-panel`.
Measure before/after with it for any change that could touch the hot path.

Before/after every iteration that builds, run at minimum `npm run smoke:boot` and the
smoke tests relevant to what you touched (`smoke:tts`, `smoke:perf-panel`, etc.). Run
`npm run smoke:all` before marking the final item done.

## Progress tracking format (RALPH_PROGRESS.md)

For each item below, maintain a section:
```
## Item N: <short title>
Status: not-started | in-progress | done | blocked
Findings: <root cause once known>
Fix: <what changed, files touched>
Verification: <how you confirmed it's fixed, with before/after numbers where relevant>
```

---

## Item 1: Slow-reply "hold on" filler gets cut off by the real reply, and arrives too late

When a reply is slow (agent/tool tasks can take seconds), ARIA speaks a short
contextual "hold on" filler so the user isn't left in silence. Two problems:

1. **It gets truncated.** The filler is frequently interrupted mid-word by the first
   chunk of the real reply, so the user hears half a sentence then a hard cut.
2. **It arrives too late / not at all for borderline-slow replies.** The user wants to
   be kept in the loop FASTER when a turn is going to take a while.

Root cause to start from (verify it yourself, don't trust this blindly):
`armThinkingHold()` in `src/renderer/app.js` arms a single `setTimeout` of **3800ms**
that calls `speakOnly(phrase)` → `ttsPlay()` → `stopPlayback(true)`. When the first
real token/chunk arrives, `cancelThinkingHold()` runs and the streaming path
(`speakChunk` → `stopPlayback(true)` / barge-in) cuts the audio sink immediately —
truncating the filler that is still playing. The filler and the real reply share one
audio sink with no "let the current short filler finish before starting the reply"
handoff.

Fix direction (pick the simplest that actually works — root cause, not a band-aid):
- **Don't truncate the filler mid-utterance.** When the real reply's first chunk is
  ready but the filler is still playing, either (a) let the short filler finish and
  then start the reply audio, or (b) only start the filler if no reply is imminent.
  A barge-in from the USER (wake word / push-to-talk / stop) must STILL interrupt
  immediately — only the system's own reply should wait for the filler, never the user.
- **Speak sooner.** 3800ms is too long for "keep me in the loop faster." Lower the
  threshold (and/or make it adaptive — e.g. a short first nudge, escalating to a
  fuller "still working on it" for genuinely long agent tasks) so the user hears
  something within ~1.5-2s of silence. Don't fire it for replies that start almost
  immediately (no filler if first token lands before the threshold).
- Keep it spoken-only (no transcript line), keep the contextual phrasing in
  `holdOnPhrase()`.

Watch the interaction with the incremental-TTS path (`speakChunk`, `ttsTurnSpeaking`,
`resetTtsStream`, `appendStreamToken`) and the barge-in path (`bargeIn`,
`stopPlayback`, `interruptedTtsEpoch` / the post-barge-in gate). The fix must not let a
stale filler leak past a real user barge-in, and must not delay the real reply audio by
more than the brief tail of an already-playing short filler.

Verify:
- A slow reply (simulate by delaying first token) plays the filler to completion, THEN
  the real reply, with no mid-word cut.
- A fast reply (<threshold) plays no filler.
- A user barge-in during the filler still stops it instantly.
- `npm run smoke:tts` and `npm run smoke:boot` pass. Add/extend one assert-level check
  for the "filler not truncated by reply" logic if it can be unit-tested in the
  renderer logic (keep it minimal — no new framework).

## Item 2: Reduce latency while screen sharing is on

Screen-share turns are noticeably slower than normal turns. Some optimization already
exists in `src/renderer/app.js` (background-cached frame off the send path, 768px @ 0.45
JPEG, and `shouldAttachScreen()` skipping the vision path for clearly non-visual asks).
Build on that — measure where the remaining time actually goes, then cut it.

- Use the Item-0 harness (perf.js / Performance panel) to break down a screen-share
  turn vs. a normal turn: frame capture/encode time, payload size, time-to-first-token
  with the image attached, and full-reply time. Write the baseline numbers in
  RALPH_PROGRESS.md BEFORE changing anything.
- Likely levers (measure each, don't assume):
  - **Vision-model cost dominates** (token/processing cost scales with image pixels).
    Test a smaller frame (e.g. 640px, or quality 0.4) and confirm the agent can still
    read typical screen content — note the latency vs. legibility tradeoff.
  - **Frame freshness vs. cost:** the background refresh interval (`setInterval(..., 1500)`)
    and `captureScreenFrame()` 600ms first-grab race. Make sure no turn ever blocks on a
    capture, and that we don't re-encode a frame that hasn't changed.
  - **Over-attaching:** confirm `shouldAttachScreen()` isn't sending the frame on turns
    that don't need it (every attached frame forces the slow vision path). Tighten the
    heuristic only if it measurably helps without dropping genuinely visual asks.
  - **Don't send the same frame to history / don't double-encode** — verify the frame is
    only attached to the current turn (it already is per coordinator.ts; confirm).
- Do NOT add buffering/batching that increases perceived latency. The goal is lower
  time-to-first-audio on screen-share turns, not lower CPU.

Verify: before/after stage-by-stage numbers in RALPH_PROGRESS.md showing a real
reduction in screen-share turn latency, with confirmation the agent can still read the
screen. `npm run smoke:boot` passes.

## Item 3: Add a volume slider and a voice-speed slider to Settings

Settings has no control for output volume or TTS speaking rate. Add both, persisted,
and applied LIVE (no app restart — match how other settings apply).

- **Voice speed:** the TTS sidecar already supports speed — `sidecars/tts/main.py` reads
  `ARIA_TTS_SPEED` into `self.speed` and passes it to both Piper and Kokoro
  `synthesize(...)`. Wire a runtime speed control end-to-end: a Settings slider →
  persisted config → applied to the running sidecar. Prefer a control message to the
  sidecar (so it applies without respawn) over only an env var read at boot; if a
  respawn is genuinely required, apply it live by restarting just the TTS sidecar, not
  the app. Sensible range ~0.5x–2.0x, default 1.0, with the numeric value shown.
- **Volume:** the renderer already plays TTS PCM through a WebAudio graph with a gain
  node (`sink.gain.value` in `src/renderer/app.js`). The lazy correct path is a master
  output gain controlled by the slider (0–100% → gain 0.0–1.0), persisted, applied
  instantly. Do NOT change volume by re-synthesizing or by altering PCM in the sidecar.
  Make sure the gain you set isn't clobbered by the existing barge-in/`stopPlayback`
  gain-ducking logic (it sets `sink.gain.value = 0` to mute the tail — your master
  volume must be restored, not overwritten, when playback resumes).
- **UI:** add two `<input type="range">` rows to the Settings panel
  (`src/renderer/index.html`), following the existing settings-panel styling/markup
  pattern. Show the current value. Persist via the same config store/IPC the other
  settings use (`src/main/config.ts`, preload, IPC channels) — reuse the existing
  save/apply path, don't invent a new one.
- Live-apply: changing either slider takes effect on the very next spoken output (and
  ideally mid-stream for volume) without restarting the app.

Verify:
- Move the volume slider → next TTS playback is audibly louder/quieter; 0% is silent;
  setting persists across restart.
- Move the speed slider → next TTS playback is faster/slower at the same pitch
  (changing speed in the sidecar preserves pitch; do not fake it with renderer
  playbackRate, which chipmunks the voice); setting persists across restart.
- `npm run smoke:tts` and `npm run smoke:boot` pass. Then run `npm run smoke:all`
  before marking this final item done.

---

## General rules for every item

- Don't mark something "done" without a concrete verification step you actually
  performed — describe it in RALPH_PROGRESS.md, with before/after latency numbers for
  anything that touches the hot path.
- Prefer fixing root cause over papering over symptoms. Fix shared functions once
  (where all callers route through), not per-caller.
- Keep changes minimal and in keeping with the surrounding code style. No new
  dependencies for what a few lines can do. No speculative abstractions.
- Keep commits scoped to one item each. Use a clear `fix(...)`/`feat(...)` message.
- Linux behavior must remain byte-for-byte working; smoke suite stays green.
- If fixing one item reveals a closely related bug not listed here, note it in
  RALPH_PROGRESS.md under "Found but not in scope" rather than silently expanding scope.
