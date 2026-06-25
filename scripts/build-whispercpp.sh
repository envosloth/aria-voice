#!/usr/bin/env bash
set -euo pipefail

# Build whisper.cpp with Vulkan backend for AMD RDNA 4 GPU acceleration.
# This avoids ROCm entirely — uses Mesa RADV Vulkan driver instead.

WHISPER_VERSION="${WHISPER_VERSION:-v1.7.6}"
BUILD_DIR="${BUILD_DIR:-/tmp/whisper-build}"
INSTALL_PREFIX="${INSTALL_PREFIX:-$HOME/.local}"

echo "=== Building whisper.cpp ${WHISPER_VERSION} with Vulkan backend ==="

# Check dependencies
for cmd in cmake g++ git vulkaninfo; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Missing: $cmd"
    exit 1
  fi
done

# Verify Vulkan is available
if ! vulkaninfo --summary 2>/dev/null | grep -qi "vulkan"; then
  echo "ERROR: Vulkan not detected. Ensure Mesa RADV drivers are installed."
  echo "  sudo apt install mesa-vulkan-drivers libvulkan-dev"
  exit 1
fi

echo "Vulkan detected:"
vulkaninfo --summary 2>/dev/null | grep -E "(GPU|driver|apiVersion)" | head -5

# Clone and build
rm -rf "$BUILD_DIR"
git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggerganov/whisper.cpp.git "$BUILD_DIR"

cd "$BUILD_DIR"
cmake -B build \
  -DGGML_VULKAN=1 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$INSTALL_PREFIX"

cmake --build build --config Release -j "$(nproc)"
cmake --install build

echo
echo "=== Installed whisper-cli to $INSTALL_PREFIX/bin/whisper-cli ==="

# Verify GPU detection
if "$INSTALL_PREFIX/bin/whisper-cli" --help 2>&1 | grep -q "\-\-gpu"; then
  echo "GPU flag available — Vulkan backend compiled successfully."
else
  echo "WARNING: --gpu flag not found. The binary may be CPU-only."
  echo "Check that libvulkan-dev and vulkan-validationlayers-dev are installed."
fi

rm -rf "$BUILD_DIR"
