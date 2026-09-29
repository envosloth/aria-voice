#!/usr/bin/env python3
"""Cloud transport on a real loopback HTTP server, plus fallback/control tests.
No external API or account credentials are used; fixture data is synthetic.
"""
import importlib.util
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
import urllib.error

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('stt_provider_test', root / 'sidecars/stt/main.py')
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Handler(BaseHTTPRequestHandler):
    response = b'{"text":"Turn on the lights."}'
    status = 200
    requests = []
    def do_POST(self):
        type(self).requests.append((self.headers, self.rfile.read(int(self.headers['Content-Length']))))
        self.send_response(type(self).status)
        if type(self).status == 302:
            self.send_header('Location', '/stolen')
        self.end_headers()
        self.wfile.write(type(self).response)
    def log_message(self, *_): pass

class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.sidecar = m.SttSidecar()
        self.messages = []
        self.sidecar.emit = self.messages.append
        self.sidecar._emit_status = lambda *a: self.messages.append(a)
        self.env = {'ARIA_STT_PROVIDER':'groq', 'ARIA_STT_GROQ_KEY':'fixture-not-a-real-key', 'ARIA_STT_GROQ_MODEL':'whisper-large-v3-turbo'}
        Handler.requests = []; Handler.status = 200; Handler.response = b'{"text":"Turn on the lights."}'
    def configured(self):
        with patch.dict(os.environ, self.env, clear=False):
            self.sidecar._cloud = self.sidecar._cloud_config()
        # Test-only loopback override; production URL is fixed to Groq.
        self.sidecar._cloud['endpoint'] = f'http://127.0.0.1:{self.server.server_port}/audio/transcriptions'
    def test_default_never_uploads(self):
        with patch.dict(os.environ, {'ARIA_STT_PROVIDER':'local'}, clear=False):
            self.assertIsNone(self.sidecar._cloud_config())
        with patch.object(self.sidecar, '_transcribe_server', return_value='local') as local:
            self.sidecar._server_proc = type('Live', (), {'poll':lambda _: None})()
            self.assertEqual(self.sidecar._transcribe(b'\0\0'*16000), 'local')
            local.assert_called_once()
        self.assertEqual(len(Handler.requests), 0)
    def test_real_http_multipart(self):
        self.configured()
        self.assertEqual(self.sidecar._transcribe(b'\0\0'*16000), 'Turn on the lights.')
        headers, body = Handler.requests[0]
        self.assertEqual(headers['Authorization'], 'Bearer fixture-not-a-real-key')
        for field in [b'name="model"', b'whisper-large-v3-turbo', b'name="language"', b'name="file"', b'RIFF', b'name="response_format"']:
            self.assertIn(field, body)
    def test_bad_json_and_wrong_text_type_fall_back(self):
        self.configured()
        for raw in [b'not json', b'{}', b'{"text":null}', b'{"text":123}', b'[]']:
            Handler.response = raw
            with patch.object(self.sidecar, '_transcribe_server', return_value='local fallback'):
                self.sidecar._server_proc = type('Live', (), {'poll':lambda _: None})()
                self.assertEqual(self.sidecar._transcribe(b'\0\0'*160), 'local fallback')
    def test_empty_transcript_is_valid(self):
        self.configured(); Handler.response=b'{"text":""}'
        with patch.object(self.sidecar, '_transcribe_server', side_effect=AssertionError('local must not run')):
            self.assertEqual(self.sidecar._transcribe(b'\0\0'*160), '')
    def test_http_auth_and_rate_limit_failures_fall_back(self):
        self.configured(); self.sidecar._server_proc = type('Live', (), {'poll':lambda _: None})()
        for code in [401, 429, 500]:
            Handler.status = code
            with patch.object(self.sidecar, '_transcribe_server', return_value='local fallback'):
                self.assertEqual(self.sidecar._transcribe(b'\0\0'*160), 'local fallback')
    def test_timeout_falls_back_and_never_logs_secret(self):
        self.configured(); self.sidecar._server_proc = type('Live', (), {'poll':lambda _: None})()
        with patch.object(self.sidecar, '_transcribe_cloud', side_effect=TimeoutError('fixture-not-a-real-key')), patch.object(self.sidecar, '_transcribe_server', return_value='local'):
            self.assertEqual(self.sidecar._transcribe(b'\0\0'*160), 'local')
        self.assertNotIn('fixture-not-a-real-key', str(self.messages))
        self.assertLessEqual(self.sidecar._CLOUD_TIMEOUT_S, 5)
    def test_redirect_rejected_without_second_upload(self):
        self.configured(); Handler.status=302
        with patch.object(self.sidecar, '_transcribe_server', return_value='local'):
            self.sidecar._server_proc = type('Live', (), {'poll':lambda _: None})()
            self.assertEqual(self.sidecar._transcribe(b'\0\0'*160), 'local')
        self.assertEqual(len(Handler.requests), 1)
    def test_cloud_does_not_upload_speculative_pauses(self):
        self.configured()
        self.sidecar.on_control({'type':'start', 'utterance_id':'cloud-turn'})
        self.sidecar.on_pcm(b'\0\0'*16000)
        self.sidecar.on_control({'type':'speculate', 'utterance_id':'cloud-turn', 'audio_bytes':32000})
        self.assertEqual(len(Handler.requests), 0)
        self.sidecar.on_control({'type':'transcribe', 'utterance_id':'cloud-turn', 'audio_bytes':32000})
        finals=[x for x in self.messages if isinstance(x,dict) and x.get('type')=='stt_result']
        self.assertEqual(finals[0]['utterance_id'], 'cloud-turn')
        self.assertEqual(len(Handler.requests), 1)
    def test_local_warm_server_error_preserves_cli_fallback(self):
        self.sidecar._server_proc = type('Live', (), {'poll':lambda _: None})()
        with patch.object(self.sidecar, '_transcribe_server', side_effect=OSError('server died')), patch.object(self.sidecar, '_transcribe_cli', return_value='cli result') as cli:
            self.assertEqual(self.sidecar._transcribe(b'\0\0'*160), 'cli result')
            cli.assert_called_once()
    def test_full_context_and_vocabulary_reach_server_request(self):
        self.sidecar._server_port=self.server.server_port
        with patch.dict(os.environ, {'ARIA_STT_AUDIO_CTX':'0','ARIA_STT_PROMPT':'Aria, Longmont.'}):
            self.sidecar._transcribe_server(b'\0\0'*16000)
        body=Handler.requests[-1][1]
        self.assertNotIn(b'name="audio_ctx"', body)
        self.assertIn(b'Aria, Longmont.', body)

if __name__ == '__main__': unittest.main(verbosity=2)
