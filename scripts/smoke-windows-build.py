#!/usr/bin/env python3
"""Exercise Windows release CMake selection without requiring an MSVC host."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class WindowsBuild(unittest.TestCase):
    def test_windows_stages_cpu_plugins_beside_executables(self):
        # GGML v1.7.6 scans the exe directory, not PATH, for CPU backend plugins.
        import shutil
        with tempfile.TemporaryDirectory(prefix="aria-win-stage-") as tmp:
            base = Path(tmp)
            (base / "scripts").mkdir()
            shutil.copy(ROOT / "scripts/stage-whisper.sh", base / "scripts")
            tools = base / "tools"
            tools.mkdir()
            uname = tools / "uname"
            uname.write_text("#!/bin/bash\nprintf '%s\\n' MINGW64_NT-10.0\n")
            uname.chmod(0o755)
            source = base / "input"
            source.mkdir()
            files = ["whisper-cli.exe", "whisper-server.exe", "whisper.dll", "ggml.dll",
                     "ggml-base.dll", "ggml-cpu-x64.dll", "ggml-cpu-haswell.dll"]
            for name in files:
                (source / name).write_bytes(b"staging-fixture")
            env = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                   "WHISPER_BIN_DIR": str(source), "WHISPER_LIB_DIR": str(base / "absent")}
            subprocess.run(["bash", str(base / "scripts/stage-whisper.sh")], env=env,
                           check=True, capture_output=True, text=True)
            for name in files:
                self.assertTrue((base / "build/whisper/bin" / name).is_file(), name)

    def test_windows_uses_runtime_cpu_dispatch_not_builder_cpu(self):
        # Intercept external build tools; run the real bash script's platform flow.
        with tempfile.TemporaryDirectory(prefix="aria-win-build-") as tmp:
            base = Path(tmp)
            tools = base / "tools"
            tools.mkdir()
            log = base / "cmake.jsonl"
            for name, body in {
                "uname": "printf '%s\\n' MINGW64_NT-10.0\n",
                "git": "exit 0\n",
                "vulkaninfo": "exit 1\n",
                "cmake": '"$TEST_PYTHON" -c \'import json,os,sys; open(os.environ["TEST_CMAKE_LOG"],"a").write(json.dumps(sys.argv[1:])+"\\n")\' "$@"\n',
            }.items():
                f = tools / name
                f.write_text("#!/bin/bash\n" + body)
                f.chmod(0o755)
            env = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                   "TEST_CMAKE_LOG": str(log), "TEST_PYTHON": __import__("sys").executable,
                   "TMPDIR": str(base), "INSTALL_PREFIX": str(base / "install")}
            subprocess.run(["bash", str(ROOT / "scripts/build-whispercpp.sh")], env=env,
                           check=True, capture_output=True, text=True)
            configure = json.loads(log.read_text().splitlines()[0])
            for flag in ("-DGGML_NATIVE=OFF", "-DGGML_BACKEND_DL=ON", "-DGGML_CPU_ALL_VARIANTS=ON"):
                self.assertIn(flag, configure)
            self.assertFalse(list(base.glob("aria-whisper-build.*")), "private build must be cleaned")


if __name__ == "__main__":
    unittest.main()
