# ARIA Build Spec — Technical Verification Report: GPU-Accelerated Voice Stack on RDNA 4 / Ubuntu 26.04 / 16 GiB

## TL;DR

- **Use whisper.cpp with the Vulkan backend (GGML_VULKAN), not ROCm/CTranslate2, for GPU STT on the RX 9060 XT.** ROCm does not officially support Ubuntu 26.04 / kernel 7.0 for this card (the ROCm 7.2.x matrix lists only Ubuntu 24.04.4 / 22.04.5 and RHEL for gfx1200), faster-whisper's CTranslate2 ROCm path crashes with GPU memory faults on RDNA 4, and Vulkan is the vendor-agnostic, Mesa-driver-level path that is most stable on this exact machine. Specify the `small` (or `base.en`) model for low-latency short utterances.
- **TTS: use Piper (ONNX/VITS) on CPU as the stable default; Kokoro-82M is an optional higher-quality CPU/ONNX upgrade.** Neither gets reliable AMD GPU acceleration on Linux in 2026 — but both run comfortably on the Ryzen 7 3700X CPU, and sentence-chunked streaming keeps perceived latency low.
- **A 900 ms VAD→first-audio target is realistic for the LOCAL stages only.** The remote, user-configured LLM's network + first-token latency dominates and is outside your control; design the latency budget so STT + TTS-first-chunk fit comfortably under ~500 ms locally and surface LLM latency separately.

## Key Findings

1. **ROCm officially supports the RX 9060 XT silicon (gfx1200) but NOT the target OS.** RDNA 4 RX 9060 XT support landed in ROCm 7.2.0 (AMD release notes: "ROCm 7.2.0 adds support for RDNA4 architecture-based AMD Radeon AI PRO R9600D and AMD Radeon RX 9060 XT LP"), and the current production line is ROCm 7.2.4 (released May 29, 2026). But AMD's official Linux system-requirements matrix restricts the RX 9060 XT family to Ubuntu 24.04.4, Ubuntu 22.04.5, RHEL 10.1, and RHEL 9.7.  Ubuntu 26.04 LTS and Linux kernel 7.0 appear nowhere in the matrix. Running ROCm on the target machine would be an unsupported configuration — a direct conflict with the project's "hard focus on stability."
1. **faster-whisper / CTranslate2 on ROCm crashes on RDNA 4.** CTranslate2 added ROCm/HIP support in v4.7.0 (released Feb 3, 2026, via PR #1989 — "Introduce AMD GPU support with ROCm HIP"), but the current PyPI release (v4.8.0, uploaded Jun 6, 2026) still ships CUDA + CPU wheels only; ROCm requires community forks built from source. A confirmed bug (CTranslate2 issue #2021) shows faster-whisper aborting with a GPU memory access fault / core dump on the sibling RDNA 4 die (gfx1201, RX 9070 XT) under ROCm 7.2.0 + CTranslate2 4.7.1. This rules out faster-whisper as the stable choice here.
1. **whisper.cpp Vulkan is the reliable GPU path on RDNA 4** — it uses the Mesa RADV/ACO Vulkan driver, independent of the ROCm stack, and produces a single binary that GPU-accelerates without a ROCm install. The whisper.cpp HIP backend works when compiled natively for gfx1200/gfx1201 but carries multiple open RDNA 4 bugs (HIP init ISA rejection, an idle 100%-GPU power bug that Vulkan does not exhibit, multi-GPU illegal-memory-access).
1. **openWakeWord remains the right local wake-word engine** for a desktop CPU; microWakeWord targets ESP32-class microcontrollers and is less accurate, while Porcupine is a strong commercial alternative if licensing is acceptable.
1. **Electron supports Wayland global shortcuts via the GlobalShortcutsPortal**, but only behind a launch flag, and the feature has had a bumpy history — design a tray/in-window fallback.
1. **PipeWire is the default on Ubuntu** and microphone capture works through the standard getUserMedia path; the portal complexity is mostly about screen capture, not mic.
1. **Electron `safeStorage` backed by gnome-keyring (libsecret) is the correct place for API keys**; `electron-store` alone is plaintext and must hold only non-sensitive config.

## Details

### 1. GPU-Accelerated STT on AMD RDNA 4

**CTranslate2 / faster-whisper.** faster-whisper's backend, CTranslate2, historically supported only CUDA and CPU. As of v4.7.0 (released Feb 3, 2026, PR #1989 by contributor @sssshhhhhh) CTranslate2 added AMD GPU support via ROCm/HIP (`-DWITH_HIP=ON`). However, two hard problems remain for this project:

- The official PyPI wheel (current v4.8.0, Jun 6, 2026) and Docker images are still CUDA + CPU only — there is no `latest-rocm` tag, and the CUDA image silently falls back to CPU on AMD machines. ROCm builds require community forks (paralin/ctranslate2-rocm, arlo-phoenix/CTranslate2-rocm) compiled from source against a matching ROCm — "a research project in itself." (For reference, the arlo-phoenix hipified fork runs whisperX about 60% faster than whisper.cpp on supported AMD hardware — but that is RDNA 3, not RDNA 4.)
- On RDNA 4, the ROCm path is actively crashing. CTranslate2 issue #2021 reports faster-whisper aborting on gfx1201 under ROCm 7.2.0 + CTranslate2 4.7.1, and the paralin/ctranslate2-rocm notes document the same failure mode verbatim: "Memory access fault by GPU node-1 (Agent handle: 0x…) on address 0x… Reason: Page not present or supervisor privilege … Short clips (~60s) work fine at 28x realtime. Workaround: Process audio in chunks, or use CPU mode for long files." The crash spans multiple model sizes; a community env-var allocator workaround exists but is unofficial.

**Conclusion: do not specify faster-whisper for this machine.** It compounds two instabilities (unsupported OS for ROCm + an active RDNA 4 crash).

**whisper.cpp backends.** whisper.cpp supports CPU, CUDA, Vulkan, and HIP/ROCm. Two relevant facts:

- **Vulkan (`-DGGML_VULKAN=1`)** is cross-vendor and runs on AMD via the Mesa RADV driver, with no ROCm dependency. The GGML Vulkan backend shipped in 2024 and matured through 2025–2026; on AMD/Intel hardware "Vulkan is the only meaningful path to acceleration."  A v1.8.0 regression caused AMD GPU non-detection (fixed by reverting to v1.7.6 in one report) — so pin a known-good whisper.cpp version and verify GPU detection at runtime.
- **HIP (`-DGGML_HIP=1 -DAMDGPU_TARGETS=gfx1200`)** works when built natively but has open RDNA 4 bugs, including a HIP-init ISA rejection on gfx1201 and an idle-power bug that the Vulkan backend does not exhibit. Note the older `WHISPER_HIPBLAS=1` / `GGML_HIPBLAS=ON` flags are silent no-ops in current ggml — a known footgun that yields a CPU-only binary.

**Other engines.** sherpa-onnx (ONNX Runtime) offers GPU acceleration only via CUDA (NVIDIA) and DirectML (Windows-only);  it has no Linux AMD GPU execution provider, so on this machine it would run CPU-only. whisperx and insanely-fast-whisper both sit on CTranslate2 or PyTorch-ROCm and inherit the same RDNA 4 fragility. wyoming-whisper is a protocol wrapper, not a backend.

**Recommendation:** whisper.cpp + Vulkan, with the `small` model (244M params) as the default for English short utterances — it balances accuracy and latency and fits VRAM trivially on a 16 GB card. Offer `base.en` (74M) as a lower-latency option and `medium` as an accuracy fallback. The GPU has 16 GB VRAM, so model size is not VRAM-constrained; the constraint is system RAM and latency. Always implement a CPU fallback path (whisper.cpp runs CPU-only fine) and a runtime check that confirms the Vulkan device was actually selected (guard against silent CPU fallback, a documented failure mode on multi-GPU and AMD systems).

### 2. TTS on AMD GPU

**Kokoro-82M** is a high-quality, small (82M) StyleTTS2-based model distributed as both PyTorch and ONNX. On GPU it is extremely fast (RTF ~0.03 on an RTX 3090). But on this AMD/Linux machine, GPU acceleration is impractical: the ONNX GPU execution providers that work are CUDA and DirectML (Windows). There is no reliable ROCm/Vulkan ONNX-Runtime path on Linux AMD, so Kokoro effectively runs on CPU here. CPU short-phrase latency has been reported around 500 ms (FP32 ONNX) on a modern laptop CPU  — acceptable for sentence-chunked synthesis but not instantaneous.

**Piper** (Rhasspy; development moved Oct 2025 to OHF-Voice's GPL-3.0 `piper1-gpl` fork) is a fast, local VITS/ONNX TTS designed for CPU and low-resource devices. It outputs raw PCM to stdout, supports sentence streaming, and is the most battle-tested low-latency local option. On the Ryzen 7 3700X, Piper `low`/`medium` voices synthesize faster than real-time on CPU.

**Recommendation:** Specify **Piper (CPU, ONNX) as the default TTS** for stability and lowest latency, with **Kokoro-82M (CPU/ONNX) as an optional higher-quality voice**. Do not budget for AMD-GPU TTS acceleration. Use sentence-boundary chunking: synthesize and start playback after the first sentence while later sentences are still generating — this cuts perceived latency substantially. Persist a warmed TTS process (model loaded once) rather than spawning per utterance, since ONNX model initialization is the dominant cold-start cost.

### 3. Wake Word

**openWakeWord** (dscripka) is the appropriate choice for a desktop. It uses ONNX/tflite runtimes and is highly efficient — per its README, "a single core of a Raspberry Pi 3 can run 15-20 openWakeWord models simultaneously in real-time" — and bundles an optional Silero VAD to cut false positives. It splits melspectrogram/embedding/prediction models to optimize latency and works on 80 ms audio frames. It is trivial for a Ryzen 7 3700X.

**microWakeWord** (kahrendt) is purpose-built for ESP32-S3 microcontrollers; the openWakeWord README itself recommends it only for that class of device because openWakeWord "may still take several seconds to process a single 80 ms frame on an ESP32-S3 with quantized openWakeWord models." microWakeWord is "less accurate than openWakeWord on average"  — it solves a problem this project does not have. **Porcupine** (Picovoice) is highly efficient — per Picovoice docs, the v1.8 standard model "is 1MB in size and consumes 3.8% of CPU cycles on a single core of a Raspberry Pi 3 (ARM Cortex-A53)" — and accurate, but is commercial/licensed.

**Recommendation:** **openWakeWord** running in the Python sidecar (or a dedicated lightweight wake-word sidecar), with Silero VAD enabled. It is CPU-light, reliable, and keeps everything local. Keep Porcupine as a documented fallback only if openWakeWord's false-activation rate proves unacceptable in the user's environment.

### 4. Wayland + GNOME 50 Specifics

**Global hotkeys.** On Wayland, apps cannot grab global keys directly; the sanctioned route is `org.freedesktop.portal.GlobalShortcuts`. Electron now wires its `globalShortcut` API to Chromium's `GlobalShortcutsPortal`, but it must be explicitly enabled:

```js
app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
```

This shipped in Electron 35.x (backported via PRs #45171/#45297) and required follow-up fixes (e.g., a D-Bus signal-signature fix backported to the 40.x line).  The portal also requires the app to run in a real Wayland session (set `ELECTRON_OZONE_PLATFORM_HINT=wayland`)  and depends on `xdg-desktop-portal-gnome` being present. Because this feature has been historically flaky on Wayland (issue #45607 reported shortcuts firing only in Chromium apps), the build spec should treat the global hotkey as best-effort and provide a reliable fallback: a tray-menu toggle and an in-window shortcut (using `before-input-event` / DOM key listeners) for when the app has focus.

**Microphone capture.** PipeWire is the default audio server on modern Ubuntu (fully default since 22.10),  with `pipewire-pulse` providing transparent PulseAudio compatibility  (apps that speak the PulseAudio API "just work"). For microphone capture specifically, an Electron renderer uses the standard `navigator.mediaDevices.getUserMedia({audio:true})` Web API, which Chromium routes through PipeWire/Pulse automatically — the heavy portal machinery (`org.freedesktop.portal.ScreenCast`) applies to screen capture, not mic. Confirm PipeWire with `pactl info` (should report "PulseAudio (on PipeWire …)")  and `wpctl status`. Recommend capturing 16 kHz mono PCM for the STT/wake-word pipeline.

### 5. Electron + Python Sidecar Stability (the stability focus)

This is the highest-risk area for a "mostly local" app. Recommended architecture:

**Process supervision.** The Electron main process owns a supervisor that spawns each Python sidecar (wake-word, STT, TTS) and tracks PIDs. Implement: (a) heartbeat/health pings on a fixed interval with a timeout; (b) automatic restart with exponential backoff and a max-retry circuit breaker that surfaces a clear error to the UI rather than restart-looping; (c) crash detection via `exit`/`error` events.

**Zombie/orphan prevention** — the most common Electron+sidecar failure. Real-world bugs (e.g., Auto-Claude issue #1252) show child Python processes (and their grandchildren — git, bash, etc.) surviving Electron exit and accumulating across restarts (2x, 3x, 4x…). Mitigations: spawn the sidecar in its own process group and kill the whole tree on quit (use a tree-kill approach); register handlers on `before-quit`/`will-quit` and OS signals; on Linux, set the child to receive SIGTERM when the parent dies (PR_SET_PDEATHSIG via a small launcher) as a backstop;  await async cleanup before the app actually exits (don't exit immediately — a documented cause of orphans).

**IPC.** For streaming audio/PCM and results between Electron and Python, recommend a **local Unix domain socket** as the primary channel: lower latency and no port-collision/firewall issues compared with localhost TCP, and far more robust for binary streaming than line-based stdio (stdio remains fine for control/JSON messages and is the simplest for capturing logs). Avoid heavyweight brokers (ZeroMQ/nanomsg) unless a clear need emerges — they add a dependency and packaging surface. A common, simple split: stdio for control/JSON, a UDS for the PCM stream.

**Packaging.** Bundle the Python sidecars as **PyInstaller-frozen binaries** (onedir, not onefile) rather than shipping a system-Python dependency or a relocated venv. PyInstaller includes the interpreter and native libs so the target needs no Python;  onedir avoids the onefile temp-extraction problems (e.g., noexec /tmp, slower startup). Build the PyInstaller bundle inside a venv that has exactly the sidecar deps (PyInstaller picks up the venv's packages). Ship as both AppImage and .deb; note AppImage on older targets may need libfuse2.  **Do not bundle multi-GB model weights in the installer** — download whisper/Kokoro/Piper/wake-word weights on first run with progress UI, checksum verification, resumable downloads, and a clear error if offline. This keeps the installer small and lets you update models independently. Beware GLIBC mismatches: build the sidecars on a base no newer than the oldest target you support.

**Memory budgeting (16 GiB is the binding constraint).** Rough resident footprints: Electron/Chromium (main + renderer + GPU process) ~300–600 MB; openWakeWord ~100–200 MB; whisper.cpp `small` ~1–1.5 GB (weights + Vulkan buffers, much of it VRAM-resident on the 16 GB card, which helps system RAM); Piper ~100–300 MB; Kokoro ~0.5–1 GB if loaded. Total realistically ~2.5–4 GB, leaving comfortable headroom in 16 GiB — provided you **lazy-load** the STT and TTS sidecars (don't hold all models resident if idle), cap whisper threads, and run a memory watchdog that restarts a sidecar if its RSS exceeds a configured ceiling. The bigger risk is GPU/VRAM contention with GNOME's compositor than system RAM exhaustion. Budget assuming the user also runs a browser.

### 6. Electron Security for API Keys

Use **`safeStorage`** (`encryptString`/`decryptString`), which on Linux derives an encryption key stored in the OS secret store  — `gnome-libsecret` (gnome-keyring) is selected automatically on GNOME and other listed desktops. Store the resulting encrypted blob via `electron-store` (or a file) — this pattern (safeStorage + electron-store) is the modern replacement for the now-deprecated `keytar`. 

Critical caveats to encode in the spec:

- If no secret store is available, safeStorage falls back to encrypting with a hardcoded plaintext password  (effectively obfuscation, not security). Detect this with `safeStorage.getSelectedStorageBackend()` returning `basic_text`  and warn the user / refuse to persist secrets.
- `electron-store`'s own `encryptionKey` option is obfuscation only (the key ships in the app, as its own maintainers note: "this_only_obfuscates") — it is **not** security. Use `electron-store` (plaintext on disk) **only** for non-sensitive config (model choice, endpoint URLs without embedded secrets, UI prefs).
- Ensure `gnome-keyring` / libsecret is a documented runtime dependency of the .deb.

### 7. Latency Assessment

**Is VAD->first-audio <= 900 ms realistic for short queries? For the local stages, yes — but the remote LLM dominates and is outside the 900 ms guarantee.** Realistic per-stage breakdown on this hardware:

|Stage                                                         |Estimate                          |Notes                                                                         |
|--------------------------------------------------------------|----------------------------------|------------------------------------------------------------------------------|
|VAD endpointing                                               |~50–150 ms                        |Silero VAD; tunable, largest controllable local lever                         |
|STT (whisper.cpp Vulkan, `small`/`base.en`, short utterance)  |~150–400 ms                       |Most work overlaps speech if streaming; result lands shortly after speech ends|
|Routing decision (local)                                      |~5–20 ms                          |Local logic, negligible                                                       |
|Network round-trip + LLM first token (remote, user-configured)|**highly variable, ~300–1500+ ms**|Depends entirely on provider/harness; NOT under app control                   |
|TTS first chunk (Piper, CPU, sentence-chunked)                |~150–400 ms                       |First sentence only; rest streams during playback                             |

**Local-only path** (VAD + STT + routing + TTS first chunk) can plausibly fit in ~400–800 ms, so a <=900 ms target is achievable *if measured excluding the remote LLM*. Once the remote LLM is in the loop, end-to-end first-audio is gated by the provider's time-to-first-token plus network RTT, which routinely exceeds the entire local budget. **Recommendation:** define two SLOs — (a) local pipeline (VAD->STT-result and LLM-first-token->first-audio) under a tight budget you control, and (b) end-to-end, reported transparently with the LLM segment broken out. Use sentence-streaming TTS and stream LLM tokens so the user hears the first sentence as soon as the first sentence's worth of tokens arrives.

## Recommendations

**Stage 1 — Lock these specs now (highest confidence):**

1. **STT:** whisper.cpp (pin a known-good version, verify Vulkan device detection at runtime), **Vulkan backend**, **`small`** model default + `base.en` fast option + CPU fallback. Explicitly exclude faster-whisper/CTranslate2-ROCm and any ROCm dependency.
1. **TTS:** Piper (CPU/ONNX) default, Kokoro-82M (CPU) optional. Sentence-chunked streaming, warmed persistent process.
1. **Wake word:** openWakeWord + Silero VAD, lazy-loaded in a sidecar.
1. **Keys:** safeStorage -> gnome-libsecret; electron-store for non-secret config only; detect `basic_text` backend and warn.
1. **No local LLM fallback** (per user decision) — on unreachable endpoint, fail gracefully with a clear, actionable error and keep text input available.

**Stage 2 — Build the stability harness:**
6. Supervisor with heartbeats, exponential-backoff restart + circuit breaker, process-group/tree-kill on quit, PDEATHSIG backstop, memory watchdog with per-sidecar RSS caps.
7. IPC: Unix domain socket for PCM streaming + stdio for control/JSON.
8. Packaging: PyInstaller onedir sidecars, AppImage + .deb, first-run model download with checksums/resume.
9. Wayland: enable `GlobalShortcutsPortal`, set `ELECTRON_OZONE_PLATFORM_HINT=wayland`, and ship tray + in-focus shortcut fallbacks.

**Benchmarks that would change the plan:**

- If AMD adds official ROCm support for Ubuntu 26.04 / kernel 7.0 for gfx1200 **and** the CTranslate2 RDNA 4 crash is fixed upstream, revisit faster-whisper (it is faster than whisper.cpp on supported hardware).
- If whisper.cpp Vulkan shows silent CPU fallback or instability on the target driver, fall back to CPU `base.en` (still interactive on this Ryzen) rather than fighting ROCm.
- If measured local first-audio exceeds ~800 ms, drop STT to `base.en` and Piper to a `low` voice before touching architecture.

## Caveats

- **OS support is the central risk:** ROCm 7.2.4 does not list Ubuntu 26.04 or kernel 7.0 for the RX 9060 XT (only Ubuntu 24.04.4 / 22.04.5 and RHEL). Ubuntu 26.04 LTS / kernel 7.0 / GNOME 50 / firmware 5.17 are themselves very new; verify the Mesa RADV Vulkan driver version on the actual machine supports gfx1200 cleanly before committing.
- The CTranslate2 RDNA 4 crash is directly confirmed on gfx1201 (RX 9070 XT); the gfx1200 (RX 9060 XT) crash is inferred (same RDNA 4 ROCm allocator path), not separately reported — but this strengthens, not weakens, the case for avoiding it.
- Latency numbers are engineering estimates synthesized from comparable-hardware benchmarks, not measurements on this exact machine; treat them as design targets to validate, not guarantees.
- Some performance figures circulating in community posts (e.g., tokens/sec claims for RDNA 4 HIP forks, and the "60% faster than whisper.cpp" whisperX number, which is RDNA 3) are self-reported and unverified for this exact card.
- Electron's Wayland global-shortcut support, while present, has a history of regressions; do not make core functionality depend solely on it.
- A note on versioning: AMD's release-note stream shows RX 9060 XT RDNA 4 support arriving in ROCm 7.2.0 and OS support expanding through 7.2.1 (Ubuntu 24.04.4) into the current 7.2.4 — but at no point does the supported-OS list reach Ubuntu 26.04 or kernel 7.0 for this card.
