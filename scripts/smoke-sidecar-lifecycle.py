#!/usr/bin/env python3
"""Focused sidecar lifecycle regression tests (no model or network needed)."""

import importlib.util
import os
import sys
import tempfile
import threading
import time
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tts_module = load("aria_tts_lifecycle", "sidecars/tts/main.py")
wake_module = load("aria_wake_lifecycle", "sidecars/wakeword/main.py")
base_module = load("aria_base_lifecycle", "sidecars/shared/base_sidecar.py")
stt_module = load("aria_stt_lifecycle", "sidecars/stt/main.py")

failures = []


def check(name, condition, detail=""):
    if not condition:
        failures.append(name)
    print(f"[{name}] {'PASS' if condition else 'FAIL'}" + (f" — {detail}" if detail else ""))


# ARIA_MODELS_DIR is the main process's authoritative models location. Piper
# must honor it just as Kokoro and STT do.
with tempfile.TemporaryDirectory() as models:
    voice = "test-voice.onnx"
    expected = os.path.join(models, voice)
    open(expected, "wb").close()
    with mock.patch.dict(os.environ, {"ARIA_MODELS_DIR": models}, clear=False):
        tts = tts_module.TtsSidecar()
        tts.voice_name = "test-voice"
        try:
            found = tts._find_piper_voice()
        except FileNotFoundError:
            found = ""
        check("piper-honors-aria-models-dir", found == expected, found)


# Wakeword cooldown must use a monotonic clock: a wall-clock correction must
# not extend the cooldown indefinitely or re-fire early.
class FakeNumpy:
    int16 = object()

    @staticmethod
    def frombuffer(_frame, dtype=None):
        return object()


class FakeWakeModel:
    def predict(self, _audio):
        return {"hey_jarvis": 0.9}

    def reset(self):
        pass


wake = wake_module.WakewordSidecar()
wake._np = FakeNumpy()
wake.model = FakeWakeModel()
wake.min_frames = 1
wake._buffer = bytearray()
detected = []
wake.emit = detected.append
with mock.patch.object(wake_module.time, "monotonic", side_effect=[100.0, 102.0]):
    wake.on_pcm(b"x" * wake_module.FRAME_BYTES)
    wake.on_pcm(b"x" * wake_module.FRAME_BYTES)
check("wakeword-cooldown-is-monotonic", len(detected) == 2, repr(detected))


# Custom wake-word discovery must use the same authoritative model directory as
# downloads and the other sidecars.
class EmptyWakePackage:
    models = {"other": {"model_path": "/fake/other.onnx"}}


with tempfile.TemporaryDirectory() as models:
    wake_dir = os.path.join(models, "wakeword")
    os.makedirs(wake_dir)
    custom_wake = os.path.join(wake_dir, f"{wake_module.DEFAULT_MODEL}.onnx")
    open(custom_wake, "wb").close()
    with mock.patch.dict(os.environ, {"ARIA_MODELS_DIR": models}, clear=False):
        resolved = wake_module.WakewordSidecar()._resolve_model_paths(EmptyWakePackage())
    check("wakeword-honors-aria-models-dir", resolved == [custom_wake], repr(resolved))


# Non-Linux parent watchers must start after the sidecar is marked running;
# otherwise their loop sees false and exits immediately at startup.
class ProbeSidecar(base_module.BaseSidecar):
    def __init__(self):
        super().__init__("probe")
        self.parent_saw_running = None

    def _set_parent_death_signal(self):
        self.parent_saw_running = self._running

    def _connect_socket(self, _socket_path):
        pass

    def initialize(self):
        pass

    def main_loop(self):
        self._running = False


probe = ProbeSidecar()
with mock.patch.object(sys, "argv", ["probe", "--socket", "tcp://127.0.0.1:1"]):
    probe.run()
check("parent-watcher-starts-after-running", probe.parent_saw_running is True)


# Per-request completion and end-of-reply completion must stay distinct and carry
# the reply/request/epoch that caused them.
tts = tts_module.TtsSidecar()
tts._ensure_loaded = lambda: "loaded"
tts._chunks_for = lambda _text: ["Hello"]
tts._emit_piper = lambda *_args: None
emitted = []
tts.emit = emitted.append
try:
    tts._synthesize("Hello", 0, "reply-1", "request-1", 7)
except TypeError:
    pass
check("tts-request-done-is-correlated", emitted == [{
    "type": "tts_done", "reply_id": "reply-1", "request_id": "request-1", "epoch": 7,
}])


# A server that remains alive but never emits a newline must not trap startup in
# blocking readline(). The independent deadline still has to select CLI fallback.
class SilentStdout:
    def readline(self):
        time.sleep(1)
        return ""

    def __iter__(self):
        return iter(())


class SilentServer:
    stdout = SilentStdout()

    def poll(self):
        return None

    def terminate(self):
        pass


stt = stt_module.SttSidecar()
stt.model_path = "/tmp/fake-model.bin"
stt._free_port = lambda: 43123
stt._port_open = lambda _port: False
with mock.patch.dict(os.environ, {"ARIA_STT_START_TIMEOUT": "0.05"}, clear=False), \
        mock.patch.object(stt_module.subprocess, "Popen", return_value=SilentServer()):
    worker = threading.Thread(target=stt._start_server, args=("fake-whisper-server",), daemon=True)
    worker.start()
    worker.join(0.3)
check("stt-startup-deadline-is-nonblocking", not worker.is_alive())


# Inference failures must resolve the correlated renderer turn instead of only
# producing an uncorrelated generic sidecar error.
stt_failure = stt_module.SttSidecar()
stt_failure._audio_buffer.extend(b"\x00\x00")
stt_failure._utterance_id = "turn-failed"
stt_failure._transcribe = lambda _pcm: (_ for _ in ()).throw(RuntimeError("decoder failed"))
stt_events = []
stt_failure.emit = stt_events.append
try:
    stt_failure.on_control({"type": "transcribe", "utterance_id": "turn-failed", "audio_bytes": 2})
except RuntimeError:
    pass
check("stt-inference-failure-is-correlated", stt_events == [{
    "type": "stt_failed", "utterance_id": "turn-failed", "error": "decoder failed",
}], repr(stt_events))

print(f"\n=== RESULT: {'PASS' if not failures else 'FAIL'} ===")
sys.exit(0 if not failures else 1)
