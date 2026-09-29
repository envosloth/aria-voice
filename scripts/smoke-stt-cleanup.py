#!/usr/bin/env python3
"""Readiness failure must terminate AND reap the actual owned server."""
import importlib.util
import pathlib
import subprocess
import sys
from unittest.mock import patch

root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aria_stt_cleanup', root / 'sidecars/stt/main.py')
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def check(ignore_term):
    side = mod.SttSidecar()
    side._running = True
    side.model_path = 'fixture'
    side._emit_status = lambda *args: None
    children = []
    popen = subprocess.Popen
    code = ('import signal,time;'
            + ('signal.signal(signal.SIGTERM,signal.SIG_IGN);' if ignore_term else '')
            + 'print("ready",flush=True);time.sleep(20)')

    def create(*args, **kwargs):
        proc = popen([sys.executable, '-u', '-c', code], stdout=subprocess.PIPE,
                     stderr=subprocess.STDOUT, text=True)
        assert proc.stdout is not None
        assert proc.stdout.readline().strip() == 'ready'
        children.append(proc)
        return proc

    try:
        with patch.dict(mod.os.environ, {'ARIA_STT_START_TIMEOUT': '0.05'}), patch.object(mod.subprocess, 'Popen', side_effect=create):
            side._start_server('fixture')
        assert side._server_proc is None, 'handle must clear only after cleanup'
        assert children[0].returncode is not None, 'startup timeout must reap child before fallback'
        side.cleanup()  # cleanup is idempotent
        print(f'PASS readiness timeout reaps {"TERM-ignoring" if ignore_term else "cooperative"} child')
    finally:
        for proc in children:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=3)
            proc.stdout.close()


if __name__ == '__main__':
    check(True)
    check(False)
