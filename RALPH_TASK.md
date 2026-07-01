# Ralph Loop Task: Ship the v2.9.0 release (all OSes + Fedora) green

You are running a loop to land the v2.9.0 cross-platform release on GitHub
(`envosloth/aria-voice`) with NO failing platform, then publish it. Each
iteration: read this file + `RALPH_PROGRESS.md`, do the next needed step, update
`RALPH_PROGRESS.md`, and stop. Don't repeat work already marked done.

Prep already completed before the loop (verify, don't redo):
- 2.9.0 in package.json; `main` pushed; tag `v2.9.0` pushed.
- Release CI builds Linux (AppImage/deb/rpm), Windows (.exe), macOS (.dmg/.zip).
  Fedora/RHEL .rpm added via `.github/workflows/release.yml` (rpmbuild installed on
  the Linux runner + `--linux AppImage deb rpm`). Local `npm run dist` stays
  deb+AppImage (electron-builder.yml unchanged).

## The loop

1. Find the release run for tag `v2.9.0`:
   `gh run list --workflow=release.yml --limit 5`  (match branch/tag v2.9.0).
2. If it is `in_progress`/`queued`: wait for it —
   `gh run watch <run-id> --exit-status` (blocks until done; if the command times
   out, just re-check next iteration). Then stop the turn.
3. If it `completed` with `success` (all 3 matrix legs green):
   - Confirm the draft GitHub Release for `v2.9.0` has every expected artifact:
     `gh release view v2.9.0 --json assets -q '.assets[].name'` — must include a
     `.deb`, `.AppImage`, `.rpm`, `.exe`, and a macOS `.dmg` (and/or `.zip`).
   - If any artifact is missing, treat it as a failure (go to step 4) — figure out
     which leg didn't upload it.
   - If all present: publish the release (it's created as a draft):
     `gh release edit v2.9.0 --draft=false`. Verify it's public:
     `gh release view v2.9.0 --json isDraft -q .isDraft` must be `false`.
   - Then the task is DONE.
4. If it `completed` with `failure` (or a missing artifact): diagnose the failing
   matrix leg and fix the ROOT CAUSE, don't paper over it:
   - `gh run view <run-id> --log-failed` (and `gh run view <run-id>` for the leg).
   - Common suspects: rpmbuild/install step, sidecar venv setup, whisper.cpp build
     (non-fatal — it warns), electron-builder publish/token, platform-specific
     path/script bugs. Fix in the repo.
   - Re-run the release: simplest is to re-point the tag at the fix —
     `git push origin main`, then
     `git tag -f v2.9.0 && git push -f origin v2.9.0` (force-move the tag to the new
     commit), which re-triggers the workflow. (A failed-leg-only rerun via
     `gh run rerun <run-id> --failed` is fine when the fix is workflow-only and
     already on the tagged commit — but a code fix needs the tag moved.)
   - Stop the turn; the next iteration watches the new run.

## Rules
- NEVER mark done until: the release run is fully `success` AND the v2.9.0 release
  is published (isDraft=false) with deb+AppImage+rpm+exe+dmg assets present.
- Mac/Windows/rpm only build on CI — there is no local fallback; rely on the run.
- Keep fixes minimal and root-cause. Commit each fix with a clear message.
- Record per-iteration status in RALPH_PROGRESS.md: run id, per-leg result, what you
  fixed, current state.

When the release is fully green AND published with all five artifact kinds present,
output the completion promise `RALPH-ARIA-RELEASE-2-9-0-SHIPPED` to end the loop.
Never output it otherwise.
