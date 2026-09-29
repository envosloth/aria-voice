#!/usr/bin/env python3
"""Real HTTP exchanges for the opt-in providers; no live accounts/credentials."""
import importlib.util
import io
import json
import os
import sys
import threading
import time
import unittest
import wave
from typing import Any, Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'sidecars/stt'))
spec = importlib.util.spec_from_file_location('extra_stt_test', ROOT / 'sidecars/stt/main.py')
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
PCM = b'\x01\x00' * 160
KEY = 'fixture-extra-key-not-real'
ID = '0072a82b-aa22-4962-add2-6121c36c17c6'
UPLOAD = 'https://cdn.assemblyai.com/upload/f756988d-47e2-4ca3-96ce-04bb168f8f2a'


class FixtureServer(ThreadingHTTPServer):
    requests: list
    reply: Callable
    base: str


class Handler(BaseHTTPRequestHandler):
    server: FixtureServer  # type: ignore[assignment]
    def do_POST(self):
        self.respond()

    def do_GET(self):
        self.respond()

    def respond(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.server.requests.append((self.command, self.path, self.headers, body))
        data = self.server.reply(self.command, self.path)
        if isinstance(data, tuple):
            status, raw, mode = data
        else:
            status, raw, mode = 200, json.dumps(data).encode(), ''
        try:
            if mode == 'slow_headers':
                for byte in b'HTTP/1.0 200 OK\r\nContent-Length: 100\r\n\r\n':
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(0.04)
                return
            if mode == 'stall':
                time.sleep(0.3)
            self.send_response(status)
            if 300 <= status < 400:
                self.send_header('Location', self.server.base + '/stolen')
            if mode != 'unbounded':
                self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            if mode == 'slow_body':
                for byte in raw:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(0.04)
            else:
                self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format, *args):
        pass


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = FixtureServer(('127.0.0.1', 0), Handler)
        cls.server.base = f'http://127.0.0.1:{cls.server.server_port}'
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.server.requests = []
        with patch.dict(os.environ, {'ARIA_STT_PROVIDER': 'local'}, clear=True):
            self.sidecar = m.SttSidecar()
        self.messages = []
        self.sidecar.emit = self.messages.append
        self.sidecar._emit_status = lambda *args: self.messages.append(args)
        self.server.reply = self.success_reply

    @staticmethod
    def success_reply(method, path) -> dict[str, Any]:
        if path == '/v2/upload':
            return {'upload_url': UPLOAD}
        if path == '/v2/transcript':
            return {'id': ID, 'status': 'queued', 'text': None}
        if path.startswith('/v2/transcript/'):
            return {'id': ID, 'status': 'completed', 'text': 'Turn on the lights.'}
        return {'results': {'channels': [{'alternatives': [{'transcript': 'Turn on the lights.'}]}]}}

    def fallback(self, provider):
        self.configured(provider)
        self.sidecar._server_proc = type('Live', (), {'poll': lambda _: None})()
        self.sidecar._server_port = self.server.server_port
        original = self.server.reply

        def reply(method, path):
            return {'text': 'warm local fallback'} if path == '/inference' else original(method, path)

        self.server.reply = reply
        return self.sidecar._transcribe(PCM)

    @unittest.skipUnless(os.environ.get('ARIA_SMOKE_REAL_STT') == '1', 'opt-in real whisper.cpp fallback')
    def test_real_whisper_warm_fallback_after_actual_http_401(self):
        default_audio = Path(os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch'))) / 'stt_test_16k.wav'
        audio_path = Path(os.environ.get('ARIA_SMOKE_STT_WAV', str(default_audio)))
        with wave.open(str(audio_path)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 16000))
            pcm = wav.readframes(wav.getnframes())
        self.sidecar._force_cpu = True
        try:
            with patch.dict(os.environ, {'ARIA_STT_MODEL': 'tiny.en', 'ARIA_STT_BACKEND': 'cpu',
                                         'ARIA_STT_THREADS': '4', 'ARIA_STT_AUDIO_CTX': '0',
                                         'ARIA_STT_PROMPT': ''}, clear=False):
                self.sidecar.initialize()
                self.assertIsNotNone(self.sidecar._server_proc)
                for provider in ('deepgram', 'assemblyai'):
                    self.configured(provider)
                    self.server.requests = []
                    self.server.reply = lambda *_: (401, KEY.encode(), '')
                    text = self.sidecar._transcribe(pcm)
                    print(f'real whisper fallback ({provider} HTTP 401): {text!r}')
                    self.assertIn('test', text.lower())
                    self.assertEqual(len(self.server.requests), 1)
                    self.assertNotIn(KEY, str(self.messages))
        finally:
            proc = self.sidecar._server_proc
            self.sidecar._stop_server()
            if proc and proc.stdout:
                proc.stdout.close()

    def test_dns_stall_cannot_accumulate_workers_or_upload_after_timeout(self):
        self.configured('deepgram')
        self.sidecar._CLOUD_TIMEOUT_S = 0.1
        release, started = threading.Event(), threading.Event()
        original = m.cloud_stt.socket.getaddrinfo
        before = set(threading.enumerate())

        def resolve(*args, **kwargs):
            started.set()
            release.wait(2)
            return original(*args, **kwargs)

        with patch.object(m.cloud_stt.socket, 'getaddrinfo', side_effect=resolve):
            try:
                with self.assertRaises(m.cloud_stt.CloudError):
                    self.sidecar._transcribe_cloud(PCM)
                self.assertTrue(started.is_set())
                workers = [thread for thread in threading.enumerate() if thread not in before
                           and thread.name == 'stt-cloud-http']
                self.assertEqual(len(workers), 1)
                for _ in range(3):
                    with self.assertRaisesRegex(m.cloud_stt.CloudError, 'transport_busy'):
                        self.sidecar._transcribe_cloud(PCM)
            finally:
                release.set()
                for thread in threading.enumerate():
                    if thread not in before and thread.name == 'stt-cloud-http':
                        thread.join(1)
                        self.assertFalse(thread.is_alive())
        self.assertEqual(self.server.requests, [])
        self.assertEqual(self.sidecar._transcribe_cloud(PCM), 'Turn on the lights.')

    def test_provider_key_isolation_and_fixed_production_urls(self):
        for provider in ('deepgram', 'assemblyai'):
            with self.subTest(provider=provider):
                with patch.dict(os.environ, {'ARIA_STT_PROVIDER': provider, 'ARIA_STT_GROQ_KEY': KEY}, clear=True):
                    self.assertIsNone(self.sidecar._cloud_config())
                with patch.dict(os.environ, {'ARIA_STT_PROVIDER': provider, 'ARIA_STT_CLOUD_KEY': KEY,
                                             'ARIA_STT_ENDPOINT': self.server.base}, clear=True):
                    cloud = self.sidecar._cloud_config()
                self.assertEqual(m.cloud_stt._base_url(provider, cloud), f'https://api.{provider}.com')
        with patch.dict(os.environ, {'ARIA_STT_PROVIDER': 'groq', 'ARIA_STT_CLOUD_KEY': KEY}, clear=True):
            self.assertIsNone(self.sidecar._cloud_config())
        with patch.dict(os.environ, {'ARIA_STT_PROVIDER': 'local', 'ARIA_STT_CLOUD_KEY': KEY,
                                     'ARIA_STT_GROQ_KEY': KEY}, clear=True):
            self.assertIsNone(self.sidecar._cloud_config())

    def test_test_endpoint_injection_is_literal_loopback_only(self):
        self.configured('deepgram')
        for url in ('https://example.com', 'http://localhost:1234', 'http://127.0.0.2:1234',
                    'http://127.0.0.1:1234/extra', 'http://user@127.0.0.1:1234',
                    'http://127.0.0.1:1234#fragment', 'http://127.0.0.1:1234?query',
                    'http://127.0.0.1:1234/', 'http://127.0.0.1:99999'):
            with self.subTest(url=url):
                self.sidecar._cloud['test_base_url'] = url
                with self.assertRaises((m.cloud_stt.CloudError, ValueError)):
                    self.sidecar._transcribe_cloud(PCM)
        self.assertEqual(self.server.requests, [])

    def test_no_speculative_upload_and_one_correlated_final(self):
        for provider in ('deepgram', 'assemblyai'):
            self.server.requests = []
            self.messages.clear()
            self.configured(provider)
            self.sidecar.on_control({'type': 'start', 'utterance_id': provider})
            self.sidecar.on_pcm(PCM[:160])
            self.sidecar.on_control({'type': 'speculate', 'utterance_id': provider, 'audio_bytes': 160})
            self.assertEqual(self.server.requests, [])
            producer = threading.Thread(target=lambda: (time.sleep(0.02), self.sidecar.on_pcm(PCM[160:])))
            producer.start()
            self.sidecar.on_control({'type': 'transcribe', 'utterance_id': provider, 'audio_bytes': len(PCM)})
            producer.join()
            finals = [msg for msg in self.messages if isinstance(msg, dict) and msg['type'] == 'stt_result']
            self.assertEqual(len(finals), 1)
            self.assertEqual(finals[0]['utterance_id'], provider)
            uploads = [r for r in self.server.requests if r[0] == 'POST' and r[1] != '/v2/transcript']
            self.assertEqual(len(uploads), 1)
            self.wav(uploads[0][3])

    def test_empty_transcript_is_silence_not_fallback(self):
        for provider in ('deepgram', 'assemblyai'):
            self.configured(provider)
            def reply(method, path):
                value = self.success_reply(method, path)
                if 'results' in value:
                    value['results']['channels'][0]['alternatives'][0]['transcript'] = ''
                elif value.get('status') == 'completed':
                    value['text'] = ''
                return value
            self.server.reply = reply
            with patch.object(self.sidecar, '_transcribe_server', side_effect=AssertionError('no fallback')):
                self.assertEqual(self.sidecar._transcribe(PCM), '')

    def test_actual_http_failures_fall_back_without_server_echo(self):
        for provider in ('deepgram', 'assemblyai'):
            for status in (401, 403, 429, 500):
                with self.subTest(provider=provider, status=status):
                    self.server.reply = lambda *_: (status, KEY.encode(), '')
                    self.assertEqual(self.fallback(provider), 'warm local fallback')
                    self.assertIn(f'HTTP {status}', str(self.messages[-1]))
        self.assertNotIn(KEY, str(self.messages))

    def test_invalid_json_and_deepgram_shape_use_warm_http_fallback(self):
        for raw in (b'not json', b'[]', b'{}', b'{"results":{"channels":[]}}',
                    b'{"results":{"channels":[{"alternatives":[{"transcript":null}]}]}}'):
            self.server.reply = lambda *_: (200, raw, '')
            self.assertEqual(self.fallback('deepgram'), 'warm local fallback')

    def test_redirect_rejected_at_every_assemblyai_stage(self):
        for stage in ('/v2/upload', '/v2/transcript', '/v2/transcript/' + ID):
            for status in (301, 302, 303, 307, 308):
                self.server.requests = []
                self.server.reply = lambda method, path: ((status, KEY.encode(), '') if path == stage
                                                         else self.success_reply(method, path))
                self.assertEqual(self.fallback('assemblyai'), 'warm local fallback')
                self.assertNotIn('/stolen', [r[1] for r in self.server.requests])
                self.assertEqual(sum(r[1] == stage for r in self.server.requests), 1)
        self.server.requests = []
        self.server.reply = lambda *_: (307, KEY.encode(), '')
        self.assertEqual(self.fallback('deepgram'), 'warm local fallback')
        self.assertEqual(len(self.server.requests), 2)  # cloud + local, not redirect

    def test_response_size_bounded_with_and_without_content_length(self):
        for provider in ('deepgram', 'assemblyai'):
            for mode in ('', 'unbounded'):
                self.server.reply = lambda *_: (200, b'x' * (m.cloud_stt.MAX_RESPONSE_BYTES + 1), mode)
                self.assertEqual(self.fallback(provider), 'warm local fallback')

    def test_proxy_env_does_not_receive_audio_or_auth(self):
        for provider in ('deepgram', 'assemblyai'):
            self.configured(provider)
            with patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:1',
                                         'HTTPS_PROXY': 'http://127.0.0.1:1', 'NO_PROXY': ''}):
                self.assertEqual(self.sidecar._transcribe_cloud(PCM), 'Turn on the lights.')
        self.assertTrue(all(not r[1].startswith('http') for r in self.server.requests))

    def test_invalid_key_never_reaches_http_headers(self):
        for provider in ('deepgram', 'assemblyai'):
            self.configured(provider)
            for key in ('', 'contains\r\nInjected: header', 'contains space', 'non-ascii-\u00e9'):
                self.sidecar._cloud['key'] = key
                with self.assertRaisesRegex(m.cloud_stt.CloudError, 'invalid_key'):
                    self.sidecar._transcribe_cloud(PCM)
        self.assertEqual(self.server.requests, [])

    def test_empty_control_never_uploads(self):
        for provider in ('deepgram', 'assemblyai'):
            self.configured(provider)
            self.sidecar.on_control({'type': 'start', 'utterance_id': provider})
            self.sidecar.on_control({'type': 'transcribe', 'utterance_id': provider, 'audio_bytes': 0})
            self.assertEqual(self.messages[-1]['text'], '')
        self.assertEqual(self.server.requests, [])

    def test_audio_limit_rejects_before_upload(self):
        for provider in ('deepgram', 'assemblyai'):
            self.configured(provider)
            with self.assertRaises(m.cloud_stt.CloudError):
                self.sidecar._transcribe_cloud(b'\0' * m.cloud_stt.MAX_AUDIO_BYTES)
        self.assertEqual(self.server.requests, [])

    def test_assemblyai_upload_url_validated_before_submission(self):
        for value in (None, 123, 'http://cdn.assemblyai.com/upload/id',
                      'https://evil.example/upload/id', 'https://cdn.assemblyai.com.evil.example/upload/id',
                      'https://user@cdn.assemblyai.com/upload/id', 'https://cdn.assemblyai.com:443/upload/id',
                      'https://cdn.assemblyai.com/upload/../id', 'https://cdn.assemblyai.com/upload/%2fsecret',
                      UPLOAD + '?token=x', UPLOAD + '\n', UPLOAD + '#secret'):
            self.server.requests = []
            self.server.reply = lambda *_: {'upload_url': value}
            self.assertEqual(self.fallback('assemblyai'), 'warm local fallback')
            self.assertEqual([r[1] for r in self.server.requests], ['/v2/upload', '/inference'])

    def test_assemblyai_id_and_status_are_fail_closed(self):
        for value in (None, 123, '', '../secret', 'abc?x=1', 'abc/secret', 'https://evil',
                      'abc%2fsecret', 'abc\r\nSecret: x', 'x' * 129):
            self.server.requests = []
            self.server.reply = lambda method, path: ({'id': value, 'status': 'queued'}
                          if path == '/v2/transcript' else self.success_reply(method, path))
            self.assertEqual(self.fallback('assemblyai'), 'warm local fallback')
            self.assertFalse(any(r[0] == 'GET' for r in self.server.requests))
        for value in ({'id': ID, 'status': 'error', 'error': KEY},
                      {'id': ID, 'status': 'made-up'}, {'id': ID, 'status': 'completed', 'text': None},
                      {'id': 'wrong-id', 'status': 'completed', 'text': 'wrong turn'}):
            self.server.reply = lambda method, path: (value if method == 'GET' else self.success_reply(method, path))
            self.assertEqual(self.fallback('assemblyai'), 'warm local fallback')
        self.assertNotIn(KEY, str(self.messages))

    def test_socket_stall_trickled_headers_and_body_have_total_deadline(self):
        for provider in ('deepgram', 'assemblyai'):
            for mode in ('stall', 'slow_headers', 'slow_body'):
                self.server.requests = []
                self.server.reply = lambda *_: (200, b'{"padding":"' + b'x' * 100 + b'"}', mode)
                self.sidecar._CLOUD_TIMEOUT_S = 0.12
                start = time.monotonic()
                self.assertEqual(self.fallback(provider), 'warm local fallback')
                self.assertLess(time.monotonic() - start, 0.7)
                self.assertEqual(len(self.server.requests), 2)
                time.sleep(0.03)  # allow cancelled worker to finish; no second upload

    def test_assemblyai_processing_has_bounded_poll_count(self):
        self.server.reply = lambda method, path: ({'id': ID, 'status': 'processing'}
                        if method == 'GET' else self.success_reply(method, path))
        with patch.object(m.cloud_stt, 'POLL_INTERVAL_S', 0.01), patch.object(m.cloud_stt, 'MAX_POLLS', 3):
            self.assertEqual(self.fallback('assemblyai'), 'warm local fallback')
        self.assertEqual(sum(r[0] == 'GET' for r in self.server.requests), 3)

    def test_assemblyai_polling_has_shared_total_deadline(self):
        self.server.reply = lambda method, path: ({'id': ID, 'status': 'processing'}
                        if method == 'GET' else self.success_reply(method, path))
        self.sidecar._CLOUD_TIMEOUT_S = 0.18
        start = time.monotonic()
        self.assertEqual(self.fallback('assemblyai'), 'warm local fallback')
        self.assertLess(time.monotonic() - start, 0.7)
        self.assertEqual(sum(r[0] == 'GET' for r in self.server.requests), 1)

    def configured(self, provider):
        with patch.dict(os.environ, {'ARIA_STT_PROVIDER': provider, 'ARIA_STT_CLOUD_KEY': KEY}, clear=True):
            self.sidecar._cloud = self.sidecar._cloud_config()
        self.assertIsNotNone(self.sidecar._cloud)
        # In-process-only injection. No environment override is permitted.
        self.sidecar._cloud['test_base_url'] = f'http://127.0.0.1:{self.server.server_port}'

    def wav(self, body):
        with wave.open(io.BytesIO(body)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 16000))
            self.assertEqual(wav.readframes(160), PCM)

    def test_assemblyai_upload_submit_poll_real_http(self):
        self.configured('assemblyai')
        pending = iter(['queued', 'processing', 'completed'])

        def reply(method, path):
            if path == '/v2/upload':
                return {'upload_url': UPLOAD}
            if method == 'POST':
                return {'id': ID, 'status': 'queued', 'text': None}
            return {'id': ID, 'status': next(pending), 'text': ' Turn on the lights. '}

        self.server.reply = reply
        self.assertEqual(self.sidecar._transcribe(PCM), 'Turn on the lights.')
        requests = self.server.requests
        self.assertEqual([(r[0], r[1]) for r in requests], [
            ('POST', '/v2/upload'), ('POST', '/v2/transcript'),
            ('GET', '/v2/transcript/' + ID), ('GET', '/v2/transcript/' + ID),
            ('GET', '/v2/transcript/' + ID)])
        for _, _, headers, _ in requests:
            self.assertEqual(headers['Authorization'], KEY)
        self.assertEqual(requests[0][2]['Content-Type'], 'application/octet-stream')
        self.wav(requests[0][3])
        payload = json.loads(requests[1][3])
        self.assertEqual(payload, {'audio_url': UPLOAD, 'speech_models': ['universal-3-5-pro'],
                                   'language_code': 'en', 'punctuate': True, 'format_text': True})
        self.assertEqual(requests[1][2]['Content-Type'], 'application/json')

    def test_deepgram_real_http_wav_and_auth(self):
        self.configured('deepgram')
        self.server.reply = lambda *_: {'results': {'channels': [{'alternatives': [{'transcript': ' Turn on the lights. '}]}]}}
        self.assertEqual(self.sidecar._transcribe(PCM), 'Turn on the lights.')
        method, path, headers, body = self.server.requests[0]
        self.assertEqual(method, 'POST')
        self.assertEqual(urlsplit(path).path, '/v1/listen')
        query = parse_qs(urlsplit(path).query)
        self.assertEqual(query['model'], ['nova-3'])
        self.assertEqual(query['language'], ['en'])
        self.assertEqual(headers['Authorization'], 'Token ' + KEY)
        self.assertEqual(headers['Content-Type'], 'audio/wav')
        self.wav(body)


if __name__ == '__main__':
    unittest.main(verbosity=2)
