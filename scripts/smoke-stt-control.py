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
# The sidecar must keep waiting instead of reporting ready early. Readiness is
# proven only by whisper-server's own "listening at ...:PORT" line (a bare port
# probe could hit an unrelated listener), so with only a Vulkan line and an open
# port it must time out to the CLI fallback.
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

    def terminate(self):
        pass

    def wait(self, timeout=None):
        return 0


startup_sidecar = SttSidecar()
startup_sidecar.model_path = "/tmp/model.bin"
startup_sidecar._emit_status = lambda *_args, **_kwargs: None
startup_sidecar._port_open = lambda _port: True
with mock.patch.object(stt_module.subprocess, "Popen", return_value=FakeProc()), \
     mock.patch.object(stt_module.threading, "Thread"), \
     mock.patch.dict(os.environ, {"ARIA_STT_START_TIMEOUT": "0.3"}, clear=False):
    startup_sidecar._start_server("/tmp/whisper-server")
check("server-waits-for-http-readiness", startup_sidecar._server_proc is None,
      "vulkan line + open port must not count as ready")

# A warm server inference can still fail; keep whisper-cli discovered so the
# advertised per-call fallback has a real executable instead of an empty path.
fallback_sidecar = SttSidecar()
fallback_sidecar._find_model = lambda: "/tmp/model.bin"
fallback_sidecar._find_binary = lambda name: f"/tmp/{name}"
fallback_sidecar._start_server = lambda _binary: setattr(fallback_sidecar, "_server_proc", FakeProc())
fallback_sidecar._emit_status = lambda *_args, **_kwargs: None
fallback_sidecar.initialize()
check("warm-server-keeps-cli-fallback", fallback_sidecar._cli_bin == "/tmp/whisper-cli")

# Speculative transcription: transcribes the audio so far WITHOUT consuming it,
# emits a correlated stt_partial, and lets the final pass reuse that text when the
# only audio added since is silence (the pause that triggered the speculation).
spec = SttSidecar()
spec_out = []
spec_calls = []
spec.emit = spec_out.append
spec._emit_status = lambda *_a, **_k: None
spec._transcribe = lambda pcm: spec_calls.append(len(pcm)) or "turn off the lights"
loud = (b"\x00\x40" * 1600)          # 100ms at ~0.5 FS
quiet = (b"\x02\x00" * 3200)         # 200ms near-silence
spec.on_control({"type": "start", "utterance_id": "s-1"})
spec.on_pcm(loud)
spec.on_control({"type": "speculate", "utterance_id": "s-1", "audio_bytes": len(loud)})
check("speculate-emits-partial", spec_out[-1] == {"type": "stt_partial", "utterance_id": "s-1",
      "text": "turn off the lights", "audio_bytes": len(loud)}, f"got {spec_out[-1]!r}")
check("speculate-keeps-buffer", len(spec._audio_buffer) == len(loud))
spec.on_control({"type": "speculate", "utterance_id": "stale", "audio_bytes": 2})
check("speculate-ignores-stale-turn", len(spec_calls) == 1)
spec.on_pcm(quiet)
spec.on_control({"type": "transcribe", "utterance_id": "s-1", "audio_bytes": len(loud) + len(quiet)})
check("final-reuses-speculation-over-silent-tail", len(spec_calls) == 1
      and spec_out[-1].get("text") == "turn off the lights" and spec_out[-1].get("reused") is True,
      f"calls={spec_calls} out={spec_out[-1]!r}")

spec2 = SttSidecar()
spec2_out = []
spec2_calls = []
spec2.emit = spec2_out.append
spec2._emit_status = lambda *_a, **_k: None
spec2._transcribe = lambda pcm: spec2_calls.append(len(pcm)) or ("turn off" if len(spec2_calls) == 1 else "turn off the lights")
spec2.on_control({"type": "start", "utterance_id": "s-2"})
spec2.on_pcm(loud)
spec2.on_control({"type": "speculate", "utterance_id": "s-2", "audio_bytes": len(loud)})
spec2.on_pcm(loud)  # user kept talking after the speculation
spec2.on_control({"type": "transcribe", "utterance_id": "s-2", "audio_bytes": 2 * len(loud)})
check("final-retranscribes-when-tail-has-speech", len(spec2_calls) == 2
      and spec2_out[-1].get("text") == "turn off the lights" and not spec2_out[-1].get("reused"),
      f"calls={spec2_calls} out={spec2_out[-1]!r}")
spec2.on_control({"type": "start", "utterance_id": "s-3"})
spec2.on_pcm(quiet)
spec2.on_control({"type": "transcribe", "utterance_id": "s-3", "audio_bytes": len(quiet)})
check("new-turn-drops-old-speculation", len(spec2_calls) == 3)

print(f"\n=== RESULT: {'PASS' if not failures else 'FAIL'} ===")
raise SystemExit(0 if not failures else 1)
