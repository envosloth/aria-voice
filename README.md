# ARIA

A local-first, GPU-accelerated voice assistant. Speech-to-text and
text-to-speech run locally; only the language model / agent is remote
(user-configured). Open source under the [MIT License](LICENSE).

- **STT**: whisper.cpp with the **Vulkan** backend (GPU, no ROCm) — warm
  `whisper-server` keeps the model loaded (~250 ms for a short utterance on an
  RX 9060 XT).
- **TTS**: **Kokoro-82M** neural voices (CPU/ONNX), sentence-chunked streaming,
  warm persistent model. Natural, expressive voices including a refined British
  male "Jarvis" default. (Piper remains available as an optional light engine.)
- **Wake word**: openWakeWord + Silero VAD (CPU, ~2 ms/frame).
- **LLM + agent harness**: any OpenAI-compatible streaming endpoint. A coordinator
  routes between a conversational LLM and an agent harness (Claude Code, Codex,
  Hermes, …), sharing one conversation history across the handoff. Keys are
  stored in the OS keyring via Electron `safeStorage`.
- **Screen share**: share your desktop with the agent live — click the screen
  button or say "share my screen". Frames are sent to the agent as vision input.

## Platform support

| Platform | Status | Installer |
|----------|--------|-----------|
| Ubuntu / Debian / Mint / Pop!_OS | ✅ Supported & tested (Ubuntu 26.04, kernel 7.0, AMD RDNA 4 gfx1200) | `.deb`, `.AppImage` |
| Fedora / RHEL / openSUSE | ⚙️ Built via CI | `.rpm`, `.AppImage` |
| Windows 10/11 | ⚙️ Built via CI (whisper.cpp Vulkan/CPU) | `.exe` (NSIS), portable |
| macOS (Apple Silicon / Intel) | ⚙️ Built via CI (whisper.cpp Metal) | `.dmg`, `.zip` |

Native components (PyInstaller-frozen Python sidecars + compiled whisper.cpp)
can't be cross-compiled, so each OS is built on its own runner — see
[`.github/workflows/release.yml`](.github/workflows/release.yml). Push a `v*`
tag to produce a release with installers for all platforms. Linux is the
reference platform validated end-to-end; Windows/macOS builds are wired through
CI and welcome validation/PRs.

## Architecture

```
Electron (TypeScript)                     Python sidecars (frozen, no system Python)
┌──────────────────────────┐             ┌──────────────────────────────────────┐
│ main: Supervisor          │  stdin JSON │ wakeword  (openWakeWord)              │
│  - spawn / heartbeat      │────────────▶│ stt       (whisper-server, Vulkan)   │
│  - restart + circuit break│  UDS  PCM   │ tts       (Piper)                    │
│  - memory watchdog        │◀───────────▶│  base_sidecar: stdin ctrl / stdout   │
│  - tree-kill on quit      │ stdout JSON │  results / UDS PCM                   │
│ renderer: UI + Web Audio  │             └──────────────────────────────────────┘
│ preload: contextBridge    │
└──────────────────────────┘   ──▶ remote OpenAI-compatible LLM (SSE streaming)
```

IPC contract: **control** as newline-JSON over stdin, **results/status** as
newline-JSON over stdout, **PCM** as raw bytes over a Unix domain socket (TTS
announces each chunk's size on stdout before sending it). See `CLAUDE.md`.

## Prerequisites

System packages (Ubuntu):

```bash
sudo apt install mesa-vulkan-drivers libvulkan-dev glslang-tools \
                 gnome-keyring libsecret-1-0 ffmpeg
```

Node 22+, Python 3.12+, cmake, g++.

## Setup (development)

```bash
# 1. Node deps
npm install

# 2. Build whisper.cpp with the Vulkan backend -> ~/.local/bin/whisper-{cli,server}
./scripts/build-whispercpp.sh

# 3. Per-sidecar Python venvs
for s in stt tts wakeword; do
  python3 -m venv sidecars/$s/venv
  sidecars/$s/venv/bin/pip install -r sidecars/$s/requirements.txt
done

# 4. Download STT/TTS models (also happens automatically on first run)
./scripts/download-models.sh small

# 5. Build + run
npm start            # or: npm run dev  (with inspector)
```

## Tests

A full smoke suite drives the real sidecars (no mocks except the LLM):

```bash
npm run smoke:all        # lifecycle + tts + stt + resilience + memory + llm + models + e2e
npm run smoke:e2e        # full pipeline: speech -> STT -> mock LLM -> TTS, with latency report
npm run smoke:boot       # headless Electron boot (ARIA_SMOKE=1, auto-quits)
```

To test against the **frozen** sidecar binaries instead of dev venvs:

```bash
npm run package:sidecars
ARIA_SIDECAR_DIR=$PWD/build/sidecars npm run smoke:stt
```

## Packaging

```bash
npm run dist     # freezes sidecars (PyInstaller onedir) + builds AppImage and .deb
```

Output lands in `dist-installers/`. Notes:

- Model weights are **not** bundled — they download on first run and resume
  interrupted transfers. Integrity is enforced whenever the manifest carries
  authoritative size or SHA-256 metadata; this repository does not claim every
  upstream model URL is currently checksum-pinned. The installer stays small.
- The `.deb` declares `gnome-keyring` / `libsecret-1-0` as dependencies — if the
  OS keyring is unavailable, ARIA refuses to persist API keys rather than using
  safeStorage's plaintext-obfuscation fallback.
- AppImage may need `libfuse2` on older targets.
- The Chromium SUID sandbox must be configured (root:root, mode 4755) —
  electron-builder handles this for the packaged app. Never ship `--no-sandbox`.

## Latency (measured, RX 9060 XT)

| Stage                         | Measured   | Spec budget |
| ----------------------------- | ---------- | ----------- |
| Wake word (per 80 ms frame)   | ~2 ms      | trivial     |
| STT (warm, short utterance)   | ~250 ms    | 150–400 ms  |
| TTS first chunk               | ~70 ms     | 150–400 ms  |
| **Local first-audio**         | **~325 ms**| < 900 ms    |
| LLM first token (remote)      | variable   | reported separately |

The remote LLM's time-to-first-token dominates end-to-end latency and is reported
separately from the local pipeline SLO.

## Contributing

Contributions are welcome. Start with **[CONTRIBUTING.md](CONTRIBUTING.md)** (setup,
the dev loop, PR conventions) and please follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through
[SECURITY.md](SECURITY.md) (report privately, not as a public issue).

- **Deep dive:** the [`collaboration/`](collaboration/) folder is an onboarding kit —
  architecture map, the sidecar IPC contract, house conventions, and the hard-won
  gotchas that aren't obvious from the code. Written for both human and AI
  contributors; read [`collaboration/gotchas.md`](collaboration/gotchas.md) before
  changing the audio or orb paths.
- **Why the stack is what it is:** [`BUILD_SPEC.md`](BUILD_SPEC.md).
- **Bugs / features:** use the issue templates. Linux is the reference platform;
  Windows/macOS builds run through CI and welcome hands-on validation.
