#!/usr/bin/env python3
"""Focused STT sidecar control-path regression tests (no model/network needed)."""

import os
import importlib.util
import sys
import threading
import time
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STT_MAIN = os.path.join(ROOT, "sidecars", "stt", "main.py")
spec = importlib.util.spec_from_file_location("aria_stt_main", STT_MAIN)
assert spec and spec.loader
stt_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stt_module)
SttSidecar = stt_module.SttSidecar


failures = []


def check(name, condition, detail=""):
    if not condition:
        failures.append(name)
    print(f"[{name}] {'PASS' if condition else 'FAIL'}" + (f" — {detail}" if detail else ""))


sidecar = SttSidecar()
emitted = []
transcribed = []
sidecar.emit = emitted.append
sidecar._emit_status = lambda *_args, **_kwargs: None
sidecar._transcribe = lambda pcm: transcribed.append(pcm) or "clear speech"

# Starting an utterance must reset the buffer and acknowledge the correlated id.
sidecar._audio_buffer.extend(b"old")
sidecar.on_control({"type": "start", "utterance_id": "turn-1"})
check("start-clears-old-audio", bytes(sidecar._audio_buffer) == b"")
check("start-acks-turn-id", emitted == [{"type": "stt_started", "utterance_id": "turn-1"}])

# The transcribe control may beat the last PCM socket frame because controls and
# audio use separate transports. It must wait briefly for the declared byte count,
# then transcribe all bytes rather than clipping the utterance edge.
sidecar.on_pcm(b"ab")

def finish_pcm():
    time.sleep(0.02)
    sidecar.on_pcm(b"cdef")

producer = threading.Thread(target=finish_pcm)
producer.start()
t0 = time.monotonic()
sidecar.on_control({"type": "transcribe", "utterance_id": "turn-1", "audio_bytes": 6})
elapsed_ms = (time.monotonic() - t0) * 1000
producer.join()
check("transcribe-waits-for-complete-audio", transcribed == [b"abcdef"], f"got {transcribed!r}")
check("wait-adds-no-fixed-latency", elapsed_ms < 100, f"waited {elapsed_ms:.1f}ms")
check(
    "result-carries-turn-id",
    emitted[-1].get("type") == "stt_result"
    and emitted[-1].get("utterance_id") == "turn-1"
    and emitted[-1].get("text") == "clear speech",
    f"got {emitted[-1]!r}",
)

# Zero-cost decoder hardening must be enabled on both warm-server and CLI paths.
source = open(os.path.join(ROOT, "sidecars", "stt", "main.py"), encoding="utf-8").read()
check("server-suppresses-nonspeech-tokens", '"--suppress-nst"' in source)
check("cli-suppresses-nonspeech-tokens", source.count('"--suppress-nst"') >= 2)

# Detecting the Vulkan backend happens before whisper-server opens its HTTP port.
# The sidecar must keep waiting for the port instead of reporting ready early.
class FakeStdout:
    def __init__(self):
        self.lines = iter(["using Vulkan backend\n"])

    def readline(self):
        return next(self.lines, "")

    def __iter__(self):
        return iter(())


class FakeProc:
    def __init__(self):
        self.stdout = FakeStdout()

    def poll(self):
        return None


startup_sidecar = SttSidecar()
startup_sidecar.model_path = "/tmp/model.bin"
startup_sidecar._emit_status = lambda *_args, **_kwargs: None
port_checks = []
startup_sidecar._port_open = lambda _port: port_checks.append(True) or len(port_checks) >= 2
with mock.patch.object(stt_module.subprocess, "Popen", return_value=FakeProc()), \
     mock.patch.object(stt_module.threading, "Thread"):
    startup_sidecar._start_server("/tmp/whisper-server")
check("server-waits-for-http-readiness", len(port_checks) >= 2, f"port checks={len(port_checks)}")

# A warm server inference can still fail; keep whisper-cli discovered so the
# advertised per-call fallback has a real executable instead of an empty path.
fallback_sidecar = SttSidecar()
fallback_sidecar._find_model = lambda: "/tmp/model.bin"
fallback_sidecar._find_binary = lambda name: f"/tmp/{name}"
fallback_sidecar._start_server = lambda _binary: setattr(fallback_sidecar, "_server_proc", FakeProc())
fallback_sidecar._emit_status = lambda *_args, **_kwargs: None
fallback_sidecar.initialize()
check("warm-server-keeps-cli-fallback", fallback_sidecar._cli_bin == "/tmp/whisper-cli")

print(f"\n=== RESULT: {'PASS' if not failures else 'FAIL'} ===")
raise SystemExit(0 if not failures else 1)
