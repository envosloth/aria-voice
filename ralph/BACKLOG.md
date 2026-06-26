# ARIA Ralph Loop — BACKLOG (append-only; newest first)

Unrelated findings logged during iterations (one subsystem per iteration — §7.5).
Pull from here by priority order (§3) when picking the next item.

## Open
- **[P-TTFA, HIGH] TTS first-chunk latency + variance (kokoro)** (escalated iter 2 → now the dominant local-latency factor). e2e TTS first chunk swings 539–831ms (bimodal: ~540–625ms normal vs ~825ms spike), tipping LOCAL over the 1300ms kokoro budget ~half the time. Memory `aria-tts-verified` recorded ~34–82ms first-chunk for Piper/CPU persistent — kokoro is much slower to first audio. Investigate: is the e2e measuring a COLD first synthesis (warm-up cost, like STT wasn't)? Does kokoro prewarm at sidecar init? Is there a sentence-chunk boundary delay? Measure first-synthesis vs warm-synthesis. Target: reliable e2e green + lower TTFA. (config has `stt.prewarm:true` — is there a TTS equivalent?)
- Whisper flash-attn (`-fa`) is BROKEN on the RX 9060 XT RADV Vulkan driver (garbage output, erratic timing) — do NOT enable. Revisit only if the driver/whisper.cpp updates. (found iter 2)

## Resolved
- ~~STT cold-start latency ~953ms~~ → RESOLVED iter 2: was not cold-start but model-size-bound encode (`small` ~810ms warm on Vulkan). Switched default to base.en → ~370ms warm / 502ms e2e (−451ms). Equivalent accuracy on common English commands.

## Notes / candidates to investigate (not yet evidence-backed)
- TTS first-chunk latency: `tts_first_request` trails first LLM token by ~138ms (waiting for first speakable clause to accumulate). Possible lever for TTFA if clause-boundary detection can fire earlier on short first sentences. Measure before touching.
- Real-provider latency baseline never captured live (no provider available in dev env). If a provider becomes available, capture a true end-to-end voice round-trip baseline (`ARIA_PERF=1 npm run start`).

## Resolved
- (none yet)
