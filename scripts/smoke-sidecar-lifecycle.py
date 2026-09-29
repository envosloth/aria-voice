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


# A stop signal that lands during a slow initialize() must suppress 'ready' and
# never enter the main loop.
class StoppedDuringInit(base_module.BaseSidecar):
    def __init__(self):
        super().__init__("probe-stop")
        self.statuses = []
        self.entered_main = False

    def _set_parent_death_signal(self):
        pass

    def _connect_socket(self, _socket_path):
        pass

    def _heartbeat_loop(self):
        pass

    def _stdin_loop(self):
        pass

    def _emit_status(self, status, detail=""):
        self.statuses.append(status)

    def initialize(self):
        self._handle_signal(15, None)  # SIGTERM arrives mid-load

    def main_loop(self):
        self.entered_main = True


stopped = StoppedDuringInit()
with mock.patch.object(sys, "argv", ["probe", "--socket", "tcp://127.0.0.1:1"]):
    stopped.run()
check("no-ready-after-stop-during-initialize", "ready" not in stopped.statuses and not stopped.entered_main,
      repr(stopped.statuses))


# Transcription must hand whisper an even number of bytes (whole int16
# samples) and keep the odd trailing byte for the next chunk.
stt_even = stt_module.SttSidecar()
seen_pcm = []
stt_even._transcribe = lambda pcm: seen_pcm.append(pcm) or "ok"
stt_even.emit = lambda _msg: None
stt_even._emit_status = lambda *_a: None
stt_even._audio_buffer.extend(b"\x01\x02\x03")
stt_even.on_control({"type": "transcribe", "utterance_id": "odd", "audio_bytes": 3})
check("stt-transcribes-even-length-pcm", seen_pcm == [b"\x01\x02"], repr(seen_pcm))
check("stt-keeps-trailing-odd-byte", bytes(stt_even._audio_buffer) == b"\x03", repr(bytes(stt_even._audio_buffer)))


# Loopback inference must ignore HTTP(S)_PROXY: point the proxy at a server that
# would answer differently and verify the real whisper endpoint is reached.
import http.server
import json as _json


def serve(body):
    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            data = _json.dumps({"text": body}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


real, proxy = serve("from-whisper"), serve("from-proxy")
stt_proxy = stt_module.SttSidecar()
stt_proxy._server_port = real.server_address[1]
proxy_url = f"http://127.0.0.1:{proxy.server_address[1]}"
with mock.patch.dict(os.environ, {"http_proxy": proxy_url, "HTTP_PROXY": proxy_url, "no_proxy": "", "NO_PROXY": ""}, clear=False):
    try:
        got = stt_proxy._transcribe_server(b"\x00\x00" * 160)
    except Exception as exc:  # noqa: BLE001
        got = f"error: {exc}"
real.shutdown(); proxy.shutdown()
check("stt-loopback-bypasses-env-proxy", got == "from-whisper", got)


# Readiness must not be inferred from an arbitrary listener on the port: with no
# whisper listening log line, startup must fall back even if the port is open.
class QuietServer:
    def __init__(self, lines):
        import io
        self.stdout = io.StringIO("".join(lines))
        self.terminated = False

    def poll(self):
        return None

    def terminate(self):
        self.terminated = True


stt_port = stt_module.SttSidecar()
stt_port.model_path = "/tmp/fake-model.bin"
stt_port._free_port = lambda: 43124
stt_port._port_open = lambda _port: True  # someone else holds the port
stt_port._emit_status = lambda *_a: None
with mock.patch.dict(os.environ, {"ARIA_STT_START_TIMEOUT": "0.3"}, clear=False), \
        mock.patch.object(stt_module.subprocess, "Popen", return_value=QuietServer(["loading model\n"])):
    stt_port._start_server("fake-whisper-server")
check("stt-ready-requires-whisper-listening-line", stt_port._server_proc is None)

stt_ok = stt_module.SttSidecar()
stt_ok.model_path = "/tmp/fake-model.bin"
stt_ok._free_port = lambda: 43125
stt_ok._port_open = lambda _port: False
stt_ok._emit_status = lambda *_a: None
fake_ok = QuietServer(["whisper server listening at http://127.0.0.1:43125\n"])
with mock.patch.dict(os.environ, {"ARIA_STT_START_TIMEOUT": "2"}, clear=False), \
        mock.patch.object(stt_module.subprocess, "Popen", return_value=fake_ok):
    stt_ok._start_server("fake-whisper-server")
check("stt-ready-on-own-listening-line", stt_ok._server_proc is fake_ok)

stt_dead = stt_module.SttSidecar()
stt_dead.model_path = "/tmp/fake-model.bin"
stt_dead._free_port = lambda: 43126
stt_dead._emit_status = lambda *_a: None


class DiesAfterListen(QuietServer):
    def __init__(self):
        super().__init__(["whisper server listening at http://127.0.0.1:43126\n"])
        self.calls = 0

    def poll(self):
        self.calls += 1
        return None if self.calls < 3 else 1


with mock.patch.dict(os.environ, {"ARIA_STT_START_TIMEOUT": "2"}, clear=False), \
        mock.patch.object(stt_module.subprocess, "Popen", return_value=DiesAfterListen()):
    stt_dead._start_server("fake-whisper-server")
check("stt-ready-requires-live-process", stt_dead._server_proc is None)


# whisper-server block-buffers stdout when piped, so readiness may come from the
# HTTP probe — but only when the listener is provably our child. A foreign
# listener spoofing whisper's /health + Server header must not be trusted.
class SpoofHealth(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        data = b'{"status":"ok"}'
        self.send_response(200)
        self.send_header("Server", "whisper.cpp")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_a):
        pass


spoof = http.server.HTTPServer(("127.0.0.1", 0), SpoofHealth)
threading.Thread(target=spoof.serve_forever, daemon=True).start()
spoof_port = spoof.server_address[1]
import subprocess as _sp
other = _sp.Popen([sys.executable, "-c", "import time; time.sleep(30)"])


class PidServer(QuietServer):
    def __init__(self, pid):
        super().__init__([])
        self.pid = pid


def probe_start(pid):
    sc = stt_module.SttSidecar()
    sc.model_path = "/tmp/fake-model.bin"
    sc._free_port = lambda: spoof_port
    sc._emit_status = lambda *_a: None
    fake = PidServer(pid)
    with mock.patch.dict(os.environ, {"ARIA_STT_START_TIMEOUT": "1.5", "http_proxy": "", "HTTP_PROXY": ""}, clear=False), \
            mock.patch.object(stt_module.subprocess, "Popen", return_value=fake):
        sc._start_server("fake-whisper-server")
    return sc._server_proc is fake


try:
    if sys.platform.startswith("linux"):
        check("stt-http-ready-rejects-foreign-listener", probe_start(other.pid) is False)
    check("stt-http-ready-accepts-owned-listener", probe_start(os.getpid()) is True)
finally:
    other.kill()
    spoof.shutdown()


# ARIA_MODELS_DIR is exclusive: a model that exists only in a legacy fallback
# location must NOT be used when the authoritative directory is set.
with tempfile.TemporaryDirectory() as models, tempfile.TemporaryDirectory() as fake_home:
    legacy = os.path.join(fake_home, ".local", "share", "aria", "models")
    os.makedirs(os.path.join(legacy, "wakeword"))
    for f in ("ggml-exclusive.bin", "kokoro-v1.0.onnx", "voices-v1.0.bin", "excl-voice.onnx",
              os.path.join("wakeword", f"{wake_module.DEFAULT_MODEL}.onnx")):
        open(os.path.join(legacy, f), "wb").close()
    with mock.patch.dict(os.environ, {"ARIA_MODELS_DIR": models, "HOME": fake_home, "ARIA_STT_MODEL": "exclusive"}, clear=False):
        def raises(fn):
            try:
                return f"found {fn()}"
            except FileNotFoundError:
                return "not-found"
        stt_res = raises(stt_module.SttSidecar()._find_model)
        tts_x = tts_module.TtsSidecar()
        tts_x.voice_name = "excl-voice"
        kok_res = raises(tts_x._find_kokoro_files)
        pip_res = raises(tts_x._find_piper_voice)
        wake_res = wake_module.WakewordSidecar()._resolve_model_paths(EmptyWakePackage())
    check("stt-models-dir-exclusive", stt_res == "not-found", stt_res)
    check("kokoro-models-dir-exclusive", kok_res == "not-found", kok_res)
    check("piper-models-dir-exclusive", pip_res == "not-found", pip_res)
    check("wakeword-models-dir-exclusive", not any(legacy in p for p in (wake_res or [])), repr(wake_res))

print(f"\n=== RESULT: {'PASS' if not failures else 'FAIL'} ===")
sys.exit(0 if not failures else 1)
