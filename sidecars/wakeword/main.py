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

    @staticmethod
    def _normalize(name: str) -> str:
        """Canonicalize a wake-word name so a typed 'Hey Jarvis' / 'hey-jarvis'
        matches the bundled key 'hey_jarvis'."""
        return name.strip().lower().replace(" ", "_").replace("-", "_")

    def _resolve_model_paths(self, openwakeword) -> list:
        """Resolve the configured wake word (ARIA_WAKEWORD_MODEL, set from the
        Settings field) to model file path(s).

        Match order, name-aware so an unknown phrase never silently loads an
        arbitrary model:
          1. a custom model file in the ARIA models dir whose name matches,
          2. a bundled pretrained model whose key matches,
          3. any custom models present (user dropped some in), else
          4. a safe default + a 'warning' status naming the built-in options.
        """
        req = self._normalize(DEFAULT_MODEL)
        custom_dirs = [
            os.path.join(os.path.dirname(__file__), "..", "..", "models", "wakeword"),
            os.path.expanduser("~/.local/share/aria/models/wakeword"),
        ]

        custom = []
        for d in custom_dirs:
            if os.path.isdir(d):
                for f in sorted(os.listdir(d)):
                    if f.endswith((".onnx", ".tflite")) and "melspec" not in f and "embedding" not in f:
                        path = os.path.join(d, f)
                        custom.append(path)
                        if self._normalize(os.path.splitext(f)[0]) == req:
                            return [path]  # 1) named custom model

        for key in openwakeword.models:  # 2) named bundled model
            if self._normalize(key) == req:
                return [openwakeword.models[key]["model_path"]]

        if custom:  # 3) custom models present, but none matched the typed name
            return custom

        # 4) Unknown phrase with no model — use a safe default and tell the user.
        fallback = "hey_jarvis" if "hey_jarvis" in openwakeword.models else next(iter(openwakeword.models))
        options = ", ".join(sorted(openwakeword.models))
        self._emit_status(
            "warning",
            f"No wake-word model for '{DEFAULT_MODEL}'; using '{fallback}'. "
            f"Built-in phrases: {options}. For a custom phrase, train an "
            f"openWakeWord model and drop the .onnx in models/wakeword/.",
        )
        return [openwakeword.models[fallback]["model_path"]]

    def cleanup(self) -> None:
        self.model = None
        super().cleanup()


if __name__ == "__main__":
    WakewordSidecar().run()
