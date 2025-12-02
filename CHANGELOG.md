# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
