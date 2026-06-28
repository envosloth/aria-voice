#!/usr/bin/env bash
# Stage the whisper.cpp binaries + shared libs into build/whisper/{bin,lib} so
# electron-builder can bundle them (extraResources). This makes the installer
# self-contained — STT works on a fresh PC without a local whisper.cpp.
#
# Cross-platform (CI runs this under bash on every runner, Git Bash on Windows):
#   Linux   -> whisper-server / whisper-cli  + libwhisper.so* / libggml*.so
#   macOS   -> whisper-server / whisper-cli  + libwhisper*.dylib / libggml*.dylib
#   Windows -> whisper-server.exe / .exe     + whisper*.dll / ggml*.dll
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_BIN="${WHISPER_BIN_DIR:-$HOME/.local/bin}"
SRC_LIB="${WHISPER_LIB_DIR:-$HOME/.local/lib}"
OUT="$ROOT/build/whisper"

# Per-OS artifact naming. On Windows the DLLs typically sit next to the .exe, so
# libs are searched in both SRC_LIB and SRC_BIN below.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) EXE=".exe"; LIB_GLOBS=("whisper*.dll" "ggml*.dll") ;;
  Darwin)                          EXE="";     LIB_GLOBS=("libwhisper*.dylib" "libggml*.dylib") ;;
  *)                               EXE="";     LIB_GLOBS=("libwhisper.so*" "libggml*.so") ;;
esac

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib"

for b in whisper-server whisper-cli; do
  if [ ! -f "$SRC_BIN/$b$EXE" ]; then
    echo "Missing $SRC_BIN/$b$EXE — run scripts/build-whispercpp.sh first"; exit 1
  fi
  cp "$SRC_BIN/$b$EXE" "$OUT/bin/"
done

# Copy libs, preserving symlinks where present (Linux sonames like
# libwhisper.so.1 -> libwhisper.so.1.7.6; the glob also copies the real file).
copied_lib=0
for dir in "$SRC_LIB" "$SRC_BIN"; do
  [ -d "$dir" ] || continue
  for glob in "${LIB_GLOBS[@]}"; do
    for f in "$dir"/$glob; do
      [ -e "$f" ] || continue
      cp -P "$f" "$OUT/lib/" 2>/dev/null || cp "$f" "$OUT/lib/"
      copied_lib=1
    done
  done
done
[ "$copied_lib" -eq 1 ] || echo "warning: no whisper libs found in $SRC_LIB or $SRC_BIN"

echo "Staged whisper ($(uname -s)) -> $OUT"
ls "$OUT/bin" "$OUT/lib" || true
