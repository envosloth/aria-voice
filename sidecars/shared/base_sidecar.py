"""Base class for ARIA Python sidecars.

IPC design (per the build spec: "stdio for control/JSON, a UDS for the PCM stream"):

  - stdin  : newline-delimited JSON control messages TO the sidecar
             (e.g. {"type":"transcribe"}, {"type":"synthesize","text":...})
  - stdout : newline-delimited JSON results/status FROM the sidecar
             (e.g. {"type":"stt_result",...}, {"type":"heartbeat"})
  - socket : raw binary PCM stream over a Unix domain socket
             (STT/wakeword read it; TTS writes it)

Keeping control messages on stdin (line-framed) and bulk PCM on the socket
avoids the framing problem of interleaving large binary blobs with JSON on a
single byte stream.
"""

import argparse
import json
import os
import signal
import socket
import sys
import threading
import time
from abc import ABC, abstractmethod


class BaseSidecar(ABC):
    def __init__(self, name: str):
        self.name = name
        self._running = False
        self._socket: socket.socket | None = None
        self._heartbeat_interval = 3.0
        self._stdout_lock = threading.Lock()

    def run(self) -> None:
        parser = argparse.ArgumentParser()
        parser.add_argument("--socket", required=True, help="UDS path for the PCM data channel")
        args = parser.parse_args()

        signal.signal(signal.SIGTERM, self._handle_signal)
        signal.signal(signal.SIGINT, self._handle_signal)
        self._set_parent_death_signal()

        self._running = True
        self._connect_socket(args.socket)

        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        threading.Thread(target=self._stdin_loop, daemon=True).start()

        try:
            self.initialize()
            self._emit_status("ready")
            self.main_loop()
        except Exception as e:
            self._emit_status("error", str(e))
            raise
        finally:
            self.cleanup()
            self._running = False

    def _set_parent_death_signal(self) -> None:
        """Linux backstop: ask the kernel to SIGTERM this process if the parent
        (the Electron supervisor) dies. Covers the case where the parent is
        hard-killed (SIGKILL) and can't run its normal tree-kill cleanup — without
        this the sidecar (and its grandchildren) would orphan. Complements, not
        replaces, the supervisor's process-group tree-kill on graceful quit."""
        if sys.platform != "linux":
            return
        try:
            import ctypes
            PR_SET_PDEATHSIG = 1
            libc = ctypes.CDLL("libc.so.6", use_errno=True)
            libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)
            # Guard against a race: if the parent already died before prctl ran,
            # exit now rather than linger as an orphan.
            if os.getppid() == 1:
                self._running = False
                os._exit(0)
        except Exception:
            pass  # best-effort backstop; tree-kill remains the primary mechanism

    # ---- socket (PCM) ----

    def _connect_socket(self, socket_path: str) -> None:
        self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._socket.connect(socket_path)

    def send_pcm(self, data: bytes) -> None:
        """Write raw PCM bytes to the socket (used by TTS)."""
        if self._socket:
            try:
                self._socket.sendall(data)
            except (BrokenPipeError, OSError):
                self._running = False

    def recv_pcm(self, bufsize: int = 4096) -> bytes:
        """Read raw PCM bytes from the socket (used by STT/wakeword)."""
        if self._socket:
            try:
                return self._socket.recv(bufsize)
            except (ConnectionResetError, OSError):
                self._running = False
                return b""
        return b""

    # ---- stdin (control JSON) ----

    def _stdin_loop(self) -> None:
        """Read newline-delimited JSON control messages from stdin."""
        for line in sys.stdin:
            if not self._running:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            try:
                self.on_control(msg)
            except Exception as e:
                self._emit_status("error", f"control handler: {e}")

    # ---- stdout (results/status JSON) ----

    def _heartbeat_loop(self) -> None:
        while self._running:
            self._emit_json({"type": "heartbeat", "ts": time.time()})
            time.sleep(self._heartbeat_interval)

    def _emit_json(self, msg: dict) -> None:
        line = json.dumps(msg) + "\n"
        with self._stdout_lock:
            try:
                sys.stdout.write(line)
                sys.stdout.flush()
            except BrokenPipeError:
                self._running = False

    def emit(self, msg: dict) -> None:
        """Public: emit a JSON result/event message over stdout."""
        self._emit_json(msg)

    def _emit_status(self, status: str, detail: str = "") -> None:
        self._emit_json({"type": "status", "sidecar": self.name, "status": status, "detail": detail})

    def _handle_signal(self, signum: int, frame) -> None:
        self._running = False

    # ---- overridable hooks ----

    @abstractmethod
    def initialize(self) -> None:
        """Load models and prepare for processing."""

    def on_control(self, msg: dict) -> None:
        """Handle a JSON control message from stdin. Override as needed."""

    def main_loop(self) -> None:
        """Default: read PCM from the socket and dispatch to on_pcm.

        Sidecars that don't consume a PCM input stream (e.g. TTS) should
        override this to idle until stopped.
        """
        while self._running:
            data = self.recv_pcm(4096)
            if not data:
                continue
            self.on_pcm(data)

    def on_pcm(self, data: bytes) -> None:
        """Handle a chunk of raw PCM from the socket. Override as needed."""

    def cleanup(self) -> None:
        if self._socket:
            self._socket.close()
