# RALPH_ORB_FIXES

Tracking for the 5-item orb / status / update bug-fix loop. One section per item.
(Separate from the prior `RALPH_PROGRESS.md`, which tracks an unrelated earlier task.)

Gates per item: `npm run build` → relevant targeted smoke → `npm run smoke:all` →
headless boot (`ARIA_SMOKE=1 xvfb-run -a ./node_modules/.bin/electron --no-sandbox dist/main/index.js`).
Visual items are verified by tests + code reasoning only; each carries a MANUAL CHECK line.

## Checklist
- [ ] 1. Update progress bar (app self-update)
- [x] 2. Orb color stage sticks on green after speaking
- [ ] 3. Status dots flaky after first utterance + green too subtle
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
Status: pending

## Item 1: Update progress bar (app self-update)
Status: pending

## Item 4+5: Orb resolution + fullscreen jitter
Status: pending
