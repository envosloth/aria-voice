"""Real loopback WebSocket acceptance; no provider requests or credentials."""
import base64
import contextlib
import json
import logging
import io
import queue
import struct
import socket
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from websockets.sync.server import serve
from cloud_tts import CloudTts, CloudTtsError, CloudTtsCancelled, DEFAULTS

KEY = "loopback-websocket-key-not-a-secret"
PCM = b"".join(struct.pack("<h", i - 1200) for i in range(2400))


@contextlib.contextmanager
def fixture(messages=None, handshakes=None, process_request=None):
    requests = queue.Queue()
    closed = threading.Event()
    frames = messages if messages is not None else [
        {"audio": base64.b64encode(PCM).decode()}, {"is_final": True}]

    def handler(ws):
        try:
            inputs = [json.loads(ws.recv(timeout=2)) for _ in range(3)]
            requests.put((ws.request, inputs))
            if callable(frames):
                frames(ws)
            else:
                for message in frames:
                    ws.send(message if isinstance(message, (str, bytes)) else json.dumps(message))
            # Client must terminate rather than wait for server EOF.
            try:
                ws.recv(timeout=2)
            except Exception:
                pass
        except Exception:
            # Fixtures deliberately exercise disconnects and aborted handshakes.
            pass
        finally:
            closed.set()

    def observed(connection, request):
        if handshakes is not None:
            handshakes.append(request)
        if process_request is not None:
            return process_request(connection, request)

    silent = logging.Logger("aria-websocket-fixture", level=logging.CRITICAL + 1)
    silent.addHandler(logging.NullHandler())
    with serve(handler, "127.0.0.1", 0, process_request=observed, logger=silent) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = f"http://127.0.0.1:{server.socket.getsockname()[1]}"
        try:
            yield endpoint, requests, closed
        finally:
            server.shutdown()
            thread.join(2)


class WebsocketTests(unittest.TestCase):
    def test_cancel_during_tls_handshake_closes_socket_and_worker(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(2)
        arrived, closed = threading.Event(), threading.Event()
        def stall_tls():
            try:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(2)
                    connection.recv(8192)  # ClientHello, deliberately no TLS reply.
                    arrived.set()
                    try:
                        while connection.recv(8192):
                            pass
                    except OSError:
                        pass
            finally:
                closed.set()
        server_thread = threading.Thread(target=stall_tls)
        server_thread.start()
        cancel = threading.Event()
        errors = []
        def run():
            try:
                list(CloudTts("elevenlabs", KEY).stream("Never upload.", 1, cancel.is_set))
            except Exception as error:
                errors.append(error)
        with patch.dict("cloud_tts.ORIGINS", {"elevenlabs": f"https://127.0.0.1:{listener.getsockname()[1]}"}):
            thread = threading.Thread(target=run)
            thread.start()
            try:
                self.assertTrue(arrived.wait(1))
                cancel.set()
                thread.join(0.8)
                self.assertIsInstance(errors[0], CloudTtsCancelled)
                self.assertTrue(closed.wait(0.8), "TLS handshake socket was not interrupted")
                self.join_network_workers()
            finally:
                cancel.set()
                listener.close()
                server_thread.join(3)
                thread.join(2)

    def test_redirect_and_proxy_cannot_forward_key_or_text(self):
        target_handshakes = []
        with fixture(handshakes=target_handshakes) as (target, _, _):
            for status in (301, 302, 307, 308, 401, 429):
                handshakes = []
                def reject(connection, request):
                    response = connection.respond(status, KEY + " private input")
                    response.headers["Location"] = target.replace("http:", "ws:") + "/stolen"
                    return response
                with self.subTest(status=status), fixture(handshakes=handshakes, process_request=reject) as (endpoint, _, _):
                    env = {"HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1",
                           "ALL_PROXY": "socks5://127.0.0.1:1", "WS_PROXY": "http://127.0.0.1:1", "NO_PROXY": ""}
                    with patch.dict("os.environ", env), self.assertRaises(CloudTtsError) as caught:
                        list(CloudTts("elevenlabs", KEY, endpoint=endpoint).stream("private input", 1, lambda: False))
                    self.assertNotIn(KEY, str(caught.exception))
                    self.assertNotIn("private input", str(caught.exception))
                    self.assertEqual(len(handshakes), 1)
            self.assertEqual(target_handshakes, [])

    def test_cancellation_before_handshake_completion_never_uploads_text(self):
        arrived, release = threading.Event(), threading.Event()
        def stall(connection, request):
            arrived.set()
            release.wait(3)
        with fixture(process_request=stall) as (endpoint, requests, _):
            cancel = threading.Event()
            errors = []
            def run():
                try:
                    list(CloudTts("elevenlabs", KEY, endpoint=endpoint).stream("private input", 1, cancel.is_set))
                except Exception as error:
                    errors.append(error)
            thread = threading.Thread(target=run)
            thread.start()
            try:
                self.assertTrue(arrived.wait(1))
                cancel.set()
                thread.join(0.8)
                self.assertFalse(thread.is_alive())
                self.assertIsInstance(errors[0], CloudTtsCancelled)
                self.join_network_workers()
                self.assertTrue(requests.empty())
            finally:
                release.set()
                thread.join(2)

    def join_network_workers(self):
        for worker in threading.enumerate():
            if worker.name in ("cloud-tts-network", "cloud-tts-ws-watchdog"):
                worker.join(1)
                self.assertFalse(worker.is_alive(), worker.name)

    def test_generator_close_releases_backpressure_and_library_threads(self):
        def flood(ws):
            for _ in range(1000):
                ws.send(json.dumps({"audio": base64.b64encode(PCM).decode()}))
        baseline = set(threading.enumerate())
        with fixture(flood) as (endpoint, _, closed):
            client = CloudTts("elevenlabs", KEY, endpoint=endpoint)
            # Observe a REAL Queue, without replacing its backpressure behavior.
            queues = []
            real_queue = queue.Queue
            def observed_queue(*args, **kwargs):
                result = real_queue(*args, **kwargs)
                queues.append(result)
                return result
            with patch("cloud_tts.queue.Queue", side_effect=observed_queue):
                iterator = client.stream("Hi.", 1, lambda: False)
                next(iterator)
                end = time.monotonic() + 1
                while queues[0].qsize() < 2 and time.monotonic() < end:
                    time.sleep(0.005)
                self.assertEqual((queues[0].maxsize, queues[0].qsize()), (2, 2))
                iterator.close()
                self.join_network_workers()
                self.assertTrue(closed.wait(1))
        end = time.monotonic() + 1
        while set(threading.enumerate()) - baseline and time.monotonic() < end:
            time.sleep(0.01)
        self.assertEqual(set(threading.enumerate()) - baseline, set())

    def test_two_stalled_dns_workers_fail_closed_then_recover(self):
        release = threading.Event()
        arrivals = queue.Queue()
        real_resolver = socket.getaddrinfo
        handshakes = []
        def stalled(*args, **kwargs):
            arrivals.put(True)
            release.wait(3)
            return real_resolver(*args, **kwargs)
        with fixture(handshakes=handshakes) as (endpoint, requests, _):
            with patch("socket.getaddrinfo", side_effect=stalled):
                try:
                    for _ in range(2):
                        with self.assertRaisesRegex(CloudTtsError, "deadline"):
                            list(CloudTts("elevenlabs", KEY, endpoint=endpoint, deadline_s=0.08).stream("Expired.", 1, lambda: False))
                        arrivals.get(timeout=1)
                    with self.assertRaisesRegex(CloudTtsError, "network workers unavailable"):
                        list(CloudTts("elevenlabs", KEY, endpoint=endpoint).stream("Never upload.", 1, lambda: False))
                    self.assertTrue(arrivals.empty())
                finally:
                    release.set()
                    self.join_network_workers()
            self.assertEqual(handshakes, [])
            self.assertTrue(requests.empty())
            self.assertEqual(b"".join(CloudTts("elevenlabs", KEY, endpoint=endpoint).stream("Fresh.", 1, lambda: False)), PCM)

    def test_eof_without_explicit_finality_is_failure(self):
        def eof(ws):
            ws.send(json.dumps({"audio": base64.b64encode(PCM).decode()}))
            ws.close(reason=KEY)
        with fixture(eof) as (endpoint, _, closed):
            with self.assertRaises(CloudTtsError) as caught:
                list(CloudTts("elevenlabs", KEY, endpoint=endpoint).stream("Hi.", 1, lambda: False))
            self.assertNotIn(KEY, str(caught.exception))
            self.assertTrue(closed.wait(1))

    def test_protocol_fragmentation_and_final_audio_are_accepted(self):
        def fragmented(ws):
            value = json.dumps({"audio": base64.b64encode(PCM).decode(), "is_final": True})
            ws.send([value[:3], value[3:47], value[47:]])
        with fixture(fragmented) as (endpoint, _, closed):
            self.assertEqual(b"".join(CloudTts("elevenlabs", KEY, voice="custom-voice", endpoint=endpoint).stream("Hi.", 1, lambda: False)), PCM)
            self.assertTrue(closed.wait(1))

    def test_library_debug_logging_cannot_echo_credentials_or_text(self):
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        root = logging.getLogger()
        old_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            with fixture([{"error": KEY + " private response"}]) as (endpoint, _, closed):
                with self.assertRaises(CloudTtsError):
                    list(CloudTts("elevenlabs", KEY, endpoint=endpoint).stream("private input", 1, lambda: False))
                self.assertTrue(closed.wait(1))
            self.assertNotIn(KEY, output.getvalue())
            self.assertNotIn("private input", output.getvalue())
            self.assertNotIn("private response", output.getvalue())
        finally:
            root.removeHandler(handler)
            root.setLevel(old_level)

    def test_cancel_and_deadline_close_stalled_reads_and_recover_slots(self):
        def stalled(ws):
            ws.send(json.dumps({"audio": base64.b64encode(PCM[:200]).decode()}))
            try:
                ws.recv(timeout=2)
            except Exception:
                pass

        for mode in ("cancel", "deadline", "close"):
            with self.subTest(mode=mode), fixture(stalled) as (endpoint, _, closed):
                cancel = threading.Event()
                client = CloudTts("elevenlabs", KEY, endpoint=endpoint, deadline_s=0.15 if mode == "deadline" else 2)
                iterator = client.stream("Hi.", 1, cancel.is_set)
                try:
                    self.assertEqual(next(iterator), PCM[:200])
                    if mode == "close":
                        iterator.close()
                    else:
                        if mode == "cancel":
                            cancel.set()
                        error = CloudTtsCancelled if mode == "cancel" else CloudTtsError
                        with self.assertRaises(error):
                            next(iterator)
                    self.assertTrue(closed.wait(0.8), "abandoned websocket left its read/socket alive")
                finally:
                    iterator.close()
        with fixture() as (endpoint, _, _):
            self.assertEqual(b"".join(CloudTts("elevenlabs", KEY, endpoint=endpoint).stream("Fresh.", 1, lambda: False)), PCM)

    def test_idle_read_has_its_own_bounded_sanitized_failure(self):
        def stalled(ws):
            try:
                ws.recv(timeout=2)
            except Exception:
                pass
        with fixture(stalled) as (endpoint, _, closed):
            start = time.monotonic()
            with self.assertRaisesRegex(CloudTtsError, "idle"):
                list(CloudTts("elevenlabs", KEY, endpoint=endpoint, idle_timeout_s=0.1, deadline_s=2).stream("Hi.", 1, lambda: False))
            self.assertLess(time.monotonic() - start, 0.8)
            self.assertTrue(closed.wait(1))

    def test_stalled_dns_abandonment_never_sends_late_handshake_or_text(self):
        release, entered = threading.Event(), threading.Event()
        real_resolver = socket.getaddrinfo
        handshakes = []
        def stalled_once(*args, **kwargs):
            if not entered.is_set():
                entered.set()
                release.wait(3)
            return real_resolver(*args, **kwargs)
        with fixture(handshakes=handshakes) as (endpoint, requests, _):
            with patch("socket.getaddrinfo", side_effect=stalled_once):
                try:
                    with self.assertRaisesRegex(CloudTtsError, "deadline"):
                        list(CloudTts("elevenlabs", KEY, endpoint=endpoint, deadline_s=0.1).stream("Expired private text.", 1, lambda: False))
                    self.assertTrue(entered.is_set())
                    self.assertEqual(b"".join(CloudTts("elevenlabs", KEY, endpoint=endpoint).stream("Fresh.", 1, lambda: False)), PCM)
                finally:
                    release.set()
                    for worker in threading.enumerate():
                        if worker.name == "cloud-tts-network":
                            worker.join(2)
            self.assertEqual(len(handshakes), 1)
            self.assertEqual(requests.qsize(), 1)
            self.assertEqual(requests.get_nowait()[1][1]["inputs"][0]["text"], "Fresh.")

    def test_invalid_or_unbounded_audio_is_rejected_without_secret_echo(self):
        cases = [
            ([{"is_final": True}], {}, "empty"),
            ([{"audio": "eA==", "is_final": True}], {}, "unaligned"),
            ([{"audio": base64.b64encode(PCM).decode(), "is_final": True}], {"max_bytes": 100}, "byte limit"),
            ([{"audio": base64.b64encode(PCM[:4]).decode()}, {"audio": base64.b64encode(PCM[:4]).decode(), "is_final": True}], {"max_bytes": 6}, "byte limit"),
            ([{"audio": "A" * 90000}], {}, "chunk limit"),
            (["x" * (128 * 1024 + 1)], {}, "interrupted"),
            ([{"audio": "@@" + KEY}], {}, "malformed"),
            ([{"audio": [KEY]}], {}, "malformed"),
            ([{"audio": base64.b64encode(b"RIFF" + PCM).decode()}], {}, "container"),
            (["{" + KEY], {}, "malformed"),
            ([[KEY]], {}, "malformed"),
            ([{"is_final": "true"}], {}, "malformed"),
            ([b"binary" + KEY.encode()], {}, "malformed"),
            ([{"error": KEY + " private text"}], {}, "provider rejected"),
        ]
        for frames, limits, reason in cases:
            with self.subTest(reason=reason), fixture(frames) as (endpoint, _, closed):
                with self.assertRaisesRegex(CloudTtsError, reason) as caught:
                    list(CloudTts("elevenlabs", KEY, endpoint=endpoint, **limits).stream("Hi.", 1, lambda: False))
                self.assertNotIn(KEY, str(caught.exception))
                self.assertNotIn("private text", str(caught.exception))
                self.assertTrue(closed.wait(1))

    def test_odd_websocket_chunks_are_carried_into_aligned_pcm(self):
        frames: list = [{"audio": base64.b64encode(piece).decode()} for piece in
                  (PCM[:1], PCM[1:7], PCM[7:])]
        frames.append({"is_final": True})
        with fixture(frames) as (endpoint, _, closed):
            packets = list(CloudTts("elevenlabs", KEY, endpoint=endpoint).stream("Hi.", 1, lambda: False))
            self.assertTrue(all(len(packet) % 2 == 0 for packet in packets))
            self.assertEqual(b"".join(packets), PCM)
            self.assertTrue(closed.wait(1))

    def test_v4_default_uses_dialogue_websocket_and_flushes_short_text(self):
        self.assertEqual(DEFAULTS["elevenlabs"][0], "eleven_v4_turbo")
        with fixture() as (endpoint, requests, closed):
            client = CloudTts("elevenlabs", KEY, endpoint=endpoint)
            packets = list(client.stream("Hi.", 1.2, lambda: False))
            self.assertEqual(b"".join(packets), PCM)
            self.assertTrue(all(len(packet) % 2 == 0 for packet in packets))
            request, inputs = requests.get(timeout=1)
            path = urlsplit(request.path)
            self.assertEqual(path.path, "/v1/text-to-dialogue/stream-input")
            self.assertEqual(parse_qs(path.query), {
                "model_id": ["eleven_v4_turbo"], "output_format": ["pcm_24000"]})
            self.assertEqual(request.headers["xi-api-key"], KEY)
            self.assertEqual(inputs, [
                {"voices": ["JBFqnCBsd6RMkjVDRZzb"]},
                {"inputs": [{"text": "Hi.", "voice_id": "JBFqnCBsd6RMkjVDRZzb", "new_turn": False}]},
                {"close_socket": True}])
            self.assertTrue(closed.wait(1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
