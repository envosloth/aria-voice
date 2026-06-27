#!/usr/bin/env bash
# Freeze all three Python sidecars. Kept as a script (not an inline `for` loop in
# the package.json "package:sidecars" script) because npm runs script bodies via
# cmd.exe on Windows, where bash `for ... do ... done` is invalid ("s was
# unexpected at this time."). cmd.exe can invoke `bash scripts/package-sidecars.sh`
# fine, and the loop runs inside bash on every platform.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for s in stt tts wakeword; do
  bash "$ROOT/scripts/package-sidecar.sh" "$s"
done
