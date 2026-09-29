#!/usr/bin/env python3
"""Cloud-STT path for the STT sidecar (roadmap: STT reliability options).

Opt-in only (ARIA_STT_PROVIDER=cloud); local whisper.cpp stays the default and
is the fallback on ANY cloud failure. No model, network, or binaries needed:
the transcription call is mocked, so this checks routing, request shape,
timeouts, key handling, and the fallback contract.
"""

import io
import json
import os
import sys
import importlib.util
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("aria_stt_main_cloud", os.path.join(ROOT, "sidecars", "stt", "main.py"))
assert spec and spec.loader
stt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stt)

failures = []


def check(name, cond, detail=""):
    if not cond:
        failures.append(name)
    print(f"[{name}] {'PASS' if cond else 'FAIL'}" + (f" — {detail}" if detail else ""))


CLOUD_ENV = {
    "ARIA_STT_PROVIDER": "cloud",
    "ARIA_STT_CLOUD_ENDPOINT": "https://api.groq.com/openai/v1/audio/transcriptions",
    "ARIA_STT_CLOUD_MODEL": "whisper-large-v3-turbo",
    "ARIA_STT_CLOUD_KEY": "test-key-123",
}


def make_sidecar(env=None, transcribe=None):
    with mock.patch.dict(os.environ, env if env is not None else CLOUD_ENV, clear=False):
        for key in ("ARIA_STT_PROVIDER", "ARIA_STT_CLOUD_ENDPOINT", "ARIA_STT_CLOUD_MODEL", "ARIA_STT_CLOUD_KEY"):
            if env is not None and key not in env:
                os.environ.pop(key, None)
        sidecar = stt.SttSidecar()
    sidecar.emit = lambda *a, **k: None
    sidecar._emit_status = lambda *a, **k: None
    # No model or binary in this test: the local path must be replaced, so any
    # real local attempt (a harness bug) raises instead of shelling out.
    sidecar._transcribe_local = transcribe if transcribe is not None else (lambda pcm: "local fallback")
    return sidecar


# 1. Default remains local: no cloud env -> cloud disabled, local path used.
local = make_sidecar(env={"ARIA_STT_PROVIDER": "local"})
check("default-is-local", local._cloud is None)
calls = []
local._transcribe_local = lambda pcm: calls.append(pcm) or "local text"
check("local-path-used", local._transcribe(b"\x00\x40" * 800) == "local text" and len(calls) == 1)

# 2. Cloud configured from env (endpoint/model/key), no network needed.
cloud = make_sidecar()
check("cloud-config-read", cloud._cloud is not None
      and cloud._cloud["endpoint"].endswith("/audio/transcriptions")
      and cloud._cloud["model"] == "whisper-large-v3-turbo"
      and cloud._cloud["key"] == "test-key-123")

# 3. Cloud request shape: multipart WAV + model, Bearer auth, timeout set.
seen = {}


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_open(req, timeout=None):
    seen["url"] = req.full_url
    seen["timeout"] = timeout
    seen["auth"] = req.get_header("Authorization")
    seen["body"] = req.data
    return FakeResp(json.dumps({"text": "  cloud transcript  "}).encode())


with mock.patch.object(stt._LOOPBACK_OPENER, "open", fake_open):
    text = cloud._transcribe(b"\x00\x40" * 1600)
check("cloud-text-returned", text == "cloud transcript", repr(text))
check("cloud-auth-header", seen.get("auth") == "Bearer test-key-123", str(seen.get("auth")))
check("cloud-multipart-wav", b"RIFF" in (seen.get("body") or b"") and b"model" in (seen.get("body") or b"")
      and b"whisper-large-v3-turbo" in (seen.get("body") or b""))
check("cloud-timeout-bounded", isinstance(seen.get("timeout"), (int, float)) and 0 < seen["timeout"] <= 30, str(seen.get("timeout")))

# 4. ANY cloud failure falls back to local, and says so once.
for label, boom in [
    ("http-error", urllib.error.HTTPError("u", 429, "rate limited", {}, None)),
    ("url-error", urllib.error.URLError("no route to host")),
    ("timeout", TimeoutError("timed out")),
    ("bad-json", ValueError("not json")),
]:
    fallback = make_sidecar()
    warnings = []
    fallback._emit_status = lambda level, msg: warnings.append((level, msg))
    fallback._transcribe_local = lambda pcm: "local fallback"
    if label == "bad-json":
        with mock.patch.object(stt._LOOPBACK_OPENER, "open", lambda *a, **k: FakeResp(b"<html>nope")):
            out = fallback._transcribe(b"\x00\x40" * 800)
    else:
        with mock.patch.object(stt._LOOPBACK_OPENER, "open", side_effect=boom):
            out = fallback._transcribe(b"\x00\x40" * 800)
    check(f"fallback-on-{label}", out == "local fallback" and any(w[0] == "warning" for w in warnings),
          f"out={out!r} warnings={warnings}")

# 5. An empty cloud transcript (silence) is NOT a fallback trigger: it is a real
#    answer, and re-running whisper on silence is how phantom phrases appear.
silent = make_sidecar()
silent._transcribe_local = lambda pcm: (_ for _ in ()).throw(AssertionError("local should not run"))
with mock.patch.object(stt._LOOPBACK_OPENER, "open", lambda *a, **k: FakeResp(json.dumps({"text": "   "}).encode())):
    check("empty-cloud-text-is-not-failure", silent._transcribe(b"\x00\x40" * 800) == "")

# 6. Cloud marked unavailable when the key is missing -> straight to local.
nokey = make_sidecar(env={"ARIA_STT_PROVIDER": "cloud", "ARIA_STT_CLOUD_ENDPOINT": "https://x/y", "ARIA_STT_CLOUD_MODEL": "m"})
nokey._transcribe_local = lambda pcm: "local only"
check("missing-key-stays-local", nokey._transcribe(b"\x00\x40" * 800) == "local only")

# 7. The advertized status names the provider so the UI can show it.
status_sidecar = make_sidecar()
reported = []
status_sidecar._emit_status = lambda level, msg: reported.append(msg)
status_sidecar.model_path = "/tmp/model.bin"
status_sidecar.using_vulkan = False
status_sidecar._server_proc = None
status_sidecar._cli_bin = "/tmp/whisper-cli"
with mock.patch.object(status_sidecar, "_find_model", lambda: "/tmp/model.bin"), \
     mock.patch.object(status_sidecar, "_find_binary", lambda n: "/tmp/whisper-cli"), \
     mock.patch.object(status_sidecar, "_start_server", lambda b: None), \
     mock.patch.dict(os.environ, CLOUD_ENV, clear=False):
    status_sidecar.initialize()
check("status-names-cloud", any("provider=cloud" in m for m in reported), str(reported))

print(f"\n=== RESULT: {'PASS' if not failures else 'FAIL'} ===")
sys.exit(0 if not failures else 1)
