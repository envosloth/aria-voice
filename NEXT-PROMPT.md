# ARIA v3 — next work session prompt

Copy-paste everything below the line into a fresh Claude Code session in
`~/aria-v3-spec`. Items are ordered by user-felt value; each has its
acceptance test. Everything above this line's date is already shipped
(conversation mode, wake chime, self-barge-in guard, hallucination filter,
history rotation, live settings, quit paths, full interruption).

---

I'm continuing ARIA v3 (native Rust voice assistant, `~/aria-v3-spec`,
Cargo workspace, 34 tests green — read `CLAUDE`/memory first). Implement the
following, in order, verifying each with a real measurement or a test before
moving on. Stop when my usage budget gets tight and leave the rest with notes.

1. **Streaming partial transcripts.** While I speak, show live words in the
   chat (grey/italic bubble that solidifies on endpoint). Approach: every
   ~500 ms during capture, run whisper tiny.en on the accumulated utterance
   buffer in a worker thread (drop stale results; GPU makes this cheap:
   base.en full-utterance is 135 ms warm). New `UiEvent::Partial(String)`.
   Accept: saying a 5-second sentence shows at least 3 partial updates.

2. **Real sessions in the sidebar.** history.jsonl → per-session files
   (`sessions/<epoch>.jsonl`), "New session" button, sidebar lists last 5 by
   first user message, clicking switches chat + LLM context to that session.
   Accept: create two sessions, restart the app, both restore correctly.

3. **Tool-activity surface.** Hermes' OpenAI endpoint only streams content
   deltas, so parse reply-side markers instead: while status is quiet >4 s
   we already play filler — also add a chat "Tool" chip showing elapsed time
   ("agent working · 12 s") that finalizes when the reply lands.
   Accept: a slow harness query shows the working chip, then the reply.

4. **Tray icon.** Use the `tray-icon` crate (needs libappindicator/gtk on
   GNOME) with menu: Show/Hide, Screen share toggle, Quit. Must coexist with
   the winit event loop (see tray-icon's winit example — event loop proxy).
   If GNOME requires an extension for appindicators, detect and fall back to
   the current socket/hotkey flow without erroring.
   Accept: closing the window shows the tray icon; Quit from tray exits.

5. **Echo cancellation.** Load PipeWire's echo-cancel module for the app's
   capture stream (`pactl load-module module-echo-cancel ...`) at startup
   (config-gated, default on, unload on exit), then lower the self-barge-in
   threshold bump from +0.25 back toward +0.10.
   Accept: play TTS at full volume; wake word from the human still triggers,
   TTS audio alone doesn't (test by playing a recording of ARIA saying
   "hey jarvis" through the speakers — should NOT fire with AEC on).

6. **Model manager.** `aria-models` crate per spec §6.8: resumable +
   SHA-256-checksummed downloads with progress events; Settings → Models tab
   listing required models (whisper tiny/base/small, kokoro, wake) with
   download buttons; missing model = degraded stage + prompt, never a crash.
   Accept: delete ggml-tiny.en.bin, download it from the UI, checksum passes.

7. **Markdown rendering in chat** (display only; speech already sanitized):
   bold, inline code, code blocks (mono, dark chip), lists. Keep the manual
   galley layout for bubbles — render markdown to a LayoutJob.
   Accept: a reply containing ```code``` renders as a code chip, no overlap.

8. **Finish the CI matrix** (spec §8): make mac/win jobs build the full app
   (piper-rs/espeak needs cmake+clang on both; whisper Metal on mac, CPU on
   win), upload artifacts, and gate release on all three passing.
   Accept: green run on a `v*` tag for all three OS jobs.

Known constraints: Hermes gateway = localhost:8642 (key in aria.toml),
first token 4–7 s (external, don't chase it); mic is a TONOR TD520S — check
its gain knob before debugging "wake word broken"; egui 0.35 API notes and
all past pitfalls are in the project memory file.
