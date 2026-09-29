"""Stdlib-only finalized-utterance cloud transport. No configurable remote URLs.

Sources: developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
and www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model.
"""
import http.client
import json
import queue
import re
import socket
import threading
import time
from urllib.parse import urlencode, urlsplit

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
POLL_INTERVAL_S = 0.5
MAX_POLLS = 10
# At most one network worker, including a resolver stuck inside OS DNS. A timed
# out worker cannot issue a subsequent credentialed request. Daemon status means
# OS resolver stalls do not wedge shutdown or accumulate threads on each turn.
_NETWORK_SLOT = threading.BoundedSemaphore(1)


class CloudError(Exception):
    """Only controlled reason codes, never server bodies, URLs or credentials."""


def _base_url(provider, config):
    production = {'deepgram': 'https://api.deepgram.com',
                  'assemblyai': 'https://api.assemblyai.com'}[provider]
    test_url = config.get('test_base_url')
    if test_url is None:
        return production
    parsed = urlsplit(test_url)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1'
            or parsed.username or parsed.password or not parsed.port
            or parsed.path or parsed.query or parsed.fragment
            or test_url != f'http://127.0.0.1:{parsed.port}'):
        raise CloudError('invalid_test_endpoint')
    return test_url


def _request_json(base, path, key, method, data, content_type, deadline):
    """Absolute caller deadline, including DNS, headers and trickled bodies.

    http.client does not consult proxy env or follow redirects. The caller owns
    cancellation and shutdown; the worker owns response/connection cleanup.
    """
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise CloudError('timeout')
    if not _NETWORK_SLOT.acquire(blocking=False):
        raise CloudError('transport_busy')
    parsed = urlsplit(base)
    cancelled = threading.Event()
    result = queue.Queue(maxsize=1)
    connection = (http.client.HTTPSConnection if parsed.scheme == 'https'
                  else http.client.HTTPConnection)(parsed.hostname, parsed.port, timeout=remaining)
    # Capture the socket before getresponse(): http.client drops its own socket
    # reference on Connection: close, while the response still owns the file.
    state = {}

    def abort():
        cancelled.set()
        sock = state.get('socket') or connection.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def exchange():
        value, error = None, None
        try:
            connection.connect()
            state['socket'] = connection.sock
            if cancelled.is_set() or time.monotonic() >= deadline:
                raise CloudError('timeout')
            headers = {'Authorization': key, 'Accept': 'application/json',
                       'Connection': 'close'}
            if data is not None:
                headers['Content-Type'] = content_type
            connection.request(method, path, body=data, headers=headers)
            with connection.getresponse() as response:
                if response.status != 200:
                    raise CloudError(f'HTTP {response.status}')
                length = response.getheader('Content-Length')
                if length is not None and int(length) > MAX_RESPONSE_BYTES:
                    raise CloudError('response_too_large')
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise CloudError('response_too_large')
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise CloudError('invalid_response')
        except CloudError as exc:
            error = exc
        except Exception:
            error = CloudError('transport_or_response_error')
        finally:
            connection.close()
            _NETWORK_SLOT.release()
        result.put((value, error))

    threading.Thread(target=exchange, name='stt-cloud-http', daemon=True).start()
    try:
        value, error = result.get(timeout=max(0, deadline - time.monotonic()))
    except queue.Empty:
        abort()
        raise CloudError('timeout') from None
    if time.monotonic() >= deadline:
        abort()
        raise CloudError('timeout')
    if error is not None:
        raise error
    return value


def transcribe(config, wav_bytes, timeout=5):
    if len(wav_bytes) > MAX_AUDIO_BYTES:
        raise CloudError('audio_too_large')
    if not isinstance(config.get('key'), str) or not config['key'] or any(
            ord(c) < 33 or ord(c) > 126 for c in config['key']):
        raise CloudError('invalid_key')
    provider = config['provider']
    base = _base_url(provider, config)
    deadline = time.monotonic() + timeout
    if provider == 'deepgram':
        query = urlencode({'model': 'nova-3', 'language': 'en', 'smart_format': 'true'})
        result = _request_json(base, '/v1/listen?' + query, 'Token ' + config['key'],
                               'POST', wav_bytes, 'audio/wav', deadline)
        try:
            text = result['results']['channels'][0]['alternatives'][0]['transcript']
        except (KeyError, TypeError, IndexError):
            raise CloudError('invalid_response') from None
        if not isinstance(text, str):
            raise CloudError('invalid_response')
        return text.strip()
    if provider == 'assemblyai':
        return _assemblyai(base, config['key'], wav_bytes, deadline)
    raise CloudError('unsupported_provider')


def _assemblyai(base, key, wav_bytes, deadline):
    upload = _request_json(base, '/v2/upload', key, 'POST', wav_bytes,
                           'application/octet-stream', deadline)
    upload_url = upload.get('upload_url')
    # The upload result is data, not an arbitrary endpoint. Validate the literal
    # canonical CDN URL before submitting it; never fetch it ourselves or attach
    # credentials to it. The documented US upload endpoint returns this host.
    if not isinstance(upload_url, str) or not re.fullmatch(
            r'https://cdn\.assemblyai\.com/upload/[A-Za-z0-9_-]{1,200}', upload_url):
        raise CloudError('invalid_upload_url')
    payload = {'audio_url': upload_url, 'speech_models': ['universal-3-5-pro'],
               'language_code': 'en', 'punctuate': True, 'format_text': True}
    transcript = _request_json(base, '/v2/transcript', key, 'POST',
                               json.dumps(payload).encode(), 'application/json', deadline)
    transcript_id = transcript.get('id')
    # A path token only, never normalize/quote a malicious ID into validity.
    if not isinstance(transcript_id, str) or not re.fullmatch(
            r'[A-Za-z0-9_-]{1,128}', transcript_id):
        raise CloudError('invalid_transcript_id')
    for poll in range(MAX_POLLS + 1):
        status = transcript.get('status')
        if status == 'completed':
            text = transcript.get('text')
            if not isinstance(text, str):
                raise CloudError('invalid_response')
            return text.strip()
        if status == 'error':
            raise CloudError('transcription_failed')
        if status not in ('queued', 'processing'):
            raise CloudError('invalid_status')
        if poll == MAX_POLLS:
            break
        # Poll immediately once after submission, then at a bounded cadence.
        if poll:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(POLL_INTERVAL_S, remaining))
        transcript = _request_json(base, '/v2/transcript/' + transcript_id, key,
                                   'GET', None, '', deadline)
        if transcript.get('id') != transcript_id:
            raise CloudError('invalid_transcript_id')
    raise CloudError('timeout')
