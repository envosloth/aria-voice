# ARIA v3 — Integrity Verification Log

Ralph-loop verification record. Each iteration re-runs the battery, fixes
what it finds, and appends here. Newest first.

## Iteration 5 — 2026-07-03 · drift check

No changes since pass 4 (HEAD 43b40e4). Suite 38/38 · boot clean · quit
clean. Only the ralph-loop state file had churned — now gitignored.

## Iteration 4 — 2026-07-03 · STEADY STATE

No new runtime defects found. This pass exercised the last untested
deliverable — packaging — and re-ran the battery.

| Check | Result |
|---|---|
| `cargo deb -p aria` (first ever run) | builds `aria-voice_0.1.0-1_amd64.deb` (14.6 MB) |
| .deb contents | /usr/bin/aria + desktop entry + icon + copyright — all present |
| .deb Depends | libasound2, libc6 (matches ldd) |
| release.yml | parses; linux/macos/windows jobs present |
| `cargo test` | 38 passed, 0 failed |
| Boot → quit cycle | clean |
| Fix applied | `license = "MIT"` added (cargo-deb warning) |

Verdict after 4 passes: battery is stable and green; the loop has converged.
Remaining unverifiable-from-here items are unchanged (screen-share portal
dialog, acoustic wake rate w/ mic gain, CI on a real GitHub remote).

## Iteration 3 — 2026-07-03

### Defects found & fixed
1. **Double-launch ran two assistants**: a second plain `aria` (e.g. clicking
   the app icon again) deleted the live instance's socket, bound its own, and
   both answered the microphone. Now a second launch sends "show" to the
   running instance (window surfaces) and exits. Verified live: boot → second
   launch exits 0 immediately → still exactly 1 process → quit clean.
2. **Latent Kokoro out-of-bounds panic**: the style table has rows 0..=509
   but tokens were truncated to 510 and the row index is `tokens.len()` — a
   sentence hitting the cap would slice past the table. Truncation is now 509;
   new test synthesizes a ~600-phoneme run-on sentence (passes, no panic).
3. **Corrupted build artifacts** from an interrupted session (Exec format
   error + invalid rlib metadata) — cleaned and fully rebuilt; suite green.

### Battery results
| Check | Result |
|---|---|
| `cargo test` | 38 passed, 0 failed (was 37) |
| Second-launch single-instance guard | PASS (1 process, exit 0) |
| `aria --quit` after the above | PASS |
| Release build | clean, 0 warnings |
| Installed binary | refreshed |

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
