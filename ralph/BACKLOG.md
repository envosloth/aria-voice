# ARIA Ralph Loop — BACKLOG (append-only; newest first)

Unrelated findings logged during iterations (one subsystem per iteration — §7.5).
Pull from here by priority order (§3) when picking the next item.

## Open
- **[P-TTFA, MED] TTS comma-less single-sentence floor + variance (kokoro)** (partially addressed iter 3). Iter 3 clause-splits the FIRST sentence for fast first-audio on clause-leading replies (-350 to -490ms), but a comma-less single sentence still pays kokoro's full ~600-800ms synth for the first chunk, with run-to-run jitter (~540-825ms). This is the residual e2e LOCAL-budget flakiness (the e2e reply's first sentence is comma-less). Lower-yield/higher-risk options left: (a) split a long comma-less first sentence at a WORD boundary for first-audio — needs audio QA (can't verify prosody by ear in this env); (b) a faster/quantized TTS engine or ONNX thread tuning — kokoro_onnx exposes no SessionOptions hook, would need a fork/monkeypatch; (c) Piper (memory `aria-tts-verified`: ~34-82ms first-chunk) is far faster but more robotic — could be an opt-in "low-latency" voice mode. Measure + audio-QA before acting.
- Whisper flash-attn (`-fa`) is BROKEN on the RX 9060 XT RADV Vulkan driver (garbage output, erratic timing) — do NOT enable. Revisit only if the driver/whisper.cpp updates. (found iter 2)
- e2e LOCAL-budget test is a SINGLE-sample measurement near a tight threshold (1300ms kokoro) → flaky when TTS jitters. Consider making the e2e TTS measurement report median-of-N (without loosening the threshold) so it reflects steady-state, OR using a representative multi-clause reply. NOT done — avoided changing the benchmark to "make it pass" this run. (noted iter 3)

## Resolved
- ~~STT cold-start latency ~953ms~~ → RESOLVED iter 2: was not cold-start but model-size-bound encode (`small` ~810ms warm on Vulkan). Switched default to base.en → ~370ms warm / 502ms e2e (−451ms). Equivalent accuracy on common English commands.

## Notes / candidates to investigate (not yet evidence-backed)
- TTS first-chunk latency: `tts_first_request` trails first LLM token by ~138ms (waiting for first speakable clause to accumulate). Possible lever for TTFA if clause-boundary detection can fire earlier on short first sentences. Measure before touching.
- Real-provider latency baseline never captured live (no provider available in dev env). If a provider becomes available, capture a true end-to-end voice round-trip baseline (`ARIA_PERF=1 npm run start`).

## Resolved
- (none yet)
