# Contributing to ARIA

Thanks for your interest! ARIA is a local-first, GPU-accelerated voice assistant
(Electron + TypeScript main process, frozen Python sidecars for STT/TTS/wake
word). This guide gets you from clone to merged PR.

New here? Read the [README](README.md) first, then this file. For a deeper mental
model of the codebase, the [`collaboration/`](collaboration/) folder is an
onboarding kit (architecture map, IPC contract, conventions, and the hard-won
gotchas that aren't obvious from the code).

## Ground rules (project constraints)

These are deliberate and non-negotiable without a strong reason — they come from
[`BUILD_SPEC.md`](BUILD_SPEC.md) and real crashes:

- **No ROCm dependency.** The target OS (Ubuntu 26.04 / kernel 7.0) isn't in AMD's
  ROCm support matrix. STT uses **whisper.cpp with the Vulkan backend**, never ROCm.
- **No faster-whisper / CTranslate2.** Its ROCm path crashes on RDNA 4.
- **No new runtime dependencies** for something a few lines of stdlib/native code
  can do. Adding a dependency needs justification in the PR. See the ["ladder"](collaboration/conventions.md).
- **Never ship `--no-sandbox`** in packaged builds. Dev/test uses it; production must
  configure the Chromium SUID sandbox.
- **Secrets go in the OS keyring** via Electron `safeStorage` — never `electron-store`,
  never plaintext, never logged.
- **Linux is the reference platform**, validated end-to-end. Windows/macOS are built
  via CI and very much welcome hands-on validation.

## Development setup

Full instructions are in the [README](README.md#setup-development). In short:

```bash
npm install
./scripts/build-whispercpp.sh                 # whisper.cpp + Vulkan
for s in stt tts wakeword; do                 # per-sidecar Python venvs
  python3 -m venv sidecars/$s/venv
  sidecars/$s/venv/bin/pip install -r sidecars/$s/requirements.txt
done
./scripts/download-models.sh small
npm start        # or: npm run dev  (with inspector)
```

Requires Node 22+, Python 3.12+, cmake, g++, and the Vulkan/keyring system
packages listed in the README.

## The dev loop

```bash
npm run build       # tsc + preload bundle + copy renderer
npm run lint        # eslint src/
npm run typecheck   # tsc --noEmit
npm run smoke:all   # full suite: drives the REAL sidecars (only the LLM is mocked)
npm run smoke:boot  # headless Electron boot (loads the real renderer, auto-quits)
```

Individual suites are `npm run smoke:<name>` — see `package.json` for the full list
(`smoke:stt`, `smoke:tts`, `smoke:llm`, `smoke:orb`, `smoke:e2e`, …).

## Before you open a PR

1. `npm run build && npm run lint && npm run typecheck` — all clean.
2. `npm run smoke:all` green (or at minimum the suites your change touches, plus
   `smoke:boot` for any renderer change).
3. **Add a runnable check** for non-trivial logic — extend an existing `smoke:*`
   rather than adding a framework. A test that only greps source strings does not
   count as verifying behavior; drive the real path.
4. **Actually run the app** for any UI change (`npm run dev`). Rendered behavior
   (menus, positioning, timing) can't be caught by string checks — this is how the
   session-menu clipping bug shipped once.
5. Keep the diff minimal and match the surrounding code — including its comment
   density. We comment the *why*, not the *what*.

## Commit & PR conventions

- Commit subjects: `type: short imperative summary` (`fix:`, `feat:`, `docs:`,
  `refactor:`, `test:`, `chore:`). Version-stamped subjects like `fix(2.13.12): …`
  are reserved for release commits the maintainer makes — you don't need to bump
  the version in your PR.
- Branch off `main`; open the PR against `main`. Fill in the PR template.
- One logical change per PR. Explain the root cause, not just the symptom.
- If your change alters latency, GPU/CPU load, or the crash surface, say so and how
  you measured it.

## Reporting bugs / requesting features

Use the issue templates (Bug report / Feature request). For anything touching API
keys, the keyring, or the sandbox, please read [SECURITY.md](SECURITY.md) first —
some things belong in a private report, not a public issue.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
