# Ralph Loop Task: Fix Settings, Setup, and Chat UX Issues

You are running in a loop. Each iteration: read this file, read `RALPH_PROGRESS.md` in
the repo root (create it if missing), pick the next unfinished item below in order,
fix it, verify it, update `RALPH_PROGRESS.md` with what you did and how you verified
it, commit, and stop your turn. Do not move to the next item until the current one
is verified. If you get stuck on an item after 3 attempts, write down why in
`RALPH_PROGRESS.md` under a "Blocked" section and move to the next item instead of
looping forever on it.

When every item below is `done` or `blocked` (after its 3 attempts) AND the overall
success bar is met, output the completion promise `RALPH-ARIA-ALL-ITEMS-VERIFIED-DONE`
to end the loop. Never output it otherwise.

## Standing constraints (apply to every item, every iteration)

This application is a real-time AI desktop assistant. Responsiveness is a core
feature, not a nice-to-have, and these constraints override generic "best practice"
instincts (e.g. "add a debounce", "batch these calls") wherever they'd conflict.

- Target: end-to-end interaction latency under 500ms whenever possible. This is a
  target to steer by, not a hard cliff — but any change that pushes latency higher
  needs a justification written in RALPH_PROGRESS.md, not a silent tradeoff.
- UI interactions must feel instantaneous. Never block the UI/main thread on network
  calls, disk I/O, or LLM/STT/TTS work — push it to a worker/background thread/async
  task and confirm the UI thread isn't waiting on it.
- Voice input (STT) processing should begin as soon as audio is received, not after
  some buffering window — check for any "wait for N ms of audio" or "wait for full
  utterance" pattern that could be replaced with streaming/incremental processing.
- TTS playback should start as soon as enough audio is available to play, not after
  the full response is synthesized — check whether TTS is being requested in
  streaming chunks tied to LLM output, or only after the full text response lands.
- Tool execution should be async/non-blocking relative to the UI and to other
  in-flight work, unless a specific tool call has a genuine ordering dependency.
- The app must stay responsive with STT, TTS, LLM inference, and background agents
  all running at once — test concurrently, not just each in isolation.

When making any change anywhere in this loop:
- Never trade responsiveness for lower CPU/memory usage. If you're tempted to add
  batching, buffering, debouncing, or scheduling delays "to be efficient," check the
  latency impact first. If it pushes end-to-end latency up, don't make that tradeoff
  — find a different approach instead.
- Measure before and after every change that could plausibly affect latency, not just
  changes explicitly about performance. A "small" change to settings-loading or
  message rendering can still add latency on the hot path.
- Prefer fixes with real-world latency impact over micro-optimizations you can't
  measure a difference from. If you can't measure a change, don't claim it helped.

Overall success bar for the app (track in RALPH_PROGRESS.md as you go, not just at
the end):
- Stable under sustained use, no crashes you could have avoided.
- Memory growth stays minimal over a long session (note any steady upward creep).
- Idle CPU stays low — STT/TTS/agents shouldn't spin or poll aggressively when idle.
- No UI freezes/stutters, including while STT, TTS, LLM inference, and background
  agents all run together.
- Response latency stays consistently under 500ms under normal (non-degraded)
  conditions.

## Progress tracking format (RALPH_PROGRESS.md)

For each item below, maintain a section:
```
## Item N: <short title>
Status: not-started | in-progress | done | blocked
Findings: <root cause once known>
Fix: <what changed, files touched>
Verification: <how you confirmed it's fixed>
```

---

## Item 0: Build a latency measurement harness (do this first, reuse everywhere)

Before touching Items 1-8, establish how end-to-end latency is actually measured in
this app, since "under 500ms" is unverifiable without it and several items below
depend on it.

- Identify the key stages of a typical interaction and add timestamps/logging at each
  boundary, for both the text-chat path and the voice path:
  - User input received (keystroke send / audio start) -> request dispatched ->
    first byte/token received from LLM -> first audio frame played (TTS) or first
    text rendered (chat) -> interaction visually "complete."
- Output this as structured logging (timestamps + stage name) that can be diffed
  before/after a change, not just console.log noise — e.g. a simple ring buffer or
  log line format you grep for, whichever fits the existing logging setup.
- Record a baseline: run a handful of typical interactions (text chat, voice
  round-trip, tool-call round-trip) and capture current end-to-end numbers in
  RALPH_PROGRESS.md before any other item is "fixed." This baseline is what every
  later "did this help or hurt" comparison gets measured against.
- This harness should stay in the app (behind a debug flag/verbose log level if
  needed) rather than being ripped out after use — later iterations of this loop and
  future debugging need it too.
- Verify: baseline numbers for text-chat and voice paths are written down in
  RALPH_PROGRESS.md with enough detail (stage-by-stage breakdown, not just one final
  number) to know where time is going.

## Item 1: Settings changes require app restart to take effect

Clicking "Apply" in Settings does not actually apply the change live — the user has
to fully quit and relaunch the app for it to take effect.

- Find where Settings -> Apply is wired up. Identify which settings are read once at
  startup (cached in memory, read into a singleton/config object at boot) vs. read
  fresh each time they're needed.
- For each setting that doesn't take effect live, either:
  (a) make the consuming code re-read config on change (e.g. subscribe to a config
      change event/store), or
  (b) if a setting genuinely requires restart (e.g. it changes a native module init),
      explicitly tell the user that in the UI ("Restart required") instead of silently
      requiring it.
- Verify: change a setting, confirm the behavior change is visible without restarting,
  for every setting in the Settings panel — not just one.

## Item 2: Setup guide is missing direct LLM provider configuration

The onboarding/setup guide doesn't walk the user through configuring a direct LLM
provider (i.e. user-supplied API key/endpoint rather than only a built-in option).

- Find the setup/onboarding flow.
- Add a step (or section) for configuring a direct LLM provider: provider selection,
  API key/endpoint entry, model selection, and a "test connection" action.
- Verify: a fresh setup run-through reaches a working direct-provider configuration
  without needing to dig into Settings after the fact.

## Item 3: No support for fully local LLM providers (Ollama, LM Studio, vLLM)

Direct LLM provider options don't include locally hosted setups.

- Determine what the existing "direct provider" abstraction looks like (likely an
  OpenAI-compatible client, since Ollama/LM Studio/vLLM all expose OpenAI-compatible
  `/v1/chat/completions` endpoints).
- Add provider presets (or a generic "OpenAI-compatible / custom base URL" option)
  for:
  - Ollama (default `http://localhost:11434/v1`)
  - LM Studio (default `http://localhost:1234/v1`)
  - vLLM (user-supplied base URL, OpenAI-compatible)
- These should not require an API key (or should accept a dummy/placeholder one,
  since local servers often ignore it).
- Verify: connect to a locally running Ollama (or LM Studio) instance and confirm a
  chat message round-trips successfully.

## Item 4: Remove "File, Edit, View, Window" menu bar items

Top-left application menu currently shows File / Edit / View / Window. Remove these
menu items (or the whole menu bar, if nothing else lives there) from the app.

- Find the native menu construction (likely `Menu.buildFromTemplate` or equivalent
  if this is Electron).
- Remove the listed menus. Check first whether any of them carry functionality the
  app depends on (e.g. Edit menu often carries copy/paste/undo keyboard shortcuts on
  some platforms) — if so, keep the underlying accelerators/shortcuts working via
  another mechanism (e.g. `role` shortcuts still registered, or app-level keybindings)
  even after removing the visible menu.
- Verify: launch app, confirm menu bar no longer shows these items, confirm copy/paste
  and any other previously-menu-driven shortcuts still work.

## Item 5: Large response delay even with direct LLM provider

Latency is high even when using a direct LLM provider (i.e. not the case where
overhead might be excused by a slower routed/proxy path).

- Do not guess. Use the latency harness from Item 0 (don't build a separate one) to
  measure: request construction -> network call -> first token received -> stream
  completion.
  - Determine where the time is actually going: is it network latency to the
    provider, time-to-first-token from the model itself, client-side buffering before
    rendering, or something app-side (e.g. waiting on an unrelated synchronous task
    before the request is even sent)?
- Common culprits to check specifically:
  - Is streaming actually enabled/used, or is the client waiting for the full
    response before displaying anything?
  - Is there an unnecessary delay/await before the request fires (e.g. waiting on a
    settings re-read, a redundant auth check, a UI animation)?
  - Is the request being retried/duplicated?
- Fix the actual bottleneck found. Do not add arbitrary timeouts or "optimizations"
  without first identifying where time is spent.
- Verify: log/measure latency before and after, report both numbers in
  RALPH_PROGRESS.md.

## Item 6: Chat messages should only show timestamp on hover

Currently timestamps are presumably always visible (or absent) — they should only
render when the user hovers over a given message.

- Find the message component/template.
- Add hover-only timestamp display (CSS `:hover` reveal, or equivalent in whatever UI
  framework is used) scoped to the individual message, not the whole message list.
- Verify: timestamp is hidden by default, appears on hover over a specific message,
  and hovering one message doesn't reveal timestamps on others.

## Item 7: Screen share causes chat to duplicate/repeat the first message

When screen share is activated, the chat behaves incorrectly: it appears to repeat
the first message in the conversation, attributed as if it were what the user said
in their most recent turn.

- This smells like a state bug, not a rendering bug — likely one of:
  - Screen-share activation triggers a re-render/re-init of the chat state that
    re-seeds from message index 0 instead of preserving current state.
  - A duplicate event listener gets attached each time screen share is toggled on,
    causing the original first message's send-handler to fire again.
  - The "user said X" payload sent when screen share starts is hardcoded to the
    first message in the history rather than the current/most recent one.
- Find where screen-share activation is wired up and what side effects it triggers
  in chat state (does it reset/reinitialize the message list, message store, or
  websocket connection?).
- Reproduce deliberately: send 3+ messages, then activate screen share, and check
  exactly which message gets duplicated and how it's attributed.
- Fix the root cause (likely deduplicate the event listener, or stop re-seeding chat
  state on screen-share toggle).
- Verify: repeat the reproduction steps above after the fix; activate/deactivate
  screen share multiple times in one session to confirm it doesn't recur.

## Item 8: Direct LLM doesn't know it can delegate to tools / agent harness

When using a direct LLM provider (vs. the built-in/routed path), the model doesn't
seem aware that it can hand off work to a tool-use harness — i.e. it isn't being told
about available tools, or tool-calling isn't wired up for the direct-provider path.

- Compare the system prompt / tool definitions sent on the built-in path vs. the
  direct-provider path. It's likely the direct path is missing the tools array,
  tool-use instructions, or both.
- Confirm whether the chosen direct provider/model actually supports tool calling at
  the API level (not all local models do) — if not, this may need a capability flag
  and a fallback message rather than a fix.
- Wire up tool definitions and tool-result handling for the direct-provider path so
  it matches the built-in path's behavior, gated on the provider/model supporting it.
- Verify: with a tool-calling-capable direct provider configured, prompt something
  that requires a tool and confirm the model actually invokes it instead of trying to
  answer from text alone.

---

## General rules for every item

- Don't mark something "done" without a concrete verification step you actually
  performed — describe it in RALPH_PROGRESS.md.
- Every change is also subject to the "Standing constraints" section above — a fix
  that resolves its own item but regresses latency, blocks the UI thread, or adds
  buffering/batching delay is not actually done. Re-measure with the Item 0 harness
  if there's any chance a change touched the hot path.
- Prefer fixing root cause over papering over symptoms.
- If fixing one item reveals a closely related bug not listed here, note it in
  RALPH_PROGRESS.md under "Found but not in scope" rather than silently expanding
  scope.
- Keep commits scoped to one item each.
