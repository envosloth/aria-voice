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


def _debounce_step(consec, above_threshold, min_frames):
    """Pure multi-frame debounce. Given the running count of consecutive
    above-threshold frames, whether THIS frame is above threshold, and the
    required run length, return (new_consec, should_fire). A wake word must stay
    above threshold for min_frames consecutive frames before firing, so a
    single-frame noise spike can't trigger it."""
    if not above_threshold:
        return 0, False
    consec += 1
    if consec >= min_frames:
        return 0, True
    return consec, False


class WakewordSidecar(BaseSidecar):
    def __init__(self):
        super().__init__("wakeword")
        self.model = None
        # 0.4 (was 0.5) — more sensitive so a normally-spoken wake word isn't
        # missed. False positives are bounded by the post-detection cooldown
        # below and openWakeWord's own per-frame confidence.
        self.threshold = float(os.environ.get("ARIA_WAKEWORD_THRESHOLD", "0.4"))
        # Used when the typed phrase is only a SUB-phrase of the closest bundled
        # model (e.g. "jarvis" vs the "hey jarvis" model). The model is trained
        # on the full phrase, so we lower the bar to let the shorter spoken
        # phrase trigger it.
        self.partial_threshold = float(os.environ.get("ARIA_WAKEWORD_PARTIAL_THRESHOLD", "0.3"))
        # Silero VAD gate. openWakeWord ZEROES a detection whose VAD speech score
        # is below this. Silero lags at speech onset, so ANY non-zero gate
        # suppresses a quick/normally-spoken wake word before the VAD ramps — the
        # documented "doesn't activate when spoken" root cause. Reliability is the
        # priority, so it DEFAULTS OFF (0.0); the model's own confidence +
        # post-detection cooldown are the discriminators. Set
        # ARIA_WAKEWORD_VAD_THRESHOLD>0 only for a very noisy room (trades recall).
        self.vad_threshold = float(os.environ.get("ARIA_WAKEWORD_VAD_THRESHOLD", "0.0"))
        # Debounce: fire only after the score stays >= threshold for this many
        # CONSECUTIVE 80ms frames. min_frames=1 = fire on the first frame (most
        # reliable — no onset penalty); raise to 2+ to filter single-frame noise
        # spikes at the cost of some recall. Default 1: consistent activation wins;
        # the 1.5s cooldown below still prevents a single word double-firing.
        self.min_frames = max(1, int(os.environ.get("ARIA_WAKEWORD_MIN_FRAMES", "1")))
        # After a detection, ignore further detections for this long so one spoken
        # wake word can't double-fire as its score lingers above threshold.
        self.cooldown_s = float(os.environ.get("ARIA_WAKEWORD_COOLDOWN", "1.5"))
        self._last_detect = 0.0
        self._consec = 0  # running count of consecutive above-threshold frames
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
        # NOTE (Windows wake word): we deliberately do NOT pass inference_framework
        # here — this openWakeWord version forwards it to AudioFeatures, which
        # rejects it. The bundled models are .onnx and onnxruntime is the only
        # runtime we ship (cross-platform, has Windows wheels), so the onnx path is
        # selected identically on every OS. If wake word still fails on Windows,
        # capture the sidecar's stderr from a real Windows run — the failure is not
        # reproducible/identifiable from Linux.
        self.model = Model(
            wakeword_model_paths=model_paths,
            enable_speex_noise_suppression=False,
            vad_threshold=self.vad_threshold,
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

            now = time.time()
            if now - self._last_detect < self.cooldown_s:
                self._consec = 0
                continue  # still cooling down from the last trigger — don't re-fire

            # Highest-scoring model above threshold this frame (if any).
            best_name, best_score = None, 0.0
            for model_name, score in prediction.items():
                if score >= self.threshold and score > best_score:
                    best_name, best_score = model_name, float(score)

            self._consec, should_fire = _debounce_step(
                self._consec, best_name is not None, self.min_frames
            )
            if should_fire:
                self._last_detect = now
                self.emit({
                    "type": "wakeword_detected",
                    "phrase": best_name,
                    "score": best_score,
                    "ts": now,
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
          2. a bundled pretrained model whose key matches exactly,
          3. a bundled model the typed phrase is a SUB-phrase of (e.g. "jarvis"
             -> "hey jarvis"), loaded with a lowered threshold,
          4. any custom models present (user dropped some in), else
          5. a safe default + a 'warning' status naming the built-in options.
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

        for key in openwakeword.models:  # 2) named bundled model (exact)
            if self._normalize(key) == req:
                return [openwakeword.models[key]["model_path"]]

        # 3) Sub-phrase match: every token of the typed phrase appears in a
        # bundled model's phrase (so "jarvis" picks "hey_jarvis"). Only accept a
        # single unambiguous match — "hey" alone matches both hey_jarvis and
        # hey_mycroft, so it falls through rather than guessing. Trained on the
        # full phrase, so trigger on the lowered partial threshold.
        req_tokens = [t for t in req.split("_") if t]
        partial = sorted({
            key for key in openwakeword.models
            if req_tokens
            and self._normalize(key).split("_") != req_tokens
            and all(t in self._normalize(key).split("_") for t in req_tokens)
        })
        if len(partial) == 1:
            key = partial[0]
            self.threshold = self.partial_threshold
            spoken = key.replace("_", " ")
            self._emit_status(
                "warning",
                f"No exact wake-word model for '{DEFAULT_MODEL}'. Using the "
                f"closest built-in '{spoken}' at a lowered threshold "
                f"({self.threshold}) so saying just '{DEFAULT_MODEL}' can trigger "
                f"it. For a clean '{DEFAULT_MODEL}'-only wake word, train an "
                f"openWakeWord model and drop the .onnx in models/wakeword/.",
            )
            return [openwakeword.models[key]["model_path"]]

        if custom:  # 4) custom models present, but none matched the typed name
            return custom

        # 5) Unknown phrase with no model — use a safe default and tell the user.
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
    if "--selftest" in sys.argv:
        # min_frames=2: one above-threshold frame must NOT fire; two in a row must.
        assert _debounce_step(0, True, 2) == (1, False)
        assert _debounce_step(1, True, 2) == (0, True)
        assert _debounce_step(1, False, 2) == (0, False)  # a gap resets the run
        assert _debounce_step(0, False, 2) == (0, False)
        assert _debounce_step(0, True, 1) == (0, True)  # min_frames=1 fires at once
        print("wakeword debounce self-test OK")
        sys.exit(0)
    WakewordSidecar().run()
