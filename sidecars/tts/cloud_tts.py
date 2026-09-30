"""Bounded, cancelable HTTP/WebSocket raw-PCM TTS transport.

Production origins are fixed: no environment endpoint overrides, redirects,
proxy inheritance, retries, or cross-provider fallback. The optional endpoint
argument is a loopback-only test seam, never populated by the sidecar.

API contracts verified against:
https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd
https://elevenlabs.io/docs/api-reference/text-to-speech/stream
https://docs.cartesia.ai/api-reference/tts/bytes
https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion
https://platform.openai.com/docs/api-reference/audio/createSpeech
https://platform.openai.com/docs/guides/text-to-speech
https://developers.deepgram.com/reference/text-to-speech-api/speak
https://developers.deepgram.com/docs/tts-media-output-settings
https://developers.deepgram.com/docs/tts-encoding
https://developers.deepgram.com/docs/tts-voice-controls

All requests explicitly select mono signed-16 LE PCM at 24 kHz, without a
container. ElevenLabs' 44.1 kHz PCM requires Pro; we request pcm_24000 instead.
Provider account/model/voice entitlements still apply. Legacy HTTP speed is
clamped to provider ranges; Cartesia PVCs ignore it. v4 Turbo supports neither
speed nor style and ignores the legacy speed parameter without uploading it.
"""
import http.client
import base64
import json
import logging
import math
import queue
import re
import socket
import ssl
import threading
import time
from urllib.parse import quote, urlencode, urlsplit

# One stalled resolver can be abandoned while the next reply proceeds. Two
# unrecoverable resolvers fail closed instead of accumulating daemon threads.
_NETWORK_SLOTS = threading.BoundedSemaphore(2)
# A private, unregistered logger cannot inherit root DEBUG configuration.
# Library frame/handshake debug logs otherwise disclose auth and spoken text.
_WS_LOGGER = logging.Logger("aria-cloud-tts-websocket", level=logging.CRITICAL + 1)
_WS_LOGGER.addHandler(logging.NullHandler())

SAMPLE_RATE = 24000
MAX_TEXT = 5000
DEFAULTS = {
    "elevenlabs": ("eleven_v4_turbo", "JBFqnCBsd6RMkjVDRZzb"),
    "cartesia": ("sonic-3.6", "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"),
    "openai": ("gpt-4o-mini-tts", "onyx"),
    "deepgram": ("aura-2-odysseus-en", "aura-2-odysseus-en"),
}
ORIGINS = {
    "elevenlabs": "https://api.elevenlabs.io",
    "cartesia": "https://api.cartesia.ai",
    "openai": "https://api.openai.com",
    "deepgram": "https://api.deepgram.com",
}
SPEED_BOUNDS = {"elevenlabs": (0.7, 1.2), "cartesia": (0.6, 1.5),
                "openai": (0.25, 4.0), "deepgram": (0.7, 1.5)}


class CloudTtsError(RuntimeError):
    """Only fixed safe messages reach the sidecar's status/log channel."""


class CloudTtsCancelled(CloudTtsError):
    pass


def _option(value, default):
    value = value or default
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", value):
        raise CloudTtsError("Invalid cloud TTS model or voice identifier")
    return value


class CloudTts:
    def __init__(self, engine, key, model="", voice="", *, endpoint=None,
                 max_bytes=8 * 1024 * 1024, deadline_s=45.0, idle_timeout_s=10.0):
        if engine not in DEFAULTS:
            raise CloudTtsError("Unsupported cloud TTS provider")
        if (not isinstance(key, str) or not key or len(key) > 4096
                or any(ord(c) < 33 or ord(c) > 126 for c in key)):
            raise CloudTtsError("Cloud TTS API key missing or invalid")
        self.engine = engine
        self._key = key
        default_model, default_voice = DEFAULTS[engine]
        self.model = _option(model, default_model)
        # Deepgram encodes the voice in its model ID; cloud voice wins if set.
        self.voice = _option(voice, self.model if engine == "deepgram" else default_voice)
        self._origin = ORIGINS[engine]
        if endpoint is not None:
            try:
                parsed = urlsplit(endpoint)
                valid = (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "::1")
                         and parsed.port is not None and not parsed.username and not parsed.password
                         and parsed.path in ("", "/") and not parsed.query and not parsed.fragment)
            except (ValueError, TypeError):
                valid = False
            if not valid:
                raise CloudTtsError("Cloud TTS test endpoint must be literal loopback HTTP")
            self._origin = endpoint.rstrip("/")
        if (not isinstance(max_bytes, int) or max_bytes < 2
                or not math.isfinite(deadline_s) or deadline_s <= 0
                or not math.isfinite(idle_timeout_s) or idle_timeout_s <= 0):
            raise CloudTtsError("Invalid cloud TTS transport limits")
        self._max_bytes = max_bytes
        self._deadline_s = deadline_s
        self._idle_timeout_s = idle_timeout_s

    def _request(self, text, speed):
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise CloudTtsError("Cloud TTS text must contain 1 to 5000 characters")
        if self.engine == "openai" and len(text) > 4096:
            raise CloudTtsError("OpenAI TTS input exceeds 4096 characters")
        if self.engine == "deepgram" and len(text) > 2000:
            raise CloudTtsError("Deepgram TTS input exceeds 2000 characters")
        try:
            speed = float(speed)
        except (ValueError, TypeError):
            speed = 1.0
        if not math.isfinite(speed):
            speed = 1.0
        low, high = SPEED_BOUNDS[self.engine]
        speed = max(low, min(high, speed))
        headers = {"Content-Type": "application/json", "Accept": "application/octet-stream, audio/*",
                   "Accept-Encoding": "identity", "Connection": "close"}
        if self.engine == "elevenlabs":
            path = f"/v1/text-to-speech/{quote(self.voice, safe='')}/stream?output_format=pcm_24000"
            headers["xi-api-key"] = self._key
            body = {"text": text, "model_id": self.model, "voice_settings": {"speed": speed}}
        elif self.engine == "cartesia":
            path = "/tts/bytes"
            # Current 2026-08-14 API accepts API key directly in Authorization.
            headers.update({"Authorization": self._key, "Cartesia-Version": "2026-08-14"})
            body = {"model_id": self.model, "transcript": text, "voice": self.voice,
                    "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": SAMPLE_RATE},
                    "generation_config": {"speed": speed}}
        elif self.engine == "openai":
            path = "/v1/audio/speech"
            headers["Authorization"] = "Bearer " + self._key
            body = {"model": self.model, "input": text, "voice": self.voice,
                    "response_format": "pcm", "stream_format": "audio", "speed": speed}
        else:
            path = "/v1/speak?" + urlencode({"model": self.voice, "encoding": "linear16",
                                            "container": "none", "sample_rate": SAMPLE_RATE, "speed": speed})
            headers["Authorization"] = "Token " + self._key
            body = {"text": text}
        return path, headers, json.dumps(body, allow_nan=False).encode("utf-8")

    def stream(self, text, speed, cancelled):
        """Bound synthesis independently of uninterruptible OS DNS resolution.

        Only this consumer yields PCM. Abandonment permanently cancels the
        network worker, so a late connect cannot upload text or emit old audio.
        The two-packet queue preserves streaming with bounded backpressure.
        """
        if cancelled():
            raise CloudTtsCancelled("Cloud TTS canceled")
        if not _NETWORK_SLOTS.acquire(blocking=False):
            raise CloudTtsError("Cloud TTS network workers unavailable; retry after network recovery or restart speech")
        abandoned = threading.Event()
        packets = queue.Queue(maxsize=2)
        deadline = time.monotonic() + self._deadline_s

        def deliver(kind, value=None):
            while not abandoned.is_set():
                try:
                    packets.put((kind, value), timeout=0.025)
                    return True
                except queue.Full:
                    pass
            return False

        def network():
            source = self._stream_network(text, speed, lambda: abandoned.is_set() or cancelled())
            try:
                for data in source:
                    if not deliver("pcm", data):
                        return
                deliver("done")
            except CloudTtsError as error:
                deliver("error", error)
            except Exception:
                deliver("error", CloudTtsError("Cloud TTS network worker failed"))
            finally:
                source.close()
                _NETWORK_SLOTS.release()

        worker = threading.Thread(target=network, name="cloud-tts-network", daemon=True)
        try:
            worker.start()
        except Exception:
            _NETWORK_SLOTS.release()
            raise CloudTtsError("Cloud TTS network worker unavailable") from None
        try:
            while True:
                if cancelled():
                    raise CloudTtsCancelled("Cloud TTS canceled")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CloudTtsError("Cloud TTS request deadline exceeded")
                try:
                    kind, value = packets.get(timeout=min(0.025, remaining))
                except queue.Empty:
                    continue
                if cancelled():
                    raise CloudTtsCancelled("Cloud TTS canceled")
                if time.monotonic() >= deadline:
                    raise CloudTtsError("Cloud TTS request deadline exceeded")
                if kind == "error":
                    raise value
                if kind == "done":
                    return
                yield value
        finally:
            abandoned.set()
            # Never wait for a resolver here: the synthesis queue must progress.

    def _stream_network(self, text, speed, cancelled):
        """Yield aligned PCM; watchdog interrupts active sockets, not DNS.

        The outer bounded worker consumer enforces timeout/cancel during DNS;
        check() after connect prevents abandoned work from uploading text.
        """
        if self.engine == "elevenlabs" and self.model == "eleven_v4_turbo":
            yield from self._stream_websocket(text, cancelled)
            return
        path, headers, body = self._request(text, speed)
        origin = urlsplit(self._origin)
        timeout = min(self._idle_timeout_s, self._deadline_s)
        connection_cls = http.client.HTTPSConnection if origin.scheme == "https" else http.client.HTTPConnection
        assert origin.hostname is not None  # fixed origin or validated loopback
        connection = connection_cls(origin.hostname, origin.port, timeout=timeout)
        deadline = time.monotonic() + self._deadline_s
        finished = threading.Event()
        expired = threading.Event()
        interrupted = threading.Event()
        active_socket: list[socket.socket | None] = [None]

        def check():
            if cancelled() or interrupted.is_set():
                raise CloudTtsCancelled("Cloud TTS canceled")
            if expired.is_set() or time.monotonic() >= deadline:
                raise CloudTtsError("Cloud TTS request deadline exceeded")

        def watchdog():
            while not finished.wait(0.025):
                if cancelled():
                    interrupted.set()
                elif time.monotonic() >= deadline:
                    expired.set()
                else:
                    continue
                sock = active_socket[0] or connection.sock
                if sock:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                # Keep watching until finally, so a connect completing after
                # cancellation/deadline cannot escape the socket shutdown.

        watcher = threading.Thread(target=watchdog, daemon=True)
        response = None
        watcher.start()
        try:
            check()
            connection.connect()
            active_socket[0] = connection.sock
            check()
            connection.request("POST", path, body=body, headers=headers)
            response = connection.getresponse()
            check()
            if 300 <= response.status < 400:
                raise CloudTtsError("Cloud TTS redirect rejected")
            if response.status != 200:
                # Never read/print error bodies, reason phrases, request IDs,
                # URLs, or transport exception strings: any can echo secrets.
                raise CloudTtsError(f"Cloud TTS HTTP {response.status}; check provider key, quota, model and format access")
            mime = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            allowed = {"application/octet-stream", "audio/octet-stream", "audio/pcm", "audio/raw", "audio/linear16"}
            if self.engine == "deepgram":
                allowed.add("audio/l16")  # Deepgram's linear16 is LE, despite this MIME name.
            if mime not in allowed:
                raise CloudTtsError("Cloud TTS response is not raw PCM")
            content_type = response.getheader("Content-Type", "").lower()
            for name, expected in (("rate", SAMPLE_RATE), ("channels", 1)):
                match = re.search(r"(?:^|;)\s*" + name + r"\s*=\s*\"?(\d+)", content_type)
                if match and int(match.group(1)) != expected:
                    raise CloudTtsError("Cloud TTS response PCM format mismatch")
            if response.getheader("Content-Encoding", "identity").lower() not in ("identity", ""):
                raise CloudTtsError("Cloud TTS compressed response rejected")
            expected_size = response.getheader("Content-Length")
            if expected_size is not None:
                if not expected_size.isdigit():
                    raise CloudTtsError("Cloud TTS invalid response length")
                expected_size = int(expected_size)
                if expected_size > self._max_bytes:
                    raise CloudTtsError("Cloud TTS response exceeds audio byte limit")
            received = 0
            carry = b""
            first = True
            while True:
                check()
                # read1, unlike read(N), returns currently available data rather
                # than waiting for a full block (critical for first-audio time).
                data = response.read1(4096)
                check()
                if not data:
                    break
                received += len(data)
                if received > self._max_bytes:
                    raise CloudTtsError("Cloud TTS response exceeds audio byte limit")
                data = carry + data
                carry = b""
                if first:
                    # Sniff a small prefix, even if HTTP fragments split it.
                    if len(data) < 4:
                        carry = data
                        continue
                    if data[:4] in (b"RIFF", b"OggS", b"fLaC") or data[:3] == b"ID3":
                        raise CloudTtsError("Cloud TTS container received instead of raw PCM")
                    first = False
                aligned = len(data) & ~1
                carry = data[aligned:]
                if aligned:
                    yield data[:aligned]
            check()
            if expected_size is not None and received != expected_size:
                raise CloudTtsError("Cloud TTS truncated audio response")
            if received == 0:
                raise CloudTtsError("Cloud TTS empty audio response")
            if len(carry) % 2:
                raise CloudTtsError("Cloud TTS unaligned audio response")
            # A legitimate sub-4-byte response was retained for prefix sniffing.
            if carry:
                yield carry
        except CloudTtsError:
            raise
        except Exception:
            check()
            raise CloudTtsError("Cloud TTS connection failed or audio response interrupted") from None
        finally:
            finished.set()
            if response is not None:
                response.close()
            connection.close()
            watcher.join(timeout=0.2)

    def _stream_websocket(self, text, cancelled):
        # v4 Turbo is NOT a legacy HTTP text-to-speech model. Register exactly
        # one voice; close_socket flushes even a short sentence. No speed/style.
        from websockets.sync.client import connect

        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise CloudTtsError("Cloud TTS text must contain 1 to 5000 characters")
        uri = self._origin.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
        uri += "/v1/text-to-dialogue/stream-input?" + urlencode({
            "model_id": self.model, "output_format": "pcm_24000"})
        deadline = time.monotonic() + self._deadline_s
        finished = threading.Event()
        active_socket: list[socket.socket | None] = [None]
        raw_socket = None

        def check():
            if cancelled():
                raise CloudTtsCancelled("Cloud TTS canceled")
            if time.monotonic() >= deadline:
                raise CloudTtsError("Cloud TTS request deadline exceeded")

        def watchdog():
            while not finished.wait(0.025):
                if cancelled() or time.monotonic() >= deadline:
                    sock = active_socket[0]
                    if sock is not None:
                        try:
                            sock.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass

        # The sync library owns its receiver thread/socket after TLS. Capture
        # that socket BEFORE the authenticated WebSocket handshake begins.
        from websockets.sync.client import ClientConnection
        class CancelableConnection(ClientConnection):
            def __init__(self, sock, protocol, **kwargs):
                active_socket[0] = sock
                check()
                super().__init__(sock, protocol, **kwargs)

        class CancelableTLSContext(ssl.SSLContext):
            def wrap_socket(self, *args, **kwargs):
                # TLS wrapping detaches the original socket's FD. Publish the
                # SSL socket BEFORE its potentially stalled handshake, otherwise
                # the watchdog can only shutdown the now-detached TCP socket.
                kwargs["do_handshake_on_connect"] = False
                wrapped = super().wrap_socket(*args, **kwargs)
                active_socket[0] = wrapped
                try:
                    check()
                    wrapped.do_handshake()
                    check()
                    return wrapped
                except BaseException:
                    wrapped.close()
                    raise

        watcher = threading.Thread(target=watchdog, name="cloud-tts-ws-watchdog", daemon=True)
        watcher.start()
        try:
            check()
            origin = urlsplit(uri)
            # Resolve/connect ourselves: sync connect() otherwise sends auth
            # immediately after uninterruptible DNS, even for abandoned work.
            raw_socket = socket.create_connection((origin.hostname, origin.port or 443),
                                                  timeout=min(self._idle_timeout_s, self._deadline_s))
            active_socket[0] = raw_socket
            check()
            raw_socket.settimeout(None)
            tls = None
            if origin.scheme == "wss":
                # PROTOCOL_TLS_CLIENT requires certificate + hostname checks;
                # system roots only, never insecure overrides or keylog env.
                tls = CancelableTLSContext(ssl.PROTOCOL_TLS_CLIENT)
                tls.load_default_certs()
            with connect(uri, sock=raw_socket, proxy=None, compression=None,
                         ssl=tls,
                         additional_headers={"xi-api-key": self._key},
                         open_timeout=min(self._idle_timeout_s, deadline - time.monotonic()),
                         create_connection=CancelableConnection, ping_interval=None, logger=_WS_LOGGER,
                         close_timeout=0.1, max_size=128 * 1024, max_queue=2) as ws:
                check()
                ws.send(json.dumps({"voices": [self.voice]}))
                check()
                ws.send(json.dumps({"inputs": [{"text": text, "voice_id": self.voice, "new_turn": False}]}))
                check()
                ws.send(json.dumps({"close_socket": True}))
                carry = b""
                received = 0
                first = True
                idle_deadline = time.monotonic() + self._idle_timeout_s
                while True:
                    check()
                    try:
                        raw = ws.recv(timeout=min(0.025, self._idle_timeout_s))
                    except TimeoutError:
                        check()
                        if time.monotonic() >= idle_deadline:
                            raise CloudTtsError("Cloud TTS WebSocket idle read timed out") from None
                        continue
                    check()
                    idle_deadline = time.monotonic() + self._idle_timeout_s
                    try:
                        if not isinstance(raw, str):
                            raise ValueError()
                        message = json.loads(raw)
                        if not isinstance(message, dict):
                            raise ValueError()
                        if "is_final" in message and not isinstance(message["is_final"], bool):
                            raise ValueError()
                    except (ValueError, TypeError, RecursionError):
                        raise CloudTtsError("Cloud TTS malformed WebSocket response") from None
                    if "error" in message:
                        raise CloudTtsError("Cloud TTS provider rejected synthesis; check key, quota, model and voice access")
                    encoded = message.get("audio")
                    if encoded is not None:
                        if not isinstance(encoded, str):
                            raise CloudTtsError("Cloud TTS malformed WebSocket audio")
                        # Bound BEFORE allocation by base64 decoding as well as
                        # at the library's complete-message/frame-buffer layer.
                        if len(encoded) > ((64 * 1024 + 2) // 3) * 4:
                            raise CloudTtsError("Cloud TTS audio chunk limit exceeded")
                        try:
                            chunk = base64.b64decode(encoded, validate=True)
                        except (ValueError, TypeError):
                            raise CloudTtsError("Cloud TTS malformed WebSocket audio") from None
                        if len(chunk) > 64 * 1024:
                            raise CloudTtsError("Cloud TTS audio chunk limit exceeded")
                        received += len(chunk)
                        if received > self._max_bytes:
                            raise CloudTtsError("Cloud TTS response exceeds audio byte limit")
                        data = carry + chunk
                        carry = b""
                        if first and len(data) < 4:
                            carry = data
                        else:
                            if first:
                                if data[:4] in (b"RIFF", b"OggS", b"fLaC") or data[:3] == b"ID3":
                                    raise CloudTtsError("Cloud TTS container received instead of raw PCM")
                                first = False
                            aligned = len(data) & ~1
                            carry = data[aligned:]
                            for offset in range(0, aligned, 4096):
                                check()
                                yield data[offset:min(offset + 4096, aligned)]
                    if message.get("is_final") is True:
                        if not received:
                            raise CloudTtsError("Cloud TTS empty audio response")
                        if len(carry) % 2:
                            raise CloudTtsError("Cloud TTS unaligned audio response")
                        if carry:
                            yield carry
                        return
        except CloudTtsError:
            raise
        except Exception:
            check()
            raise CloudTtsError("Cloud TTS WebSocket connection failed or audio response interrupted") from None
        finally:
            finished.set()
            if raw_socket is not None:
                raw_socket.close()
            watcher.join(timeout=0.2)
