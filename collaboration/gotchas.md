# Gotchas & Landmines

The non-obvious stuff. Most of these are here because something crashed, hung, or
shipped broken. Verified against the code — but if a detail has drifted, trust the
code and fix this file.

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

The single nastiest crash class. The canvas orb rendering at native refresh **while a
Vulkan STT transcription runs** saturated the GPU and took the renderer down on
`balanced`+ profiles. Mitigations live in `orb.js` and must not be casually removed:

- **GPU relief** during real pressure: `beginStt()`/`endStt()` cap the orb frame
  cadence while the mic is open, but they **do not** drop backing-store resolution
  (listening must stay crisp). The hard backing-store drop (`RELIEF_BACKING = 1024`
  device-px long edge) is reserved for the adaptive pressure detector; Vulkan STT
  compute uses the short zero-frame freeze instead.
- Relief is a **boolean + 12 s watchdog**, not a refcount. A refcount leaked when a
  barge-in abandoned a transcription whose `endStt` never fired, pinning the orb in
  its listening throttle until restart. If you touch this, keep it leak-proof.
- An **adaptive pressure detector** engages relief when frames land far late, then
  probes for recovery. The **renderer crash circuit breaker** (`index.ts`,
  `render-process-gone`) reloads into a stepped-down GPU profile for a cooldown.
- Raising `RELIEF_BACKING` or removing the FPS cap risks reintroducing the crash on
  the target hardware, which is not validated under load. Change with care + a device.

## Audio pipeline

- **PCM has no framing.** UDS segments aren't 2-byte aligned; building an `Int16Array`
  over an odd-length buffer throws. The renderer carries the trailing odd byte into
  the next segment (`pcmCarryByte` in `app.js`). **A barge-in must reset it** — a
  stale carry byte prepended to the next reply misaligns every sample → pure noise.
- **Sidecar stdout is line-framed JSON that splits across read chunks.** The
  supervisor keeps a per-sidecar `stdoutBuf` until the newline (reset on respawn,
  size-capped). Emit whole JSON lines from Python.
- **Endpointing vs latency is a live tension.** `VadEndpointer` hang is ~850 ms:
  shorter clips users mid-pause ("it replied before I finished"); longer feels
  laggy. It's a calibration knob, not a constant to "optimize away."
- **Wake-word sensitivity vs false fires is the other tension.** Too sensitive → room
  noise/ARIA's own audio barge in and cut replies; too strict → misses. There's a
  barge-in score gate while speaking. Re-tune deliberately, both directions.
- **Whisper hallucinates on silence** ("Thank you.", "you"). Silent follow-up windows
  must **discard** the STT result, never submit it as a user turn.

## Renderer sandbox & UI

- The renderer is fully sandboxed (`sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`). New capabilities go through `preload` — see
  [ipc-contract.md](ipc-contract.md).
- **Never ship `--no-sandbox`.** It's dev/test only. Packaged builds must have a
  correctly-configured Chromium SUID sandbox (root:root, 4755).
- **`position: fixed` is trapped by `backdrop-filter`/`transform`/`filter`
  ancestors.** A dropdown inside the glass `.panel` (which has `overflow:hidden` AND
  `backdrop-filter`) gets clipped — its containing block becomes the panel, not the
  viewport. The fix pattern: re-parent the popup onto `<body>` and position it from
  the button's viewport rect. (This is exactly why the session ⋮ menu was "hidden
  away.")
- **rAF loops must be capped and gated.** Uncapped orb render + TTS-RMS loops once
  pegged the CPU. Loops are FPS-capped, background-throttled, and stop themselves when
  idle. Don't add an always-on `requestAnimationFrame`.

## LLM / coordinator

- Direct LLM is invoked with **zero tools** at the model level; anything needing
  live data/tools/actions is routed to the **agent harness** by `router.ts`
  pre-invocation. Don't give the direct LLM tools.
- **Never retry or fall back after reply text has already streamed** — a second stream
  concatenates onto the shown/spoken reply. `coordinator.ts` guards this with
  `sawFirstToken`.
- Both targets share **one conversation history**, so context survives an LLM↔harness
  handoff. History stores assistant *text* only (not replayed tool calls).
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
