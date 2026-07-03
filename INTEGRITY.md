# ARIA v3 — Integrity Verification Log

Ralph-loop verification record. Each iteration re-runs the battery, fixes
what it finds, and appends here. Newest first.

## Iteration 2 — 2026-07-03

### Defects found & fixed
1. **Quit/toggle dead when the compositor idles the window** (reproduced
   twice): GNOME Wayland stops frame callbacks for occluded/idle surfaces,
   stalling the eframe render loop — and Quit was routed through it as a
   UiEvent, so `aria --quit` (and toggle) silently did nothing until the
   window repainted. Fixes: (a) socket "quit" now calls `process::exit(0)`
   directly — shutdown can never depend on the render loop; (b) new
   `aria_ui::ping_ui()` (global egui Context handle) — the socket thread and
   every runtime event now `request_repaint()` so toggle/wake/Show drain even
   from an idled loop. Verified: 2× fresh boot → straight quit → 0 processes.
2. **New coverage** (spec §11.5 was untested): `PanicLlm` test proves an LLM
   panic is contained (counts toward the breaker, app lives); breaker test
   proves it opens after 3 failures and fast-fails while open; hallucination
   guard edge tests (quiet+filler dropped, loud or substantive kept).

### Battery results
| Check | Result |
|---|---|
| `cargo test` | 37 passed, 0 failed (was 34) |
| Live RSS after boot (Kokoro+whisper+ort loaded) | 588 MB — ceiling 2048 MB |
| Thread count live | 60 (inference pools; no leaks across turns) |
| `aria --quit`, fresh boot ×2 | PASS, PASS |
| `aria --loop-fakes` | M0 loop OK |
| Desktop entry Exec path | ok |
| Alt+Shift+Space gsettings binding | present |
| history.jsonl | all lines valid JSON |


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
