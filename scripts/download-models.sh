#!/usr/bin/env bash
set -euo pipefail

MODELS_DIR="${ARIA_MODELS_DIR:-$HOME/.local/share/aria/models}"
mkdir -p "$MODELS_DIR" "$MODELS_DIR/wakeword"

WHISPER_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
PIPER_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"

declare -A WHISPER_MODELS=(
  ["base.en"]="ggml-base.en.bin"
  ["small"]="ggml-small.bin"
  ["medium"]="ggml-medium.bin"
)

declare -A WHISPER_CHECKSUMS=(
  ["base.en"]=""
  ["small"]=""
  ["medium"]=""
)

download_with_resume() {
  local url="$1" dest="$2"
  if [ -f "$dest" ]; then
    echo "  Already exists: $(basename "$dest")"
    return 0
  fi

  echo "  Downloading: $(basename "$dest")"
  curl -L --retry 3 --retry-delay 5 -C - -o "$dest.partial" "$url"
  mv "$dest.partial" "$dest"
}

echo "=== ARIA Model Download ==="
echo "Target directory: $MODELS_DIR"
echo

STT_MODEL="${1:-small}"
echo "[1/3] STT: whisper.cpp model '$STT_MODEL'"
if [ -z "${WHISPER_MODELS[$STT_MODEL]+x}" ]; then
  echo "  Unknown model: $STT_MODEL (available: ${!WHISPER_MODELS[*]})"
  exit 1
fi
download_with_resume "$WHISPER_BASE/${WHISPER_MODELS[$STT_MODEL]}" "$MODELS_DIR/${WHISPER_MODELS[$STT_MODEL]}"

echo
echo "[2/3] TTS: Piper voice 'en_US-lessac-medium'"
download_with_resume "$PIPER_BASE/en_US-lessac-medium.onnx" "$MODELS_DIR/en_US-lessac-medium.onnx"
download_with_resume "$PIPER_BASE/en_US-lessac-medium.onnx.json" "$MODELS_DIR/en_US-lessac-medium.onnx.json"

echo
echo "[3/3] Wake word: openWakeWord default models"
echo "  (openWakeWord downloads built-in models automatically on first run)"

echo
echo "=== Done ==="
echo "Models stored in: $MODELS_DIR"
