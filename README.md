# ARIA

A local-first, GPU-accelerated voice assistant for Linux. Speech-to-text and
text-to-speech run locally; only the language model is remote (user-configured).

- **STT**: whisper.cpp with the **Vulkan** backend (GPU, no ROCm) — warm
  `whisper-server` keeps the model loaded (~250 ms for a short utterance on an
  RX 9060 XT).
- **TTS**: Piper (CPU/ONNX), sentence-chunked streaming, warm persistent voice
  (~30–80 ms first chunk).
- **Wake word**: openWakeWord + Silero VAD (CPU, ~2 ms/frame).
- **LLM**: any OpenAI-compatible streaming endpoint (remote), keys stored in the
  OS keyring via Electron `safeStorage`.

Target platform: Ubuntu 26.04 / kernel 7.0 / GNOME 50 / AMD RDNA 4 (gfx1200).

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

- Model weights are **not** bundled — they download on first run (resumable,
  checksummed). The installer stays small.
- The `.deb` declares `gnome-keyring` / `libsecret-1-0` as dependencies — without
  a secret store, `safeStorage` silently falls back to plaintext obfuscation.
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
