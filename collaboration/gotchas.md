# Gotchas & Landmines

The non-obvious stuff. Most of these are here because something crashed, hung, or
shipped broken. Verified against the code — but if a detail has drifted, trust the
code and fix this file.

## Routing

The router in `src/main/router.ts` is an ORDERED decision list: explicit requests
first, then user-text work, then on-screen/deictic, then imperatives, machine
changes, knowledge framings, live lookups, implicit asks, and only then the broad
keyword list. Order is load-bearing — the keyword list matches NOUNS anywhere in
the sentence, so anything broad placed early silently swallows everything after
it. Two real examples of that failure: putting `translate` in the imperative list
made "translate this into French" an agent task, and letting a bare `best way to`
into the navigation rule made "the best way to back up my files" an agent task.
Both were caught only by the labeled benchmark, never by inspection.

`routeDetailed()` also reports whether a RULE recognised the message. Two cases
do not: a match on nothing but the broad keyword list, and the final default.
Those go to `turn-classifier.ts`, which asks the configured chat model one
non-streaming question with a 6-token answer and a hard deadline, then keeps the
heuristic answer if the model does not answer usefully (timeout, HTTP error,
unparseable text, insecure endpoint). Measured on 1,194 labeled utterances, the
tiebreaker lifts the hardest unseen set from 81.7% to 87.5% — but ONLY when the
classifier is fast. Pointed at the local Hermes agent (~6s per call) almost every
call misses the 1.5s budget and the turn falls back, so `routing.classifier`
exists to turn it off and `routing.classifierTimeoutMs` to bound the cost.
Never route the classifier at an agent: the point is a cheap one-word answer.

Accuracy is measured, not assumed: `npm run smoke:routing-accuracy` grades 1,060+
labeled utterances plus the dispute file. Fresh independent sets scored 75-90%
unseen while the fitted corpus sat at ~99%, which is the honest state of a
heuristic router. Regenerate a set from a subagent that is forbidden to read
`router.ts` or the existing case files, or the number means nothing.

## Stack constraints (don't "fix" these)

- **No ROCm.** Target OS (Ubuntu 26.04 / kernel 7.0) isn't in AMD's ROCm matrix. STT
  is whisper.cpp **Vulkan** (`-DGGML_VULKAN=1`), CPU fallback. Full rationale +
  sources in [/BUILD_SPEC.md](../BUILD_SPEC.md).
- **No faster-whisper / CTranslate2.** Its ROCm path crashes on RDNA 4 (gfx1200/1201).
- **TTS is CPU** (Piper default, Kokoro-82M optional). Neither gets reliable AMD GPU
  accel on Linux; sentence-chunked streaming hides the latency instead.
- **16 GB VRAM / 30 GB RAM budget.** Sidecars lazy-load; the supervisor runs an RSS
  watchdog per sidecar. Don't hold big buffers.

## The GPU-contention crash (orb + Vulkan STT)

The single nastiest historical crash class. The first canvas orb rendered at native
refresh while Vulkan transcription ran, saturated the GPU, and could take the renderer
down on `balanced`+ profiles. The current procedural orb (`orb.js`) is a canvas again,
so these safeguards are load-bearing:

- The rAF loop is FPS-capped per quality tier (low 24 / medium 30 / high 60 active;
  12 / 20 / 30 once settled at idle/listening) and particle count and backing-store
  DPR scale with the tier. Dots are batched into six alpha-bucket paths per frame,
  measured at ~1.3–2 ms/frame at 2000 dots.
- `beginSttCompute()` cancels the loop **and** hides the canvas during Vulkan
  compute; `endSttCompute()` resumes, with a 6 s failsafe and next-listen recovery.
- The loop stops entirely while `document.hidden` (closed to tray) and, under
  `prefers-reduced-motion`, once settled at idle (rotation is also dropped).
- Never put a CSS `filter`/`drop-shadow` on `#orb-canvas`: it re-rasterises on the
  GPU every frame. The glow is a static radial gradient on `.orb-slot::before`.
- `smoke:orb` drives the real adapter with a fake canvas/rAF/clock and asserts the
  caps, hidden stop, compute freeze/failsafe, and state motion as behavior. Don't
  add `setInterval` or an uncapped loop.

## Audio pipeline

- **PCM has no framing.** UDS segments aren't 2-byte aligned; building an `Int16Array`
  over an odd-length buffer throws. The renderer carries the trailing odd byte into
  the next segment (`pcmCarryByte` in `app.js`). **A barge-in must reset it** — a
  stale carry byte prepended to the next reply misaligns every sample → pure noise.
- **Sidecar stdout is line-framed JSON that splits across read chunks.** The
  supervisor keeps a per-sidecar `stdoutBuf` until the newline (reset on respawn,
  size-capped). Emit whole JSON lines from Python.
- **Endpointing vs latency is a live tension.** Hands-free turns use
  `AriaAudio.HANDSFREE_ENDPOINT_OPTS`: ~850 ms of trailing silence normally, but
  1.3 s while only 200–500 ms of speech has been heard (an opening fragment such
  as "I'm…" followed by a hesitation). A ~1 s command and a lone cough/click
  (< 200 ms) both end on the normal 850 ms hang. Shorter clips users mid-pause
  ("it replied before I finished"); longer feels laggy. These are calibration
  knobs, not constants to "optimize away" — `smoke:audio` asserts the shipped
  values against a 1 s command, a cough, and a short opening.
- **Push-to-talk release only ends PTT turns.** mouseup/mouseleave/blur/keyup on
  the mic button are gated by `pttActive`; otherwise moving the pointer off the
  button cut off an in-progress wake-word (VAD) turn.
- **Wake-word sensitivity vs false fires is the other tension.** Too sensitive → room
  noise/ARIA's own audio barge in and cut replies; too strict → misses. There's a
  barge-in score gate while speaking. Re-tune deliberately, both directions.
- **Whisper hallucinates on silence** ("Thank you.", "you"). Silent follow-up windows
  must **discard** the STT result, never submit it as a user turn. Correlate that
  discard with the silent turn's ID; a global "drop the next result" boolean can
  survive when a stale result is rejected and then erase the next real utterance.
- **A detected GPU is not a ready whisper HTTP server.** The Vulkan log appears
  during model loading; `_start_server` must still wait for a listening log/port
  probe before the sidecar emits `ready`. Also discover `whisper-cli` even on the
  warm-server path so a later HTTP failure has a real cold fallback.
- **STT stdin and PCM sockets race each other.** Utterance start is acknowledged
  before queued PCM is flushed, end declares its expected byte count, and final
  results carry the utterance ID. This prevents erased leading audio, clipped last
  words, and stale/duplicate results becoming repeated chat turns. The complete
  audio wait is conditional (normally zero; capped at 120 ms), not a fixed delay.
- **16 kHz mic downsampling must anti-alias.** At the common 48 kHz input rate,
  selecting every third sample folds high-frequency noise into speech. The
  interval-average filter in `audio-utils.js` is frame-local (no added buffering)
  and shared by wake-word/STT capture.

## Renderer sandbox & UI

- The renderer is fully sandboxed (`sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`). New capabilities go through `preload` — see
  [ipc-contract.md](ipc-contract.md).
- **Never ship `--no-sandbox`.** It's dev/test only. Packaged builds must have a
  correctly-configured Chromium SUID sandbox (root:root, 4755).
- **`npm run dev` must include `--no-sandbox` on this checkout.** Electron runs
  directly from `node_modules`, where `chrome-sandbox` is not installed as
  root:root mode 4755; without that dev-only flag it aborts before a renderer
  window opens. Keep the flag out of packaged builds — electron-builder sets up
  the production sandbox separately.
- **`position: fixed` is trapped by `backdrop-filter`/`transform`/`filter`
  ancestors.** A dropdown inside the glass `.panel` (which has `overflow:hidden` AND
  `backdrop-filter`) gets clipped — its containing block becomes the panel, not the
  viewport. The fix pattern: re-parent the popup onto `<body>` and position it from
  the button's viewport rect. (This is exactly why the session ⋮ menu was "hidden
  away.")
- **Every renderer→main channel is sender-checked.** Register handlers only via
  the `handle()`/`on()` wrappers in `index.ts`; they assert the sender is the top
  frame of `mainWindow` showing the packaged `renderer/index.html`. Navigation,
  redirects, `window.open`, and `<webview>` are refused app-wide
  (`web-contents-created`) because any other page would inherit `aria.*`.
  Validate payloads in main: CONFIG_SET goes through `validateConfigSet`, secure
  storage accepts only `llm-api-key`/`harness-api-key`, and LLM_SEND is bounded
  (`parseLlmSendPayload`). `smoke:ipc-hardening` covers all of this.
- **Main owns the TTS epoch.** It survives renderer reloads (crash recovery,
  unresponsive reload) while the renderer restarts at 0. The renderer seeds from
  `aria.tts.epoch()` at startup and adopts the value `aria.tts.stop()` resolves;
  without that, every TTS_PLAY after a reload carried a stale epoch → permanent mute.
- **rAF loops must be capped and gated.** Uncapped orb render + TTS-RMS loops once
  pegged the CPU. Loops are FPS-capped, background-throttled, and stop themselves when
  idle. Don't add an always-on `requestAnimationFrame`.

## LLM / coordinator

- Routing contract: `router.ts` chooses the target before invocation. Unmistakable
  agentic, real-time, or action requests go to the harness up front; ordinary chat
  goes to the direct conversational LLM. The direct LLM receives no tools and no
  prose handoff escape hatch. Forced `llm` mode is a deliberate direct-only user
  override, not an implicit harness route. `smoke:routing-invariant` executes this
  boundary in the real app and must remain aligned with `ralph/STATE.md`.
- `router.ts` is an ordered decision list (explicit → creative writing → on-screen
  reference → imperative order → knowledge framing → live lookups → advice framing
  → broad keywords → stickiness → chat). The order is load-bearing: the broad
  keyword list matches NOUNS, so an imperative check and the knowledge/advice
  framings must run BEFORE it, or "how do I take a screenshot on a Mac" and
  "what's the best way to back up my files" get dragged to the agent. Adding a
  keyword is therefore not free — re-run `smoke:routing-accuracy` (a labeled
  benchmark with a per-category floor) and `smoke:router` together.
- Harness replies get an `[agent tools used: …]` note appended in the **live
  history only** (not the persisted/spoken transcript) so the fast chat mode can
  see what the agent did. Anything scanning history text (e.g. the
  `lastWasQuestion` stickiness check) must strip that suffix first.
- **Never retry or fall back after reply text has already streamed** — a second stream
  concatenates onto the shown/spoken reply. `coordinator.ts` guards this with
  `sawFirstToken`.
- Both targets share **one conversation history**, so context survives an LLM↔harness
  handoff. History stores assistant *text* plus the tools-used note (never the
  harness's raw tool_calls/results).
- **`stream_options: { include_usage: true }`** is now sent on every request (for the
  token meter). Standard OpenAI, broadly supported; a strict server could 400 — that's
  the cause if the token meter dies with an error.
- **Hermes session continuity** rides `X-Hermes-Session-Id` (rotated only on New
  session). *Integration note (harness-side, not this repo):* a Hermes gateway with
  `approvals.mode: manual` auto-denies tool turns on `/v1/chat/completions` — it must
  be `off` for the agent to run tools headlessly.

## Persistence & secrets

- `sessions.ts` + `config.ts` persist via the atomic `JsonStore`. It has survived a
  null-intermediate-key crash before — don't assume nested keys exist.
- `getSecret()` is **synchronous** (`string | null`). Some call sites `await` it out of
  habit; that's a harmless no-op, not a signal it's async.

## Platform & lifecycle

- **Never build both macOS architectures from one runner when bundling native
  sidecars or whisper.cpp.** Keep macOS targets architecture-neutral in
  `electron-builder.yml`; release CI selects `--arm64` on `macos-15` and `--x64`
  on `macos-15-intel`, then merges `latest-mac.yml` after both native builds.
- **Keep one Linux desktop ID for the current app.** The current Electron package
  owns `aria.desktop`; the legacy `aria-voice` package owns
  `aria-voice.desktop`. Co-installing both exposes two apps named ARIA, so release
  upgrades should remove/conflict with the legacy package or mask its desktop ID.
  Also never create an `applications` symlink inside
  `~/.local/share/applications/` that points back to that directory: GLib follows
  the loop at successive depths and GNOME search can show dozens of copies of
  every user launcher.
- **Wayland global shortcuts are best-effort** (portal, behind a flag). Tray + in-window
  shortcuts are the real fallback — always wire them.
- **Windows has no `AF_UNIX`**: the PCM channel becomes `tcp://127.0.0.1:port`; kills
  use `taskkill`; sidecars are `.exe`. Keep Linux byte-for-byte unchanged when touching
  cross-platform code.
- **Windows wake word needs a complete frozen ONNX/openWakeWord bundle.** The TCP
  transport is not enough: PyInstaller must collect all `openwakeword` resources,
  `onnxruntime` binaries/submodules, and the native pybind state module. A bundle
  that starts but never detects usually missed one of those pieces.
- **Fresh installs intentionally default to Power saver.** That means CPU STT,
  Piper TTS, low orb quality, and a 30% GPU cap. Treat it as the stability baseline;
  optimize smoothness there before making `auto`/`balanced` more aggressive.
- **Fedora/RHEL/openSUSE updates are RPM-notify, not dpkg self-install.** The updater
  should detect RPM-family distros, link the matching `.rpm` release asset, and avoid
  launching `pkexec dpkg` outside Debian-family systems.
- Closing the window **hides** it (ARIA lives in the tray, wake word stays active); it
  only quits from the tray. Sidecars tree-kill on real quit + PDEATHSIG backstop.

## Testing traps

- `smoke:all` is the gate, but two suites are **load-sensitive flakes**: `smoke:e2e`
  (a ~1300 ms local latency budget) and `smoke:memory` (needs a restarted sidecar to
  re-reach `ready` under an artificial 1 MB ceiling race). Both pass standalone —
  re-run individually before assuming a regression.
- String-presence smoke checks (e.g. `smoke:session-features`) can't catch rendering
  or timing bugs. Drive the app.
