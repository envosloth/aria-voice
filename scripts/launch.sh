#!/usr/bin/env bash
# Launch ARIA from the dev tree. Builds if needed, then runs Electron.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Build if dist is missing or sources are newer than the built main entry.
if [ ! -f dist/main/index.js ]; then
  npm run build
fi

# Run in a real Wayland session when available.
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"

# The Chromium SUID sandbox needs root setup (chrome-sandbox root:root mode 4755).
# If it isn't configured, fall back to --no-sandbox so the app still launches.
SANDBOX="node_modules/electron/dist/chrome-sandbox"
ARGS=()
if [ ! -u "$SANDBOX" ]; then
  ARGS+=(--no-sandbox)
fi

exec node_modules/.bin/electron "${ARGS[@]}" dist/main/index.js
