#!/usr/bin/env bash
# Stage the whisper.cpp binaries + shared libs into build/whisper/{bin,lib} so
# electron-builder can bundle them (extraResources). This makes the .deb/.AppImage
# self-contained — STT works on a fresh Ubuntu PC without a local whisper.cpp.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_BIN="${WHISPER_BIN_DIR:-$HOME/.local/bin}"
SRC_LIB="${WHISPER_LIB_DIR:-$HOME/.local/lib}"
OUT="$ROOT/build/whisper"

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib"

for b in whisper-server whisper-cli; do
  if [ ! -x "$SRC_BIN/$b" ]; then
    echo "Missing $SRC_BIN/$b — run scripts/build-whispercpp.sh first"; exit 1
  fi
  cp "$SRC_BIN/$b" "$OUT/bin/"
done

# Copy libs, dereferencing symlinks but preserving the soname filenames the
# binaries actually dlopen (libwhisper.so.1, libggml*.so, ...).
for f in "$SRC_LIB"/libwhisper.so* "$SRC_LIB"/libggml*.so; do
  [ -e "$f" ] || continue
  cp -P "$f" "$OUT/lib/"          # keep symlinks as-is
done
# Also materialize the real file behind libwhisper.so.1 in case the symlink chain
# points outside the bundle.
if [ -e "$SRC_LIB/libwhisper.so.1.7.6" ]; then
  cp "$SRC_LIB/libwhisper.so.1.7.6" "$OUT/lib/"
fi

echo "Staged whisper -> $OUT"
du -sh "$OUT"
ls "$OUT/bin" "$OUT/lib"
