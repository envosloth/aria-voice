# ARIA Ralph Loop — STATE

> Migrated 2026-06-26 from `RALPH_PROGRESS.md` + `RALPH_TASK.md` (repo root).
> Those files are now historical; this file is canonical going forward.

## Current Status (overwrite each iteration)
Run #: 6 | Status: local, uncommitted audit repairs on v3.0.6: turn/session/mic isolation, TTS provisioning, SSE/model-discovery correctness, Electron 42.11.8, single-writer release publication | Verified?: build/lint/typecheck/audit/boot and focused regressions passed; smoke:all reached final latency test (916 ms versus <900 ms), standalone rerun passed at 870 ms. Package-directory build passed with missing staged Whisper warning; no installer or release claim. Evidence and limitations: `AUDIT-2026-09-28.md`.
Architecture invariant: routing decides delegation before invocation; the direct conversational LLM receives no tools or handoff sentinel.
Current limitation: this Fedora checkout still lacks system `cmake`/`glslc` for the canonical Vulkan build script. A locally built whisper.cpp CPU fallback is installed and selected by the live power-saver preset; release packaging on the target Vulkan build hosts remains the ship gate.
Next target: install/smoke the published packages on representative Linux, Windows, and macOS hosts.

## Current artifacts (v3.0.5 — released 2026-07-12)
- Published release: https://github.com/envosloth/aria-voice/releases/tag/v3.0.5
- GitHub Actions run `29209525011` passed all four native builds plus macOS metadata finalization.
- One canonical release contains 17 uploaded assets: Linux AppImage/deb/rpm, Windows installer/portable executable, Intel and arm64 macOS dmg/zip packages, blockmaps, and updater metadata.

## Pre-loop baseline (from Item 0 harness, prior loop)
- App-side pre-network overhead: ~3ms, TTFT-independent (user_input → llm_request).
- User-visible time-to-first-text = provider TTFT + ~3ms (53ms @ 40ms TTFT mock / 361ms @ 350ms TTFT mock).
- streamChat client overhead over raw provider TTFT: ~1-4ms.
- tts_first_request trails first token by ~138ms (waiting for first speakable clause).
- Keep-alive/TLS reuse already works (0 new conns / 5 turns). Not a lever.
- `Accept: text/event-stream` header already added (fixes buffering proxies, item5).
Harness commands: `npm run perf:baseline`, `npm run perf:live [ttftMs]`, `npm run perf:llm-path`.

## Build / test commands (confirmed 2026-07-12)
- Build: `npm run build` (tsc + preload + copy renderer)
- Static gates: `npm run lint`; `npm run typecheck`; `npm audit --audit-level=high`; `git diff --check`
- Full suite: `npm run smoke:all` (native Whisper/model/tooling required)
- Focused hardening gates: `smoke:core-security`, `smoke:routing-invariant`, `smoke:release-packaging`, plus `scripts/smoke-{voice,supervisor,mic,update}-*.js` and `scripts/smoke-sidecar-lifecycle.py`
- Boot: `npm run smoke:boot`; package: `npm run dist`; config/package-dir validation: `npx electron-builder --linux dir --config electron-builder.yml`

## Backlog
→ ./ralph/BACKLOG.md

## History (append-only, newest first)

### Application-Open Voice Runtime — 2026-07-18
Provisioned isolated development venvs for STT, TTS, and wake word, installed a local whisper.cpp CPU fallback, and repaired openWakeWord 0.6 compatibility. The wake sidecar now supports the uppercase `MODELS` registry, selects ONNX paths and ONNX Runtime explicitly (avoiding the NumPy 2/TFLite ABI failure), declares `tqdm`, and pins the supported openWakeWord API range. The model installer now downloads the required feature, VAD, and Hey Jarvis ONNX assets from a pinned release with SHA-256 verification. The STT fixture falls back to ARIA's downloaded British Piper voice instead of requiring an obsolete US-only fixture.

Verification: all three sidecars reached initialized/ready simultaneously and accepted control messages with zero orphans. Piper emitted 236,544 PCM bytes for a 5.36-second utterance and passed speed control. Whisper transcribed generated speech as “testing 1 2 3 4 5” with all five expected numbers. The Hey Jarvis model scored a generated wake utterance at 0.9967 against the production 0.4 threshold. A live Electron app remained open with wake word, Piper TTS, Tiny English STT, and the whisper server all alive; its STT command included `--no-gpu` under the power-saver preset. Build, lint, typecheck, orb/routing/release-packaging smokes, model checksum verification, Python/shell self-tests, audit (zero vulnerabilities), and `git diff --check` passed.

### State-Controlled Particle Orb — 2026-07-18
Reworked the uncommitted looping-GIF replacement so its motion follows the conversation lifecycle. The supplied 600×600/450-frame GIF remains the repository source reference; a 520×520, 24 fps transparent WebM derived from the same frames provides seek/pause control, with a transparent compact PNG poster for startup. Idle/listening remain paused and consolidated once any required post-turn return finishes; a direct speaking/processing→listening transition briefly completes that requested return instead of snapping the particles together. Processing alone plays the expansion and loops the dispersed ripple segment. Speaking holds the reached particle shape while the existing TTS RMS analyser drives scale, brightness, and glow. Leaving processing/speaking plays the GIF's return segment and ends paused at the compact first frame. A new processing turn submitted during speech finishes that return before beginning the thinking expansion, rather than seeking directly from the held speaking shape to frame zero. The WebM carries packet keyframes at 0, 2.75, and 6.0 seconds so the controlled loop and return seeks do not decode from distant frames. Runtime packaging copies only the WebM and poster, keeping the 5.9 MB source GIF out of installers.

Vulkan STT compute now pauses decode as well as hiding the media element, retains the 6-second/next-listen recovery, and resumes the correct phase. Real Electron/CDP verification exposed a Chromium race in which an intentional `pause()` rejected a pending `video.play()` promise and incorrectly collapsed the phase; playback requests are now generation-tagged, with a focused regression reproducing that race. The renderer retains no canvas, custom rAF, interval loop, autoplay, uncontrolled media loop, or obsolete canvas-FPS diagnostics.

Independent-review follow-up corrected a stale `collaboration/gotchas.md` routing section that contradicted the executable router-time dispatch invariant. `smoke:routing-invariant` now also checks the canonical documentation, preventing the obsolete direct-LLM tool/sentinel description from returning. Obsolete Ctrl+Shift+F and placeholder video benchmark hooks were removed; `ARIA_FPS` now reports Chromium video decode/drop metrics, and orb smoke screenshots seek the native video without calling deleted adapter methods. The ops-panel comments now describe the in-panel video.

Verification: the focused orb smoke was written red first and now passes the state/phase, live-level, speaking/processing→listening consolidation, speaking→processing return-before-thinking transition, duplicate-listening tail preservation, compact completion, diagnostic API compatibility, alpha/duration metadata, packaging, and compute-race contracts. `npm run build`, `npm run lint`, `npm run typecheck`, `npm audit --audit-level=high`, `smoke:boot`, `smoke:routing-invariant`, `smoke:release-packaging`, `smoke:ui-stability`, `smoke:ux`, `smoke:status-dots`, runtime-asset byte comparisons, packet-keyframe inspection, and `git diff --check` pass. An isolated real Electron renderer loaded the transparent 520×520 video with no console errors and proved idle=paused/compact, processing=playing/expanded, speaking=paused with live 1.106×1.082 transform and 1.596 brightness at 0.86 level, consolidation=playing from 6 seconds, final compact=paused at 0, and Vulkan compute=hidden/paused then resumed. Visual screenshots showed no rectangle or clipping. `smoke:all` was attempted and stopped at the pre-existing host dependency/tooling block (`numpy`/`openwakeword`, Piper, and whisper.cpp missing); cleanup found zero orphans.

### Animated Orb Refresh — 2026-07-18
Replaced the Glass Observatory 2D canvas renderer with the user-supplied 600×600, 450-frame looping dotted-sphere animation. The repository asset is transparently encoded so it sits directly on the glass panel rather than inside a black rectangle. The lightweight `AriaOrb` adapter preserves the existing idle/listening/processing/speaking, TTS-level, quality, and STT lifecycle calls without scheduling a custom graphics loop alongside Vulkan STT. During Vulkan transcription it removes the GIF from layout, restoring it on the result path, the next listen, or a 6-second failsafe. Renderer copying now includes `assets/`; the focused smoke checks asset packaging, real transparency, state feedback, adapter behavior, Vulkan-compute quiesce/recovery, and no canvas loop.

Verification: `npm run build`, `npm run lint`, `npm run typecheck`, `npm audit --audit-level=high`, `npm run smoke:orb`, and `git diff --check` pass. The focused smoke and a deterministic 6.1-second Node regression prove the Vulkan-compute failsafe restores the GIF. A built Electron renderer launched with an isolated user-data directory was inspected over CDP: it loaded the 600×600 GIF, moved it to `display:none` during a real compute-freeze call, restored it afterward, reached `speaking`, exposed the pulse animation, and visibly had no black background rectangle. A fresh independent review found no security concerns or logic errors. The host is still missing the wakeword Python dependencies, so full native audio lifecycle coverage remains blocked as recorded above.

### v3.0.5 Release — 2026-07-12
Bumped package and lock metadata from v3.0.4 to v3.0.5 for the reviewed reliability/security hardening in commits `1da6e71` and `9f2c5cf`. Native GitHub Actions builds passed on Linux, Windows, macOS arm64, and macOS x64. A parallel-publisher race initially created two releases for the same tag; their verified-size assets were consolidated into release `352848294`, the duplicate was removed, and the final public release was verified as one release with 17 uploaded assets.

### Run 2 Independent-review follow-up — 2026-07-12
Closed the final review findings after commit `1da6e71`: whisper.cpp now builds in a private `mktemp` directory created by the current invocation and rejects caller-selected cleanup paths; update installation now claims a dedicated single-flight slot before download or quiescing and releases it on every retryable failure path. Added regressions for `/usr`, `/etc`, `/opt`, `/var`, concurrent update attempts, and retry after failure. Build, lint, typecheck, audit, updater/update-quiesce, release-packaging, boot, shell syntax, and diff checks pass.

### Run 2 Reliability and Security Hardening — 2026-07-12
Corrected router/direct-LLM boundaries, concurrent turn correlation, settle-once and bounded HTTP/SSE handling, credential transport policy, model-download integrity, pinned-session retention, and secure-storage behavior. Reworked STT/TTS/microphone/VAD/orb and supervisor lifecycle handling, including correlated completion/failure events, cross-channel PCM framing, nonblocking STT readiness, restart cancellation, isolated Python environments, single-owner PCM sockets, and private per-user/per-process socket directories. Hardened unsigned updater behavior, moved `.deb` verification/installation into root-owned staging with dependency resolution, made failed update quiescing reversible, pinned and startup-verified model revisions/checksums, upgraded electron-builder to 26.15.3, removed generated machine-specific PyInstaller specs, and strengthened release gates.

Verification: build, lint, typecheck, npm audit (0 vulnerabilities), shell/Python syntax, boot smoke, routing invariant, LLM/network/model/session/security, hardware/updater/UI/audio, release/package, voice/mic/supervisor/update lifecycle, Python sidecar lifecycle, Piper TTS, and STT turn-control gates passed. electron-builder 26.15.3 produced `dist-installers/linux-unpacked`. `npm run smoke:all` was attempted and stopped at STT startup because this host lacks `cmake`, `glslc`, and whisper.cpp executables; sidecar cleanup found zero orphans. No release artifacts were claimed.

### Run 1 Ship Gate (§13) — 2026-06-26
Stopped after iter 3: priority items cleared (KNOWN ISSUE routing fix + top two TTFA bottlenecks STT/TTS), remaining backlog items lower-yield/higher-risk or blocked on unavailable resources (live provider, audio QA). Not a plateau-by-failure — all 3 iters were measurable wins; stopped per §12 "all priority items clear → proceed to §13".
1. Full regression suite: `npm run smoke:all` PASS — 10/10 green (lifecycle, tts, stt, resilience, pdeathsig, memory, llm, router, models, audio, e2e). NOTE: smoke:e2e is jitter-sensitive at the kokoro LOCAL budget (1300ms); it passed this run and passes most runs post-STT-fix, but can flake on a TTS first-chunk spike — functional pipeline (transcription+reply+audio) is correct every run; only the latency-budget assertion is jittery. Logged in BACKLOG.
2. Production build: `npm run dist` (version bumped 2.0.0→2.0.1) → electron-builder produced ARIA-2.0.1-x86_64.AppImage + aria_2.0.1_amd64.deb in dist-installers/. Sidecars re-frozen via PyInstaller (stt/tts/wakeword) with the iter-2/3 changes; whisper staged.
3. Packaged smoke-test: (a) FROZEN sidecars (ARIA_SIDECAR_DIR=build/sidecars) — smoke:e2e PASS (STT 403ms confirms base.en is in the frozen binary; full STT→routing→TTS round-trip), smoke:tts PASS (clause-split). (b) AppImage headless boot (APPIMAGE_EXTRACT_AND_RUN=1 ARIA_SMOKE=1) — exit 0, `app ready, window+tray+supervisor initialized`, wakeword `initialized`+`ready` (hey_jarvis model), `[ARIA_SMOKE] OK`, NO genuine startup errors (only documented benign CUDA/dbus/jarvis-fallback warnings).
4. No P1 packaged-build failures.
Net run result: routing invariant restored (correctness); voice critical path materially faster — STT −451ms (953→502, frozen 403ms) and first-audio −350..490ms on clause-leading replies; v2.0.1 installers verified.

### Iter 3 — 2026-06-26
Bottleneck: TTS first-chunk latency (kokoro). Measured (§4): kokoro synth is ~0.26x realtime, scales linearly with text length; the first audio chunk waits for the ENTIRE first sentence (~600ms warm for a 7-word sentence, spiking to ~825ms under load). Ruled out: cold-start (3 consecutive ~825ms; warmup already exists via _warmup_kokoro "Ready."), idle-threadpool-spindown (idle gap gave 592-797ms, no clean correlation — it's inherent CPU jitter), ONNX thread tuning (kokoro_onnx creates InferenceSession with default threads, no clean hook). Only lever: emit a shorter first unit.
Change: `sidecars/tts/main.py` — new `_chunks_for()` splits the FIRST sentence at its first clause boundary (comma/semicolon/colon/dash — natural pauses kokoro already renders as pauses, so prosody-safe), only when the first sentence is ≥20 chars and both head (≥4) and tail (≥6) are substantial. Only the first sentence is split (into ≤2 parts); the rest stay whole for smooth prosody + to avoid create() overhead on fragments.
Before/After (measured through the real sidecar, time-to-first-tts_chunk): "Sure, it is currently sunny in Austin today." 845→358ms (-487ms); "According to the latest forecast, ..." 992→643ms (-349ms); "Well, ..." ~690→~296ms (-394ms). Comma-less sentences UNCHANGED: "I heard you say the test numbers." stays 1 chunk (zero regression).
Gate: pass. smoke:tts PASS (byte-accounting exact, 3 chunks — short opener "Hello from ARIA." <20 chars stays whole), smoke:e2e PASS this run (comma-less reply unaffected; STT 401ms + TTS 763ms = 1164 < 1300), smoke:routing-invariant PASS. No build needed (Python sidecar).
Honest scope note: this improves real-world TTFA for clause-leading replies (very common: "Sure,", "Well,", "According to ...,") but does NOT change the comma-less e2e benchmark sentence, so it does not resolve the e2e budget flakiness (that's kokoro's inherent single-sentence floor + jitter, logged in BACKLOG). It targets the mission metric (speech→first audio), not the benchmark.
Outcome: kept. Commit: e5f0b2a.

### Iter 2 — 2026-06-26
Bottleneck: STT latency. e2e LOCAL budget OVER; measured the STT sidecar (whisper-server, Vulkan, RX 9060 XT) at ~810ms warm inference for a short utterance (953ms in e2e incl. 100ms flush + overhead). Verified it is NOT cold-start (3 consecutive transcribes all ~825ms) and NOT CPU fallback (Vulkan0 backend confirmed in server log). Whisper encodes a fixed 30s window, so cost is model-size-bound.
Change: `DEFAULT_STT_MODEL` small→base.en (`src/shared/constants.ts`) + sidecar standalone fallback small→base.en (`sidecars/stt/main.py`). Updated STT_MODELS descriptions (moved "(default)" label).
Investigation that ruled out alternatives (measured, §4): flash-attn (`-fa`) is BROKEN on this RADV Vulkan driver (garbage transcripts + erratic 0.3–5.8s timing) — not a lever; threads (`-t 8/16`) and best-of (`-bo 1`) make ZERO difference (0.81s flat) — encode is GPU-bound, not decode-bound. Only model size moves it.
Accuracy (measured both, §4): base.en vs small on 5 hard phrases (numbers, %, "Dr. Alvarez", "Kubernetes", "authentication service", timers/reminders) = 4/5 identical; base.en differs only on the rare foreign proper noun "Reykjavik"→"Rick de Vec". Equivalent for common English commands; small/medium remain opt-in via Settings for accuracy-sensitive users.
Before: STT 953ms (e2e) / ~810ms warm inference. After: STT 502ms (e2e) / ~370ms warm inference. −451ms on the voice critical path.
Gate: pass (no regression introduced). smoke:stt PASS (base.en transcribes correctly through the sidecar), smoke:models PASS (uses 'small' explicitly, unaffected), smoke:routing-invariant 6/6, build clean. e2e: STT now stable 502–503ms across 4 runs; LOCAL budget is now TTS-bound and flaky (2 PASS / 2 FAIL) entirely due to TTS first-chunk variance (539–831ms) — a separate subsystem, escalated to iter 3 (my STT change took e2e from ALWAYS-fail to passes-when-TTS-normal; strictly an improvement, not a regression).
Outcome: kept. Commit: 375949c.

### Iter 1 — 2026-06-26
Bottleneck: routing-invariant violation — v2.0.0's `delegate_to_agent` tool was offered to the DIRECT conversational LLM (reproduced: `smoke:delegate` showed `llm requests: [{hasTools:true}]`, model invoked the tool). Violates §2 (direct LLM must have zero tools at the model level; routing decision must be pre-invocation, not a tool the model calls mid-reply).
Change: removed `DELEGATE_TOOL`, `DELEGATE_SYSTEM_HINT`, `isToolsUnsupportedError`, `runHarnessForTask`, the `onToolCalls` delegation handler, and the `withTools`/`offerTools`/`tools` plumbing from `coordinator.ts`. The direct LLM is now invoked with NO tools; tool-requiring requests are routed to the harness up front by `router.ts` (already does this — AGENTIC/REALTIME/ACTION → harness), and the harness runs tools server-side and weaves the result into its own reply (user-facing outcome preserved). Repurposed the regression gate: `smoke-delegate.js` → `smoke-routing-invariant.js` (+ `ARIA_VERIFY_DELEGATE` hook → `ARIA_VERIFY_ROUTING`, now honors a routing-mode env). Left `llm-stream.ts` generic tool plumbing intact (general OpenAI-client capability, no longer offered to the direct LLM — not a violation).
Before: direct LLM sent `tools:[delegate_to_agent]`, model called it (invariant broken). After: direct LLM sent zero tools in both auto and llm modes; tool-requiring prompt routes to harness up front.
Gate: pass — `smoke:routing-invariant` 6/6 (A: tool-prompt routes to harness, direct LLM not called; B: forced direct LLM gets NO tools array, never delegates, still answers). `smoke:router` (45/45), `smoke:llm` (5/5), `smoke:local-llm`, `smoke:boot` all PASS. Full `smoke:all`: 9/10 — only `smoke:e2e` fails, on the LOCAL STT+TTS latency budget (STT ~953ms cold), which is environmental and in code (`streamChat`/`Supervisor`) this change does NOT touch (verified: llm-stream.ts + supervisor.ts unmodified; same failure on the LLM-segment-healthy run). Logged to BACKLOG.
Outcome: kept. Commit: 9cb27af. Correctness fix (NOT a revert of v2.0.0 delegation feature — the outcome is preserved, only the mechanism moved to routing).

### Migration — 2026-06-26
Prior loop ("Fix Settings, Setup, and Chat UX Issues", Items 0–8) is COMPLETE: all 8 items done + verified, shipped as v2.0.0 (commit a585a5e). Summary of what shipped:
- Item 0: latency harness (`src/main/perf.ts`, `src/renderer/perf.js`, `perf:baseline/live/llm-path`). Baseline above. OFF by default (`ARIA_PERF=1`).
- Item 1: live Settings apply (tts.voice/stt.model/stt.backend now hot-reload sidecars, debounced 300ms).
- Item 2: onboarding step for direct LLM provider (+ test connection).
- Item 3: local LLM presets (Ollama/LM Studio/vLLM) + base-URL normalization (bare host / …/v1 / full path all work).
- Item 4: removed default File/View/Window menu (Edit-only, hidden bar, accelerators kept).
- Item 5: `Accept: text/event-stream` header → fixes buffering-proxy TTFT (~300ms earlier first token on such proxies).
- Item 6: hover-only message timestamps (data-time + ::after, out of textContent).
- Item 7: screen-share first-message duplication — verified already fixed; added permanent regression guard.
- Item 8: `delegate_to_agent` tool for direct LLM — ⚠️ THIS IS THE v2.0.0 ROUTING-INVARIANT VIOLATION the new loop must fix (iter 1).
