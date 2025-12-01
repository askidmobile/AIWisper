#!/bin/bash

# AIWisper - запуск приложения

set -e

cd "$(dirname "$0")"

echo "=== Building Swift ScreenCaptureKit module ==="
cd backend/audio/screencapture
swift build -c release
cd ../../..

echo ""
echo "=== Building Go backend ==="
cd backend
go build -o aiwisper .
cd ..

echo ""
echo "=== Starting backend ==="
echo "NOTE: If this is the first run, you may need to grant Screen Recording permission"
echo "      Go to System Settings > Privacy & Security > Screen Recording"
echo ""

cd backend
./aiwisper -model ggml-base.bin &
BACKEND_PID=$!
cd ..

echo "Backend started (PID: $BACKEND_PID)"
echo ""

# Ждём пока backend запустится
sleep 2

echo "=== Starting frontend ==="
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo "Frontend started (PID: $FRONTEND_PID)"
echo ""
echo "=== AIWisper is running ==="
echo "Open http://localhost:5173 in your browser"
echo ""
echo "Press Ctrl+C to stop"

# Обработка Ctrl+C
trap "echo 'Stopping...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM

# Ждём
wait
