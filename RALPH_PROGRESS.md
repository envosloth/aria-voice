# RALPH_PROGRESS

Tracking for the Ralph loop task in `RALPH_TASK.md`. One section per item.

## Standing-constraints scorecard (revisit every item)
- Stability under sustained use: existing crash hardening intact (uncaughtException/
  unhandledRejection kept-alive handlers, renderer reload-on-gone). No new crash paths.
- Memory: perf harness uses a bounded ring buffer (512 marks, `shift()` on overflow) —
  no unbounded growth. OFF by default.
- Idle CPU: perf harness adds nothing when disabled (boolean check + early return);
  when enabled, marks are fire-and-forget and only happen on interaction boundaries.
- UI responsiveness: perf marks on the renderer hot path are `ipcRenderer.send`
  (non-blocking, never awaited). Measured app-side overhead ~3ms (see Item 0 baseline).
- Latency < 500ms: text path user-visible time-to-first-text measured at 53ms (fast
  provider) / 361ms (350ms-TTFT provider) — app adds ~3ms; rest is provider TTFT.

---

## Item 0: Build a latency measurement harness
Status: done
Findings:
- The interaction hot path spans two processes: renderer (UI, TTS playback) and
  main (IPC, coordinator, streamChat SSE). There was no latency instrumentation;
  only ad-hoc `[ARIA]`/`[ARIA_SMOKE]` console logs.
- Key stages identified — text: user_input -> dispatch -> main_recv -> llm_request
  -> first_token -> first_token_render -> (tts_first_request -> tts_first_audio) ->
  llm_done -> turn_complete. Voice prepends: audio_start -> audio_end ->
  stt_start -> stt_transcribe_req -> stt_result -> stt_result_render.

Fix (files touched):
- `src/main/perf.ts` (new): structured perf logger. OFF by default; enable via
  `ARIA_PERF=1` env or `debug.perf` config. Emits one grep-able line per mark:
  `[ARIA_PERF] turn=<id> stage=<name> t=<epochMs> proc=<main|renderer> [k=v...]`.
  Bounded 512-entry ring buffer (`recentMarks()`); zero overhead when disabled.
- `src/renderer/perf.js` (new): `window.AriaPerf` { newTurn, mark, isEnabled }.
  Queries enablement once at load; marks are fire-and-forget IPC, forwarded to
  main so renderer + main marks land in ONE timeline (main stdout).
- `src/shared/ipc-channels.ts`: added `PERF_ENABLED`, `PERF_MARK`.
- `src/preload/index.ts`: added `aria.perf.{enabled,mark}`; threaded a `turnId`
  through `aria.llm.send(msg,img,turnId)` and `aria.stt.start(turnId)` so a single
  correlation id spans processes.
- `src/main/index.ts`: PERF_ENABLED/PERF_MARK handlers; marks `main_recv`,
  `stt_start`, `stt_transcribe_req`, `stt_result`; boot honors `debug.perf`.
  Added an `ARIA_PERF_LIVE` SMOKE hook that drives one real text turn for the
  live baseline runner.
- `src/main/coordinator.ts`: marks `llm_request`, `first_token` (first token only),
  `llm_done`; `turnId` added to `CoordinateOptions`.
- `src/renderer/app.js`: marks `user_input`, `dispatch`, `audio_start`,
  `audio_end`, `stt_result_render`, `first_token_render`, `tts_first_request`,
  `tts_first_audio`, `turn_complete`; safe no-op stub if perf.js absent.
- `scripts/perf-baseline.js` (new, `npm run perf:baseline`): drives real
  streamChat against a mock SSE server with tunable TTFT; reports req->1st-tok /
  1st-tok->done / total.
- `scripts/perf-live.js` (new, `npm run perf:live [ttftMs]`): boots the real app
  headless, drives one genuine UI text turn vs a mock endpoint, parses the unified
  [ARIA_PERF] timeline, prints the stage-by-stage breakdown.
- `src/renderer/index.html`, `package.json` build: load/copy `perf.js`.

Verification:
- `npm run typecheck` clean; `npm run build` clean; `node scripts/smoke-llm.js`
  PASS (no regression to streamChat/coordinator).
- Headless boot (`ARIA_PERF=1 ARIA_SMOKE=1 electron …`) logs both
  `[ARIA_PERF] instrumentation ENABLED` (main) and renderer-side ENABLED, boots to
  `[ARIA_SMOKE] OK`.
- BASELINE captured (this is the reference for all later "did it help/hurt"):

  streamChat path (`npm run perf:baseline`, avg of 3):
  | scenario            | req->1st tok | 1st tok->done | total  |
  |---------------------|--------------|---------------|--------|
  | local-fast  TTFT 40 |     44ms     |    305ms      | 349ms  |
  | remote-typ  TTFT 350|    351ms     |    727ms      | 1078ms |
  | remote-slow TTFT 800|    801ms     |   1261ms      | 2062ms |
  => streamChat client overhead over raw provider TTFT is ~1-4ms.

  Live full-path text turn (`npm run perf:live <ttft>`), stage offsets from user_input:
  | stage              | TTFT=40 | TTFT=350 |
  |--------------------|---------|----------|
  | dispatch           |   2ms   |   2ms    |
  | main_recv          |   2ms   |   2ms    |
  | llm_request        |   3ms   |   3ms    |
  | first_token        |  53ms   |  361ms   |
  | first_token_render |  53ms   |  361ms   |
  | tts_first_request  | 191ms   |  498ms   |
  | llm_done           | 213ms   |  519ms   |
  | turn_complete      | 213ms   |  519ms   |
  => user_input -> llm_request (pure app overhead before the network) = **3ms**,
     independent of TTFT. User-visible time-to-first-text = **53ms / 361ms**, i.e.
     provider TTFT + ~3ms. tts_first_request trails first token by ~138ms (waiting
     for the first speakable clause to accumulate — see Item 5 if this is a lever).
- How to capture a LIVE real-provider baseline: configure a provider in Settings,
  run `ARIA_PERF=1 npm run start`, interact, then `grep ARIA_PERF` over stdout.
  (tts_first_audio only appears when a TTS sidecar + model are present; it's absent
  in headless smoke because TTS isn't loaded.)

---

## Item 1: Settings changes require app restart to take effect
Status: not-started

## Item 2: Setup guide is missing direct LLM provider configuration
Status: not-started

## Item 3: No support for fully local LLM providers (Ollama, LM Studio, vLLM)
Status: not-started
Findings (early, from Item 0 reconnaissance): `src/renderer/harnesses.js` PROVIDERS
already lists Ollama (11434) and LM Studio (1234) but NOT vLLM; and onboarding
(`onbFinish`) only configures the harness, not the conversational LLM provider —
so these presets aren't reachable from setup. Revisit under Items 2/3.

## Item 4: Remove "File, Edit, View, Window" menu bar items
Status: not-started
Findings (early): `src/main/index.ts` never calls `Menu.setApplicationMenu`, so
Electron shows its DEFAULT menu (File/Edit/View/Window). Fix will likely be
`Menu.setApplicationMenu(null)` while preserving copy/paste accelerators (role-based
or a minimal hidden menu).

## Item 5: Large response delay even with direct LLM provider
Status: not-started
Findings (early): Item 0 baseline shows app-side pre-network overhead is ~3ms and
streaming starts rendering/speaking on the first token. So any "large delay" is most
likely provider TTFT or a TTS-start gap (tts_first_request trails first token ~138ms),
NOT app buffering. Must confirm against a real provider with the harness.

## Item 6: Chat messages should only show timestamp on hover
Status: not-started
Findings (early): `addMessage()` in app.js currently renders no timestamp at all.

## Item 7: Screen share causes chat to duplicate/repeat the first message
Status: not-started

## Item 8: Direct LLM doesn't know it can delegate to tools / agent harness
Status: not-started

---

## Found but not in scope
- (none yet)

## Blocked
- (none yet)
