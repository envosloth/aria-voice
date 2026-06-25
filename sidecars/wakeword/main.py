#!/usr/bin/env python3
"""Wake word sidecar: openWakeWord with Silero VAD for local wake-word detection.

Listens to 16kHz mono PCM audio over UDS, emits wake-word detection events over
stdio JSON. openWakeWord expects raw int16 PCM in 80ms (1280-sample) frames.

The pretrained ONNX models (alexa, hey_mycroft, hey_jarvis, plus the shared
melspectrogram/embedding feature models and silero_vad) ship bundled with the
openwakeword wheel — no separate download is required. A custom "hey aria"
model would need to be trained separately and dropped into the models dir.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shared"))
from base_sidecar import BaseSidecar

FRAME_BYTES = 1280 * 2  # 80ms at 16kHz, 16-bit mono = 2560 bytes
DEFAULT_MODEL = os.environ.get("ARIA_WAKEWORD_MODEL", "hey_jarvis")


class WakewordSidecar(BaseSidecar):
    def __init__(self):
        super().__init__("wakeword")
        self.model = None
        self.threshold = float(os.environ.get("ARIA_WAKEWORD_THRESHOLD", "0.5"))
        self._np = None
        self._buffer = bytearray()

    def initialize(self) -> None:
        try:
            import numpy as np
            import openwakeword
            from openwakeword.model import Model
        except ImportError:
            raise RuntimeError("openwakeword not installed. pip install openwakeword")

        self._np = np
        model_paths = self._resolve_model_paths(openwakeword)
        self.model = Model(
            wakeword_model_paths=model_paths,
            enable_speex_noise_suppression=False,
            vad_threshold=0.5,
        )
        names = ", ".join(os.path.basename(p) for p in model_paths)
        self._emit_status("initialized", f"threshold={self.threshold} models=[{names}]")

    def on_pcm(self, data: bytes) -> None:
        np = self._np
        self._buffer.extend(data)

        # Process complete 80ms frames
        while len(self._buffer) >= FRAME_BYTES:
            frame = bytes(self._buffer[:FRAME_BYTES])
            del self._buffer[:FRAME_BYTES]

            audio = np.frombuffer(frame, dtype=np.int16)
            prediction = self.model.predict(audio)

            for model_name, score in prediction.items():
                if score >= self.threshold:
                    self.emit({
                        "type": "wakeword_detected",
                        "phrase": model_name,
                        "score": float(score),
                        "ts": time.time(),
                    })
                    self.model.reset()

    def _resolve_model_paths(self, openwakeword) -> list:
        """Prefer a custom model in the ARIA models dir; fall back to a bundled one."""
        custom_dirs = [
            os.path.join(os.path.dirname(__file__), "..", "..", "models", "wakeword"),
            os.path.expanduser("~/.local/share/aria/models/wakeword"),
        ]

        custom = []
        for d in custom_dirs:
            if os.path.isdir(d):
                for f in sorted(os.listdir(d)):
                    if f.endswith((".onnx", ".tflite")) and "melspec" not in f and "embedding" not in f:
                        custom.append(os.path.join(d, f))
        if custom:
            return custom

        # Fall back to a bundled pretrained model
        if DEFAULT_MODEL in openwakeword.models:
            return [openwakeword.models[DEFAULT_MODEL]["model_path"]]

        # Last resort: first available bundled model
        first = next(iter(openwakeword.models))
        return [openwakeword.models[first]["model_path"]]

    def cleanup(self) -> None:
        self.model = None
        super().cleanup()


if __name__ == "__main__":
    WakewordSidecar().run()
