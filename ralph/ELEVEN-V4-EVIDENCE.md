# Eleven v4 Turbo and session-hover evidence

## Delivered
- ElevenLabs default model: `eleven_v4_turbo` in main config, renderer metadata and adapter fallback. Other providers and the local default are unchanged; explicitly saved model/voice selections are not overwritten by the code default.
- Actual Text to Dialogue WebSocket, fixed `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input`, one registered voice, `pcm_24000`, header auth, inputs, close_socket flush and explicit is_final. Legacy Flash continues using HTTP. No automatic cross-provider upload.
- Bounded 2-network-worker/2-packet consumer, message/audio limits, odd-PCM carry, safe errors and private library logging. Cancel/timeout interrupts handshake/TLS/read and prevents late DNS uploads.
- V4 speed controls disabled; changing the editable model updates availability. No unsupported speed/style parameters uploaded.
- Voice recommendation: George, `JBFqnCBsd6RMkjVDRZzb`, supported by ElevenLabs' current V4 quickstart. This is a documented British-voice fit, not an account audition or objective model-specific ranking. It is a legacy default voice: provider retirement is scheduled for December 31, 2026 and the Settings hint warns to replace it before then.
- Session overflow dots: hidden at rest; revealed on row hover, keyboard focus, open-menu ownership and no-hover devices. No layout shift or deleted tab stop.

## Parent execution
- Observed RED for session visibility and V4 default before their fixes.
- Build, lint, typecheck and diff check passed.
- Cloud TTS: 35 tests passed (real loopback HTTP, WebSockets, real sidecar PCM/status/finality; no provider account request).
- Isolated actual Electron cloud Settings: 47 checks passed. Real imported-session UI: 17 checks passed, including mouse enter/leave, Tab, popup opening, Escape focus-return and touch access. Liquid glass: 26 checks passed at 1280/820px.
- Credential isolation: 15 actual Supervisor/fake-child checks passed. First-chunk and TTS deadline/prosody checks passed. Session-feature/UX and boot passed.
- Rebuilt actual TTS PyInstaller bundle; six frozen startup/control probes and packaging-script regressions passed. Full installers not built.
- Dependency: `websockets>=15.0.1,<16`, isolated TTS venv tested at 15.0.1, BSD-3-Clause. OSV lookup for that exact version returned no listed advisories; this is a lookup result, not a guarantee.
- Default-profile handover: existing ElevenLabs Flash selection explicitly changed to V4 Turbo through the app config IPC; exact model and George ID read back. Engine/voice untouched. Both STT/TTS reported ready; actual-profile session dots computed opacity=0/pointer-events=none and screenshot inspected. Diagnostic shutdown initially timed out; explicit scratch-client termination fixed it and the repeat returned exit 0. Returned to normal Electron without the debugger.
- Independent bounded review approved: no required defects; another real 35-test run passed. All seven reviewed source/test SHA256 digests matched before/after and were verified again by the parent before staging.

## Limits
No live ElevenLabs synthesis/account entitlement, V4 voice-quality audition, real-provider latency, human microphone conversation or installer acceptance. Existing historical CPU latency gate remains unresolved; no thresholds were relaxed. New dependency requires provisioning updated TTS requirements and rebuilding bundles on release hosts.

## Official contracts
- https://elevenlabs.io/docs/overview/models
- https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4
- https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd
- https://elevenlabs.io/docs/eleven-api/quickstart
- https://elevenlabs.io/docs/product/voices/default-voices

The newer realtime dialogue guide explicitly supports V4 Turbo; the API reference still contained older V3-only wording at lookup. Use current V4 guide semantics, not only a model-string substitution into the legacy HTTP adapter.
