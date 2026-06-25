#!/usr/bin/env bash
# Generate a known 16kHz mono test utterance for the STT round-trip smoke test.
# Uses the TTS venv's Piper to synthesize, then ffmpeg to resample 22050 -> 16000.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VOICE="$HOME/.local/share/aria/models/en_US-lessac-medium.onnx"
PIPER_PY="$ROOT/sidecars/tts/venv/bin/python"

if [ ! -f "$VOICE" ]; then echo "Voice model missing: $VOICE"; exit 1; fi
if [ ! -x "$PIPER_PY" ]; then echo "TTS venv missing: $PIPER_PY"; exit 1; fi

echo "Testing one two three four five." | "$PIPER_PY" -m piper -m "$VOICE" -f /tmp/stt_test_22k.wav 2>/dev/null
ffmpeg -y -i /tmp/stt_test_22k.wav -ar 16000 -ac 1 -f wav /tmp/stt_test_16k.wav 2>/dev/null
echo "Generated /tmp/stt_test_16k.wav (16kHz mono)"
