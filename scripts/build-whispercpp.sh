#!/usr/bin/env bash
set -euo pipefail

# Build whisper.cpp for ARIA's STT, selecting the backend per OS:
#   Linux   -> Vulkan (Mesa RADV; no ROCm) — the AMD RDNA 4 target
#   Windows -> Vulkan if the SDK is present, else CPU
#   macOS   -> Metal
# CI runs this on each native runner (see .github/workflows/release.yml). The
# non-Linux paths cannot be verified from the Linux dev box — confirm via CI.

WHISPER_VERSION="${WHISPER_VERSION:-v1.7.6}"
BUILD_DIR="${BUILD_DIR:-${TMPDIR:-/tmp}/whisper-build}"
INSTALL_PREFIX="${INSTALL_PREFIX:-$HOME/.local}"

OS="$(uname -s)"

# Portable core count for `-j`.
jobs() {
  if command -v nproc >/dev/null 2>&1; then nproc
  elif command -v sysctl >/dev/null 2>&1; then sysctl -n hw.ncpu
  else echo "${NUMBER_OF_PROCESSORS:-4}"; fi
}

CMAKE_BACKEND=()
REQUIRED=(cmake git)
NEED_VULKAN_CHECK=0
case "$OS" in
  Darwin)
    echo "=== Building whisper.cpp ${WHISPER_VERSION} (Metal backend) ==="
    CMAKE_BACKEND=(-DGGML_METAL=1)
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    if command -v vulkaninfo >/dev/null 2>&1 && vulkaninfo --summary >/dev/null 2>&1; then
      echo "=== Building whisper.cpp ${WHISPER_VERSION} (Vulkan backend) ==="
      CMAKE_BACKEND=(-DGGML_VULKAN=1)
    else
      echo "=== Building whisper.cpp ${WHISPER_VERSION} (CPU backend; no Vulkan SDK) ==="
    fi
    ;;
  *)  # Linux — Vulkan, the primary target (unchanged).
    echo "=== Building whisper.cpp ${WHISPER_VERSION} with Vulkan backend ==="
    CMAKE_BACKEND=(-DGGML_VULKAN=1)
    REQUIRED=(cmake g++ git vulkaninfo glslc)
    NEED_VULKAN_CHECK=1
    ;;
esac

# Check dependencies
for cmd in "${REQUIRED[@]}"; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Missing: $cmd"
    exit 1
  fi
done

# Linux: the whole point is GPU STT, so require a working Vulkan loader/driver.
if [ "$NEED_VULKAN_CHECK" -eq 1 ]; then
  if ! vulkaninfo --summary 2>/dev/null | grep -qi "vulkan"; then
    echo "ERROR: Vulkan not detected. Ensure Mesa RADV drivers are installed."
    echo "  sudo apt install mesa-vulkan-drivers libvulkan-dev"
    exit 1
  fi
  echo "Vulkan detected:"
  vulkaninfo --summary 2>/dev/null | grep -E "(GPU|driver|apiVersion)" | head -5
fi

# Clone and build
rm -rf "$BUILD_DIR"
git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggerganov/whisper.cpp.git "$BUILD_DIR"

cd "$BUILD_DIR"
cmake -B build \
  "${CMAKE_BACKEND[@]}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$INSTALL_PREFIX"

cmake --build build --config Release -j "$(jobs)"
cmake --install build

echo
echo "=== Installed whisper.cpp ($OS) to $INSTALL_PREFIX ==="
rm -rf "$BUILD_DIR"
