# ARIA Ralph Loop — STATE

> Migrated 2026-06-26 from `RALPH_PROGRESS.md` + `RALPH_TASK.md` (repo root).
> Those files are now historical; this file is canonical going forward.

## Current Status (overwrite each iteration)
Run #: 1 | Iteration #: 3 | Last benchmark: TTS first-chunk -350 to -490ms on clause-leading replies | Last change: split first sentence at first clause boundary | Verified?: yes
Biggest bottleneck: TTS first-chunk floor for COMMA-LESS single sentences (~600-800ms kokoro, inherent) + run-to-run variance; the clause-split cannot shorten a comma-less opener
Next target: PLATEAU CHECK — remaining local-latency levers are higher-risk/lower-yield. Lean toward stopping (§12) and running the §13 ship gate. Candidates left: real-provider latency baseline (needs a live provider); TTS engine/quant alternatives (need audio QA, can't verify by ear here).

## Pre-loop baseline (from Item 0 harness, prior loop)
- App-side pre-network overhead: ~3ms, TTFT-independent (user_input → llm_request).
- User-visible time-to-first-text = provider TTFT + ~3ms (53ms @ 40ms TTFT mock / 361ms @ 350ms TTFT mock).
- streamChat client overhead over raw provider TTFT: ~1-4ms.
- tts_first_request trails first token by ~138ms (waiting for first speakable clause).
- Keep-alive/TLS reuse already works (0 new conns / 5 turns). Not a lever.
- `Accept: text/event-stream` header already added (fixes buffering proxies, item5).
Harness commands: `npm run perf:baseline`, `npm run perf:live [ttftMs]`, `npm run perf:llm-path`.

## Build / test commands (confirmed 2026-06-26)
- Build: `npm run build` (tsc + preload + copy renderer)
- Suite (10): `npm run smoke:all` = smoke + tts + stt + resilience + pdeathsig + memory + llm + router + models + audio + e2e
- Boot: `npm run smoke:boot` ; Package: `npm run dist`
- Extra gates: `smoke:router`, `smoke:delegate` (→ being repurposed as routing-invariant gate), `smoke:settings/onboarding/local-llm/menu/hover/screenshare`

## Backlog
→ ./ralph/BACKLOG.md

## History (append-only, newest first)

### Iter 3 — 2026-06-26
Bottleneck: TTS first-chunk latency (kokoro). Measured (§4): kokoro synth is ~0.26x realtime, scales linearly with text length; the first audio chunk waits for the ENTIRE first sentence (~600ms warm for a 7-word sentence, spiking to ~825ms under load). Ruled out: cold-start (3 consecutive ~825ms; warmup already exists via _warmup_kokoro "Ready."), idle-threadpool-spindown (idle gap gave 592-797ms, no clean correlation — it's inherent CPU jitter), ONNX thread tuning (kokoro_onnx creates InferenceSession with default threads, no clean hook). Only lever: emit a shorter first unit.
Change: `sidecars/tts/main.py` — new `_chunks_for()` splits the FIRST sentence at its first clause boundary (comma/semicolon/colon/dash — natural pauses kokoro already renders as pauses, so prosody-safe), only when the first sentence is ≥20 chars and both head (≥4) and tail (≥6) are substantial. Only the first sentence is split (into ≤2 parts); the rest stay whole for smooth prosody + to avoid create() overhead on fragments.
Before/After (measured through the real sidecar, time-to-first-tts_chunk): "Sure, it is currently sunny in Austin today." 845→358ms (-487ms); "According to the latest forecast, ..." 992→643ms (-349ms); "Well, ..." ~690→~296ms (-394ms). Comma-less sentences UNCHANGED: "I heard you say the test numbers." stays 1 chunk (zero regression).
Gate: pass. smoke:tts PASS (byte-accounting exact, 3 chunks — short opener "Hello from ARIA." <20 chars stays whole), smoke:e2e PASS this run (comma-less reply unaffected; STT 401ms + TTS 763ms = 1164 < 1300), smoke:routing-invariant PASS. No build needed (Python sidecar).
Honest scope note: this improves real-world TTFA for clause-leading replies (very common: "Sure,", "Well,", "According to ...,") but does NOT change the comma-less e2e benchmark sentence, so it does not resolve the e2e budget flakiness (that's kokoro's inherent single-sentence floor + jitter, logged in BACKLOG). It targets the mission metric (speech→first audio), not the benchmark.
Outcome: kept. Commit: <pending>.

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
