# RALPH_ORB_FIXES

Tracking for the 5-item orb / status / update bug-fix loop. One section per item.
(Separate from the prior `RALPH_PROGRESS.md`, which tracks an unrelated earlier task.)

Gates per item: `npm run build` → relevant targeted smoke → `npm run smoke:all` →
headless boot (`ARIA_SMOKE=1 xvfb-run -a ./node_modules/.bin/electron --no-sandbox dist/main/index.js`).
Visual items are verified by tests + code reasoning only; each carries a MANUAL CHECK line.

## Checklist
- [ ] 1. Update progress bar (app self-update)
- [x] 2. Orb color stage sticks on green after speaking
- [x] 3. Status dots flaky after first utterance + green too subtle
- [ ] 4+5. Orb low-res after optimization + fullscreen right-side jitter

---

## Item 2: Orb stays green after the agent finishes speaking
Status: done
Root cause (confirmed in code): the orb is set to 'speaking' in `speakChunk`, and the
only return-to-idle was a one-shot timer in `aria.tts.onState('done')` gated on
`ttsSources.length === 0`. A scheduled buffer source is removed from `ttsSources`
only when its `onended` fires; if the last `onended` hadn't fired when that timer
ran (a routine race), the guard was false, the orb never went idle, and there was
NO retry — so it stayed green.
Fix (`src/renderer/app.js`):
- Track the renderer's view of the orb state (`orbStateName`) + a `ttsSynthDone` flag.
- New `ttsMaybeGoIdle()`: idle only when speaking AND synthesis done AND audio drained;
  gated on state so a barge-in to listening/processing is never clobbered.
- Drive idle from the real last `source.onended` (snappy) AND from a wall-clock
  backstop in onState('done') that is NO LONGER gated on `ttsSources.length` (by
  nextPlayTime+250ms all audio has finished, so release is correct even if an
  onended was missed). `stopPlayback` resets `ttsSynthDone` and cancels the timer
  so a new turn can't be stranded by a stale timer.
Verify: build clean; `smoke:orb` PASS; headless boot reaches `[ARIA_SMOKE] OK`.
MANUAL CHECK: speak to ARIA; when it finishes talking the orb must return from green
to cyan (idle) within a moment, both on a normal finish and when you barge in mid-reply.

## Item 3: Status dots stop working after first utterance; green too subtle
Status: done
Root cause (confirmed in code): `supervisor.ts` forwards EVERY sidecar stdout line
as `onStatus(name, 'log', ...)` (lines 113, 248). The renderer handler did
`dot.className = 'status-dot'` (blanking it) on any status, then only re-added a
class for ready/started/error/circuit-open/restarting. So the first time STT logged
during a transcription, status 'log' wiped the green dot and nothing restored it —
exactly "the dots don't work after I talk to the agent for the first time".
Fix:
- `src/renderer/app.js`: a `DOT_CLASS_FOR_STATUS` table maps only real lifecycle
  statuses (ready/started/initialized→active, restarting/circuit-reset→loading,
  error/circuit-open/exited/memory-exceeded/heartbeat-timeout→error). The handler
  early-returns on anything else ('log'/heartbeat/unknown), leaving the dot's last
  good state intact.
- `src/renderer/index.html`: 8px flat dot → 9px with a coloured halo/ring glow on
  `.active` (and a glow on `.error`), using the theme `--success`/`--error` tokens
  so it reads clearly across all 6 themes.
Verify: new `scripts/smoke-status-dots.js` (wired into `smoke:all`) — 13/13 PASS,
incl. the regression case `log.keeps.active` and `log.not.in.map`. Build clean;
headless boot reaches `[ARIA_SMOKE] OK`.
MANUAL CHECK: launch ARIA, confirm STT/TTS/Wake dots turn a vivid glowing green when
ready; talk to it, then confirm all three STAY green afterward (no dropping to grey).

## Item 1: Update progress bar (app self-update)
Status: pending

## Item 4+5: Orb resolution + fullscreen jitter
Status: pending
