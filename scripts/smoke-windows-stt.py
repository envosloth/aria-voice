#!/usr/bin/env python3
"""Cross-platform regressions for Windows STT failures; no model required."""
import importlib.util
import pathlib
import subprocess
import sys
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


if __name__ == "__main__":
    unittest.main()