# Architecture

Three process tiers: **Electron main** (privileged, TypeScript), **renderer**
(sandboxed UI, vanilla JS), **Python sidecars** (frozen, single-purpose). Plus a
**remote** OpenAI-compatible LLM/agent you configure.

## Turn routing

`main/coordinator.ts` picks one target per turn at router time — a direct chat
model with NO tools, or the agent harness. There is no mid-turn handoff.

1. `router.routeDetailed()` runs an ordered rule list and returns the target plus
   a `confident` flag.
2. If no rule recognised the message and both targets are configured,
   `turn-classifier.classifyTurn()` asks the selected coordinator for a second
   opinion: `routing.coordinator` is `builtin` (one short non-streaming question
   to the chat model, 6-token answer, `routing.classifierTimeoutMs` deadline) or
   `jev` (`jev-classifier.ts` → TypeSafe, one typed Choice returning a choice and
   a calibrated confidence, `JEV_TIMEOUT_MS` deadline). Jev falls back to the
   built-in path, and then to the rules; any failure keeps the heuristic answer,
   so a dead, slow, or unkeyed coordinator degrades to the old behavior instead
   of blocking. `routing.classifier = off` disables the second opinion entirely.
3. `routing.mode` (auto | llm | harness) still overrides everything, and an
   attached screen frame is always the agent's job.

Nothing in this path can send a credential anywhere but loopback or https
(`endpoint-security.credentialedEndpointSecurityError`), and the classifier's
question carries no history, no tools, and nothing the user did not just say.


## Data flow (a voice turn)

1. A persistent `getUserMedia` stream feeds an **AudioWorklet** (`mic-worklet.js`).
   Every frame is downsampled to 16 kHz mono int16 (`audio-utils.js`) and sent to
   main over `MIC_AUDIO`, which forwards it to the always-on **wakeword** sidecar
   (and to **stt** while an utterance is open).
2. Wake word (or the mic button / global shortcut) opens an utterance
   (`STT_START`). The renderer runs energy-based endpointing (`VadEndpointer`) for
   hands-free turns; ~850 ms of trailing silence ends it (`STT_END`), or 1.3 s
   when only a brief 200–500 ms opening fragment has been spoken so far.
   **Speculative early endpoint** (`stt.speculative`, default on): after 300 ms
   of pause (≥400 ms of speech), the renderer sends `STT_SPECULATE`; the sidecar
   transcribes the audio so far without consuming it and returns `STT_PARTIAL`.
   If `looksComplete()` accepts it and the user has not spoken since (VAD speech
   epoch unchanged), the hang drops to 500 ms, and the final `transcribe` reuses
   the partial when the added tail is silent (`reused: true`, ~0 ms). Resumed
   speech voids the grant and the final re-transcribes. If the
   STT sidecar dies with a turn in flight, main fails that turn (`STT_STATE`
   `stt_failed`) so the renderer never waits on a result that cannot arrive.
3. The **stt** sidecar (warm `whisper-server`, Vulkan) returns text (`STT_RESULT`).
4. The renderer submits it (`LLM_SEND`). The **coordinator** routes to the direct
   LLM or the agent harness, streams the reply over SSE (`llm-stream.ts`), and emits
   `LLM_ROUTE` / `LLM_TOKEN` / `LLM_TOOL` / `LLM_DONE`.
5. As sentences complete, the renderer feeds them to the **tts** sidecar
   (`TTS_PLAY`). PCM streams back over a UDS; each chunk's size/rate is announced on
   stdout (`TTS_STATE`), bytes arrive as `TTS_AUDIO`, and Web Audio schedules them
   gaplessly while the **orb** reacts to the RMS envelope.

**Desktop context** (`context-refs.ts`, pure; `context-capture.ts`, desktop):
`detectContextRefs()` decides whether an utterance points at something —
selection, clipboard, active app, browser page — and returns nothing for
"this morning", "check it out", "tell me a joke". Only then, and only for
sources enabled in Settings → Context (`context.selection|clipboard|activeApp`,
all off by default), `captureContext()` reads them with 400 ms-bounded probes
(Hyprland `hyprctl clients` focus history so ARIA's own window is skipped,
Sway, X11 xdotool; `wl-paste` for selection and clipboard on Wayland because
Electron's clipboard reads "" there while another app has focus).
`buildContextBlock()` renders it for this one request's system prompt (never
stored in shared history), framed as data not instructions, withholding
anything that looks like a key/token. `LLM_CONTEXT` sends the renderer one chip
per source read. Text work on handed-over text ("summarize this") stays on the
chat path. Text files dropped on the composer ride on `LLM_SEND.files` for one
message. The header shows "ARIA can read: …" while any source is enabled.

**User memory** (`user-memory.ts`, pure; `user-memory-app.ts`, Electron
binding): durable facts in `userData/aria-memory.json`, encrypted with
`safeStorage` when the keyring backend is safe (else owner-only plaintext, shown
in the panel). Every item has kind, timestamps, source and the source utterance.
"Remember that…", "forget…", "forget everything", "what do you remember about
me" are local intents in `local-intents.ts` — answered in the coordinator, never
sent to a model. For model turns, `selectMemories()` picks relevant items
(lexical overlap, then recency) within 1200 chars and `renderMemoryBlock()`
appends them to the system prompt as user data, not instructions
(`memory.enabled` off removes it). Settings → Memory lists, edits, deletes,
adds, exports and clears via the `MEMORY_*` IPC channels.

**Voice barge-in** (`conversation.voiceBargeIn`, default off): while TTS is
playing, each mic frame's RMS and the TTS analyser RMS × volume feed
`AriaAudio.EchoAwareBargeDetector` (peak-held reference, learned speaker→mic
coupling, vote over 200 ms, 500 ms warm-up). On fire it latches for the rest of
that playback run and calls `beginUtterance({ vad: true, preroll })`, which
replays ≤320 ms of pre-detection PCM after `STT_START`. Energy-only: the user
must be ≥ ~4 dB above ARIA's echo at the mic (see `smoke:barge-in`).

The orb's state machine (`idle → listening → processing → speaking`) is driven from
`app.js` via `orbState()`.

## Main process — `src/main/`

| File | Owns |
|------|------|
| `index.ts` | App entry: window, tray, menus, **all IPC handlers** (registered via sender-checked `handle()`/`on()` wrappers; navigation/popup/webview guards), authoritative TTS epoch, wiring sidecar callbacks to the renderer, renderer crash **circuit breaker** (`render-process-gone`). |
| `supervisor.ts` | Spawns/monitors sidecars: heartbeat, **restart + circuit breaker**, **RSS memory watchdog**, tree-kill on quit, PDEATHSIG backstop. Public API: `start/stop/restart/stopAll/startMonitoring/sendToSidecar/sendPcm/onBinaryData`. |
| `coordinator.ts` | The brain of a turn: shared conversation history, `route()` to LLM vs harness (+ fallback), Hermes session continuity, per-session **token attribution**, session delete/harness-delete. |
| `router.ts` | Pure routing heuristics (regex), an ordered decision list: explicit overrides → creative writing → on-screen reference → imperative → knowledge framing → live lookups → advice framing → keyword list → stickiness. Unit-tested by `smoke:router`; accuracy-gated by `smoke:routing-accuracy`. Also `visionDetailFor()`. |
| `llm-stream.ts` | Pure OpenAI-compatible SSE streamer: tokens, tool calls, `usage`. Keep-alive agents, `TCP_NODELAY`, abort handle for barge-in. No Electron dep → unit-testable. |
| `llm-models.ts` / `llm-client.ts` / `harness-detect.ts` | Model discovery, non-streaming client, auto-detect a local harness's endpoint+key from its own config. |
| `sessions.ts` | Persisted conversations (JsonStore): turns, titles, pin, harness session id, token totals. Sidebar summaries. |
| `config.ts` / `json-store.ts` | Non-secret config; atomic JSON persistence used by config + sessions. |
| `secure-storage.ts` | API keys via Electron `safeStorage` (+ keyring). **Sync** `getSecret(): string \| null`. Never plaintext. |
| `hardware.ts` | CPU/RAM/GPU detection → adaptive perf profile (STT threads/backend, orb quality, GPU cap). |
| `model-manager.ts` | Resumable, checksummed model downloads (STT/TTS weights, not bundled). |
| `perf.ts` | Latency instrumentation (stage marks → the Settings → Performance panel). |
| `updater.ts` | electron-updater (AppImage and signed Windows only) + release-page fallback (.deb/rpm/dev/unsigned desktop). |
| `tunnel-supervisor.ts` | SSH tunnel to a remote harness/LLM, with reconnect backoff. |

## Renderer — `src/renderer/` (vanilla JS, no bundler)

| File | Owns |
|------|------|
| `app.js` | The orchestrator (~2.3k lines): mic capture, VAD, utterance lifecycle, barge-in, TTS streaming/playback, orb state, sessions sidebar + overflow menu, settings, onboarding, screen share, token meter. |
| `orb.js` | Procedural particle orb: a Fibonacci-sphere of dots on a 2D canvas. Idle/listening stay compact; processing bursts into a rippling shell; speaking opens the shell and the TTS RMS level pushes rings through it; leaving either consolidates back. The rAF loop is FPS-capped per quality tier, stops while hidden, and stops/hides during Vulkan STT. `npm run preview:orb` renders a state timeline in headless Chromium. |
| `audio-utils.js` | Pure helpers: 16 kHz downsample, float→int16, RMS, `VadEndpointer`, `sanitizeForSpeech`. Loadable in Node → unit-tested. |
| `mic-worklet.js` | The AudioWorklet that emits mic frames. |
| `perf.js` | Renderer-side latency marks mirrored to main. |
| `harnesses.js` | Known-harness presets for Settings/onboarding. |
| `index.html` | Single-file UI: all CSS + DOM. The glass 3-column shell (sidebar / chat / ops-rail-with-orb). |
| `src/preload/index.ts` | The **only** bridge: an allowlisted `aria.*` API surfaced to the renderer via `contextBridge`. Bundled with esbuild. |

## Sidecars — `sidecars/`

Each is `sidecars/<name>/` with its own `venv` (dev) or PyInstaller onedir binary
(packaged), subclassing `sidecars/shared/base_sidecar.py`. They implement
`initialize()` / `on_control(msg)` / `on_pcm(bytes)` and call `self.emit(dict)` /
`self.send_pcm(bytes)`. See [ipc-contract.md](ipc-contract.md).

- `stt/` — spawns/warms `whisper-server` (Vulkan), streams PCM in, emits partial +
  final text.
- `tts/` — Piper (default light) or Kokoro-82M (neural), sentence-chunked, emits PCM.
- `wakeword/` — openWakeWord (+ optional Silero VAD gate), always-on, emits
  `wakeword:detected` with a score.

## Shared — `src/shared/`

`ipc-channels.ts` (the channel-name registry — import `IPC`, never hardcode a
string) and `constants.ts` (also the pure renderer-input policy: `parseLlmSendPayload`,
`isRendererSecretKey`, `isTrustedRendererUrl`).
