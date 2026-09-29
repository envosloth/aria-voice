# ARIA Feature Roadmap (set by Envo, 2026-09-29)

Priority order is binding. Each phase ships behind its measurable gate before the next starts
(one subsystem per Ralph iteration). Baselines are from the v3.1.0 tree.

## P0 — Highest priority

### 1. Low-latency voice (feature 1)
- Baseline: warm whisper-server per utterance (base.en ~370 ms warm), energy VAD 850 ms hang,
  sentence/clause-chunked Piper/Kokoro, barge-in exists; e2e ~870–916 ms CPU-only.
- Build: streaming partial STT (rolling-window whisper with early-commit), Silero VAD endpointing
  with semantic end-of-turn (shorter hang when the utterance is syntactically complete),
  speculative LLM start on stable partials, word-boundary first-audio split, full-duplex
  echo-cancelled barge-in (interrupt on speech, not on noise), opt-in Piper "fast voice".
- Gate: median end-of-speech → first audio < 500 ms local (Vulkan host), < 800 ms CPU-only;
  false barge-in < 1 per 10 min of TTS playback.

### 2. Memory (feature 2)
- Baseline: session history only; no durable user memory.
- Build: local encrypted store (`memory-store.ts`) of typed facts {preference, project, routine,
  person}, explicit "remember/forget" local intents, post-turn extraction by the small model,
  retrieval injected into both targets, and a Memory panel to view/edit/delete/export.
- Gate: recall ≥ 90 % on a labeled 50-fact set; every stored item visible and deletable in UI;
  nothing persisted without source turn + timestamp.

### 3. Context + screen awareness (features 3, 4)
- Baseline: manual screen-share frame (desktopCapturer) forces the harness; clipboard write only.
- Build: opt-in context provider in main — active app/window title, selected text (primary
  selection on Linux), clipboard read on demand, dropped files, current browser tab via
  extension/CDP; "look at this" one-shot capture with region select; camera frame on request.
  Per-source toggles and a visible "Aria can see:" indicator.
- Gate: context attached only when referenced ("this", "here", "my screen") or explicitly
  granted; zero capture while indicator is off.

### 4. Computer control + Action preview/Undo (features 5, 6)
- Baseline: delegated wholesale to the Hermes harness; no preview or rollback in ARIA.
- Build: typed action layer (open app, file ops, install, shell, settings) with risk tiers;
  medium/high risk actions render a preview card ("Will move 12 files to ~/Archive") needing
  voice or click confirmation; journaled file ops (trash, not rm; snapshot before overwrite)
  with "undo that".
- Gate: every destructive action is previewed and reversible or explicitly marked irreversible.

### 5. JEV model routing (features 9, 10)
- Baseline: JEV picks `llm | harness` only; `local-intents.ts` answers time/timers locally.
- Build: widen `Target` to `local | small | large | harness` (+ vision); JEV returns tier +
  confidence; local small model (llama.cpp on Strix Halo) handles chit-chat, memory ops,
  summarizing context; escalate on low confidence or tool need; per-tier cost/latency telemetry.
- Gate: routing benchmark accuracy ≥ current bars; ≥ 50 % of turns served locally with no
  quality regression on the labeled set; fallback chain still never blocks a turn.

## P1 — After P0 gates pass
- 7. Integrations (Gmail, Calendar, Spotify, Discord, GitHub, smart home) — via Hermes skills/MCP
  first, native only where latency demands it.
- 11. Background tasks — detached harness jobs with a task tray, spoken completion notice.

## P2
- 8. Custom skills SDK — manifest + sandboxed action schema reusing the action layer's risk tiers.
- 12. Proactive assistance — opt-in watchers (events, deliveries, prices, crashes), quiet hours,
  one-tap mute per source.

## Sequencing rationale
Latency first because every other feature adds per-turn cost; memory and context next because
they feed routing; the action layer must exist before broad computer control or an SDK can
be safe; routing tiers land once there are enough local-capable turn types to route.
