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
        parser.add_argument("--socket", required=True, help="PCM data channel: a UDS path (POSIX) or tcp://host:port (Windows)")
        args = parser.parse_args()

        # SIGTERM/SIGINT exist everywhere; SIGBREAK is Windows-only (Ctrl-Break).
        # On Windows SIGTERM isn't delivered cross-process (the supervisor force-
        # terminates via taskkill), but registering is harmless. Guard defensively
        # so a platform/thread quirk can't crash startup.
        for _signame in ("SIGTERM", "SIGINT", "SIGBREAK"):
            _sig = getattr(signal, _signame, None)
            if _sig is not None:
                try:
                    signal.signal(_sig, self._handle_signal)
                except (ValueError, OSError):
                    pass  # not registerable on this platform/thread
        self._running = True
        # The non-Linux parent watcher loops on `_running`; set it before the
        # watcher starts or its daemon exits immediately during process startup.
        self._set_parent_death_signal()
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
        """Backstop so a sidecar doesn't orphan if the supervisor is hard-killed
        (SIGKILL / TerminateProcess) and can't run its normal tree-kill cleanup —
        without this the sidecar (and its grandchildren) would linger. Complements,
        not replaces, the supervisor's tree-kill on graceful quit.

        Linux uses the kernel's PR_SET_PDEATHSIG (immediate). macOS/Windows have no
        equivalent, so a daemon thread polls the parent and self-exits when it
        disappears."""
        if sys.platform == "linux":
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
            return

        # Non-Linux backstop: watch the parent on a daemon thread.
        initial_ppid = os.getppid()
        watcher = self._watch_parent_windows if sys.platform == "win32" else self._watch_parent_posix
        threading.Thread(target=watcher, args=(initial_ppid,), daemon=True).start()

    def _watch_parent_posix(self, initial_ppid: int) -> None:
        """macOS/BSD: an orphaned child is reparented (to launchd/init), so a
        changed parent PID means the supervisor died — exit to avoid orphaning."""
        while self._running:
            if os.getppid() != initial_ppid:
                os._exit(0)
            time.sleep(2.0)

    def _watch_parent_windows(self, initial_ppid: int) -> None:
        """Windows doesn't reparent, so poll whether the parent PID is still
        alive via the Win32 API and exit once it isn't."""
        try:
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, initial_ppid)
            if not handle:
                return  # can't observe the parent; rely on supervisor taskkill /T
            while self._running:
                code = ctypes.c_ulong()
                ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
                if not ok or code.value != STILL_ACTIVE:
                    os._exit(0)  # parent gone -> don't orphan
                time.sleep(2.0)
        except Exception:
            pass  # best-effort; tree-kill remains the primary mechanism

    # ---- socket (PCM) ----

    def _connect_socket(self, socket_path: str) -> None:
        # The supervisor encodes the transport in the address string: a
        # "tcp://host:port" URL means a loopback TCP channel (Windows, where
        # Node can't serve a UDS file path); anything else is a filesystem Unix
        # domain socket path (Linux/macOS). AF_UNIX is never referenced on
        # Windows, where some Python builds lack it.
        if socket_path.startswith("tcp://"):
            host, _, port = socket_path[len("tcp://"):].rpartition(":")
            self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._socket.connect((host, int(port)))
        else:
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
                data = self._socket.recv(bufsize)
                if not data:
                    # The socket is blocking, so an empty read is an orderly EOF
                    # (the supervisor closed the connection), not a transient "no
                    # data yet" — recv would keep returning b"" instantly. Stop so
                    # main_loop exits cleanly instead of spinning a core at 100%
                    # CPU; the supervisor restarts the sidecar if it's still wanted.
                    self._running = False
                return data
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
