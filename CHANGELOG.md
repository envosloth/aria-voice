# Changelog

## 3.2.0

### Added
- Cloud speech, opt-in with your own keys: Deepgram and AssemblyAI speech recognition, and ElevenLabs, Cartesia, OpenAI and Deepgram voices. Local speech stays the default, and keys are kept in secure storage.
- ElevenLabs Eleven v4 Turbo is the default ElevenLabs model, streamed over the realtime dialogue API.
- ElevenLabs expressive delivery: on Eleven v3/v4 the assistant can use tags such as [laughs] or [whispers]. Tags are performed, never read aloud or shown. An optional Jev delivery director picks the mood before each reply.
- While the agent works, ARIA says what it is doing ("I'll search the web for …").
- Opt-in desktop context (selected text, clipboard, active app, dropped files), local memory with an editable panel, and talking over ARIA to interrupt.
- Liquid-glass buttons, a Talk waveform key, tactile controls and wallpaper cross-fades.

### Fixed
- ARIA no longer cuts herself off mid-reply when her own voice leaks back into the microphone. A false alarm now pauses and resumes the reply instead of dropping it.
- The agent now sees the whole conversation, including turns the chat model answered, and "yes, go ahead" after an offer actually starts the lookup.
- Message Copy, Edit and Regenerate buttons stay visible and clickable while the pointer moves onto them.
- Themes now colour all text, with 4.5:1 contrast kept on every background.
- Session options appear inside each session on hover, and a disabled wake word shows Off instead of Starting.

### Validation notes
- Build, lint, type checks, isolated Electron boot, and all 66 smoke-suite groups passed before release, including the end-to-end latency gate.
- Cloud providers were tested against local loopback servers only; live account quality and latency were not measured.
- Native installers are produced by the release workflow. Unsigned Windows and macOS builds keep manual-download updates.

## 3.1.0

### Added
- Import past conversations from Hermes, Claude Code, and Codex.
- Sort the conversation list and choose an app-wide font.
- Measure time to first audio with the Performance settings Test button.
- Choose the TTS engine and voice separately, with per-engine voice preferences.
- Background scenes, custom background images, and glass chat bubbles with adaptive text contrast.
- Plain-English errors with suggested fixes, message actions, and reduced-motion support.

### Fixed
- Preserve corrupt or unreadable conversation/configuration files rather than overwriting them; retain a last-good backup and avoid logging parser snippets.
- Reject incomplete model streams and unexpected non-streaming response bodies.
- Support IPv6 literal endpoints across chat, discovery, downloads, updates, and harness-session deletion.
- Cancel latency-test model requests reliably, including voice failures and timeouts.
- Include inference-child memory in the sidecar watchdog and reap failed speech-server startup processes.
- Show the speaking orb state only while audio plays, and start conservatively until the hardware profile is available.

### Validation notes
- Build, lint, type checks, audit regressions, isolated Electron boot, and the full isolated smoke suite passed during development.
- Local speech latency is load-sensitive: one integrated run missed the 900 ms target at 921 ms; standalone confirmation passed at 868 ms without relaxing the threshold.
- Native installers are produced by the release workflow. Unsigned Windows and macOS builds retain manual-download update behaviour.
