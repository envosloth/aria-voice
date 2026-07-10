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

# Prefer the bundled whisper.cpp libs (set by the packaged app) so STT works on
# a fresh PC; fall back to a local build for development.
LIB_DIR = os.environ.get("ARIA_WHISPER_LIB_DIR") or os.path.expanduser("~/.local/lib")


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
            t0 = time.time()
            text = self._transcribe(pcm) if pcm else ""
            ms = int((time.time() - t0) * 1000)
            audio_ms = int(len(pcm) / 2 / 16000 * 1000) if pcm else 0
            # Measured inference latency (prove the warm/GPU path is fast, and let
            # the perf panel / logs show real numbers instead of guesses).
            self._emit_status("info", f"transcribe {ms}ms for {audio_ms}ms audio ({'vulkan' if self.using_vulkan else 'cpu'})")
            self.emit({"type": "stt_result", "text": text, "transcribe_ms": ms})
        elif mtype == "reset":
            with self._buffer_lock:
                self._audio_buffer.clear()

    def _transcribe(self, pcm_data: bytes) -> str:
        if self._server_proc and self._server_proc.poll() is None:
            try:
                return self._transcribe_server(pcm_data)
            except Exception as e:
                self._emit_status("warning", f"server inference failed ({e}); using CLI fallback")
        return self._transcribe_cli(self._pcm_to_wav(pcm_data))

    # audio_ctx fast path: whisper's encoder always processes a full 30s window
    # (ctx 1500) no matter how short the utterance, so a 2s voice command wastes
    # ~2/3 of the STT time encoding silence. Passing audio_ctx = seconds*50 plus
    # a safety margin cuts warm-server inference ~3x (293ms -> ~95ms for a 2s
    # clip, measured on the RX 9060 XT / Vulkan) with identical transcriptions.
    # Two guards make it safe: (1) the PCM is padded with trailing silence —
    # speech running to the very edge of the reduced window is what triggers
    # whisper's repetition-loop failure mode ("what time is it what time is
    # it…"), and a silence tail reliably prevents it (verified empirically);
    # (2) a generous margin + floor. Set ARIA_STT_AUDIO_CTX=0 to disable.
    _CTX_PAD_MS = 600     # trailing silence appended before transcribing
    _CTX_MARGIN = 128     # ctx headroom beyond the audio's own length
    _CTX_FLOOR = 256      # never request a window smaller than this

    def _transcribe_server(self, pcm_data: bytes) -> str:
        # temperature_inc=0 disables the server's temperature-retry ladder — the
        # same determinism knob as the CLI path's --no-fallback. The retry ladder
        # is what produces looped/phantom phrases on noisy or edge-clipped audio
        # ("what's the weather what's the weather…"); an empty result beats a
        # fake one.
        extra = {"temperature": "0", "temperature_inc": "0", "response_format": "json"}
        if os.environ.get("ARIA_STT_AUDIO_CTX", "").strip().lower() not in ("0", "off"):
            pcm_data = pcm_data + b"\x00" * (16000 * 2 * self._CTX_PAD_MS // 1000)
            secs = len(pcm_data) / 32000.0
            ctx = int(secs * 50) + self._CTX_MARGIN
            if ctx < 1500:  # longer audio keeps whisper's full default window
                extra["audio_ctx"] = str(max(ctx, self._CTX_FLOOR))
        wav_bytes = self._pcm_to_wav(pcm_data)
        boundary = "----ariaSTT" + str(int(time.time() * 1000))
        body = self._multipart(boundary, wav_bytes, extra=extra)
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
            cmd += self._thread_args()
            if self._force_cpu or not self.using_vulkan:
                cmd.append("--no-gpu")
            # Same determinism knob as the server: --no-fallback (disable the
            # temperature-increment retry) and pin temperature to 0 explicitly.
            # Together they kill the "Thanks for watching" hallucination on
            # clipped audio — the high-temp retry path is what produced the
            # phantom phrase in the first place. Empty result beats a fake one.
            cmd += ["--temperature", "0.0", "--no-fallback"]
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
        # Bound CPU thread use to the host-adaptive budget the supervisor computed
        # (ARIA_STT_THREADS, derived from the machine's cores + the GPU/CPU cap),
        # so a transcription can't saturate every core and starve the UI/audio.
        cmd += self._thread_args()
        # Honor a forced-CPU preference (Settings -> STT backend). Without this
        # the server always tries the GPU; --no-gpu gives a deterministic CPU
        # path (the spec's required CPU fallback, and a guard against fighting a
        # flaky Vulkan driver).
        self._force_cpu = os.environ.get("ARIA_STT_BACKEND", "").lower() == "cpu"
        if self._force_cpu:
            cmd.append("--no-gpu")
        # Accuracy / determinism knob that doesn't cost latency: --no-fallback
        # tells the server NOT to retry with increasing temperature when greedy
        # decoding produces low-confidence output. The retry path is the source
        # of the "Thanks for watching" hallucinations on clipped audio (the
        # model picks a high-temperature guess when its first attempt scores
        # below the entropy threshold). Disabling it pins the server to greedy
        # decoding; if the first pass doesn't transcribe, you get an empty
        # result, which is preferable to a hallucinated phrase. The CLI side
        # uses --temperature 0.0 + --no-fallback for the same reason.
        cmd += ["--no-fallback"]
        self._server_proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            env=self._env(), text=True,
        )

        # Read startup log to detect the GPU backend and wait for readiness. The
        # "using Vulkan backend" line is printed during model load, BEFORE the HTTP
        # "listening" line — but the two can interleave/buffer such that we'd break
        # on "listening" first and miss it (the old bug that reported backend=cpu
        # while the server was really on the GPU). So we keep reading briefly past
        # readiness, and the drain thread below keeps detecting too.
        deadline = time.time() + 30
        ready = False
        ready_grace = None
        while time.time() < deadline:
            if self._server_proc.poll() is not None:
                self._emit_status("warning", "whisper-server exited during startup; will use CLI fallback")
                self._server_proc = None
                return
            line = self._server_proc.stdout.readline()
            if line:
                if self._detect_gpu_line(line):
                    break  # GPU confirmed + (by ordering) load is essentially done
                low = line.lower()
                if "listening" in low or "http server" in low or "server is listening" in low:
                    ready = True
                    ready_grace = time.time() + 0.4  # keep reading a touch for the GPU line
            if not ready and self._port_open(self._server_port):
                ready = True
                ready_grace = time.time() + 0.4
            if ready and (self.using_vulkan or (ready_grace and time.time() >= ready_grace)):
                break
            time.sleep(0.02)

        # Drain server stdout in the background so it doesn't block — and keep
        # detecting the GPU backend in case the line arrives after startup.
        threading.Thread(target=self._drain_server_log, daemon=True).start()

    def _detect_gpu_line(self, line: str) -> bool:
        """Set using_vulkan when a server log line confirms the GPU backend.

        whisper-server enumerates the Vulkan device even under --no-gpu, so we only
        trust the definitive "using Vulkan ... backend" / GPU-init lines, and never
        when the user forced CPU. Returns True the first time it confirms."""
        if self._force_cpu or self.using_vulkan:
            return False
        low = line.lower()
        if ("using vulkan" in low or "init_gpu" in low or "vulkan0 backend" in low
                or "ggml_vulkan: 0" in low):
            self.using_vulkan = True
            self._emit_status("info", "STT backend: Vulkan GPU")
            return True
        return False

    def _drain_server_log(self) -> None:
        proc = self._server_proc
        if not proc or not proc.stdout:
            return
        for line in proc.stdout:
            if not self._running:
                break
            self._detect_gpu_line(line)

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
        # Point the dynamic loader at the bundled whisper libs. The variable and
        # separator differ per OS: LD_LIBRARY_PATH (Linux, ":"), DYLD_LIBRARY_PATH
        # (macOS, ":"), and PATH (Windows, ";"; DLLs load from PATH + the exe dir).
        if sys.platform == "win32":
            env["PATH"] = LIB_DIR + os.pathsep + env.get("PATH", "")
        elif sys.platform == "darwin":
            env["DYLD_LIBRARY_PATH"] = LIB_DIR + os.pathsep + env.get("DYLD_LIBRARY_PATH", "")
        else:
            env["LD_LIBRARY_PATH"] = LIB_DIR + os.pathsep + env.get("LD_LIBRARY_PATH", "")
        return env

    @staticmethod
    def _thread_args() -> list:
        """whisper -t N from the supervisor's host-adaptive budget.

        ARIA_STT_THREADS is set by the Electron main process from the detected
        core count and the GPU/CPU usage cap (see src/main/hardware.ts). Absent or
        invalid -> no -t flag (whisper picks its own default).
        """
        raw = os.environ.get("ARIA_STT_THREADS", "").strip()
        try:
            n = int(raw)
        except (TypeError, ValueError):
            return []
        return ["-t", str(n)] if n >= 1 else []

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
        # whisper.cpp binaries carry the platform exe suffix (.exe on Windows).
        exe = name + (".exe" if sys.platform == "win32" else "")
        bundled = os.environ.get("ARIA_WHISPER_BIN_DIR", "")
        candidates = [
            os.environ.get(f"{name.upper().replace('-', '_')}_BIN", ""),
            os.path.join(bundled, exe) if bundled else "",   # packaged app: bundled whisper
            os.path.expanduser(f"~/.local/bin/{exe}"),
            f"/usr/local/bin/{exe}",                          # harmless no-op on Windows
        ]
        for c in candidates:
            if c and os.path.isfile(c):
                return c
        return shutil.which(exe) or shutil.which(name) or ""

    def _find_model(self) -> str:
        model_name = os.environ.get("ARIA_STT_MODEL", "base.en")
        model_file = f"ggml-{model_name}.bin"
        # ARIA_MODELS_DIR is the authoritative location the main process downloads
        # to (set per-OS via os.homedir()); the rest are dev/legacy fallbacks.
        models_dir = os.environ.get("ARIA_MODELS_DIR", "")
        search_paths = [
            os.path.join(models_dir, model_file) if models_dir else "",
            os.path.join(os.path.dirname(__file__), "..", "..", "models", model_file),
            os.path.expanduser(f"~/.local/share/aria/models/{model_file}"),
            os.path.expanduser(f"~/.cache/whisper/{model_file}"),
        ]
        for p in search_paths:
            if p and os.path.isfile(p):
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
