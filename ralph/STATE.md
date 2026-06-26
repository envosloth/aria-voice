# ARIA Ralph Loop — STATE

> Migrated 2026-06-26 from `RALPH_PROGRESS.md` + `RALPH_TASK.md` (repo root).
> Those files are now historical; this file is canonical going forward.

## Current Status (overwrite each iteration)
Run #: 1 | Iteration #: 1 | Last benchmark: routing-invariant gate 6/6 PASS | Last change: removed delegate_to_agent tool from direct LLM | Verified?: yes
Biggest bottleneck: STT cold-start latency ~953ms (e2e local budget OVER; warm baseline was ~251ms) — this is the top voice-latency lever now
Next target: investigate STT cold/slow path (whisper-server warmth, per-call vs persistent) — see BACKLOG

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

### Iter 1 — 2026-06-26
Bottleneck: routing-invariant violation — v2.0.0's `delegate_to_agent` tool was offered to the DIRECT conversational LLM (reproduced: `smoke:delegate` showed `llm requests: [{hasTools:true}]`, model invoked the tool). Violates §2 (direct LLM must have zero tools at the model level; routing decision must be pre-invocation, not a tool the model calls mid-reply).
Change: removed `DELEGATE_TOOL`, `DELEGATE_SYSTEM_HINT`, `isToolsUnsupportedError`, `runHarnessForTask`, the `onToolCalls` delegation handler, and the `withTools`/`offerTools`/`tools` plumbing from `coordinator.ts`. The direct LLM is now invoked with NO tools; tool-requiring requests are routed to the harness up front by `router.ts` (already does this — AGENTIC/REALTIME/ACTION → harness), and the harness runs tools server-side and weaves the result into its own reply (user-facing outcome preserved). Repurposed the regression gate: `smoke-delegate.js` → `smoke-routing-invariant.js` (+ `ARIA_VERIFY_DELEGATE` hook → `ARIA_VERIFY_ROUTING`, now honors a routing-mode env). Left `llm-stream.ts` generic tool plumbing intact (general OpenAI-client capability, no longer offered to the direct LLM — not a violation).
Before: direct LLM sent `tools:[delegate_to_agent]`, model called it (invariant broken). After: direct LLM sent zero tools in both auto and llm modes; tool-requiring prompt routes to harness up front.
Gate: pass — `smoke:routing-invariant` 6/6 (A: tool-prompt routes to harness, direct LLM not called; B: forced direct LLM gets NO tools array, never delegates, still answers). `smoke:router` (45/45), `smoke:llm` (5/5), `smoke:local-llm`, `smoke:boot` all PASS. Full `smoke:all`: 9/10 — only `smoke:e2e` fails, on the LOCAL STT+TTS latency budget (STT ~953ms cold), which is environmental and in code (`streamChat`/`Supervisor`) this change does NOT touch (verified: llm-stream.ts + supervisor.ts unmodified; same failure on the LLM-segment-healthy run). Logged to BACKLOG.
Outcome: kept. Commit: <pending>. Correctness fix (NOT a revert of v2.0.0 delegation feature — the outcome is preserved, only the mechanism moved to routing).

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
