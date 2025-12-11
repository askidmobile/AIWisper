#!/usr/bin/env bash
set -euo pipefail

# Build Go backend into build/resources and also refresh backend_bin for dev runs.
# Uses AIWISPER_GOARCH (optional) or host arch; normalizes x64/x86_64 to amd64.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ARCH="${AIWISPER_GOARCH:-$(uname -m)}"
case "$ARCH" in
  x86_64|x64) ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
esac

mkdir -p "$ROOT_DIR/build/resources"

echo "==> Building aiwisper-backend (GOARCH=$ARCH)"
(
  cd "$ROOT_DIR/backend"
  GOOS=darwin GOARCH="$ARCH" go build -o "$ROOT_DIR/build/resources/aiwisper-backend"
)

# Keep dev binary in sync
cp "$ROOT_DIR/build/resources/aiwisper-backend" "$ROOT_DIR/backend_bin"

echo "Built backend -> build/resources/aiwisper-backend and backend_bin"

# Build Swift modules
echo "==> Building ScreenCaptureKit module (Swift)"
(
  cd "$ROOT_DIR/backend/audio/screencapture"
  swift build -c release
)
cp "$ROOT_DIR/backend/audio/screencapture/.build/release/screencapture-audio" "$ROOT_DIR/build/resources/screencapture-audio"
echo "Built screencapture-audio -> build/resources/screencapture-audio"

echo "==> Building CoreAudio tap module (Swift, macOS 14.2+)"
(
  cd "$ROOT_DIR/backend/audio/coreaudio"
  swift build -c release
)
cp "$ROOT_DIR/backend/audio/coreaudio/.build/release/coreaudio-tap" "$ROOT_DIR/build/resources/coreaudio-tap"
echo "Built coreaudio-tap -> build/resources/coreaudio-tap"

echo "==> Building FluidAudio diarization module (Swift)"
(
  cd "$ROOT_DIR/backend/audio/diarization"
  swift build -c release
)
cp "$ROOT_DIR/backend/audio/diarization/.build/release/diarization-fluid" "$ROOT_DIR/build/resources/diarization-fluid"
echo "Built diarization-fluid -> build/resources/diarization-fluid"

echo "==> Building FluidAudio transcription module (Swift)"
(
  cd "$ROOT_DIR/backend/audio/transcription"
  swift build -c release
)
cp "$ROOT_DIR/backend/audio/transcription/.build/release/transcription-fluid" "$ROOT_DIR/build/resources/transcription-fluid"
echo "Built transcription-fluid -> build/resources/transcription-fluid"

echo "==> Building FluidAudio streaming transcription module (Swift)"
(
  cd "$ROOT_DIR/backend/audio/transcription-stream"
  swift build -c release
)
cp "$ROOT_DIR/backend/audio/transcription-stream/.build/release/transcription-fluid-stream" "$ROOT_DIR/build/resources/transcription-fluid-stream"
echo "Built transcription-fluid-stream -> build/resources/transcription-fluid-stream"
