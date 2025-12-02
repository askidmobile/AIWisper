# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.7] - 2024-12-02

### Added
- **Model Manager**: New UI for managing Whisper models
  - Browse available models (GGML and Faster-Whisper)
  - Download models on-demand with progress tracking
  - Switch between downloaded models
  - Delete unused models to free space
  - Filter by type: All / Downloaded / GGML / Faster-Whisper
  - Recommended models highlighted: `ggml-large-v3-turbo` and `faster-large-v3-russian`
- **Settings Persistence**: User preferences now saved between app restarts
  - Language selection (Russian/English/Auto)
  - Active model selection
  - Echo cancellation level
  - Voice Isolation toggle
  - System audio capture toggle
- **Russian Language Model Support**: Added `antony66/whisper-large-v3-russian` (WER 6.4%)
  - Best quality for Russian language recognition
  - Auto-downloaded by faster-whisper on first use

### Changed
- Models are no longer bundled - downloaded on-demand to reduce app size
- Model selection moved from dropdown to dedicated Model Manager modal
- Improved startup: app works without pre-downloaded model

### Technical
- New backend package `models/` with registry, manager, and downloader
- WebSocket handlers: `get_models`, `download_model`, `cancel_download`, `delete_model`, `set_active_model`
- Electron IPC: `save-settings`, `load-settings` using `electron-store`
- Direct HTTP download from HuggingFace for CTranslate2 models
- HuggingFace ID support for transformers models (auto-converted by faster-whisper)

## [1.0.6] - 2024-12-02

### Improved
- **Whisper Turbo Quality Optimization**: Significant improvements to speech recognition quality
  - Added `temperature=0.0` for deterministic output (reduces hallucinations)
  - Added `condition_on_previous_text=False` to prevent looping and error accumulation
  - Added `hallucination_silence_threshold=2.0` to filter out phantom speech on silence
  - Added `no_speech_threshold=0.5` for better silence detection
  - Optimized Silero VAD parameters for better speech detection:
    - `threshold=0.5` for speech detection
    - `min_speech_duration_ms=250` minimum speech duration
    - `min_silence_duration_ms=2000` for segment separation
    - `speech_pad_ms=400` padding around speech
  - Enabled `word_timestamps=True` for hallucination detection
- **Go binding optimization**: Updated whisper.cpp parameters
  - Temperature: 0.1 -> 0.0 (deterministic)
  - Temperature fallback: 0.3 -> 0.2 (less variability)
  - Added `MaxContext=-1` to disable context (prevents looping)

### Technical Details
- These changes apply to both `faster-whisper` (Python CLI) and native `whisper.cpp` (Go binding)
- Silero VAD in faster-whisper works alongside the existing Go-based VAD for chunk splitting
- No API changes - improvements are transparent to end users

## [1.0.5] - 2024-XX-XX

### Added
- Session list API support
- IPC for opening recordings folder
- Improved stereo transcription handling

## [1.0.1] - 2024-XX-XX

### Fixed
- Chunk playback - now plays only selected chunk
- Dialog order (You/Interlocutor) via Voice Activity Detection
- Added milliseconds to timestamps for accurate sorting

### Improved
- UX: Clear selected session when starting new recording
- Auto-update via electron-updater

## [1.0.0] - 2024-XX-XX

### Added
- Initial release
- Real-time speech recognition using whisper.cpp
- Support for microphone and system audio capture
- Voice Isolation mode (macOS 15+)
- Session recording with MP3 compression
- Chunk-based transcription with timestamps
- Electron desktop application
