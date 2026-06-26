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
- Item 1 live-settings reload is on the Settings-save path only (debounced), not the
  interaction hot path — no latency regression.

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
Status: done
Findings (which settings were live vs. restart-required, by code path):
- ALREADY live (read fresh per use): `routing.mode`, `llm.endpoint`, `llm.model`,
  `harness.endpoint`, `harness.model` — all read via `config.get(...)` inside
  `coordinator.coordinate()`/`resolve()` on every turn. API keys
  (`llm-api-key`/`harness-api-key`) fetched via `getSecret()` per request.
  `ui.theme` applied immediately in the renderer (`applyTheme` in the save
  handler). `wakeword.phrase`/`wakeword.enabled` already had a live reload.
- RESTART-REQUIRED (the actual bug): `tts.voice`, `stt.model`, `stt.backend`.
  These are consumed by the TTS/STT sidecars, which read `ARIA_TTS_VOICE` /
  `ARIA_STT_MODEL` / `ARIA_STT_BACKEND` from the environment ONLY at spawn
  (`sidecars/tts/main.py:38`, `sidecars/stt/main.py:233,38`). `applyConfigToEnv()`
  set those env vars once at boot, so a Settings change never reached a
  running sidecar.

Fix (root cause, files touched — `src/main/index.ts`):
- Extended the `CONFIG_SET` handler's live-apply (previously wakeword-only) to
  `tts.voice`/`tts.engine` -> `scheduleSidecarReload('tts')` and
  `stt.model`/`stt.backend` -> `scheduleSidecarReload('stt')`.
- New `scheduleSidecarReload(name)` (debounced 300ms, per sidecar, so saving
  several related fields reloads once) + `applySidecarConfig(name)`: refreshes ALL
  `ARIA_*` env from current config via `applyConfigToEnv()`, then restarts the
  sidecar — but ONLY if it has actually been started (a not-yet-lazy-started
  sidecar just reads the fresh env on first spawn). For STT it first runs
  `ensureModelsReady()` so a newly-selected model is downloaded before reload.
- No "Restart required" UI is needed: every field in the Settings panel now
  applies live (chose option (a) for all of them).
- Verification hook: an `ARIA_VERIFY_SETTINGS` SMOKE path that starts TTS and
  changes `tts.voice` through the real config IPC, used by the new
  `scripts/smoke-settings-live.js` (`npm run smoke:settings`).

Verification:
- `npm run smoke:settings` (real app, isolated --user-data-dir): PASS —
  `TTS voices observed (one running process): ["bm_george","af_sarah"]`,
  i.e. the voice changed live in the SAME process, no app restart. The user's
  real config is untouched (isolated user-data-dir).
- Other fields confirmed live by code path (above): routing/llm/harness/keys read
  per-turn, theme applied in-renderer, wakeword pre-existing live reload.
- `npm run typecheck` clean; `npm run build` clean; standard `smoke:boot` still
  reaches `[ARIA_SMOKE] OK` (SMOKE-block edits didn't regress boot).
- Latency: the change is on the Settings-save path only (debounced background
  reload), NOT the interaction hot path — Item 0 marks unaffected. STT/TTS reload
  cost is paid off the user's next turn (sidecar re-warms in the background).

## Item 2: Setup guide is missing direct LLM provider configuration
Status: done
Findings: The first-run onboarding (`onboard-overlay` in index.html + `onb` logic
in app.js) had 5 steps (welcome, agent harness, harness API key, mic, done) and
`onbFinish` only persisted the agent HARNESS (`harness.*` + `harness-api-key`). A
direct conversational LLM provider (`llm.endpoint`/`llm.model`/`llm-api-key`) could
only be set later in Settings — exactly the gap reported.

Fix (files touched):
- `src/renderer/index.html`: inserted a new onboarding step (data-step=3) "Add a
  language model" — provider `<select>`, endpoint, model, password key, and a
  "Test connection" button + result span. Renumbered mic->4, done->5.
- `src/renderer/app.js`:
  - registered the new fields on `onb`; bumped `ONB_LAST` 4->5.
  - populated the provider dropdown from the shared `PROVIDERS` presets (same list
    Settings uses); picking a preset pre-fills endpoint + default model (editable).
  - added a Test-connection handler using the existing `aria.llm.test` path with
    the LLM endpoint/model/key.
  - `onbFinish` now persists harness AND/OR direct-LLM config, each only when its
    endpoint is filled (so configuring one doesn't wipe the other). The LLM step
    defaults to the "custom" (empty) preset on first run, so it's truly optional —
    a blank endpoint is skipped.
- Verification hook `ARIA_VERIFY_ONBOARD` in `src/main/index.ts` +
  `scripts/smoke-onboarding-llm.js` (`npm run smoke:onboarding`).

Verification:
- `npm run smoke:onboarding` (fresh app, isolated --user-data-dir, mock endpoint):
  all 6 checks PASS — onboarding HAS the direct-LLM step; Test connection returns
  "✓ Connected" against the mock; and after finishing, `llm.endpoint`/`llm.model`/
  `llm-api-key` are all persisted and `ui.onboarded=true` — i.e. a fresh run-through
  reaches a working direct-provider config without opening Settings.
- `npm run typecheck` clean; `npm run build` clean.
- Latency: onboarding is first-run UI, off the interaction hot path — no impact.

Found but not in scope (now in scope for Item 3): the provider preset list lacks a
vLLM entry; Ollama/LM Studio presets exist and are now reachable from setup.

## Item 3: No support for fully local LLM providers (Ollama, LM Studio, vLLM)
Status: done
Findings: The "direct provider" abstraction is an OpenAI-compatible SSE client
(`src/main/llm-stream.ts` `streamChat`) driven by the `PROVIDERS` presets in
`src/renderer/harnesses.js`. Ollama (11434) + LM Studio (1234) presets existed but
(a) there was NO vLLM preset, and (b) `streamChat` only normalized a bare host
("/" or "") to `/v1/chat/completions` — a user pasting the documented base
`http://localhost:11434/v1` would POST to `/v1` and 404. Local providers already
work without a key (no Authorization header is sent when `apiKey` is empty), and
Item 2 already made these presets reachable from setup.

Fix (files touched):
- `src/renderer/harnesses.js`: added a `vllm` preset
  (`http://localhost:8000/v1/chat/completions`, vLLM's default serve port) and a
  `local: true` flag on ollama/lmstudio/vllm.
- `src/main/llm-stream.ts`: broadened base-URL normalization — bare host, AND a
  trailing "…/vN" base, both normalize to "…/chat/completions"; a full/custom path
  is left untouched. So all of `http://host`, `http://host/v1`, and
  `http://host/v1/chat/completions` work.
- `src/renderer/app.js`: onboarding LLM key placeholder shows "not required for
  local servers" when a local preset is picked.

Verification:
- No real local server was available in this env (no ollama binary / LM Studio /
  vLLM responding — probed). Verified with `npm run smoke:local-llm` against a mock
  implementing the same OpenAI-compatible /v1/chat/completions SSE contract, driving
  the REAL `streamChat`: 8/8 PASS — presets present+local+reverse-lookup; base URL
  ".../v1" AND bare host both normalize to /v1/chat/completions and round-trip
  "Hello, world!"; and NO Authorization header is sent when the key is omitted
  (proves "no API key required"). The script also best-effort hits a real Ollama on
  11434 if one is running.
- Regression: `npm run smoke:llm` still 5/5 PASS (full path + connection-failure
  cases unaffected by the normalization change). typecheck + build clean.
- Latency: streamChat URL parsing is a one-time per-request string op (µs), already
  on the path; no measurable change.

## Item 4: Remove "File, Edit, View, Window" menu bar items
Status: done
Findings: `src/main/index.ts` never called `Menu.setApplicationMenu`, so Electron
rendered its DEFAULT application menu (File / Edit / View / Window) in the window's
menu bar. The Edit menu is also what carries the standard copy/paste/undo
accelerators, so a blind `setApplicationMenu(null)` would risk those shortcuts.

Fix (files touched — `src/main/index.ts`):
- `applyAppMenu()`: replaces the default menu with an Edit-only menu
  (`Menu.buildFromTemplate([{ role: 'editMenu' }])`) — this keeps the
  undo/redo/cut/copy/paste/selectAll accelerators registered app-wide.
- `createWindow()`: `win.autoHideMenuBar = false` + `win.setMenuBarVisibility(false)`
  so the bar is fully hidden (and can't be revealed with Alt). Net effect: the user
  sees NO menu, File/View/Window are gone, and editing shortcuts still work in the
  chat box and on selected transcript text.
- Verification hook `ARIA_VERIFY_MENU` + `scripts/smoke-menu.js`
  (`npm run smoke:menu`).

Verification:
- `npm run smoke:menu` (real app headless): 7/7 PASS. Live main-process menu state:
  `appmenu-toplevel=["Edit"]`, `appmenu-roles=["undo","redo","cut","copy","paste",
  "delete","selectall"]`, `menubar-visible=false`. So no File/View/Window, the bar
  is hidden, and copy/paste/selectAll accelerators are preserved.
- Standard `smoke:boot` still reaches `[ARIA_SMOKE] OK` (window still displays;
  hiding the bar didn't break boot). typecheck + build clean.
- Latency: main-process menu setup at startup only — off the interaction hot path.

## Item 5: Large response delay even with direct LLM provider
Status: done
Findings (all MEASURED with the Item 0 harness + `scripts/perf-llm-path.js`, not
guessed — no real provider was available so realistic mocks drive the REAL
streamChat client):
- App-side pre-network overhead: ~3ms (Item 0 perf-live), TTFT-independent.
- Streaming IS used: first token renders/ speaks on arrival, well before
  completion (req->first-token 69ms vs total 224ms for a 60ms-TTFT mock).
- Connection + TLS reuse ALREADY works via Node's default keep-alive agent
  (Electron 40 / Node 19+): measured 1 TCP conn + 1 TLS handshake for 5 sequential
  HTTPS turns, and 0 NEW connections across 5 follow-up turns. So there is NO
  per-turn handshake to eliminate — keep-alive was a red herring (verified before
  "fixing" it, per the task's "don't guess").
- No request retry/duplication on the happy path; `getSecret` is synchronous and
  the keyring key is process-cached, so it's not a per-turn cost.
- THE real app-side cause of a "large delay even with a direct provider": the
  request did NOT advertise SSE. Some OpenAI-compatible servers/proxies
  (nginx-fronted gateways especially) BUFFER the entire reply and flush it at the
  end unless the client sends `Accept: text/event-stream`, silently degrading
  streaming into a wait-for-everything batch.

Fix (files touched):
- `src/main/llm-stream.ts`: add `Accept: text/event-stream` to the request headers.
- `scripts/perf-llm-path.js` (`npm run perf:llm-path`): measures the stage
  breakdown, connection reuse, AND the buffering-proxy before/after.

Verification (before/after, measured):
- `npm run perf:llm-path`: 4/4 PASS. Against a proxy that only streams when the
  client advertises SSE:
  - BEFORE (no Accept header): first token at 322ms of 322ms total — i.e. buffered
    to the very end (the bug, reproduced).
  - AFTER (streamChat now sends Accept): first token at 22ms of 325ms total —
    streaming restored. ~300ms earlier first token on a buffering proxy.
- Stage breakdown reported (mock TTFT 60ms -> first-token 69ms; 350ms -> 352ms),
  connection reuse confirmed (0 new conns / 5 turns).
- Regression: `npm run smoke:llm` 5/5 PASS (mocks that ignore Accept still stream).
  typecheck + build clean.
- Latency: the change is a single static request header — no added work on the hot
  path; for buffering proxies it's a large net REDUCTION in time-to-first-token.

Note: with a well-behaved direct provider that already streams, the dominant
latency is provider TTFT (network + model), which is outside the app's control;
the harness now makes that attributable so future app-side regressions are visible.

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
