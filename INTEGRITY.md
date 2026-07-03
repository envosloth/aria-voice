# ARIA v3 — Integrity Verification Log

Ralph-loop verification record. Each iteration re-runs the battery, fixes
what it finds, and appends here. Newest first.

## Iteration 1 — 2026-07-03

### Defects found & fixed
1. **Dropped commands mid-reply** (`runtime.rs respond()`): non-interrupt
   commands (SaveSettings, SetVoice, ScreenShare, CheckUpdate) arriving while
   ARIA spoke were stuffed into `interrupt` and discarded unless a barge-in
   happened. → collected into `deferred`, re-queued after the turn. FIXED.
2. **Barge-in blocked on the full LLM stream**: cancelling a reply stopped
   audio instantly but `thread::scope` joined the SSE worker only after
   Hermes finished streaming — ARIA couldn't listen again for seconds.
   → `Llm::complete`'s `on_sentence` now returns `bool`; `false` aborts the
   stream within one token (connection dropped). All impls/tests updated. FIXED.
3. **No version control**: entire project had zero git history.
   → `git init` + `.gitignore` + full initial commit `42d4da1`. FIXED.
4. Clippy had never run: 10 warnings → autofix applied (derive Default,
   redundant `Ok(?)`); 4 benign style lints remain (match-for-equality,
   unwrap-after-is_some, large enum variant, manual checked div).

### Battery results (all pass)
| Check | Result |
|---|---|
| `cargo test` full workspace | 34 passed, 0 failed |
| `cargo clippy` | 0 errors, 4 benign style warnings |
| Release build | clean, 0 warnings |
| `aria --loop-fakes` (M0 path) | `M0 loop OK` |
| Boot (UI + voice + Kokoro + Vulkan STT) | no panics, no ui errors |
| `aria --toggle` against running instance | ok (3 ms) |
| `aria --quit` | process exits, 0 stragglers |
| Live gateway round-trip (`--ask`) | reply spoken via Kokoro ("Sounds good.") |
| history.jsonl | 6/6 lines valid JSON |
| ~/.local/share/aria/aria.log | zero panics ever recorded |
| Installed binary vs source | in sync (reinstalled this iteration) |

### Known-good baselines (unchanged)
- STT warm: 135 ms (base.en, Vulkan) · Kokoro: 405 ms/sentence
- Wake: fixture fires at threshold 0.35 (mic hardware gain is the only live blocker)
- First-audio dominated by Hermes first token (4–9 s, external)

### Not verifiable from this seat
- Screen-share portal flow (needs user's one-time GNOME dialog)
- Wake-word acoustic hit rate (mic gain knob turned down)
- CI matrix (no GitHub remote configured)
