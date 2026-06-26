# ARIA Ralph Loop — BACKLOG (append-only; newest first)

Unrelated findings logged during iterations (one subsystem per iteration — §7.5).
Pull from here by priority order (§3) when picking the next item.

## Open
- **[P-TTFA, HIGH] STT cold-start latency ~953ms** (found iter 1). `smoke:e2e` LOCAL budget (STT+TTS-1st) is OVER (1500–1795ms vs 1300ms kokoro budget). STT alone is ~953ms consistently; memory `aria-e2e-and-warm-stt` recorded a *warm* whisper-server STT of ~251ms, so the e2e run is hitting a COLD/per-call whisper path, not the persistent warm server. This is the single biggest voice-latency lever right now (mission metric = speech-end→first audio ≤500ms). Investigate: is the e2e harness starting whisper-server warm? Is the sidecar re-loading the model per utterance? Is GPU/Vulkan init on the hot path? Measure STT stage breakdown (model load vs encode vs decode) before optimizing. NOTE: e2e failure is environmental/pre-existing — NOT caused by the iter-1 routing fix (e2e imports only streamChat+Supervisor, both untouched).
- TTS first chunk varies 549–841ms (kokoro) in e2e — secondary to STT but also above the ~34–82ms first-chunk in memory `aria-tts-verified` (that was Piper/CPU persistent). Check whether kokoro first-chunk warmth matches.

## Notes / candidates to investigate (not yet evidence-backed)
- TTS first-chunk latency: `tts_first_request` trails first LLM token by ~138ms (waiting for first speakable clause to accumulate). Possible lever for TTFA if clause-boundary detection can fire earlier on short first sentences. Measure before touching.
- Real-provider latency baseline never captured live (no provider available in dev env). If a provider becomes available, capture a true end-to-end voice round-trip baseline (`ARIA_PERF=1 npm run start`).

## Resolved
- (none yet)
