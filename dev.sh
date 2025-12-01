#!/usr/bin/env bash
set -euo pipefail

# Build Go backend and start Electron dev env (Vite + Electron).
# Usage: ./dev.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Building Go backend"
export DYLD_LIBRARY_PATH="$ROOT_DIR/backend/whisper.cpp/build/src:$ROOT_DIR/backend/whisper.cpp/build/ggml/src:$ROOT_DIR/backend/whisper.cpp/build/ggml/src/ggml-metal:${DYLD_LIBRARY_PATH:-}"
export CGO_LDFLAGS="-rpath @executable_path/backend/whisper.cpp/build/src -rpath @executable_path/backend/whisper.cpp/build/ggml/src -rpath @executable_path/backend/whisper.cpp/build/ggml/src/ggml-metal"
(
  cd "$ROOT_DIR/backend/whisper.cpp"
  cmake -B build -DGGML_METAL=ON -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF
  cmake --build build -j
  cd "$ROOT_DIR/backend"
  export CGO_LDFLAGS_ALLOW=".*"
  go build -o "$ROOT_DIR/backend_bin"
  
  # Copy artifacts to root for runtime availability
  cp "$ROOT_DIR/backend/whisper.cpp/build/bin/ggml-metal.metal" "$ROOT_DIR/" || true
)

echo "==> Starting Electron dev (Vite + Electron)"
(
  cd "$ROOT_DIR/frontend"
  npm run electron:dev
)
