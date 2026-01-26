# AGENTS

## Активная разработка

- **Основной код**: `rust/` — Tauri приложение (backend + UI)
  - `rust/src-tauri/` — Rust backend
  - `rust/ui/` — React/TypeScript UI
  - `rust/crates/` — внутренние крейты (aiwisper-audio, aiwisper-ml, aiwisper-types)

- **Swift модули**: `swift/` — нативные macOS модули
  - `swift/screencapture/` — захват системного аудио через ScreenCaptureKit
  - `swift/coreaudio/` — CoreAudio Process Tap (macOS 14.2+)
  - `swift/diarization/` — диаризация через FluidAudio
  - `swift/transcription/` — транскрипция через FluidAudio/Parakeet

## Deprecated (не изменять без явного запроса)

- `backend/` — Go backend (deprecated, миграция на Rust завершена)
- `frontend/` — Electron UI (deprecated, заменён на Tauri)

## Скрипты

- `scripts/build-tauri.sh` — сборка Tauri приложения
- `scripts/build-swift.sh` — сборка Swift модулей
