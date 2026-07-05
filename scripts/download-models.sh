#!/usr/bin/env bash
set -euo pipefail

MODELS_DIR="${ARIA_MODELS_DIR:-$HOME/.local/share/aria/models}"
mkdir -p "$MODELS_DIR" "$MODELS_DIR/wakeword"

WHISPER_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
# Clear British male Piper voice; used by the power-saver preset's lightweight
# CPU engine. piper-voices is laid out as <group>/<lang>/<speaker>/<quality>/.
PIPER_VOICE="en_GB-alan-medium"
PIPER_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium"

# Keys mirror the STT models the app actually selects across presets
# (power-saver/weak-hardware = tiny.en, default = base.en, high tier = small/medium;
# see src/main/hardware.ts). tiny.en was missing, so low-end users whose preset
# needs it couldn't pre-fetch it.
declare -A WHISPER_MODELS=(
  ["tiny.en"]="ggml-tiny.en.bin"
  ["base.en"]="ggml-base.en.bin"
  ["small"]="ggml-small.bin"
  ["medium"]="ggml-medium.bin"
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

# Default matches the app's DEFAULT_STT_MODEL (src/shared/constants.ts) so a
# no-arg run pre-fetches exactly what a fresh install uses — no wasted download.
STT_MODEL="${1:-base.en}"
echo "[1/3] STT: whisper.cpp model '$STT_MODEL'"
if [ -z "${WHISPER_MODELS[$STT_MODEL]+x}" ]; then
  echo "  Unknown model: $STT_MODEL (available: ${!WHISPER_MODELS[*]})"
  exit 1
fi
download_with_resume "$WHISPER_BASE/${WHISPER_MODELS[$STT_MODEL]}" "$MODELS_DIR/${WHISPER_MODELS[$STT_MODEL]}"

echo
echo "[2/3] TTS: Kokoro-82M neural voices (default engine)"
KOKORO_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
download_with_resume "$KOKORO_BASE/kokoro-v1.0.onnx" "$MODELS_DIR/kokoro-v1.0.onnx"
download_with_resume "$KOKORO_BASE/voices-v1.0.bin" "$MODELS_DIR/voices-v1.0.bin"
# Piper voice kept as an optional lightweight fallback engine (ARIA_WITH_PIPER=1).
if [ "${ARIA_WITH_PIPER:-0}" = "1" ]; then
  echo "  (optional) Piper voice '$PIPER_VOICE'"
  download_with_resume "$PIPER_BASE/$PIPER_VOICE.onnx" "$MODELS_DIR/$PIPER_VOICE.onnx"
  download_with_resume "$PIPER_BASE/$PIPER_VOICE.onnx.json" "$MODELS_DIR/$PIPER_VOICE.onnx.json"
fi

echo
echo "[3/3] Wake word: openWakeWord default models"
echo "  (openWakeWord downloads built-in models automatically on first run)"

echo
echo "=== Done ==="
echo "Models stored in: $MODELS_DIR"
