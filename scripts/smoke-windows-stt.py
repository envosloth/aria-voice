#!/usr/bin/env python3
"""Cross-platform regressions for Windows STT failures; no model required."""
import http.server
import importlib.util
import os
import pathlib
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("windows_stt", ROOT / "sidecars/stt/main.py")
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class SttFailures(unittest.TestCase):
    def test_windows_parent_watcher_preserves_64_bit_handles_and_closes_them(self):
        import ctypes
        from types import SimpleNamespace
        base = sys.modules["base_sidecar"]
        side = mod.SttSidecar()
        side._running = True
        full_handle = 0x1234567887654321
        seen, closed, exits = [], [], []

        class NativeCall:
            # ctypes defaults to signed c_int when restype has not been declared.
            def __init__(self, fn):
                self.fn = fn
                self.restype = ctypes.c_int
                self.argtypes = None

            def __call__(self, *args):
                value = self.fn(*args)
                if self.restype is ctypes.c_int:
                    return ctypes.c_int(value).value
                return value

        def get_exit(handle, code):
            seen.append(handle)
            code._obj.value = 259
            side._running = False
            return 1

        api = SimpleNamespace(
            OpenProcess=NativeCall(lambda *args: full_handle),
            GetExitCodeProcess=NativeCall(get_exit),
            CloseHandle=NativeCall(lambda handle: closed.append(handle) or 1),
        )
        with patch.object(ctypes, "windll", SimpleNamespace(kernel32=api), create=True), \
             patch.object(base.time, "sleep"), patch.object(base.os, "_exit", side_effect=exits.append):
            side._watch_parent_windows(123)
        self.assertEqual(seen, [full_handle], "Win64 HANDLE must not truncate to c_int")
        self.assertEqual(closed, [full_handle], "watcher must release its process handle")
        self.assertFalse(exits)

    def test_decoder_crash_fails_the_correlated_turn(self):
        side = mod.SttSidecar()
        side._cli_bin = "fixture-whisper-cli"
        side.model_path = "fixture-model"
        events = []
        side.emit = events.append
        side._emit_status = lambda *args: None
        side.on_control({"type": "start", "utterance_id": "windows-crash"})
        side.on_pcm(b"\0\0" * 160)
        run = subprocess.run

        def failed_child(cmd, **kwargs):
            # Execute a real failing process, not an invented successful transcript.
            return run([sys.executable, "-c", "import sys; print('not a transcript'); sys.exit(7)"], **kwargs)

        with patch.object(mod.subprocess, "run", side_effect=failed_child):
            side.on_control({"type": "transcribe", "utterance_id": "windows-crash", "audio_bytes": 320})
        self.assertEqual(events[-1]["type"], "stt_failed", events[-1])
        self.assertEqual(events[-1]["utterance_id"], "windows-crash")
        self.assertIn("7", events[-1]["error"])
        self.assertNotIn("not a transcript", events[-1]["error"])


    def test_late_pcm_from_the_previous_turn_is_discarded(self):
        self._assert_late_pcm_is_discarded(2)

    def test_late_pcm_larger_than_one_socket_chunk_is_discarded(self):
        self._assert_late_pcm_is_discarded(8192)

    def test_repeated_start_preserves_in_flight_pcm_debt(self):
        side = mod.SttSidecar()
        heard = []
        side.emit = lambda msg: None
        side._emit_status = lambda *args: None
        side._transcribe = lambda pcm: heard.append(pcm) or "synthetic"
        side.on_control({"type": "start", "utterance_id": "A"})
        side.on_pcm(b"AA")
        side.on_control({"type": "transcribe", "utterance_id": "A", "audio_bytes": 10})
        side.on_control({"type": "start", "utterance_id": "B"})
        side.on_pcm(b"aa")
        # B is superseded before it has audio. Six bytes are still owed to A.
        side.on_control({"type": "start", "utterance_id": "C"})
        side.on_pcm(b"aaaaaaCC")
        side.on_control({"type": "transcribe", "utterance_id": "C", "audio_bytes": 2})
        self.assertEqual(heard, [b"AA", b"CC"])

    def _assert_late_pcm_is_discarded(self, tail_bytes):
        """A delayed tail belongs to the utterance that declared it, not the next.

        PCM and controls travel on separate streams, so `transcribe` can expire
        its 120 ms barrier with bytes still in flight. They used to land in the
        next utterance's buffer — clipping one command and contaminating the next.
        """
        side = mod.SttSidecar()
        side._running = True
        reader, writer = socket.socketpair()
        side._socket = reader
        heard = []
        side.emit = lambda msg: None
        side._emit_status = lambda *args: None
        side._transcribe = lambda pcm: heard.append(pcm.hex()) or pcm.hex()
        thread = threading.Thread(target=side.main_loop, daemon=True)
        thread.start()

        def wait_buffer(n, timeout=2.0):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                with side._audio_ready:
                    if len(side._audio_buffer) >= n:
                        return
                time.sleep(0.005)
            raise AssertionError("PCM never arrived")

        try:
            side.on_control({"type": "start", "utterance_id": "A"})
            writer.sendall(b"AA")
            wait_buffer(2)
            # A declares a tail that arrives only after the barrier expires.
            side.on_control({"type": "transcribe", "utterance_id": "A", "audio_bytes": 2 + tail_bytes})

            def late_tail():
                time.sleep(0.05)
                writer.sendall(b"a" * tail_bytes)  # A's delayed tail, after A's result
                time.sleep(0.05)
                writer.sendall(b"BB")   # B's own audio

            threading.Thread(target=late_tail, daemon=True).start()
            side.on_control({"type": "start", "utterance_id": "B"})
            wait_buffer(2)
            side.on_control({"type": "transcribe", "utterance_id": "B", "audio_bytes": 2})
        finally:
            side._running = False
            writer.close()
            thread.join(1)
            reader.close()

        self.assertEqual(heard[:1], ["4141"], "A transcribes the audio it received")
        self.assertEqual(heard[1:], ["4242"], "the late tail must not reach B")

    def test_cloud_stt_has_one_absolute_deadline(self):
        """A trickling provider must not hold the sidecar's control thread."""
        body = b'{"text":"yes"}'

        class Trickle(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                for byte in body:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(0.08)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Trickle)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            side = mod.SttSidecar()
            side._cloud = {
                "provider": "groq",
                "endpoint": f"http://127.0.0.1:{server.server_port}/transcriptions",
                "model": "whisper-large-v3-turbo",
                "key": "synthetic",
            }
            side._CLOUD_TIMEOUT_S = 0.25
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                side._transcribe_cloud(bytes(2))
            elapsed = time.monotonic() - started
        finally:
            server.shutdown()
            server.server_close()
        # At 80 ms per byte this response would take ~1 s; the deadline must win.
        self.assertLess(elapsed, 1.0, elapsed)

    def test_unknown_listener_ownership_is_not_trusted(self):
        """An unavailable ownership query must select CLI, not trust headers."""
        from types import SimpleNamespace
        from unittest.mock import MagicMock

        side = mod.SttSidecar()
        side._server_proc = SimpleNamespace(pid=123, poll=lambda: None)
        side._server_port = 12345
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.headers = {"Server": "whisper.cpp"}
        response.read.return_value = b'{"status":"ok"}'
        with patch.object(side, "_listener_owned_by", return_value=None), \
             patch.object(mod._LOOPBACK_OPENER, "open", return_value=response):
            self.assertFalse(side._server_identity_ok(), "unknown ownership is not identity")

    def test_foreign_listener_cannot_become_ready(self):
        """A whisper-shaped health reply is not proof that the child owns the port."""
        class Spoof(http.server.BaseHTTPRequestHandler):
            server_version = "whisper.cpp"
            sys_version = ""

            def log_message(self, *args):
                pass

            def do_GET(self):
                payload = b'{"status":"ok"}'
                self.send_response(200)
                self.send_header("Server", "whisper.cpp")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        spoof = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Spoof)
        threading.Thread(target=spoof.serve_forever, daemon=True).start()
        port = spoof.server_port
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            owned = mod.SttSidecar._listener_owned_by(child.pid, port)
            if owned is None:
                self.skipTest("listener ownership is not discoverable on this host")
            self.assertFalse(owned, "the listener belongs to this test process, not the child")

            side = mod.SttSidecar()
            side.model_path = "synthetic"
            side._free_port = lambda: port
            side._emit_status = lambda *args: None
            with patch.object(mod.subprocess, "Popen", return_value=child), \
                 patch.dict(os.environ, {"ARIA_STT_START_TIMEOUT": "1"}):
                side._start_server("synthetic")
            self.assertIsNone(side._server_proc, "a foreign listener must not be accepted as whisper")
        finally:
            try:
                child.terminate()
                child.wait(timeout=3)
            except Exception:
                child.kill()
            spoof.shutdown()
            spoof.server_close()


if __name__ == "__main__":
    unittest.main()