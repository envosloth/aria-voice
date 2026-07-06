# Conventions

How to write code that fits ARIA. The house style is **minimal and boring**: the
smallest change that works, reusing what's already here, commented for *why*.

## The laziness ladder (stop at the first rung that holds)

1. Does this need to exist at all? Speculative need → skip it.
2. Is it already in the codebase? A helper/util/type/pattern a few files over →
   reuse it. (Re-implementing what exists is the most common slop here.)
3. Does the stdlib / Node / Web platform do it? Use it.
4. Does an already-installed dependency solve it? Use it.
5. Can it be a few lines? Write the few lines.
6. Only then: the minimum new code that works.

**No new runtime dependency** for what a few lines can do — this is a hard project
rule, not a preference. `package.json` has exactly one runtime dep on purpose. If you
genuinely need one, justify it in the PR.

No speculative abstractions: no interface with one implementation, no factory for one
product, no config for a value that never changes.

## `ponytail:` comments

Deliberate shortcuts are marked in-code with a `ponytail:` comment naming the ceiling
and the upgrade path — e.g. `// ponytail: newest MAX_SESSIONS kept, whole array
rewritten per turn; switch to append-only log only if history gets large`. When you
take a known shortcut, leave one. When you hit one that no longer holds, that comment
tells you how to grow it. Grep `ponytail:` to see the current debt ledger.

## Comments

Comment the **why**, not the **what**. Match the surrounding density — this codebase
is heavily commented with the *reasoning and the bug that motivated the code*
(you'll see "the X bug", "was the crash path", "past this point…"). A one-line
rationale on a non-obvious guard is expected. A comment restating the code is noise.

## Bug fixes = root cause

A report names a symptom. Before editing, find every caller of the function you're
about to touch and fix it **once** where they all route through, not per-caller. Read
the whole flow first; the smallest diff in the wrong place is a second bug.

## Style specifics

- **TypeScript** (`src/main`, `src/preload`) — `npm run lint` (eslint) and
  `npm run typecheck` (`tsc --noEmit`) must be clean. Prefer pure, Electron-free
  functions where possible (that's what makes `llm-stream`, `router`, `audio-utils`
  unit-testable).
- **Renderer JS** is plain ES modules loaded by `<script>` — **no bundler, no
  framework**. Keep it that way. `index.html` holds all CSS + DOM.
- **Python sidecars** subclass `BaseSidecar`; keep them single-purpose and dependency-lean.
- Import channel names from the `IPC` registry; never hardcode an IPC string.
- Secrets: `secure-storage` only. Never log a key, never put one in `electron-store`.

## Commits & PRs

- Subject: `type: short imperative summary` (`fix`, `feat`, `docs`, `refactor`,
  `test`, `chore`). Version-stamped subjects (`fix(2.13.12): …`) are for the
  maintainer's release commits — don't bump the version in a contributor PR.
- One logical change per PR; explain the root cause. Fill in the PR template.
- The release flow (maintainer): bump `package.json` + lockfile, commit on `main`,
  push, then push a lightweight `vX.Y.Z` tag — CI builds the cross-platform
  installers on the tag. See [gotchas.md](gotchas.md).

## Testing philosophy

- The `smoke:*` suites **drive the real sidecars** (only the remote LLM is mocked).
  `smoke:all` is the gate; `smoke:boot` loads the real renderer headless.
- Non-trivial logic leaves **one runnable check** — extend an existing `smoke:*`,
  don't add a framework or fixtures.
- **A test that only greps source strings does not verify behavior.** The
  `smoke:session-features` string checks passed while the session menu was visually
  clipped and unusable. For anything rendered or timing-dependent, drive the real
  path — run `npm run dev` and watch it.
- If you change latency, GPU/CPU load, or the crash surface, measure it and say so.
