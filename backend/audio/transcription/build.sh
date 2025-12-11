#!/bin/bash
# Build script для transcription-fluid
# Собирает Swift CLI для транскрипции через FluidAudio

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building transcription-fluid..."
swift build -c release

BINARY_PATH=".build/release/transcription-fluid"
if [ -f "$BINARY_PATH" ]; then
    echo "✓ Build successful: $BINARY_PATH"
    echo "Binary size: $(du -h "$BINARY_PATH" | cut -f1)"
else
    echo "✗ Build failed: binary not found"
    exit 1
fi
