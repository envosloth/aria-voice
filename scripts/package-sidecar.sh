#!/usr/bin/env bash
# Freeze a sidecar into a PyInstaller onedir bundle (interpreter + deps included,
# no system Python needed on the target). onedir avoids onefile's temp-extraction
# issues (noexec /tmp, slow startup). Build inside the sidecar's own venv so
# PyInstaller picks up exactly that sidecar's dependencies.
#
# Usage: scripts/package-sidecar.sh <sidecar-name>
set -euo pipefail

NAME="${1:?usage: package-sidecar.sh <sidecar-name>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR_DIR="$ROOT/sidecars/$NAME"
VENV="$SIDECAR_DIR/venv"
SHARED="$ROOT/sidecars/shared"
OUT="$ROOT/build/sidecars"

if [ ! -d "$VENV" ]; then echo "Missing venv: $VENV"; exit 1; fi
if [ ! -x "$VENV/bin/pyinstaller" ]; then
  echo "Installing PyInstaller into $NAME venv..."
  "$VENV/bin/pip" install -q pyinstaller
fi

echo "=== Freezing sidecar '$NAME' (onedir) ==="
rm -rf "$OUT/$NAME" "$SIDECAR_DIR/build" "$SIDECAR_DIR"/*.spec

# Collect openwakeword's bundled resource models if this is the wakeword sidecar
EXTRA_ARGS=()
if [ "$NAME" = "wakeword" ]; then
  EXTRA_ARGS+=(--collect-data openwakeword)
fi
if [ "$NAME" = "tts" ]; then
  # onnxruntime native libs + Kokoro/espeak-ng/phonemizer data so the frozen
  # TTS sidecar is self-contained (Kokoro is the default engine).
  EXTRA_ARGS+=(--collect-binaries onnxruntime)
  EXTRA_ARGS+=(--collect-all kokoro_onnx)
  EXTRA_ARGS+=(--collect-all espeakng_loader)
  EXTRA_ARGS+=(--collect-all phonemizer)
  EXTRA_ARGS+=(--collect-data language_tags)
  EXTRA_ARGS+=(--hidden-import numpy)
  # Piper is an optional fallback engine; collect it only if installed.
  if "$VENV/bin/python" -c "import piper" >/dev/null 2>&1; then
    EXTRA_ARGS+=(--collect-data piper)
  fi
fi

"$VENV/bin/pyinstaller" \
  --onedir \
  --name "$NAME" \
  --paths "$SHARED" \
  --hidden-import base_sidecar \
  --distpath "$OUT" \
  --workpath "$SIDECAR_DIR/build" \
  --specpath "$SIDECAR_DIR" \
  --noconfirm \
  "${EXTRA_ARGS[@]}" \
  "$SIDECAR_DIR/main.py"

echo
echo "=== Built: $OUT/$NAME/$NAME ==="
ls -la "$OUT/$NAME/$NAME"
