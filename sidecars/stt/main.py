#!/usr/bin/env python3
"""STT sidecar: whisper.cpp with Vulkan backend for GPU-accelerated speech-to-text.

Runs whisper-server (built with -DGGML_VULKAN=1) as a persistent subprocess so
the model stays loaded — warm inference is ~4x faster than cold whisper-cli
(which reloads the model every call). Raw 16kHz mono PCM streams in over the UDS
socket and accumulates; a stdin control {"type":"transcribe"} POSTs the buffered
audio to the server's /inference endpoint and emits {"type":"stt_result",...}.

Falls back to per-call whisper-cli if whisper-server can't be started.
Stdlib-only (urllib) so it freezes into a small PyInstaller bundle.
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shared"))
from base_sidecar import BaseSidecar

LIB_DIR = os.path.expanduser("~/.local/lib")


class SttSidecar(BaseSidecar):
    def __init__(self):
        super().__init__("stt")
        self.model_path: str = ""
        self.using_vulkan = False
        self._force_cpu = os.environ.get("ARIA_STT_BACKEND", "").lower() == "cpu"
        self._audio_buffer = bytearray()
        self._buffer_lock = threading.Lock()
        self._server_proc: subprocess.Popen | None = None
        self._server_port = 0
        self._cli_bin = ""  # fallback

    def initialize(self) -> None:
        self.model_path = self._find_model()
        server_bin = self._find_binary("whisper-server")

        if server_bin:
            self._start_server(server_bin)

        if not self._server_proc:
            # Fallback path: per-call whisper-cli
            self._cli_bin = self._find_binary("whisper-cli") or ""
            if not self._cli_bin:
                raise FileNotFoundError("Neither whisper-server nor whisper-cli found. Build whisper.cpp.")

        backend = "vulkan" if self.using_vulkan else "cpu"
        mode = "server(warm)" if self._server_proc else "cli(cold)"
        self._emit_status("initialized", f"backend={backend} mode={mode} model={os.path.basename(self.model_path)}")

    # ---- audio handling ----

    def on_pcm(self, data: bytes) -> None:
        with self._buffer_lock:
            self._audio_buffer.extend(data)

    def on_control(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "transcribe":
            with self._buffer_lock:
                pcm = bytes(self._audio_buffer)
                self._audio_buffer.clear()
            text = self._transcribe(pcm) if pcm else ""
            self.emit({"type": "stt_result", "text": text})
        elif mtype == "reset":
            with self._buffer_lock:
                self._audio_buffer.clear()

    def _transcribe(self, pcm_data: bytes) -> str:
        wav_bytes = self._pcm_to_wav(pcm_data)
        if self._server_proc and self._server_proc.poll() is None:
            try:
                return self._transcribe_server(wav_bytes)
            except Exception as e:
                self._emit_status("warning", f"server inference failed ({e}); using CLI fallback")
        return self._transcribe_cli(wav_bytes)

    def _transcribe_server(self, wav_bytes: bytes) -> str:
        boundary = "----ariaSTT" + str(int(time.time() * 1000))
        body = self._multipart(boundary, wav_bytes, extra={"temperature": "0", "response_format": "json"})
        req = urllib.request.Request(
            f"http://127.0.0.1:{self._server_port}/inference",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")
        try:
            return json.loads(raw).get("text", "").strip()
        except json.JSONDecodeError:
            return raw.strip()

    def _transcribe_cli(self, wav_bytes: bytes) -> str:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
            tmp.write(wav_bytes)
        try:
            cmd = [self._cli_bin, "-m", self.model_path, "-f", tmp_path, "--no-timestamps", "-l", "en"]
            if self._force_cpu or not self.using_vulkan:
                cmd.append("--no-gpu")
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=self._env())
            return result.stdout.strip()
        finally:
            os.unlink(tmp_path)

    # ---- whisper-server lifecycle ----

    def _start_server(self, server_bin: str) -> None:
        self._server_port = self._free_port()
        cmd = [
            server_bin, "-m", self.model_path,
            "--host", "127.0.0.1", "--port", str(self._server_port),
            "-l", "en", "--no-timestamps",
        ]
        # Honor a forced-CPU preference (Settings -> STT backend). Without this
        # the server always tries the GPU; --no-gpu gives a deterministic CPU
        # path (the spec's required CPU fallback, and a guard against fighting a
        # flaky Vulkan driver).
        self._force_cpu = os.environ.get("ARIA_STT_BACKEND", "").lower() == "cpu"
        if self._force_cpu:
            cmd.append("--no-gpu")
        self._server_proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            env=self._env(), text=True,
        )

        # Read startup log to detect Vulkan and wait for readiness
        deadline = time.time() + 30
        while time.time() < deadline:
            if self._server_proc.poll() is not None:
                self._emit_status("warning", "whisper-server exited during startup; will use CLI fallback")
                self._server_proc = None
                return
            line = self._server_proc.stdout.readline()
            if line:
                low = line.lower()
                # whisper-server enumerates the Vulkan device even under --no-gpu,
                # so only treat Vulkan as in-use when GPU wasn't forced off.
                if not self._force_cpu and ("vulkan" in low or "ggml_vulkan" in low):
                    self.using_vulkan = True
                if "listening" in low or "http server" in low or "server is listening" in low:
                    break
            if self._port_open(self._server_port):
                break
            time.sleep(0.05)

        # Drain server stdout in the background so it doesn't block
        threading.Thread(target=self._drain_server_log, daemon=True).start()

    def _drain_server_log(self) -> None:
        proc = self._server_proc
        if not proc or not proc.stdout:
            return
        for _ in proc.stdout:
            if not self._running:
                break

    # ---- helpers ----

    def _pcm_to_wav(self, pcm_data: bytes) -> bytes:
        import io
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(pcm_data)
        return buf.getvalue()

    @staticmethod
    def _multipart(boundary: str, wav_bytes: bytes, extra: dict) -> bytes:
        parts = []
        for key, val in extra.items():
            parts.append(f"--{boundary}\r\n".encode())
            parts.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
            parts.append(f"{val}\r\n".encode())
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(b'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n')
        parts.append(b"Content-Type: audio/wav\r\n\r\n")
        parts.append(wav_bytes)
        parts.append(b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        return b"".join(parts)

    def _env(self) -> dict:
        env = os.environ.copy()
        env["LD_LIBRARY_PATH"] = LIB_DIR + ":" + env.get("LD_LIBRARY_PATH", "")
        return env

    @staticmethod
    def _free_port() -> int:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        return port

    @staticmethod
    def _port_open(port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                return True
        except OSError:
            return False

    def _find_binary(self, name: str) -> str:
        import shutil
        candidates = [
            os.environ.get(f"{name.upper().replace('-', '_')}_BIN", ""),
            os.path.expanduser(f"~/.local/bin/{name}"),
            f"/usr/local/bin/{name}",
        ]
        for c in candidates:
            if c and os.path.isfile(c):
                return c
        return shutil.which(name) or ""

    def _find_model(self) -> str:
        model_name = os.environ.get("ARIA_STT_MODEL", "small")
        model_file = f"ggml-{model_name}.bin"
        search_paths = [
            os.path.join(os.path.dirname(__file__), "..", "..", "models", model_file),
            os.path.expanduser(f"~/.local/share/aria/models/{model_file}"),
            os.path.expanduser(f"~/.cache/whisper/{model_file}"),
        ]
        for p in search_paths:
            if os.path.isfile(p):
                return p
        raise FileNotFoundError(f"Whisper model '{model_file}' not found. Run the model download script first.")

    def cleanup(self) -> None:
        if self._server_proc:
            try:
                self._server_proc.terminate()
                self._server_proc.wait(timeout=3)
            except Exception:
                try:
                    self._server_proc.kill()
                except OSError:
                    pass
        super().cleanup()


if __name__ == "__main__":
    SttSidecar().run()
