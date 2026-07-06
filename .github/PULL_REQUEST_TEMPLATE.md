<!-- Thanks for contributing to ARIA! Keep the diff minimal and match the
     surrounding code. See CONTRIBUTING.md and collaboration/ for context. -->

## What & why

<!-- What does this change and, for a fix, what was the ROOT cause? -->

Closes #

## How it was verified

<!-- Which suites did you run? Did you actually drive the app for UI changes? -->

- [ ] `npm run build && npm run lint && npm run typecheck` clean
- [ ] `npm run smoke:all` (or the relevant `smoke:*` suites) green
- [ ] `npm run smoke:boot` green (for renderer changes)
- [ ] Ran the app (`npm run dev`) and observed the change (for UI/behavior changes)
- [ ] Added/updated a runnable check for non-trivial logic

## Notes for reviewers

<!-- Latency/GPU/CPU impact, platform coverage (Linux is the reference platform),
     any new dependency and why it's justified, follow-ups deliberately left out. -->
