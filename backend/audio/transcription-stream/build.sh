#!/bin/bash
set -e

echo "Building transcription-fluid-stream..."

# Определяем директорию скрипта
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Сборка в release режиме
swift build -c release

# Копируем бинарник в удобное место
BUILD_DIR="$SCRIPT_DIR/.build/release"
if [ -f "$BUILD_DIR/transcription-fluid-stream" ]; then
    cp "$BUILD_DIR/transcription-fluid-stream" "$SCRIPT_DIR/"
    echo "✅ Binary copied to $SCRIPT_DIR/transcription-fluid-stream"
    ls -lh "$SCRIPT_DIR/transcription-fluid-stream"
else
    echo "❌ Build failed: binary not found"
    exit 1
fi

echo "✅ Build completed successfully"
