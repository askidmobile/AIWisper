#!/usr/bin/env bash
set -euo pipefail

# Build Swift modules for AIWisper
# Usage: ./scripts/build-swift.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_DIR="$ROOT_DIR/swift"
RESOURCES_DIR="$ROOT_DIR/rust/src-tauri/resources"

mkdir -p "$RESOURCES_DIR"

echo "==> Building Swift modules from $SWIFT_DIR"

# ScreenCaptureKit module (system audio capture)
echo "==> Building ScreenCaptureKit module..."
(
  cd "$SWIFT_DIR/screencapture"
  swift build -c release
)
cp "$SWIFT_DIR/screencapture/.build/release/screencapture-audio" "$RESOURCES_DIR/screencapture-audio"
echo "Built screencapture-audio -> $RESOURCES_DIR/screencapture-audio"

# CoreAudio tap module (macOS 14.2+)
echo "==> Building CoreAudio tap module..."
(
  cd "$SWIFT_DIR/coreaudio"
  swift build -c release
)
cp "$SWIFT_DIR/coreaudio/.build/release/coreaudio-tap" "$RESOURCES_DIR/coreaudio-tap"
echo "Built coreaudio-tap -> $RESOURCES_DIR/coreaudio-tap"

# FluidAudio diarization module
echo "==> Building FluidAudio diarization module..."
(
  cd "$SWIFT_DIR/diarization"
  swift build -c release
)
cp "$SWIFT_DIR/diarization/.build/release/diarization-fluid" "$RESOURCES_DIR/diarization-fluid"
echo "Built diarization-fluid -> $RESOURCES_DIR/diarization-fluid"

# FluidAudio transcription module
echo "==> Building FluidAudio transcription module..."
(
  cd "$SWIFT_DIR/transcription"
  swift build -c release
)
cp "$SWIFT_DIR/transcription/.build/release/transcription-fluid" "$RESOURCES_DIR/transcription-fluid"
echo "Built transcription-fluid -> $RESOURCES_DIR/transcription-fluid"

# FluidAudio streaming transcription module
echo "==> Building FluidAudio streaming transcription module..."
(
  cd "$SWIFT_DIR/transcription-stream"
  swift build -c release
)
cp "$SWIFT_DIR/transcription-stream/.build/release/transcription-fluid-stream" "$RESOURCES_DIR/transcription-fluid-stream"
echo "Built transcription-fluid-stream -> $RESOURCES_DIR/transcription-fluid-stream"

echo ""
echo "==> All Swift modules built successfully!"
echo "Resources directory: $RESOURCES_DIR"
ls -la "$RESOURCES_DIR"
