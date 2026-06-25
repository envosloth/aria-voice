#!/usr/bin/env python3
"""TTS sidecar: Kokoro-82M (default) or Piper for local text-to-speech.

Both run on CPU via ONNX. Receives text over UDS, streams PCM audio back.
Sentence-chunked: starts playback after the first sentence is synthesized.

Kokoro-82M produces markedly more natural, less robotic speech than Piper and
ships a set of expressive voices (including a refined British male used as the
"Jarvis" assistant default). Phonemization is handled by the bundled espeak-ng
via espeakng-loader, so there is no system espeak dependency.

Both engines keep a persistent loaded model (warm process) — model load is the
dominant cost; synthesis is several times realtime once warm.
"""

import json
import os
import re
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shared"))
from base_sidecar import BaseSidecar

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")

# Voice -> language for the phonemizer. British voices (bf_/bm_) use en-gb so the
# accent is rendered correctly; everything else defaults to en-us.
def _lang_for_voice(voice: str) -> str:
    return "en-gb" if voice[:2] in ("bf", "bm") else "en-us"


class TtsSidecar(BaseSidecar):
    def __init__(self):
        super().__init__("tts")
        self.engine = os.environ.get("ARIA_TTS_ENGINE", "kokoro")
        self.voice_name = os.environ.get("ARIA_TTS_VOICE", "bm_george")
        self.speed = float(os.environ.get("ARIA_TTS_SPEED", "1.0"))
        self.voice_model_path: str = ""
        self._voice = None       # persistent PiperVoice (piper engine)
        self._kokoro = None      # persistent Kokoro (kokoro engine)
        self._cancel = False
        self._load_lock = threading.Lock()

    def initialize(self) -> None:
        detail = self._ensure_loaded()
        self._emit_status("initialized", detail)

    def _ensure_loaded(self) -> str:
        """Load the configured engine's model if it isn't already loaded.

        Idempotent and lock-guarded so it is safe to call from both initialize()
        (main thread) and a 'synthesize' control message (the stdin thread). This
        closes a startup race: a synthesize arriving before initialize() finished
        loading used to hit a None model ("'NoneType' object has no attribute
        'create'") and produce no audio on the very first utterance.
        """
        with self._load_lock:
            if self.engine == "kokoro":
                if self._kokoro is None:
                    self._load_kokoro()
                return f"engine=kokoro voice={self.voice_name}"
            elif self.engine == "piper":
                if self._voice is None:
                    # Piper voice names look like en_US-lessac-medium; fall back if
                    # a Kokoro-style name leaked into the piper path.
                    if self.voice_name.startswith(("af_", "am_", "bf_", "bm_")):
                        self.voice_name = "en_US-lessac-medium"
                    self.voice_model_path = self._find_piper_voice()
                    self._load_piper()
                return f"engine=piper voice={os.path.basename(self.voice_model_path)}"
            else:
                raise RuntimeError(f"Unsupported TTS engine: {self.engine}")

    # --- Kokoro ---------------------------------------------------------------
    def _load_kokoro(self) -> None:
        from kokoro_onnx import Kokoro
        model_path, voices_path = self._find_kokoro_files()
        self._kokoro = Kokoro(model_path, voices_path)
        # Validate the requested voice; fall back to the Jarvis default.
        try:
            available = set(self._kokoro.get_voices())
        except Exception:
            available = set(getattr(self._kokoro, "voices", {}).keys())
        if available and self.voice_name not in available:
            self.voice_name = "bm_george" if "bm_george" in available else sorted(available)[0]

    def _find_kokoro_files(self):
        names = ("kokoro-v1.0.onnx", "voices-v1.0.bin")
        dirs = [
            os.path.join(os.path.dirname(__file__), "..", "..", "models"),
            os.path.expanduser("~/.local/share/aria/models"),
        ]
        # Allow an explicit override directory (used by frozen builds).
        if os.environ.get("ARIA_MODELS_DIR"):
            dirs.insert(0, os.environ["ARIA_MODELS_DIR"])
        for d in dirs:
            model = os.path.join(d, names[0])
            voices = os.path.join(d, names[1])
            if os.path.isfile(model) and os.path.isfile(voices):
                return model, voices
        raise FileNotFoundError(
            "Kokoro model files (kokoro-v1.0.onnx, voices-v1.0.bin) not found. "
            "Run scripts/download-models.sh to fetch them."
        )

    # --- Piper ----------------------------------------------------------------
    def _load_piper(self) -> None:
        from piper import PiperVoice
        self._voice = PiperVoice.load(self.voice_model_path)

    def _find_piper_voice(self) -> str:
        voice_file = f"{self.voice_name}.onnx"
        search_paths = [
            os.path.join(os.path.dirname(__file__), "..", "..", "models", voice_file),
            os.path.expanduser(f"~/.local/share/aria/models/{voice_file}"),
            os.path.expanduser(f"~/.local/share/piper/voices/{voice_file}"),
        ]
        for p in search_paths:
            if os.path.isfile(p):
                return p
        raise FileNotFoundError(f"Piper voice model '{voice_file}' not found.")

    # --- Control loop ---------------------------------------------------------
    def main_loop(self) -> None:
        # TTS does not consume an input PCM stream — it produces one. Idle until
        # control messages arrive on stdin (handled in on_control).
        import time
        while self._running:
            time.sleep(0.1)

    def on_control(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "synthesize":
            self._cancel = False
            self._synthesize(msg.get("text", ""))
        elif mtype == "stop":
            self._cancel = True
            self.emit({"type": "tts_stopped"})

    def _synthesize(self, text: str) -> None:
        """Synthesize sentence by sentence, streaming PCM as each is ready.

        Sentence chunking lets the renderer start playback after the first
        sentence while later sentences are still being generated. Each chunk's
        size + sample rate is announced over stdout before its bytes go out over
        the socket.
        """
        # Guard against a first-utterance race: the model may not have finished
        # loading when this synthesize arrived. _ensure_loaded() is idempotent.
        self._ensure_loaded()

        sentences = [s.strip() for s in SENTENCE_SPLIT.split(text) if s.strip()]
        total = len(sentences)

        for i, sentence in enumerate(sentences):
            if self._cancel:
                break
            if self.engine == "kokoro":
                self._emit_kokoro(sentence, i, total)
            else:
                self._emit_piper(sentence, i, total)

        self.emit({"type": "tts_done"})

    def _emit_kokoro(self, sentence: str, index: int, total: int) -> None:
        import numpy as np
        samples, sr = self._kokoro.create(
            sentence, voice=self.voice_name, speed=self.speed,
            lang=_lang_for_voice(self.voice_name),
        )
        if self._cancel:
            return
        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        self.emit({
            "type": "tts_chunk", "index": index, "total": total,
            "size": len(pcm), "sample_rate": int(sr),
        })
        self.send_pcm(pcm)

    def _emit_piper(self, sentence: str, index: int, total: int) -> None:
        for chunk in self._voice.synthesize(sentence):
            if self._cancel:
                break
            pcm = chunk.audio_int16_bytes
            self.emit({
                "type": "tts_chunk", "index": index, "total": total,
                "size": len(pcm), "sample_rate": chunk.sample_rate,
            })
            self.send_pcm(pcm)

    def cleanup(self) -> None:
        self._voice = None
        self._kokoro = None
        super().cleanup()


if __name__ == "__main__":
    TtsSidecar().run()
