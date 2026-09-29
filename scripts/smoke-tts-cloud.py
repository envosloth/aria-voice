#!/usr/bin/env python3
"""Behavioral cloud TTS gate: stdlib only, synthetic PCM over loopback HTTP.

No real credentials, provider calls, model downloads, or external uploads. Run:
    python3 scripts/smoke-tts-cloud.py
"""
import contextlib
import io
import json
import math
from pathlib import Path
import queue
import socket
import struct
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecars" / "tts"))
from cloud_tts import CloudTts, CloudTtsError, CloudTtsCancelled, DEFAULTS
from main import TtsSidecar

PCM = b"".join(struct.pack("<h", int(12000 * math.sin(i * 0.11))) for i in range(2400))
KEY = "loopback-test-key-not-a-secret"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.put((self.path, dict(self.headers), body))
        scenario = self.server.scenarios.get(timeout=3)
        scenario.get("arrived", threading.Event()).set()
        if scenario.get("before_headers"):
            scenario["before_headers"].wait(3)
        self.send_response(scenario.get("status", 200))
        self.send_header("Content-Type", scenario.get("mime", "application/octet-stream"))
        if scenario.get("redirect"):
            self.send_header("Location", scenario["redirect"])
        if scenario.get("length") is not None:
            self.send_header("Content-Length", str(scenario["length"]))
        else:
            self.send_header("Transfer-Encoding", "chunked")
        if scenario.get("encoding"):
            self.send_header("Content-Encoding", scenario["encoding"])
        self.end_headers()
        try:
            pieces = scenario.get("pieces", [PCM[:7], PCM[7:99], PCM[99:]])
            for i, piece in enumerate(pieces):
                if scenario.get("length") is None:
                    self.wfile.write(f"{len(piece):X}\r\n".encode() + piece + b"\r\n")
                else:
                    self.wfile.write(piece)
                self.wfile.flush()
                if i == 0:
                    scenario.get("first", threading.Event()).set()
                    if scenario.get("release"):
                        scenario["release"].wait(3)
                if scenario.get("delay"):
                    time.sleep(scenario["delay"])
            if scenario.get("length") is None:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            elif scenario.get("truncate"):
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


class CloudTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.server.scenarios = queue.Queue()
        cls.server.requests = queue.Queue()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(2)

    def client(self, engine="openai", **kwargs):
        return CloudTts(engine, KEY, endpoint=self.endpoint, **kwargs)

    def setUp(self):
        while not self.server.requests.empty():
            self.server.requests.get_nowait()
        self.assertTrue(self.server.scenarios.empty())

    def stream(self, engine="openai", scenario=None, **kwargs):
        self.server.scenarios.put(scenario or {})
        client = self.client(engine, **kwargs)
        return list(client.stream("Hello loopback.", 1.0, lambda: False))

    def test_each_provider_delivers_exact_aligned_pcm_and_auth_contract(self):
        for engine in DEFAULTS:
            with self.subTest(engine=engine):
                mime = "audio/l16;rate=24000" if engine == "deepgram" else "application/octet-stream"
                packets = self.stream(engine, {"mime": mime})
                self.assertEqual(b"".join(packets), PCM)
                self.assertTrue(all(len(p) % 2 == 0 for p in packets))
                path, headers, body = self.server.requests.get(timeout=2)
                query = parse_qs(urlsplit(path).query)
                self.assertEqual(headers["Content-Type"], "application/json")
                self.assertEqual(headers["Accept-Encoding"], "identity")
                if engine == "elevenlabs":
                    self.assertEqual(headers["xi-api-key"], KEY)
                    self.assertIn("/stream", path)
                    self.assertEqual(query["output_format"], ["pcm_24000"])
                    self.assertEqual(body["model_id"], "eleven_flash_v2_5")
                    self.assertEqual(body["voice_settings"]["speed"], 1)
                elif engine == "cartesia":
                    self.assertEqual(headers["Authorization"], KEY)
                    self.assertEqual(headers["Cartesia-Version"], "2026-08-14")
                    self.assertEqual(body["model_id"], "sonic-3.6")
                    self.assertEqual(body["voice"], "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")
                    self.assertEqual(body["output_format"], {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000})
                elif engine == "openai":
                    self.assertEqual(headers["Authorization"], "Bearer " + KEY)
                    self.assertEqual(body["response_format"], "pcm")
                    self.assertEqual(body["stream_format"], "audio")
                    self.assertEqual(body["voice"], "onyx")
                else:
                    self.assertEqual(headers["Authorization"], "Token " + KEY)
                    self.assertEqual(query["encoding"], ["linear16"])
                    self.assertEqual(query["container"], ["none"])
                    self.assertEqual(query["sample_rate"], ["24000"])
                    self.assertEqual(query["model"], ["aura-2-odysseus-en"])

    def test_audio_arrives_before_response_finishes(self):
        release = threading.Event()
        self.server.scenarios.put({"release": release, "pieces": [PCM[:200], PCM[200:]]})
        iterator = self.client().stream("Hi.", 1, lambda: False)
        try:
            self.assertEqual(next(iterator), PCM[:200])
            self.assertFalse(release.is_set())
            release.set()
            self.assertEqual(b"".join(iterator), PCM[200:])
        finally:
            release.set()
            iterator.close()

    def test_provider_specific_speed_bounds_and_custom_options(self):
        bounds = {"elevenlabs": (0.7, 1.2), "cartesia": (0.6, 1.5), "openai": (0.25, 4), "deepgram": (0.7, 1.5)}
        for engine, (low, high) in bounds.items():
            for value, expected in [(-3, low), (9, high), (float("nan"), 1), (float("inf"), 1)]:
                self.server.scenarios.put({})
                list(self.client(engine, model="custom-model", voice="custom-voice").stream("Hi.", value, lambda: False))
                path, _, body = self.server.requests.get(timeout=2)
                if engine == "elevenlabs":
                    speed = body["voice_settings"]["speed"]
                    self.assertIn("custom-voice", path)
                elif engine == "cartesia":
                    speed = body["generation_config"]["speed"]
                    self.assertEqual(body["voice"], "custom-voice")
                elif engine == "openai":
                    speed = body["speed"]
                else:
                    query = parse_qs(urlsplit(path).query)
                    speed = float(query["speed"][0])
                    self.assertEqual(query["model"], ["custom-voice"])
                self.assertEqual(speed, expected)

    def test_http_failures_are_sanitized_and_not_retried(self):
        for status in (401, 403, 429, 500):
            with self.subTest(status=status):
                with self.assertRaises(CloudTtsError) as caught:
                    self.stream(scenario={"status": status, "pieces": [(KEY + " private text").encode()]})
                self.assertIn(str(status), str(caught.exception))
                self.assertNotIn(KEY, str(caught.exception))
                self.assertNotIn("private text", str(caught.exception))

    def test_redirect_rejected_without_following_or_forwarding_key(self):
        target = self.endpoint + "/stolen"
        with self.assertRaisesRegex(CloudTtsError, "redirect"):
            self.stream(scenario={"status": 307, "redirect": target})
        # Drain prior requests then prove no new redirect request occurs.
        while not self.server.requests.empty():
            path, _, _ = self.server.requests.get_nowait()
            self.assertNotEqual(path, "/stolen")
        time.sleep(0.08)
        self.assertTrue(self.server.requests.empty())

    def test_wrong_response_types_encodings_and_headers_fail_before_audio(self):
        for scenario in [
            {"mime": "application/json"}, {"mime": "text/event-stream"},
            {"mime": "audio/mpeg"}, {"mime": "audio/wav"},
            {"encoding": "gzip"}, {"mime": "audio/pcm;rate=48000"},
            {"mime": "audio/pcm;channels=2"},
            {"pieces": [b"RIFF" + PCM]}, {"pieces": [b"ID3" + PCM]},
        ]:
            with self.subTest(scenario=scenario):
                packets = []
                self.server.scenarios.put(scenario)
                with self.assertRaises(CloudTtsError):
                    for packet in self.client().stream("Hi.", 1, lambda: False):
                        packets.append(packet)
                self.assertEqual(packets, [])

    def test_empty_odd_truncated_and_oversize_responses_fail(self):
        for scenario, kwargs in [
            ({"pieces": []}, {}), ({"pieces": [PCM + b"x"]}, {}),
            ({"pieces": [PCM], "length": len(PCM) + 2, "truncate": True}, {}),
            ({"length": len(PCM)}, {"max_bytes": 100}),
            ({}, {"max_bytes": 100}),
        ]:
            with self.subTest(scenario=scenario):
                with self.assertRaises(CloudTtsError):
                    self.stream(scenario=scenario, **kwargs)

    def test_deadline_interrupts_a_stalled_stream(self):
        release = threading.Event()
        self.server.scenarios.put({"release": release, "pieces": [PCM[:200], PCM[200:]]})
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(CloudTtsError, "deadline"):
                list(self.client(deadline_s=0.15).stream("Hi.", 1, lambda: False))
            self.assertLess(time.monotonic() - started, 1)
        finally:
            release.set()

    def test_cancel_before_headers_and_mid_stream_releases_connection(self):
        for before in (True, False):
            arrived, release, cancel = threading.Event(), threading.Event(), threading.Event()
            self.server.scenarios.put({"arrived": arrived, "before_headers": release} if before else {"arrived": arrived, "release": release})
            errors = []
            def run():
                try:
                    list(self.client().stream("Hi.", 1, cancel.is_set))
                except Exception as exc:
                    errors.append(exc)
            thread = threading.Thread(target=run)
            thread.start()
            self.assertTrue(arrived.wait(2))
            cancel.set()
            thread.join(1)
            release.set()
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], CloudTtsCancelled)
        self.assertEqual(b"".join(self.stream()), PCM)

    def test_invalid_inputs_never_send_any_request(self):
        for kwargs in ({"key": ""}, {"key": "x\r\nInjected: yes"}, {"engine": "other"}, {"endpoint": "http://example.com"}, {"endpoint": "https://example.com"}):
            args = {"engine": "openai", "key": KEY, "endpoint": self.endpoint}
            args.update(kwargs)
            with self.assertRaises(CloudTtsError):
                CloudTts(**args)
        client = self.client()
        for text in (None, {}, "x" * 5001):
            with self.assertRaises(CloudTtsError):
                list(client.stream(text, 1, lambda: False))
        for engine, limit in (("openai", 4096), ("deepgram", 2000)):
            with self.assertRaisesRegex(CloudTtsError, str(limit)):
                list(self.client(engine).stream("x" * (limit + 1), 1, lambda: False))
        self.assertTrue(self.server.requests.empty())

    @contextlib.contextmanager
    def sidecar(self, engine="openai"):
        # Real BaseSidecar stdout framing and raw socket writes (no send_pcm mock).
        output = io.StringIO()
        writer, reader = socket.socketpair()
        audio = bytearray()
        def receive():
            while True:
                data = reader.recv(8192)
                if not data:
                    break
                audio.extend(data)
        receiver = threading.Thread(target=receive)
        receiver.start()
        env = {"ARIA_TTS_ENGINE": engine, "ARIA_TTS_VOICE": "LOCAL-VOICE", "ARIA_TTS_CLOUD_KEY": KEY}
        with patch.dict("os.environ", env, clear=True), contextlib.redirect_stdout(output):
            sidecar = TtsSidecar()
            sidecar._cloud = self.client(engine)
            sidecar._socket = writer
            sidecar._running = True
            with patch.object(sidecar, "_load_piper", side_effect=AssertionError("local load")), patch.object(sidecar, "_load_kokoro", side_effect=AssertionError("local load")):
                sidecar.initialize()
                try:
                    yield sidecar, output, audio
                finally:
                    sidecar._running = False
                    sidecar.cleanup()
        receiver.join(2)
        reader.close()
        self.assertFalse(receiver.is_alive())

    def test_sidecar_preserves_packet_metadata_pcm_and_reply_finality(self):
        for engine in DEFAULTS:
            with self.subTest(engine=engine):
                self.server.scenarios.put({})
                with self.sidecar(engine) as (sidecar, output, audio):
                    self.assertEqual(sidecar.voice_name, "LOCAL-VOICE")
                    sidecar.on_control({"type": "synthesize", "text": "Hello.", "reply_id": "reply-1", "request_id": "request-1", "epoch": 71})
                    sidecar.on_control({"type": "reply_done", "reply_id": "reply-1", "epoch": 71})
                    sidecar._synth_queue.join()
                messages = [json.loads(line) for line in output.getvalue().splitlines()]
                packets = [m for m in messages if m["type"] == "tts_chunk"]
                self.assertTrue(packets)
                self.assertEqual(bytes(audio), PCM)
                self.assertEqual(sum(m["size"] for m in packets), len(audio))
                for m in packets:
                    self.assertEqual((m["sample_rate"], m["reply_id"], m["request_id"], m["epoch"], m["index"], m["total"]), (24000, "reply-1", "request-1", 71, 0, 1))
                self.assertEqual([m["type"] for m in messages[-2:]], ["tts_done", "tts_reply_done"])

    def test_cloud_initialization_reads_only_cloud_settings_without_loading_local_models(self):
        for engine in DEFAULTS:
            env = {"ARIA_TTS_ENGINE": engine, "ARIA_TTS_VOICE": "LOCAL-VOICE",
                   "ARIA_TTS_CLOUD_KEY": KEY, "ARIA_TTS_CLOUD_MODEL": "custom-model",
                   "ARIA_TTS_CLOUD_VOICE": "custom-voice", "ARIA_TTS_SPEED": "nan",
                   "ELEVENLABS_API_KEY": "not-selected", "OPENAI_API_KEY": "not-selected",
                   "ARIA_TTS_CLOUD_ENDPOINT": self.endpoint}
            with patch.dict("os.environ", env, clear=True):
                sidecar = TtsSidecar()
                with patch.object(sidecar, "_load_piper", side_effect=AssertionError("local load")), patch.object(sidecar, "_load_kokoro", side_effect=AssertionError("local load")):
                    sidecar._ensure_loaded()
                self.assertEqual(sidecar.voice_name, "LOCAL-VOICE")
                self.assertEqual((sidecar._cloud.model, sidecar._cloud.voice), ("custom-model", "custom-voice"))
                self.assertEqual(sidecar._cloud._key, KEY)
                self.assertTrue(sidecar._cloud._origin.startswith("https://api."))
                self.assertEqual(sidecar.speed, 1)
                sidecar.on_control({"type": "set_speed", "speed": "nan"})
                self.assertEqual(sidecar.speed, 1)
                sidecar.cleanup()

    def test_proxy_environment_is_not_used(self):
        env = {"HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1",
               "http_proxy": "http://127.0.0.1:1", "NO_PROXY": "", "no_proxy": ""}
        with patch.dict("os.environ", env):
            self.assertEqual(b"".join(self.stream()), PCM)

    def test_stop_after_first_audio_drops_remaining_old_frames_and_next_request_is_clean(self):
        first, release = threading.Event(), threading.Event()
        self.server.scenarios.put({"first": first, "release": release, "pieces": [PCM[:200], PCM[200:]]})
        self.server.scenarios.put({})
        with self.sidecar() as (sidecar, output, audio):
            sidecar.on_control({"type": "synthesize", "text": "Old.", "request_id": "old", "epoch": 1})
            self.assertTrue(first.wait(2))
            deadline = time.monotonic() + 2
            while len(audio) < 200 and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertEqual(bytes(audio), PCM[:200])
            sidecar.on_control({"type": "stop", "epoch": 2})
            sidecar.on_control({"type": "synthesize", "text": "New.", "request_id": "new", "epoch": 2})
            release.set()
            sidecar._synth_queue.join()
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(bytes(audio), PCM[:200] + PCM)
        stopped = next(i for i, m in enumerate(messages) if m["type"] == "tts_stopped")
        self.assertFalse(any(m.get("request_id") == "old" for m in messages[stopped + 1:]))

    def test_sidecar_stop_drops_queued_stale_audio_and_odd_byte_carry(self):
        arrived, release = threading.Event(), threading.Event()
        self.server.scenarios.put({"arrived": arrived, "release": release, "pieces": [b"x", PCM]})
        self.server.scenarios.put({})
        with self.sidecar() as (sidecar, output, audio):
            sidecar.on_control({"type": "synthesize", "text": "Old.", "request_id": "old", "epoch": 1})
            self.assertTrue(arrived.wait(2))
            sidecar.on_control({"type": "synthesize", "text": "Queued.", "request_id": "queued", "epoch": 1})
            sidecar.on_control({"type": "stop", "epoch": 2})
            sidecar.on_control({"type": "synthesize", "text": "New.", "request_id": "new", "epoch": 2})
            release.set()
            sidecar._synth_queue.join()
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(bytes(audio), PCM)
        for m in messages:
            if m["type"] in ("tts_chunk", "tts_done"):
                self.assertEqual(m["request_id"], "new")
        self.assertFalse(any(m.get("status") == "error" for m in messages))

    def test_dns_deadline_stop_and_fresh_reply_do_not_block_worker(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        real_resolver = socket.getaddrinfo

        def stalled_once(*args, **kwargs):
            if not entered.is_set():
                entered.set()
                release.wait(5)
                try:
                    return real_resolver(*args, **kwargs)
                finally:
                    finished.set()
            return real_resolver(*args, **kwargs)

        with self.sidecar() as (sidecar, output, audio):
            sidecar._cloud._deadline_s = 0.1
            with patch('socket.getaddrinfo', side_effect=stalled_once):
                try:
                    sidecar.on_control({'type': 'synthesize', 'text': 'Expired.', 'request_id': 'expired', 'epoch': 1})
                    self.assertTrue(entered.wait(1))
                    end = time.monotonic() + 0.8
                    while 'deadline exceeded' not in output.getvalue() and time.monotonic() < end:
                        time.sleep(0.005)
                    self.assertIn('deadline exceeded', output.getvalue())
                    sidecar.on_control({'type': 'stop', 'epoch': 2})
                    sidecar._cloud._deadline_s = 2
                    self.server.scenarios.put({})
                    sidecar.on_control({'type': 'synthesize', 'text': 'Fresh.', 'request_id': 'fresh', 'reply_id': 'fresh-reply', 'epoch': 2})
                    sidecar.on_control({'type': 'reply_done', 'reply_id': 'fresh-reply', 'epoch': 2})
                    end = time.monotonic() + 2
                    while 'tts_reply_done' not in output.getvalue() and time.monotonic() < end:
                        time.sleep(0.005)
                    self.assertIn('tts_reply_done', output.getvalue())
                    self.assertEqual(bytes(audio), PCM)
                finally:
                    release.set()
                    self.assertTrue(finished.wait(2))
                # Once DNS returns, canceled/expired work must never POST text.
                end = time.monotonic() + 1
                while sidecar._synth_queue.unfinished_tasks and time.monotonic() < end:
                    time.sleep(0.005)
                self.assertEqual(sidecar._synth_queue.unfinished_tasks, 0)
                time.sleep(0.1)
                self.assertEqual(self.server.requests.qsize(), 1)
                self.assertEqual(self.server.requests.get_nowait()[2]['input'], 'Fresh.')
                self.assertNotIn('"request_id": "expired"', output.getvalue())

    def test_stalled_dns_workers_are_bounded_and_recover_without_late_uploads(self):
        release = threading.Event()
        real_resolver = socket.getaddrinfo
        arrivals = queue.Queue()

        def stalled(*args, **kwargs):
            arrivals.put(True)
            release.wait(3)
            return real_resolver(*args, **kwargs)

        with patch('socket.getaddrinfo', side_effect=stalled):
            try:
                for _ in range(2):
                    with self.assertRaisesRegex(CloudTtsError, 'deadline exceeded'):
                        list(self.client(deadline_s=0.1).stream('Expired.', 1, lambda: False))
                    arrivals.get(timeout=1)
                start = time.monotonic()
                with self.assertRaisesRegex(CloudTtsError, 'network workers unavailable'):
                    list(self.client(deadline_s=0.1).stream('Never started.', 1, lambda: False))
                self.assertLess(time.monotonic() - start, 0.1)
                self.assertTrue(arrivals.empty())
            finally:
                release.set()
                for worker in threading.enumerate():
                    if worker.name == 'cloud-tts-network':
                        worker.join(2)
        self.assertTrue(self.server.requests.empty())
        self.assertEqual(b''.join(self.stream()), PCM)

    def test_sidecar_failure_uses_safe_status_without_done_or_fallback(self):
        self.server.scenarios.put({"status": 401, "pieces": [KEY.encode()]})
        with self.sidecar() as (sidecar, output, audio):
            sidecar.on_control({"type": "synthesize", "text": "Hello.", "request_id": "bad"})
            sidecar._synth_queue.join()
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(any(m.get("status") == "error" for m in messages))
        self.assertFalse(any(m["type"] in ("tts_done", "tts_chunk") for m in messages))
        self.assertEqual(audio, b"")
        self.assertNotIn(KEY, output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
