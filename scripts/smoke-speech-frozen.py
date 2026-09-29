#!/usr/bin/env python3
"""Exercise frozen sidecar imports/startup/controls without a cloud request.

Requires scripts/package-sidecar.sh stt/tts. Uses only synthetic credentials;
startup must never contact a provider. No system Python in the child processes.
"""
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]

def probe(name, provider):
    server = socket.socket()
    server.bind(('127.0.0.1', 0))
    server.listen(1)
    server.settimeout(20)
    env = dict(os.environ)
    env.update(ARIA_MODELS_DIR=str(Path.home()/'.local/share/aria/models'),
               ARIA_STT_MODEL='tiny.en', ARIA_STT_BACKEND='cpu', ARIA_STT_THREADS='2',
               ARIA_STT_PROVIDER=provider, ARIA_STT_CLOUD_KEY='fixture-unused-stt-key',
               ARIA_TTS_ENGINE=provider, ARIA_TTS_CLOUD_KEY='fixture-unused-tts-key')
    for key in ['ARIA_TTS_CLOUD_MODEL','ARIA_TTS_CLOUD_VOICE','ARIA_STT_GROQ_KEY']:
        env.pop(key, None)
    proc = subprocess.Popen([str(ROOT/'build/sidecars'/name/name), '--socket',
                             'tcp://127.0.0.1:'+str(server.getsockname()[1])],
                            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
    messages = queue.Queue()
    def read():
        assert proc.stdout is not None
        for line in proc.stdout:
            try:
                messages.put(json.loads(line))
            except json.JSONDecodeError:
                pass
    threading.Thread(target=read, daemon=True).start()
    conn = None
    try:
        conn, _ = server.accept()
        end = time.monotonic()+25
        ready = False
        while time.monotonic()<end:
            try: msg=messages.get(timeout=0.5)
            except queue.Empty:
                if proc.poll() is not None: break
                continue
            if msg.get('type')=='status' and msg.get('status')=='error':
                raise AssertionError(msg.get('detail'))
            if msg.get('type')=='status' and msg.get('status')=='ready':
                ready=True; break
        assert ready, f'{name} {provider} frozen startup must reach ready'
        if name=='tts':
            proc.stdin.write(json.dumps({'type':'stop','epoch':71})+'\n');proc.stdin.flush()
            end=time.monotonic()+3
            while time.monotonic()<end:
                msg=messages.get(timeout=1)
                if msg.get('type')=='tts_stopped':
                    assert msg.get('epoch')==71; break
            else: raise AssertionError('frozen stop ack missing')
        print(f'PASS frozen {name} {provider}: ready'+(' and stop acknowledged' if name=='tts' else ''),flush=True)
    finally:
        proc.terminate()
        try: proc.wait(timeout=4)
        except subprocess.TimeoutExpired: proc.kill();proc.wait()
        if conn:conn.close()
        server.close()
        proc.stdin.close();proc.stdout.close();proc.stderr.close()

if __name__=='__main__':
    for engine in ['elevenlabs','cartesia','openai','deepgram']: probe('tts',engine)
    for provider in ['deepgram','assemblyai']: probe('stt',provider)
