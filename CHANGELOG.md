# Changelog

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
