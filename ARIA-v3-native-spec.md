# ARIA v3 — Native Rust Rebuild: Formal Specification

> **Status:** Draft spec — reference document, not agent instructions.
> **Supersedes:** ARIA v2.x (Electron + TypeScript shell, Python sidecars).
> **Target:** A clean-foundation, native, cross-platform local voice assistant.
> **Date:** 2026-07-02

---

## 0. How to read this document

This is a **specification**, not a build script. It defines *what* ARIA v3 is,
*how* its pieces fit, and *what constraints* they must satisfy. It deliberately
does **not** prescribe implementation step order — that belongs to a separate
roadmap.

Two appendices carry forward everything learned building v1/v2:

- **Appendix A — Known Pitfalls:** concrete failure modes discovered the hard
  way. Consult before implementing the relevant component. These are *warnings*,
  not architecture.
- **Appendix B — Verified Performance Baselines:** measured numbers from v2 that
  set the bar v3 must meet or beat.

The body of the spec stays clean and architectural on purpose. When a design
decision exists *only* because of a past bug, it links to the pitfall by number
(e.g. *(see A-3)*) rather than inlining the war story.

---

## 1. Mission & scope

### 1.1 What ARIA is

A **local-first, always-listening desktop voice assistant.** The user says a wake
word, speaks, and ARIA transcribes, reasons with an LLM, and speaks back — with a
visible "orb" as its presence on screen. Everything runs on-device by default;
cloud is opt-in per stage.

### 1.2 The v3 thesis

v2 proved the product works. It also accreted an Electron shell, a Python sidecar
fleet, a supervisor with three IPC channels, and a long tail of concurrency and
lifecycle bugs. v3 keeps **the validated pipeline and UX** and discards **the
integration substrate**:

- **One language (Rust) for the whole runtime** — no Node↔Python process fleet,
  no cross-runtime IPC serialization, no PyInstaller freezing, no
  `contextBridge`/preload footguns.
- **Native GPU rendering (wgpu) for the orb**, native immediate-mode UI (egui)
  for settings — no webview, no browser event loop, no `requestAnimationFrame`
  CPU traps *(see A-1)*.
- **In-process components with supervised isolation** replacing the
  supervisor/sidecar process model — same crash-resilience guarantees, far less
  IPC surface *(see §5.2)*.

### 1.3 v1 priority: clean foundation

The explicit priority for v3 is a **maintainable, well-tested core** — not
feature count, not raw latency. Where a choice trades cleanliness/testability
against speed or features, **choose cleanliness for v1**; latency and feature
parity are follow-on milestones with baselines already established in Appendix B.

### 1.4 Non-goals (v1)

- Mobile / web targets. Desktop only (Linux, macOS, Windows).
- Multi-user, accounts, or telemetry-to-cloud.
- Plugin/extension SDK. (Design for it in the boundary shapes; don't build it.)
- Feature parity on day one — barge-in, screen-share/vision, and the perf panel
  are milestones, not v1 gates (§12).

---

## 2. Design principles

1. **Local-first, cloud-optional.** Every stage (STT, LLM, TTS) has an on-device
   default and a pluggable cloud alternative selected by config. Nothing requires
   the network to function.
2. **One process, isolated failure domains.** Prefer in-process components. Wrap
   every fallible/native-FFI component so its failure cannot take down the app
   *(see §5)*.
3. **Testable seams over convenience.** Every component is a trait with a real
   implementation and a fake. The voice loop is drivable end-to-end with all
   inference mocked.
4. **Config is data, behavior is code.** All tunables live in a versioned,
   schema-validated config file. No magic constants scattered in modules.
5. **The UI is a view, never the source of truth.** State lives in the core; the
   renderer subscribes. A UI stall must never stall the audio loop *(see A-2)*.
6. **Bounded everything.** Every queue, buffer, retry loop, and render loop has an
   explicit cap. Unbounded loops are the root of v2's CPU and memory incidents
   *(see A-1, A-6)*.
7. **Fail loud in dev, degrade gracefully in prod.** Panics are caught at
   component boundaries; the app announces degradation (orb state + log) rather
   than dying.

---

## 3. Technology stack

| Concern              | Choice                                   | Rationale |
|----------------------|------------------------------------------|-----------|
| Core language        | **Rust** (stable, 2021+ edition)         | Memory safety, single static binary, clean C/C++ FFI |
| Async runtime        | **Tokio** (multi-thread) + dedicated real-time audio thread | Async for I/O/LLM; RT thread for capture (never on the async pool) |
| Audio I/O            | **cpal**                                 | Cross-platform capture/playback |
| Resampling           | **rubato**                               | High-quality 48k/44.1k → 16k for STT |
| Wake word            | **onnxruntime** (`ort` crate) running openWakeWord ONNX models | Reuse validated models *(see A-4)* |
| STT                  | **whisper.cpp** via `whisper-rs`, GPU backend (Vulkan/Metal/CUDA) | Matches v2 baseline; FFI isolated *(see §5.2, B-1)* |
| TTS                  | **Piper** ONNX via `ort` (or `piper-rs`), CPU | Matches v2 baseline *(see B-2)* |
| LLM                  | HTTP/SSE client (`reqwest`) to local gateway; pluggable cloud | Local Hermes gateway default *(see A-9)* |
| UI — orb             | **wgpu**                                 | Native GPU, no webview |
| UI — settings/HUD    | **egui** (`egui-wgpu` + `winit`)         | Immediate-mode, shares the wgpu device |
| Windowing            | **winit**                                | Cross-platform window/tray/hotkey host |
| Config/serialization | **serde** + **TOML** (config), JSON (IPC/cloud) | Human-editable config |
| Model download       | `reqwest` + resumable/checksummed fetch  | *(see A-10)* |
| Logging/tracing      | **tracing** + `tracing-subscriber`       | Structured, per-span timing for the perf panel |
| Errors               | **thiserror** (libs) / **anyhow** (app)  | Typed errors at boundaries |
| Testing              | built-in + **insta** (snapshots), fakes for every trait | §11 |

> Crate names are the *intended* choices; equivalents are acceptable if a listed
> crate proves unsuitable during spikes. The **architecture** (native Rust, wgpu
> orb, in-process isolated components, ONNX inference) is fixed.

---

## 4. System architecture

### 4.1 Top-level shape

```
┌──────────────────────────────────────────────────────────────┐
│                        ARIA process (Rust)                     │
│                                                                │
│  ┌────────────┐   events    ┌───────────────────────────────┐ │
│  │  UI thread │◀───────────▶│         Core (state owner)      │ │
│  │ winit+wgpu │  commands   │   ┌──────────────────────────┐ │ │
│  │  orb+egui  │             │   │   Conversation state /    │ │ │
│  └────────────┘             │   │   session FSM             │ │ │
│         ▲                   │   └──────────────────────────┘ │ │
│         │ render state      │        ▲          │            │ │
│         │ (lock-free)       │        │ events   │ commands   │ │
│         │                   │  ┌─────┴──────────▼──────────┐ │ │
│         │                   │  │      Voice pipeline        │ │ │
│         │                   │  │  Capture→Wake→STT→LLM→TTS  │ │ │
│         │                   │  └───────────────────────────┘ │ │
│         │                   └────────────────────────────────┘ │
│         │                            │ supervised workers        │
│  ┌──────┴─────────────────────────────────────────────────────┐ │
│  │  Isolated failure domains: STT(FFI), TTS(FFI), wake(FFI)    │ │
│  │  each on its own thread, panic-caught, restartable          │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
        │ HTTP/SSE (optional network)
        ▼
   Local LLM gateway  ·  optional cloud STT/LLM/TTS
```

### 4.2 Module map (crate/workspace layout)

A Cargo **workspace** with small, independently testable crates:

```
aria/
├─ crates/
│  ├─ aria-core        # session FSM, state, event bus, config — no I/O deps
│  ├─ aria-audio       # cpal capture/playback, resample, ring buffers
│  ├─ aria-wake        # wake-word engine (ort), trait + onnx impl + fake
│  ├─ aria-stt         # whisper-rs wrapper, trait + impl + fake
│  ├─ aria-tts         # piper wrapper, streaming synth, trait + impl + fake
│  ├─ aria-llm         # gateway client (SSE), trait + local/cloud impls + fake
│  ├─ aria-orb         # wgpu renderer for the orb (pure view)
│  ├─ aria-ui          # egui settings/HUD, winit host, tray, hotkeys
│  ├─ aria-models      # resumable/checksummed model manager
│  ├─ aria-health      # watchdog: memory, liveness, circuit breakers
│  └─ aria-ipc         # (optional) out-of-process worker protocol, if used
└─ apps/
   └─ aria             # binary: wires crates, owns lifecycle
```

**Dependency rule:** `aria-core` depends on nothing app-specific — it defines the
traits (`WakeWord`, `Stt`, `Llm`, `Tts`, `AudioSource`, `AudioSink`) and the FSM.
Everything else depends *inward* on core. This is what makes the loop testable
with fakes (§11).

### 4.3 The voice loop (data flow)

```
mic ─PCM16k─▶ [ring buffer] ─frames─▶ Wake ──(detected)──▶ Core.FSM: LISTENING
                                    │
             capture keeps filling  ▼
        ┌── endpointing (energy/VAD, VAD default OFF) ──┐  (see A-3)
        │                                               │
        └─▶ utterance PCM ─▶ STT ─text─▶ Core ─prompt─▶ LLM
                                                         │ SSE tokens
                             sentence chunks ◀───────────┘
                                    │
                                    ▼
                       TTS (streaming synth) ─PCM─▶ [playback queue] ─▶ speaker
                                    │
                     barge-in: wake/energy during playback ─▶ stop TTS, → LISTENING (see A-7)
```

Latency-critical rule: **capture never blocks on downstream stages.** The RT
audio thread only fills a ring buffer; wake/STT read from it. TTS synthesis and
playback are decoupled by a bounded queue so token-by-token LLM output streams
into audio without head-of-line stalls *(see A-8)*.

---

## 5. Concurrency, lifecycle & failure isolation

This section replaces v2's supervisor/sidecar/UDS process model. It is the
highest-risk area for a "clean foundation," so it is specified in detail.

### 5.1 Threading model

- **RT audio thread** (cpal callback): lock-free, allocation-free in the hot
  path. Writes capture PCM to an SPSC ring buffer; reads playback PCM from
  another. Never awaits, never logs synchronously.
- **Tokio runtime** (multi-thread): LLM HTTP/SSE, model downloads, config I/O,
  event fan-out.
- **Inference worker threads** (blocking): one per FFI engine (STT, TTS, wake).
  These call into C/C++ and can block for tens–hundreds of ms; they must not run
  on the async pool.
- **UI thread**: `winit` event loop owns the window and wgpu surface (platform
  requirement). Renders orb + egui. Reads a lock-free snapshot of render state.

Communication is via **channels + an event bus**, never shared mutable state
across threads. Core owns the authoritative state; others send commands / receive
events.

### 5.2 In-process vs out-of-process — the key decision

**Decision:** Default to **in-process components on isolated threads**, with an
**escape hatch to out-of-process workers** (`aria-ipc`) reserved for engines that
prove crash-prone.

Rationale:
- In-process wins on latency (no serialization/UDS hop — v2's PCM-over-UDS was a
  measurable cost), simplicity, and packaging (one binary, no sidecar freezing).
- The one real risk of in-process is that a **segfault in C/C++ FFI**
  (whisper.cpp, onnxruntime) takes down the whole app — something v2's process
  isolation contained. Rust panics are catchable; foreign segfaults are not.

Mitigation, in priority order:
1. **Catch panics** at every worker boundary (`std::panic::catch_unwind` around
   each inference call); a panicking engine is marked unhealthy and restarted by
   `aria-health`, app stays up.
2. **Pin known-good native lib versions** and fuzz the FFI input shapes (odd PCM
   lengths, empty buffers — *see A-6*) in tests so foreign-code crashes are
   designed out rather than contained.
3. **Escape hatch:** if a given engine/GPU driver combo proves unstable
   (historically GPU drivers do), move *that engine only* behind `aria-ipc` as a
   supervised child process with the same trait interface. The rest stay
   in-process. This keeps the isolation benefit exactly where it's needed without
   paying for a full sidecar fleet.

### 5.3 Lifecycle & shutdown

- **Startup:** load+validate config → init models (verify checksums, no download
  in hot path) → start health watchdog → start audio → start UI. Each step is
  fallible and reported; a missing model degrades that stage, doesn't abort boot.
- **Shutdown (clean):** signal all workers to stop → drain playback →
  join threads with timeout → release GPU/audio devices. **No orphaned
  threads/processes.** For any out-of-process worker, use OS-level parent-death
  binding: `prctl(PR_SET_PDEATHSIG)` on Linux, **Job Objects** on Windows,
  process groups on macOS *(see A-5)*.
- **Restart guarding:** component restarts pass through a single supervisor with a
  **`recovering` guard flag** and backoff, so a crash-during-recovery cannot
  re-enter and spin *(see A-6)*.
- **Circuit breakers:** each external/fallible stage (LLM gateway, GPU inference)
  has a breaker that opens on repeated failure and **auto-resets** after a cooldown
  *(see A-11)*.

### 5.4 Health watchdog (`aria-health`)

- **RSS memory watchdog** with a configured ceiling; on breach, triggers a
  graceful restart of the offending component (not the whole app). This caught a
  real re-entrant restart bug in v2 — the fix (recovering flag) is baked into the
  restart path above.
- **Liveness:** each worker heartbeats; a stalled inference thread past a timeout
  is killed and restarted.
- **GPU/unresponsive handling:** GPU device-lost is a first-class event → drop to
  CPU backend for that stage, announce degradation via orb color.

---

## 6. Component specifications

Each component is defined by (a) its trait in `aria-core`, (b) its production
impl, (c) its fake for tests. Only behavioral requirements are given here.

### 6.1 Audio (`aria-audio`)
- Capture at device-native rate; resample to **16 kHz mono int16** for wake/STT.
- Playback accepts streaming PCM from TTS via a bounded queue.
- Ring buffers are lock-free SPSC; sizes are configured, not hardcoded.
- **Odd-length PCM must be handled** — carry the trailing byte across chunk
  boundaries; never assume even-length buffers *(see A-6)*.
- Master output gain and a live volume control feed the sink.

### 6.2 Wake word (`aria-wake`)
- Runs openWakeWord ONNX models on **int16** frames on CPU *(see A-4)*.
- Configurable **threshold** (default ~0.4), and **sub-phrase matching** (e.g.
  `hey_jarvis` should trigger on `jarvis`) *(see A-7)*.
- **VAD gating defaults OFF** — a Silero VAD gate silently broke wake detection in
  v2. If offered, VAD is opt-in and clearly labeled *(see A-3)*.
- Post-detection cooldown to prevent double-fires.
- Custom wake word support is a config option, not a rebuild.

### 6.3 STT (`aria-stt`)
- whisper.cpp via `whisper-rs`, GPU backend by default (Vulkan/Metal/CUDA),
  CPU fallback.
- **Warm/persistent model** — never cold-load per utterance (v2 cut ~604→251ms by
  keeping the server warm) *(see B-1)*.
- Thread count / backend selection are bounded by a hardware-detection step and a
  configurable GPU cap *(see A-12)*.
- Input contract: 16 kHz mono int16; endpointed utterance.

### 6.4 LLM (`aria-llm`)
- HTTP client with **SSE streaming**; emits tokens/sentences as they arrive.
- **Local gateway is the default** target; the endpoint, port, and API key are
  config — **do not hardcode a port** (v2's real gateway was on **8642 with a
  key**, not the preset 8000) *(see A-9)*.
- Connection tuning: **keep-alive** and **`TCP_NODELAY`** on the socket to shave
  first-token latency *(see A-8)*.
- Cloud impl is a drop-in behind the same trait, selected by config.
- Split system prompts: the **assistant's** conversational prompt is entirely
  separate from any internal/tool prompt, with anti-confabulation guidance, so the
  model can't hallucinate tool calls into user-facing replies *(see A-13)*.

### 6.5 TTS (`aria-tts`)
- Piper ONNX, persistent voice, CPU (30× realtime, 34–82ms first chunk in v2)
  *(see B-2)*.
- **Streaming/eager synthesis:** begin synthesizing the first sentence as soon as
  the LLM emits it; do not wait for the full reply *(see A-8)*.
- A **worker queue** owns synthesis so a **stop** (barge-in) can cancel in-flight
  and queued work atomically *(see A-7)*.
- **`sanitize_for_speech`** filter strips markdown, code fences, emoji, URLs, and
  other non-spoken artifacts before synthesis *(see A-14)*.
- Configurable voice, live **speed** (Piper `length_scale`) and volume.
- Filler/acknowledgement handling: if a short filler is played, the real reply
  **queues behind it** and nudges faster — filler must never cut off the reply
  *(see A-15)*.

### 6.6 Orb renderer (`aria-orb`)
- wgpu-rendered orb. **Pure view** — reads a state snapshot, owns no logic.
- **Frame rate is capped** and the render loop is **throttled/paused when the
  window is hidden, minimized, or unfocused**, and **gated** when idle. Uncapped
  render + audio-RMS loops were the direct cause of v2's CPU/crash incidents
  *(see A-1)*.
- Visual language (carry forward from v2): constant slow spin at rest; deform
  amplitude driven by TTS output RMS **only while speaking**; state colors —
  e.g. idle/listening/thinking/speaking/error — mapped to distinct hues.
- RMS-driven deformation reads the **same playback buffer** the sink uses; it does
  not run its own uncapped sampling loop.

### 6.7 Settings & HUD (`aria-ui`)
- egui panels: general, voice (wake word, voices, speed, volume), models,
  performance, advanced.
- **Performance panel:** per-stage latency (wake→STT→first-token→first-audio→full
  reply), timed **from `audio_end`, not `audio_start`** *(see A-16)*, plus RSS and
  GPU status. Backed by `tracing` spans.
- Global **hotkey** to summon/mute. Abstract the hotkey behind a trait:
  **Wayland does not support global shortcuts** — detect and fall back to a
  tray action / focus-based trigger, don't assume it works *(see A-17)*.
- System **tray** presence and window show/hide.

### 6.8 Model manager (`aria-models`)
- **Resumable, checksum-verified** downloads (SHA-256) with progress events.
- Models live in a known cache dir; integrity is verified at boot before a stage
  is marked ready.
- No inference stage cold-downloads in the hot path — missing model → degraded
  stage + UI prompt to fetch.

---

## 7. Configuration

- Single **TOML** file, `serde`-validated, **versioned** with a `schema_version`
  field and forward-migration on load.
- Every tunable named in this spec lives here: audio buffer sizes, wake threshold,
  VAD on/off, STT backend/threads/GPU cap, LLM endpoint/port/key/keep-alive,
  TTS voice/speed/volume, orb FPS cap, memory ceiling, breaker thresholds.
- Secrets (API keys) use the OS keychain where available (`keyring` crate) rather
  than plaintext; the v2 `safeStorage` cross-platform lessons apply.
- Sensible local-first defaults; the app runs fully offline with zero config.

---

## 8. Cross-platform strategy

- **Single codebase, `cfg`-gated platform specifics.** Byte-for-byte identical
  behavior is the goal; platform code is confined to: audio device quirks, GPU
  backend selection (Vulkan/Metal/DX/CUDA), hotkeys, tray, parent-death binding,
  keychain, and packaging.
- Parent-death / orphan prevention: `PR_SET_PDEATHSIG` (Linux), Job Objects
  (Windows), process-group kill (macOS) *(see A-5)*.
- GPU backend probing per platform with CPU fallback everywhere.
- **CI builds and smoke-tests all three targets** — v2 repeatedly shipped
  Linux-verified changes that were broken on Windows/macOS (venv paths, `.exe`
  suffixes, shell quoting). Native Rust removes most of these, but the CI matrix
  is non-negotiable.

---

## 9. Packaging & distribution

- **One statically-linked binary** per platform plus bundled models/assets.
  No Python runtime, no sidecar freezing (PyInstaller is gone).
- Installers: `.deb` + `.AppImage` (Linux), `.dmg` (macOS), `.exe`/MSI (Windows).
- Auto-update channel with signed artifacts.
- Bundle native inference libs (whisper.cpp, onnxruntime) as vendored/prebuilt per
  platform; verify GPU backends actually build in CI, not just link.

---

## 10. Observability

- `tracing` spans wrap every stage; span durations feed the perf panel and logs.
- Structured logs with levels; a debug overlay toggles verbose timing.
- No cloud telemetry. Everything stays local.

---

## 11. Testing strategy (foundation priority)

Because "clean, well-tested core" is the v1 priority, testing is a **first-class
requirement**, not an afterthought.

1. **Trait fakes for every engine.** `FakeWake`, `FakeStt`, `FakeLlm`, `FakeTts`,
   `FakeAudio` let the entire voice-loop FSM run deterministically with no models,
   no GPU, no network.
2. **FSM unit tests.** Every state transition (idle→listening→thinking→speaking,
   barge-in, error/degrade, restart-guard) covered in `aria-core` with fakes.
3. **Golden pipeline test.** A fixture WAV → real STT → recorded LLM → real TTS →
   PCM out, asserted against tolerances. The v2 `smoke:all` equivalent.
4. **FFI robustness tests.** Feed engines odd-length PCM, empty buffers, silence,
   truncated audio — the exact shapes that crashed v2 native code *(see A-6)*.
5. **Concurrency/lifecycle tests.** Simulated crash of each worker asserts the app
   survives, the watchdog restarts it, and no thread/process leaks (assert on
   handle counts before/after).
6. **Latency budget tests** with **generous, load-tolerant budgets** — v2's tight
   e2e budgets flaked under CI load. Budgets are regression tripwires, not perf
   targets, and are marked load-sensitive *(see A-18)*.
7. **Snapshot tests** (`insta`) for config migration and `sanitize_for_speech`.
8. **CI matrix** across Linux/macOS/Windows (§8).

---

## 12. Milestones (phasing, not step-by-step)

Ordered by the clean-foundation priority. Each milestone ends green + tested.

- **M0 — Skeleton & seams.** Workspace, `aria-core` traits + FSM, all fakes,
  config load/validate, full voice loop running end-to-end **with fakes only**.
  Proves the architecture before any model touches it.
- **M1 — Real audio + wake.** cpal capture/playback, resample, ring buffers,
  openWakeWord ONNX. Orb renders (capped) and reacts to wake.
- **M2 — Real STT + LLM + TTS.** whisper-rs (warm), gateway SSE client, Piper
  streaming. First real spoken round-trip. Meet Appendix B baselines.
- **M3 — Lifecycle hardening.** Watchdog, panic isolation, circuit breakers,
  restart guard, clean shutdown/no-orphans, cross-platform parent-death.
- **M4 — UI & settings.** egui panels, perf panel, tray, hotkey abstraction with
  Wayland fallback, model manager UI.
- **M5 — Packaging.** Three-platform CI, installers, auto-update, signing.
- **M6 — Feature parity.** Barge-in, screen-share/vision (glance = low detail),
  custom wake words, voice/speed/volume live controls, filler handling.

Latency optimization is folded into M2 (meet baselines) and revisited after M6.

---

## Appendix A — Known Pitfalls (carried forward from v1/v2)

Consult the relevant item before implementing a component. These are failures we
have *already paid for*; do not rediscover them.

- **A-1 — Uncapped render/RMS loops burn CPU and crash.** v2's two
  `requestAnimationFrame` loops (orb render + TTS RMS sampling) ran uncapped and
  were the root cause of CPU spikes and crashes. Native fix: cap FPS,
  throttle/pause when hidden/unfocused, gate when idle, and read RMS from the
  shared playback buffer instead of a second sampling loop.
- **A-2 — UI must never stall the audio loop.** Keep rendering strictly a view of
  a lock-free state snapshot; audio/inference threads never wait on the UI.
- **A-3 — VAD gate defaults OFF.** A Silero VAD gate defaulting ON silently broke
  wake-word detection. Ship VAD opt-in only, clearly labeled.
- **A-4 — Wake word needs int16 input.** openWakeWord expects int16 frames. Do
  **not** pass an `inference_framework` kwarg to openWakeWord 0.4.0 — it's
  rejected. (Native path uses `ort` directly, but the input contract stands.)
- **A-5 — Prevent orphans with OS parent-death binding.** Any child
  process/worker must die with the parent: `PR_SET_PDEATHSIG` (Linux), Job Objects
  (Windows), process groups (macOS). v2 needed a PDEATHSIG backstop.
- **A-6 — Handle odd-length PCM.** Native audio/inference code crashed on
  odd-length PCM buffers. Carry the trailing byte across chunks; fuzz-test empty
  and truncated buffers.
- **A-7 — Barge-in / TTS stop must be atomic.** Wake word or energy during
  playback must stop in-flight *and* queued TTS work cleanly and return to
  listening. Use a worker-queue with a cancel signal. Support sub-phrase wake
  matching (`jarvis` → `hey_jarvis`).
- **A-8 — Latency comes from streaming + socket tuning.** Eager/streaming TTS
  (synth the first sentence while the LLM is still generating), LLM keep-alive,
  and `TCP_NODELAY` were the real latency wins. Decouple synth from playback with
  a bounded queue to avoid head-of-line stalls.
- **A-9 — Do not hardcode the LLM endpoint.** The real local gateway was on
  **port 8642 and required a key**, not the preset default 8000. Endpoint, port,
  and key are config.
- **A-10 — Model downloads must be resumable + checksummed.** Partial/corrupt
  downloads otherwise wedge a stage silently.
- **A-11 — Circuit breakers must auto-reset.** A breaker that opens and never
  recovers permanently disables a stage. Add a cooldown auto-reset.
- **A-12 — Cap GPU threads/backend by detected hardware.** Unbounded STT thread
  counts / wrong backend selection hurt more than help; bound by a hardware probe
  and a user GPU cap.
- **A-13 — Split assistant and internal system prompts.** Sharing one
  system prompt caused the LLM to hallucinate tool-call syntax into user replies.
  Keep them separate with anti-confabulation guidance.
- **A-14 — Sanitize text before speech.** Strip markdown, code, emoji, URLs, and
  symbols before TTS or the assistant "speaks" punctuation and code.
- **A-15 — Filler must never cut off the reply.** If a short acknowledgement is
  played, the real reply queues behind it and nudges faster; never let filler
  truncate the answer.
- **A-16 — Time latency from `audio_end`, not `audio_start`.** Perf metrics
  (first-audio, full-reply) must be measured from when the user *stopped* speaking.
- **A-17 — Wayland has no global shortcuts.** Detect the compositor and fall back
  to tray/focus triggers; don't assume a global hotkey registers.
- **A-18 — Keep e2e latency budgets generous.** Tight budgets flake under CI/parent
  load. Treat them as regression tripwires, mark them load-sensitive, and don't
  gate merges on marginal timing.
- **A-19 — Screen-share/vision: match detail to intent.** For quick "glance"
  questions, downscale frames (~768px) and skip the heavy vision path; only go
  high-detail when the ask needs it.

---

## Appendix B — Verified Performance Baselines (from v2)

v3 must **meet or beat** these on comparable hardware. They are targets for M2,
not v1 gates.

- **B-1 — STT (whisper.cpp Vulkan, RX 9060 XT):** ~69 ms encode, ~459 ms total for
  3 s audio cold; **warm persistent server ~251 ms** (down from ~604 ms cold);
  local first-audio path ~324 ms.
- **B-2 — TTS (Piper, persistent voice, CPU):** 34–82 ms first chunk, ~30×
  realtime.
- **B-3 — Wake word (openWakeWord 0.4.0, CPU):** ~2.19 ms per frame.
- **B-4 — Voice loop:** local first-audio ~324 ms from `audio_end`.

Hardware note: baselines were measured on an AMD RX 9060 XT (Vulkan). v3's GPU
backend must pick the best available (Vulkan/Metal/CUDA/DX) with CPU fallback.

---

## Appendix C — Open decisions (resolve before or during M0)

1. **TTS engine binding:** `piper-rs` vs Piper ONNX via `ort` directly — spike
   both in M2; pick on first-chunk latency and build simplicity.
2. **egui + orb compositing:** single wgpu surface shared between the orb renderer
   and egui, vs separate windows. Prefer shared surface; validate in M1.
3. **Out-of-process escape hatch trigger:** define the concrete stability
   threshold (crash rate / driver blocklist) that moves an engine from in-process
   to `aria-ipc` (§5.2).
4. **Cloud provider(s):** which cloud STT/LLM/TTS to implement first behind the
   traits (local-first, cloud-optional). Deferred past v1.
