# Cloud speech follow-up evidence

## Delivered scope
- Canonical header logo clipped to 7px rounded corners; removed the top `ARIA can read` banner. Consent switches in Settings and per-reply context chips remain.
- STT providers: local whisper.cpp (default unchanged), retained Groq, new Deepgram Nova-3 and AssemblyAI Universal-3.5 Pro finalized-utterance REST adapters. No speculative cloud uploads. Warm local fallback remains.
- Cloud TTS: ElevenLabs Flash v2.5, Cartesia Sonic-3.6, OpenAI gpt-4o-mini-tts, Deepgram Aura-2. Provider model/voice IDs editable, stored independently; local voice unchanged when selecting cloud.
- Separate secure-store aliases, selected-child-only credential injection, inherited cloud-env stripping, new values reread on restart. Existing Groq alias retained. Blank fields preserve credentials; changing provider clears the field.
- Cloud TTS streams raw mono s16le PCM at 24kHz with existing byte/epoch metadata; stop cancels blocked network reads and drops stale audio. No cross-provider retries/fallback or background capture.

## Verification performed by parent
- Build, lint, typecheck and diff checks passed; final boot passed.
- Final isolated visible Electron UI: 45 checks passed, including rounded logo, banner absence with context enabled, key isolation/persistence/masking, local-voice preservation, and CSS computed visibility. Screenshots inspected at 820/1280 widths; a label CSS rule initially overrode `hidden`, now fixed and covered by computed-style assertions.
- Actual Supervisor/fake-child environment tests: 15 checks passed. Actual desktop context: 13 checks passed; consent switches and chips still work.
- Cloud STT tests: 21/21 passed with ARIA_SMOKE_REAL_STT=1, including actual HTTP failures followed by real warm whisper.cpp for both providers (`Testing 1 2 3 4 5`). Default fixture run skips that one opt-in test.
- Cloud TTS: 18 tests passed using real loopback HTTP plus socket PCM delivery; auth/body/format/deadline/cancellation/error paths exercised for all four providers.
- All 57 declared smoke groups exercised, resuming the persisted runner after terminal timeouts. Initial audit: 54 passed, STT/Vulkan, UX source-order assertion and E2E failed. UX was an obsolete adjacency assertion fixed to test load order; isolated UX then passed. Isolated STT passed on CPU and Vulkan (831/826ms); the transient Vulkan failure is retained in the original log. E2E remains failed at 1090ms versus unchanged 900ms gate. Initial results/logs: $TMPDIR/aria-cloud-final-gates/; focused reruns are tool-backed but not substituted into that historical audit.
- Actual STT and TTS PyInstaller bundles built at build/sidecars/{stt,tts}; six frozen startup probes passed (four TTS providers ready + stop acknowledgement, both STT providers ready). No cloud request during frozen startup. Packaging repaired to invoke pip/PyInstaller through the venv interpreter rather than stale copied entrypoint shebangs; regression added.

## Service boundary and limits
No live cloud account calls or human microphone conversation performed; real quota, entitlement, voice availability, latency and accuracy remain unverified. Keys must be entered in masked application Settings, never chat. Local defaults and saved profile were not switched to cloud.

Deepgram/AssemblyAI have a 5-second total cloud deadline, 10MiB audio and 1MiB response bounds. AssemblyAI is asynchronous batch mode: queued work may time out locally yet finish remotely and be billed; this is explicitly disclosed in Settings. Explicit vocabulary applies to local fallback, not these two adapters. Groq retains its earlier socket-timeout limitations.

TTS has 8MiB/request audio, 45-second deadline and 10-second idle timeout; OS DNS may stall a daemon network worker, but the synthesis consumer now times out/cancels independently. Two global worker slots and a two-packet queue bound resources; a second unrecoverable resolver produces a safe immediate error rather than blocking reply finality. Abandoned requests cannot POST after DNS returns. Cloud errors are safe and visible; no automatic upload to another provider. Speed is provider-clamped (Cartesia PVCs may ignore it). ElevenLabs PCM entitlements depend on account. No installer/release/push; this is not an all-green latency/shippable claim.

## Official API contracts checked
- https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
- https://www.assemblyai.com/docs/api-reference/files/upload
- https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model
- https://elevenlabs.io/docs/api-reference/text-to-speech/stream
- https://docs.cartesia.ai/api-reference/tts/bytes (2026-08-14 schema; direct API-key Authorization, string voice ID)
- https://platform.openai.com/docs/api-reference/audio/createSpeech
- https://developers.deepgram.com/reference/text-to-speech-api/speak
- https://developers.deepgram.com/docs/tts-voice-controls

Read-only full review identified a DNS-blocked single synthesis worker. A failing regression reproduced it before the fix; after bounded worker isolation all 18 TTS tests passed. Independent follow-up review approved the exact helper/test hashes, plus Stop-during-DNS and backpressure probes. Parent rebuilt the TTS freeze and repeated six frozen startup probes, build/lint/typecheck, 15 environment checks and boot successfully. No required review findings remain.

## Liquid-glass follow-up
All button surfaces now share a translucent sheen, beveled rim, tinted selected/danger states, visible focus and pressed feedback. Scene swatches retain their previews. The microphone is a 96×42px glass Talk pill with five waveform bars; existing PTT element/listeners/ARIA semantics retained. Reduced motion stops the waveform/ring, and blur-off disables button backdrop work. The live-profile check caught an attribute-presence selector treating data-blur-off="false" as disabled; a red-first regression now checks actual enabled blur, and the selector matches only "true". Default-profile IPC returned STT/TTS ready with Talk blur enabled; no saved provider/configuration was changed.
Real visible Electron regression: 26/26 checks across all eight Settings tabs at 1280/820px, including new/dynamic controls, geometry, keyboard focus and performance escape hatch. Main screenshots inspected at both widths. Existing tactile, UX, voice lifecycle, barge-in, live barge-in, mic lifecycle, 45 cloud Settings checks and boot passed. Initial red test caught the old solid-circle design; hidden screenshot capture then timed out, so the harness now uses a visible disposable profile and per-CDP call deadlines. No human microphone conversation performed.
