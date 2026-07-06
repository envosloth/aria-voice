# ARIA — AI Contributor Kit

You are (probably) an AI agent about to change this codebase. This folder is
everything you need to do that well without relearning the hard way. Read it
before your first edit.

## Read in this order

1. **[/README.md](../README.md)** — what ARIA is, how to build/run/test, latency
   numbers. Start here if you haven't.
2. **[/CLAUDE.md](../CLAUDE.md)** — the canonical short spec: stack, constraints,
   commands, sidecar IPC summary, project structure.
3. **[architecture.md](architecture.md)** — the mental model: processes, data flow,
   and what each `src/` file owns.
4. **[ipc-contract.md](ipc-contract.md)** — the sidecar protocol and the main↔renderer
   IPC channels. The thing you're most likely to break silently.
5. **[conventions.md](conventions.md)** — how to write code that fits here: the
   laziness ladder, commit/PR rules, the testing philosophy.
6. **[gotchas.md](gotchas.md)** — the landmines. Hard-won constraints and crashes.
   **If you skip one file, don't skip this one.**
7. **[/BUILD_SPEC.md](../BUILD_SPEC.md)** — the *why* behind the stack choices
   (Vulkan not ROCm, Piper/Kokoro on CPU, etc.), with sources.

Also: `docs/` holds the v3 native rewrite spec and the cross-platform hardening
notes.

## The 60-second model

- **Electron main (TypeScript, `src/main/`)** owns everything privileged: spawns and
  supervises the Python sidecars, talks to the remote LLM/agent, holds conversation
  state and secrets.
- **Renderer (`src/renderer/`, vanilla JS)** is sandboxed. It's the UI, the orb
  (canvas), mic capture, and Web Audio playback. It reaches main only through the
  `contextBridge` allowlist in `src/preload/index.ts`.
- **Python sidecars (`sidecars/`)** are frozen (PyInstaller) single-purpose
  processes: `stt` (whisper.cpp/Vulkan), `tts` (Piper/Kokoro), `wakeword`
  (openWakeWord). They speak a tiny protocol: control JSON on stdin, results/status
  JSON on stdout, PCM over a Unix domain socket.
- **The remote LLM/agent** is user-configured and OpenAI-compatible. ARIA never
  bundles a model; STT/TTS/wake word are 100% local.

```
 mic ─▶ renderer (worklet, 16k PCM) ─▶ main ─▶ wakeword + stt sidecars
                                         │
 user speech ──▶ STT text ──▶ coordinator ──▶ remote LLM or agent harness (SSE)
                                         │
 reply tokens ──▶ TTS sidecar ──▶ PCM ──▶ renderer Web Audio ──▶ speakers + orb
```

## Before you touch anything

```bash
npm run build && npm run lint && npm run typecheck   # must stay clean
npm run smoke:all                                    # real sidecars, mock LLM
npm run smoke:boot                                   # loads the real renderer headless
```

Then make the **smallest change that works** (see [conventions.md](conventions.md)),
add a runnable check, and — for any UI/behavior change — actually run `npm run dev`
and watch it. String-only tests have shipped visible bugs here.

## When your memory of this repo is stale

Docs drift. If a file/function/flag named here doesn't exist anymore, trust the
code, not this folder — then fix the doc. Everything here was verified against the
code at the time of writing, but you are the current source of truth.
