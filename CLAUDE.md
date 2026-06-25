# ARIA — Voice Assistant

## Architecture
- **Electron** main process (TypeScript) with **Python sidecars** for STT, TTS, and wake word
- IPC: Unix domain sockets for PCM streaming, stdio for control/JSON
- Target: Ubuntu 26.04 LTS / kernel 7.0 / AMD RX 9060 XT (RDNA 4, gfx1200)

## Stack
- **STT**: whisper.cpp with Vulkan backend (`-DGGML_VULKAN=1`), NOT ROCm. CPU fallback.
- **TTS**: Piper (CPU/ONNX) default, Kokoro-82M optional. Sentence-chunked streaming.
- **Wake word**: openWakeWord + Silero VAD
- **Security**: `safeStorage` + gnome-libsecret for API keys; `electron-store` for non-secret config only

## Key Constraints
- No ROCm dependency (Ubuntu 26.04 / kernel 7.0 not in ROCm support matrix)
- No faster-whisper/CTranslate2 (RDNA 4 crash bug)
- 16 GB VRAM, 30 GB RAM — lazy-load sidecars, RSS watchdog per sidecar
- Wayland global shortcuts are best-effort; tray + in-window shortcuts are fallbacks

## Commands
- `npm run build` — compile TypeScript + copy renderer
- `npm run dev` — dev mode with inspector
- `npm run smoke:all` — full suite (10 tests: lifecycle, tts, stt, resilience, pdeathsig, memory, llm, models, audio, e2e)
- individual: `smoke` / `smoke:tts` / `smoke:stt` / `smoke:resilience` / `smoke:pdeathsig` / `smoke:memory` / `smoke:llm` / `smoke:models` / `smoke:audio` / `smoke:e2e`
- `npm run smoke:boot` — headless Electron boot test (ARIA_SMOKE=1, auto-quits)
- `npm run dist` — build distributable .deb + .AppImage (freezes sidecars first)

## Known dev-env notes
- Chromium SUID sandbox needs root setup; dev/test uses `--no-sandbox`. **Production packaging must configure chrome-sandbox properly — never ship `--no-sandbox`.**
- openWakeWord warns about missing CUDAExecutionProvider then falls back to CPU (expected on AMD).
- `./scripts/build-whispercpp.sh` — build whisper.cpp with Vulkan
- `./scripts/download-models.sh [model]` — download STT/TTS models
- `./scripts/package-sidecar.sh <name>` — freeze a sidecar as a PyInstaller onedir binary
- Test frozen binaries: `ARIA_SIDECAR_DIR=$PWD/build/sidecars npm run smoke:*`

## Sidecar IPC (verified)
- **Control → sidecar**: JSON over **stdin** (`supervisor.sendToSidecar`)
- **PCM → sidecar**: raw bytes over **UDS socket** (`supervisor.sendPcm`) — STT/wakeword input
- **Results/status → main**: JSON over **stdout** (`onStatus`/`onMessage` callbacks)
- **PCM → main**: raw bytes over **UDS socket** (`onBinaryData`) — TTS output, size announced via stdout `tts_chunk`
- Python sidecars override `initialize()` / `on_control(msg)` / `on_pcm(data)`; call `self.emit(msg)` / `self.send_pcm(bytes)`
- Each sidecar runs in its own venv (`sidecars/<name>/venv`); supervisor auto-detects it in dev

## Project Structure
```
src/main/         — Electron main process
src/preload/      — context bridge (renderer API)
src/renderer/     — UI (HTML + vanilla JS)
src/shared/       — constants, IPC channel names
sidecars/stt/     — whisper.cpp STT sidecar
sidecars/tts/     — Piper/Kokoro TTS sidecar
sidecars/wakeword/ — openWakeWord sidecar
sidecars/shared/  — base sidecar class
scripts/          — build and setup scripts
models/           — model weights (gitignored, downloaded at runtime)
```
