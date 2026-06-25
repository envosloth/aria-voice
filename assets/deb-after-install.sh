#!/bin/bash
# Ensure the Chromium SUID sandbox helper has the setuid bit. Without root:root
# mode 4755 here, Electron aborts at launch (SIGTRAP) rather than run unsandboxed.
set -e
SANDBOX="/opt/ARIA/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX" || true
  chmod 4755 "$SANDBOX" || true
fi
