#!/usr/bin/env python3
"""TTS sidecar: Piper (default) or Kokoro-82M for local text-to-speech.

Both run on CPU via ONNX. Receives text over UDS, streams PCM audio back.
Sentence-chunked: starts playback after the first sentence is synthesized.

Uses the PiperVoice Python API with a persistent loaded model (warm process)
rather than spawning a subprocess per utterance — model load is the dominant
cost (~1.2s) and synthesis is ~30x realtime once warm (first chunk 30-80ms).
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shared"))
from base_sidecar import BaseSidecar

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


class TtsSidecar(BaseSidecar):
    def __init__(self):
        super().__init__("tts")
        self.engine = os.environ.get("ARIA_TTS_ENGINE", "piper")
        self.voice_model_path: str = ""
        self._voice = None  # persistent loaded PiperVoice
        self._cancel = False

    def initialize(self) -> None:
        if self.engine == "piper":
            self.voice_model_path = self._find_voice()
            self._load_voice()
        else:
            raise RuntimeError(f"Unsupported TTS engine: {self.engine}")
        self._emit_status("initialized", f"engine={self.engine} voice={os.path.basename(self.voice_model_path)}")

    def _load_voice(self) -> None:
        from piper import PiperVoice
        self._voice = PiperVoice.load(self.voice_model_path)

    def main_loop(self) -> None:
        # TTS does not consume an input PCM stream — it produces one. Idle
        # until control messages arrive on stdin (handled in on_control).
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
        size is announced over stdout before its bytes go out over the socket.
        """
        sentences = [s.strip() for s in SENTENCE_SPLIT.split(text) if s.strip()]
        total = len(sentences)

        for i, sentence in enumerate(sentences):
            if self._cancel:
                break

            for chunk in self._voice.synthesize(sentence):
                if self._cancel:
                    break
                pcm = chunk.audio_int16_bytes
                self.emit({
                    "type": "tts_chunk",
                    "index": i,
                    "total": total,
                    "size": len(pcm),
                    "sample_rate": chunk.sample_rate,
                })
                self.send_pcm(pcm)

        self.emit({"type": "tts_done"})

    def _find_voice(self) -> str:
        voice_name = os.environ.get("ARIA_TTS_VOICE", "en_US-lessac-medium")
        voice_file = f"{voice_name}.onnx"

        search_paths = [
            os.path.join(os.path.dirname(__file__), "..", "..", "models", voice_file),
            os.path.expanduser(f"~/.local/share/aria/models/{voice_file}"),
            os.path.expanduser(f"~/.local/share/piper/voices/{voice_file}"),
        ]

        for p in search_paths:
            if os.path.isfile(p):
                return p
        raise FileNotFoundError(f"Piper voice model '{voice_file}' not found.")

    def cleanup(self) -> None:
        self._voice = None
        super().cleanup()


if __name__ == "__main__":
    TtsSidecar().run()
