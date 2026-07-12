# Architecture

Three process tiers: **Electron main** (privileged, TypeScript), **renderer**
(sandboxed UI, vanilla JS), **Python sidecars** (frozen, single-purpose). Plus a
**remote** OpenAI-compatible LLM/agent you configure.

## Data flow (a voice turn)

1. A persistent `getUserMedia` stream feeds an **AudioWorklet** (`mic-worklet.js`).
   Every frame is downsampled to 16 kHz mono int16 (`audio-utils.js`) and sent to
   main over `MIC_AUDIO`, which forwards it to the always-on **wakeword** sidecar
   (and to **stt** while an utterance is open).
2. Wake word (or the mic button / global shortcut) opens an utterance
   (`STT_START`). The renderer runs energy-based endpointing (`VadEndpointer`) for
   hands-free turns; ~850 ms of trailing silence ends it (`STT_END`).
3. The **stt** sidecar (warm `whisper-server`, Vulkan) returns text (`STT_RESULT`).
4. The renderer submits it (`LLM_SEND`). The **coordinator** routes to the direct
   LLM or the agent harness, streams the reply over SSE (`llm-stream.ts`), and emits
   `LLM_ROUTE` / `LLM_TOKEN` / `LLM_TOOL` / `LLM_DONE`.
5. As sentences complete, the renderer feeds them to the **tts** sidecar
   (`TTS_PLAY`). PCM streams back over a UDS; each chunk's size/rate is announced on
   stdout (`TTS_STATE`), bytes arrive as `TTS_AUDIO`, and Web Audio schedules them
   gaplessly while the **orb** reacts to the RMS envelope.

The orb's state machine (`idle → listening → processing → speaking`) is driven from
`app.js` via `orbState()`.

## Main process — `src/main/`

| File | Owns |
|------|------|
| `index.ts` | App entry: window, tray, menus, **all IPC handlers**, wiring sidecar callbacks to the renderer, renderer crash **circuit breaker** (`render-process-gone`). |
| `supervisor.ts` | Spawns/monitors sidecars: heartbeat, **restart + circuit breaker**, **RSS memory watchdog**, tree-kill on quit, PDEATHSIG backstop. Public API: `start/stop/restart/stopAll/startMonitoring/sendToSidecar/sendPcm/onBinaryData`. |
| `coordinator.ts` | The brain of a turn: shared conversation history, `route()` to LLM vs harness (+ fallback), Hermes session continuity, per-session **token attribution**, session delete/harness-delete. |
| `router.ts` | Pure routing heuristics (regex): agentic/realtime/action phrases → harness; chat → LLM. Also `visionDetailFor()`. Unit-tested by `smoke:router`. |
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
| `orb.js` | The Glass Observatory canvas orb: seeded particles, per-state palette/motion, FPS caps, **GPU relief** during STT, adaptive pressure detector, backing-store caps. |
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
string) and `constants.ts`.
