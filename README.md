# ARIA v3

Local-first, always-listening desktop voice assistant — a ground-up native
Rust rewrite of ARIA (v2 was Electron + Python sidecars; see the `main`
branch). One binary, no runtimes, no sidecars.

**Say "hey jarvis"** → whisper.cpp transcribes (GPU/Vulkan, 135 ms warm) →
your local agent harness or a direct LLM answers → Kokoro speaks (British
"Jarvis" voice by default) — everything on-device except the LLM you choose.

## Highlights
- **Glass Observatory UI** (egui/wgpu): live ember orb that reacts to the
  agent's actual voice, chat with timestamps, activity feed, per-stage
  latency panel
- **Mixture routing**: tool-shaped queries → agent harness (tools/skills),
  chat → optional direct LLM; one shared conversation, sticky handoffs
- **Interrupt anywhere**: wake word, ■ button, Esc, clicking the orb, or
  just typing — barge-in aborts the LLM stream within one token
- **Conversation mode**: keep talking after a reply, no re-wake needed
- **Background mode**: close hides to background; `aria --toggle` /
  Alt+Shift+Space brings it back; `aria --quit` always works
- **Hardware presets**: probes CPU/RAM/GPU and sizes the STT model; every
  tunable lives in `~/.config/aria/aria.toml`
- Circuit breakers, panic isolation, restart guard, RSS watchdog,
  hallucination filtering, natural speech (units + acronyms expanded)

## Build (Linux)
```sh
# deps: cmake, clang/libclang, libasound2-dev, libvulkan-dev, glslc, espeak-ng dev headers
cargo build --release          # → target/release/aria
cargo deb -p aria --no-build   # → target/debian/aria-voice_*.deb
```
Models (whisper ggml, Kokoro, openWakeWord) live in
`~/.local/share/aria/models`. First-run setup docs: `NEXT-PROMPT.md` has the
remaining roadmap; `INTEGRITY.md` has the verification log.

## Architecture
Cargo workspace per `ARIA-v3-native-spec.md`: `aria-core` (traits, FSM,
config — no I/O), `aria-wake` (openWakeWord/ort), `aria-stt` (whisper-rs),
`aria-tts` (Kokoro + Piper), `aria-llm` (SSE client), `aria-audio` (cpal +
lock-free rings), `aria-orb`/`aria-ui` (view only), `apps/aria` (runtime).
38 tests including a golden WAV→wake→STT→LLM→TTS pipeline test.
