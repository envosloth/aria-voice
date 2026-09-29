# Voice latency optimization

## Result

On this Intel i5-7260U (2 cores / 4 threads), the measured improvement exceeds run-to-run noise in both forward and reverse A/B order. These are local synthetic-fixture measurements, not a live-cloud or human-microphone claim.

| First reply PCM metric | Baseline median | Optimized median | Reduction | Samples per policy |
| --- | ---: | ---: | ---: | ---: |
| Typed submission through the actual Electron renderer, local SSE, real Piper | 2,149 ms | 889 ms | 1,260 ms / 58.6% | 10 |
| STT request through real CPU Whisper, local SSE, real Piper | 4,128 ms | 2,426.5 ms | 1,701.5 ms / 41.2% | 6 |

The typed medians in the two individual pairs were 1,840 → 859 ms and 2,369 → 919 ms. Baseline order was first in one pair and last in the other. The whole-pipeline result also includes variable STT and synthesis load, so not all of that delta can be attributed to the chunker. The voice clock starts at the transcription request: it excludes microphone capture, VAD trailing silence, and physical speaker-output latency. The model service is a deterministic local SSE fixture, not the user's real provider.

Raw samples, transcripts, method, and exploratory inference results are committed in `scripts/latency-benchmark-results.json`. Both voice policies produced the same narrow synthetic transcript (including the unchanged "ARIA" → "area" recognition error) and the entire expected reply.

## Shipped source behavior

- Preserve existing early sentence, clause and phrase boundaries. If the first reply is still buffered after 250 ms from its first token, allow a cut after at least six complete words and 18 characters instead of waiting for the 90-character fallback.
- A single timer also releases a usable phrase during an SSE pause. If six complete words are not yet available, subsequent tokens use the elapsed budget; the timer does not manufacture an incomplete word.
- Keep open endings such as "and" or "the" for the following chunk. Later chunks keep the existing sentence/prosody rules.
- Cancel the timer on first speech, completion, cancellation, supersession and reset; preserve reply correlation and lossless text buffering.
- Settings' latency diagnostic uses the actual renderer chunk policy rather than a separate approximation.
- No runtime dependency, voice/model default, user setting, remote service, VAD threshold or speech-quality downgrade was introduced.

## Verification

Build, lint, type checking, diff hygiene and boot passed. All 62 members of `smoke:all` were exercised serially: 61 passed; only the existing CPU local STT+TTS latency gate failed, at a median 1,263 ms against its unchanged 900 ms target. Because the chained suite stops there, all eight later groups were run separately and passed; boot passed separately as well. This is not an all-green suite or installer claim.

Focused tests cover deadline boundaries, incomplete words, open endings, later chunks, stalled streams, cancellation, supersession, duplicate prevention, lossless subword replay, and diagnostic/playback parity. The actual renderer regression fails against the old app at the stalled-stream assertion and passes against the new app. A five-trial Electron/Piper benchmark is registered in `smoke:all`; it verifies first PCM, full reply text, and final completion of every queued speech request. The full voice diagnostic is opt-in:

```bash
npm run build
node scripts/smoke-streaming-latency.js --voice
```

A/B changed only the built renderer/app chunk-policy files to the pre-change HEAD versions, keeping the current shared diagnostic instrumentation, fixtures, warmed model, and isolated temporary profile. Built optimized files were restored on exit and the final build was repeated. Baseline's new first-audio budget assertion fails as expected; optimized passes in both orders. Audio was muted; no by-ear prosody or real microphone/speaker QA is claimed.

## Other measured candidates

CPU flash attention was slower on the clean speech set: 806.5 → 1,056.55 ms median; not adopted. Explicit ONNX threads helped the short Piper-only probe modestly but did not consistently improve Kokoro; STT threading also did not provide a clear win over its current default. These platform-sensitive tweaks were not shipped. The main measurable lever was unnecessary first-phrase buffering plus synthesizing too much opening text before returning any audio.

## Scope and remaining limits

The outstanding Windows decoder portability/failure-reporting work was committed separately, including its native release guard. No push, version bump, installer, release or modification of the user's persisted profile was performed. Local CPU recognition still prevents the universal 900 ms local-stage target; live-provider latency and human/noise recognition require separate measurements. Short fast replies that already reach a natural boundary before the deadline are unchanged.
