# Ralph Progress — Ship v2.9.0 release (all OSes + Fedora)

## Prep (done before loop)
- package.json 2.9.0; main pushed (3228ba2); tag v2.9.0 pushed.
- Fedora/RHEL .rpm added on CI (release.yml: rpm install + `--linux AppImage deb rpm`
  via per-matrix ebargs). Local `npm run dist` unchanged (deb+AppImage).
- Release run triggered: 28420880604 (in_progress at start).

## Iterations
- iter 1: watched run 28420880604 (v2.9.0) to completion = SUCCESS, all 3 legs green:
  - macos-latest (--mac): success
  - ubuntu-latest (--linux AppImage deb rpm): success  [rpm-install step: success]
  - windows-latest (--win): success
  (mac whisper.cpp build warned + fell back — non-fatal, expected; Node20 deprecation
  warnings — non-fatal.)

- iter 2: verified release v2.9.0 is published (isDraft=false) with all 5 required
  artifact kinds present:
  - .deb  → aria_2.9.0_amd64.deb
  - .AppImage → ARIA-2.9.0-x86_64.AppImage
  - .rpm  → aria-2.9.0.x86_64.rpm
  - .exe  → ARIA-Setup-2.9.0.exe
  - .dmg  → ARIA-2.9.0.dmg (Intel) + ARIA-2.9.0-arm64.dmg (Apple Silicon)
  No missing artifacts. Release is public.

## Result
DONE — v2.9.0 release shipped: CI green, all 5 artifact kinds present, release
published (isDraft=false).

RALPH-ARIA-RELEASE-2-9-0-SHIPPED
