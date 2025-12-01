# AIWisper

AIWisper is a cross-platform desktop application for local speech recognition using `whisper.cpp` and Electron.

## Prerequisites

- **Go**: Version 1.18 or later.
- **Node.js**: Version 16 or later.
- **C/C++ Compiler**: GCC or Clang (required for CGO).
- **macOS** (Tested on Apple Silicon).

## Project Structure

- `backend/`: Go backend service.
  - `ai/binding/`: CGO bindings for `whisper.cpp` and `ggml`.
  - `audio/`: Audio capture logic using `malgo`.
  - `server/`: WebSocket server.
- `frontend/`: Electron + React frontend.
  - `electron/`: Electron main process.
  - `src/`: React UI.

## Setup

1.  **Clone the repository.**
2.  **Download the Whisper model:**
    The backend requires a GGML model file.
    ```bash
    cd backend
    # Download base model (or others)
    bash whisper.cpp/models/download-ggml-model.sh base
    # Move/Link to backend root if needed, or ensure the path is correct.
    # The app expects `ggml-base.bin` in `backend/` or `resources/` in prod.
    cp whisper.cpp/models/ggml-base.bin .
    ```
3.  **Install Frontend Dependencies:**
    ```bash
    cd frontend
    npm install
    ```

## Running in Development

1.  **Build the Backend:**
    The frontend spawns the backend binary. You must build it first.
    ```bash
    cd backend
    # Important: Enable CPU backend for Apple Silicon if not using Metal explicitly, 
    # though Metal is enabled by default in CGO flags for Darwin.
    # We added GGML_USE_CPU to ensure CPU fallback/registration works.
    go build -o ../backend_bin .
    ```
    This creates `backend_bin` in the project root.

2.  **Run the Frontend:**
    ```bash
    cd frontend
    npm run electron:dev
    ```
    This starts the Vite dev server and launches Electron.

## Building for Production

1.  **Build the Backend:**
    ```bash
    cd backend
    go build -o ../backend_bin .
    ```

2.  **Build the Frontend & Package:**
    ```bash
    cd frontend
    npm run build
    ```
    This uses `electron-builder` to package the application.
    *Note: You may need to configure `electron-builder.yml` or `package.json` to include `backend_bin` and `ggml-base.bin` in `extraResources`.*

## Troubleshooting

- **White Screen**: Ensure `backend_bin` is running. Check console logs (DevTools).
- **No Transcription**: Check "System Console" in the app. Ensure microphone permission is granted.
- **Backend Crash**: Check terminal logs. Ensure `ggml-base.bin` is present and compatible.
