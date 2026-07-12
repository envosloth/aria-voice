#!/usr/bin/env bash
set -euo pipefail

MODELS_DIR="${ARIA_MODELS_DIR:-$HOME/.local/share/aria/models}"
mkdir -p "$MODELS_DIR" "$MODELS_DIR/wakeword"

WHISPER_REVISION="5359861c739e955e79d9a303bcbc70fb988958b1"
PIPER_REVISION="e21c7de8d4eab79b902f0d61e662b3f21664b8d2"
WHISPER_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/$WHISPER_REVISION"
# Clear British male Piper voice; used by the power-saver preset's lightweight
# CPU engine. piper-voices is laid out as <group>/<lang>/<speaker>/<quality>/.
PIPER_VOICE="en_GB-alan-medium"
PIPER_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/$PIPER_REVISION/en/en_GB/alan/medium"

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
declare -A WHISPER_SHA256=(
  ["tiny.en"]="921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f"
  ["base.en"]="a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
  ["small"]="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
  ["medium"]="6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208"
)

KOKORO_MODEL_SHA256="7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"
KOKORO_VOICES_SHA256="bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"
PIPER_MODEL_SHA256="0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330"
PIPER_CONFIG_SHA256="c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e"

download_with_resume() {
  local url="$1" dest="$2" sha256="$3"
  if [ -f "$dest" ]; then
    if printf '%s  %s\n' "$sha256" "$dest" | sha256sum -c --status; then
      echo "  Already verified: $(basename "$dest")"
      return 0
    fi
    echo "  Existing file failed verification; downloading again"
    rm -f "$dest"
  fi

  echo "  Downloading: $(basename "$dest")"
  curl -L --retry 3 --retry-delay 5 -C - -o "$dest.partial" "$url"
  if ! printf '%s  %s\n' "$sha256" "$dest.partial" | sha256sum -c; then
    rm -f "$dest.partial"
    return 1
  fi
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
download_with_resume "$WHISPER_BASE/${WHISPER_MODELS[$STT_MODEL]}" "$MODELS_DIR/${WHISPER_MODELS[$STT_MODEL]}" "${WHISPER_SHA256[$STT_MODEL]}"

echo
echo "[2/3] TTS: Kokoro-82M neural voices (default engine)"
KOKORO_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
download_with_resume "$KOKORO_BASE/kokoro-v1.0.onnx" "$MODELS_DIR/kokoro-v1.0.onnx" "$KOKORO_MODEL_SHA256"
download_with_resume "$KOKORO_BASE/voices-v1.0.bin" "$MODELS_DIR/voices-v1.0.bin" "$KOKORO_VOICES_SHA256"
# Piper voice kept as an optional lightweight fallback engine (ARIA_WITH_PIPER=1).
if [ "${ARIA_WITH_PIPER:-0}" = "1" ]; then
  echo "  (optional) Piper voice '$PIPER_VOICE'"
  download_with_resume "$PIPER_BASE/$PIPER_VOICE.onnx" "$MODELS_DIR/$PIPER_VOICE.onnx" "$PIPER_MODEL_SHA256"
  download_with_resume "$PIPER_BASE/$PIPER_VOICE.onnx.json" "$MODELS_DIR/$PIPER_VOICE.onnx.json" "$PIPER_CONFIG_SHA256"
fi

echo
echo "[3/3] Wake word: openWakeWord default models"
echo "  (openWakeWord downloads built-in models automatically on first run)"

echo
echo "=== Done ==="
echo "Models stored in: $MODELS_DIR"
