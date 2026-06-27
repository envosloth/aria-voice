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
import queue
import re
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shared"))
from base_sidecar import BaseSidecar

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")

# Clause boundaries (comma/semicolon/colon/dash) are natural pauses kokoro already
# renders as pauses. We split the FIRST sentence at its first clause boundary so
# the first audio chunk is emitted sooner (lower time-to-first-audio) — splitting
# there sounds the same as synthesizing the clause inline, but gets speech out
# ~400-570ms earlier for clause-leading replies ("Sure, ...", "According to ...").
# Only the first sentence is split, only into two parts, and only when both parts
# are substantial — so short openers and the rest of the reply stay whole/smooth.
CLAUSE_SPLIT = re.compile(r"(?<=[,;:—])\s+")
FIRST_SENTENCE_SPLIT_MIN = 20  # don't bother splitting an already-short opener
FIRST_CLAUSE_HEAD_MIN = 4      # head clause must be a real word, not a stray char
FIRST_CLAUSE_TAIL_MIN = 6      # remainder must be substantial enough to be worth it

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
        self._load_lock = threading.Lock()
        # Synthesis runs on a dedicated worker thread (not the stdin thread) so a
        # 'stop' control message is read and applied immediately — that's what
        # makes barge-in crisp. `_epoch` is bumped on every stop; queued and
        # in-progress synthesis whose epoch is stale is discarded.
        self._synth_queue: "queue.Queue[tuple[int, str]]" = queue.Queue()
        self._epoch = 0
        self._epoch_lock = threading.Lock()

    def initialize(self) -> None:
        detail = self._ensure_loaded()
        threading.Thread(target=self._synth_worker, daemon=True).start()
        self._emit_status("initialized", detail)

    def _current_epoch(self) -> int:
        with self._epoch_lock:
            return self._epoch

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
                    # Piper voice names look like en_US-ryan-high; fall back if
                    # a Kokoro-style name leaked into the piper path.
                    if self.voice_name.startswith(("af_", "am_", "bf_", "bm_")):
                        self.voice_name = "en_US-ryan-high"
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
        self._warmup_kokoro()

    def _warmup_kokoro(self) -> None:
        """Run one throwaway synthesis so the ONNX graph is hot before the first
        real utterance. The cold first inference dominates first-audio latency
        (~0.8s in the e2e budget); doing it here — during load, behind the
        'ready' gate — moves that cost off the user's first request."""
        try:
            self._kokoro.create(
                "Ready.", voice=self.voice_name, speed=self.speed,
                lang=_lang_for_voice(self.voice_name),
            )
        except Exception:
            pass  # warmup is best-effort; real synthesis will still work

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
        # Warm the graph (see _warmup_kokoro) so the first utterance is fast.
        try:
            for _ in self._voice.synthesize("Ready."):
                pass
        except Exception:
            pass

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
            # Tag the request with the current epoch and hand it to the worker;
            # the stdin thread stays free to receive a 'stop' mid-synthesis.
            self._synth_queue.put((self._current_epoch(), msg.get("text", "")))
        elif mtype == "stop":
            # Bump the epoch (cancels the in-progress + queued synthesis) and
            # drop anything already queued so the next turn starts clean.
            with self._epoch_lock:
                self._epoch += 1
            while True:
                try:
                    self._synth_queue.get_nowait()
                    self._synth_queue.task_done()
                except queue.Empty:
                    break
            self.emit({"type": "tts_stopped"})

    def _synth_worker(self) -> None:
        """Consume the synthesis queue off the stdin thread. Each item carries
        the epoch it was queued under; if a 'stop' has since bumped the epoch the
        item is skipped, so an interrupted reply is abandoned instead of played
        over the user's next utterance."""
        while self._running:
            try:
                item_epoch, text = self._synth_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                if item_epoch == self._current_epoch():
                    self._synthesize(text, item_epoch)
            except Exception as e:  # one bad utterance must not kill the worker
                self._emit_status("error", f"synthesize: {e}")
            finally:
                self._synth_queue.task_done()

    def _synthesize(self, text: str, item_epoch: int) -> None:
        """Synthesize sentence by sentence, streaming PCM as each is ready.

        Sentence chunking lets the renderer start playback after the first
        sentence while later sentences are still being generated. Each chunk's
        size + sample rate is announced over stdout before its bytes go out over
        the socket. A 'stop' (epoch bump) abandons the rest mid-stream.
        """
        # Guard against a first-utterance race: the model may not have finished
        # loading when this synthesize arrived. _ensure_loaded() is idempotent.
        self._ensure_loaded()

        chunks = self._chunks_for(text)
        total = len(chunks)

        for i, chunk in enumerate(chunks):
            if item_epoch != self._current_epoch():
                return  # superseded by a stop — drop the rest, no tts_done
            if self.engine == "kokoro":
                self._emit_kokoro(chunk, i, total, item_epoch)
            else:
                self._emit_piper(chunk, i, total, item_epoch)

        if item_epoch == self._current_epoch():
            self.emit({"type": "tts_done"})

    def _chunks_for(self, text: str) -> list:
        """Split text into speakable chunks. Sentences are the base unit; the
        first sentence is additionally split at its first clause boundary so the
        first audio is emitted sooner (see CLAUSE_SPLIT). Only the first sentence
        is affected; everything after it stays whole for smooth prosody and to
        avoid create() overhead on tiny fragments."""
        sentences = [s.strip() for s in SENTENCE_SPLIT.split(text) if s.strip()]
        if not sentences:
            return []
        first = sentences[0]
        if len(first) >= FIRST_SENTENCE_SPLIT_MIN:
            parts = CLAUSE_SPLIT.split(first, maxsplit=1)
            if len(parts) == 2:
                head, tail = parts[0].strip(), parts[1].strip()
                if len(head) >= FIRST_CLAUSE_HEAD_MIN and len(tail) >= FIRST_CLAUSE_TAIL_MIN:
                    return [head, tail] + sentences[1:]
        return sentences

    def _emit_kokoro(self, sentence: str, index: int, total: int, item_epoch: int) -> None:
        import numpy as np
        samples, sr = self._kokoro.create(
            sentence, voice=self.voice_name, speed=self.speed,
            lang=_lang_for_voice(self.voice_name),
        )
        if item_epoch != self._current_epoch():
            return  # a stop landed while synthesizing — don't emit this chunk
        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        self.emit({
            "type": "tts_chunk", "index": index, "total": total,
            "size": len(pcm), "sample_rate": int(sr),
        })
        self.send_pcm(pcm)

    def _emit_piper(self, sentence: str, index: int, total: int, item_epoch: int) -> None:
        for chunk in self._voice.synthesize(sentence):
            if item_epoch != self._current_epoch():
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
