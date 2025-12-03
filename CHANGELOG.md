# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.6] - 2024-12-03

### Changed
- **Chunk-Based Full Retranscription**: Full retranscription now uses existing chunks instead of arbitrary 20-minute segments
  - Chunks are already cut at natural speech boundaries during recording
  - This preserves context and improves transcription quality
  - Fallback to 20-minute segments for old sessions without chunk boundaries

- **Unified VAD for Stereo Channels**: Both mic and sys channels now use the same speech region map
  - Solves timestamp desynchronization between speakers
  - Uses `CreateUnifiedSpeechRegions()` which mixes channels via max(abs) amplitude
  - Both channels are mapped to the same timeline for accurate dialogue ordering

### Technical
- `main.go`: Refactored `retranscribe_full` handler
  - Added `ProcessingSegment` struct to unify chunk and fallback segment handling
  - Checks for valid `StartMs`/`EndMs` in existing chunks
  - Uses `session.CreateUnifiedSpeechRegions()` instead of separate VAD per channel
  - Adds chunk offset to final timestamps for correct global positioning
- `session/vad.go`: `CreateUnifiedSpeechRegions()` already implemented in v1.5.5

## [1.5.1] - 2024-12-03

### Added
- **Chunked Transcription for Long Files**: Audio files are now split into 20-minute segments for reliable transcription
  - Solves the issue where files >25 minutes were not transcribed at all
  - Each segment is processed independently with proper timestamp offsetting
  - Progress indicator shows current segment (e.g., "Segment 2/3")
  - Works for both stereo and mono modes

### Technical
- `main.go`: Added `maxSegmentDurationMs` constant (20 minutes)
- Stereo mode: Loops through segments, extracts audio, runs VAD, transcribes, and merges results
- Mono mode: Same segmentation approach for consistency
- Timestamps are correctly offset by segment start time

## [1.5.0] - 2024-12-03

### Added
- **High-Quality Transcription Mode**: New `TranscribeHighQuality()` method for full file retranscription
  - Optimized Whisper parameters: beam_size=5, temperature=0.0, entropy threshold=2.4
  - MaxTokensPerSegment increased to 256 for longer sentences
  - MaxContext=0 to prevent hallucination loops
  - Used automatically for full file retranscription

- **AI-Powered Transcription Improvement**: Post-processing with LLM via Ollama
  - New "Improve with AI" button (purple layers icon) in session header
  - Fixes recognition errors, punctuation, and capitalization
  - Uses configured Ollama model (same as summary generation)
  - New WebSocket messages: `improve_transcription`, `improve_started`, `improve_completed`, `improve_error`
  - New backend functions: `improveTranscriptionWithLLM()`, `parseImprovedDialogue()`, `UpdateImprovedDialogue()`

### Changed
- **Enhanced Logging**: Added detailed logging for full transcription process
  - Logs converted segments with word counts
  - Logs chunk data before sending to frontend
  - Better error handling with specific error messages

### Technical
- `ai/whisper.go`: New `TranscribeHighQuality()` method with optimized parameters
- `main.go`: 
  - Full retranscription now uses high-quality mode
  - Added `improve_transcription` WebSocket handler
  - Added `improveTranscriptionWithLLM()` and `parseImprovedDialogue()` functions
- `session/manager.go`: Added `UpdateImprovedDialogue()` method
- `frontend/src/App.tsx`:
  - New state: `isImproving`, `improveError`
  - New handler: `handleImproveTranscription()`
  - New UI: AI improvement button and progress indicator

## [1.3.1] - 2024-12-03

### Fixed
- **VAD Mapping for Word Timestamps**: Applied VAD time mapping to word-level timestamps
  - **Problem**: Word timestamps were not being mapped through VAD regions, causing incorrect chronology
  - **Solution**: Added `MapWhisperTimeToRealTime()` function and applied it to all words in all transcription paths
  - Now words have correct real-time timestamps that account for pauses in audio

### Technical
- `session/vad.go`: Added `MapWhisperTimeToRealTime()` for single timestamp mapping
- `main.go`: Updated all 6 VAD mapping locations to also map word timestamps

## [1.3.0] - 2024-12-03

### Added
- **Word-Level Timestamps**: Implemented precise word-level timestamps using whisper.cpp token timestamps
  - Each word now has its own start/end time, not just segments
  - Enables accurate dialogue chronology even when Whisper merges multiple phrases into one segment
  - New `TranscriptWord` structure with `Start`, `End`, `Text`, `P` (confidence), `Speaker`

### Changed
- **Improved Dialogue Merging**: New `mergeWordsToDialogue()` function creates dialogue from word-level data
  - Words from both channels (mic/sys) are sorted by timestamp
  - Consecutive words from same speaker are grouped into phrases
  - Phrases are split on speaker change OR pause > 1 second
  - Falls back to segment-level merging if word data unavailable

### Technical
- `ai/whisper.go`: Added `TranscriptWord` struct and `extractWordsFromTokens()` function
- `session/types.go`: Added `TranscriptWord` struct and `Words` field to `TranscriptSegment`
- `session/manager.go`: New `mergeWordsToDialogue()` for word-level dialogue creation
- `main.go`: Updated `convertSegmentsWithGlobalOffset()` to include word timestamps

## [1.2.5] - 2024-12-03

### Fixed
- **Complete Timestamp Synchronization Fix**: Implemented multi-region VAD mapping for accurate timestamps
  - **Problem**: Whisper "compresses" silence - returns timestamps relative to speech, not audio. Multiple speech regions with pauses caused wrong timestamps for all segments after first pause
  - **Solution**: New `DetectSpeechRegions()` finds ALL speech regions, `MapWhisperSegmentsToRealTime()` maps Whisper's compressed timestamps to real audio time
  - Applied to all three transcription paths: WAV, MP3 fallback, and re-transcription

### Technical
- New VAD functions in `session/vad.go`:
  - `SpeechRegion` struct with StartMs/EndMs
  - `DetectSpeechRegions()` - finds all speech regions (20ms window, 300ms silence to end region, 100ms minimum)
  - `MapWhisperSegmentsToRealTime()` - distributes Whisper segments across detected speech regions
- Replaced simple `DetectSpeechStart()` with multi-region approach in retranscribe handler

## [1.2.4] - 2024-12-03

### Fixed
- **Sys Channel Timestamp Correction**: Fixed timestamps for sys (Собеседник) channel
  - **Problem**: VAD offset was only applied when `Whisper.Start == 0`, but Whisper often returns `Start > 0` even with silence at the beginning
  - **Solution**: Compare VAD speech start with Whisper's first segment start, adjust if Whisper started earlier than VAD detected speech
  - Now both mic and sys channels use the same improved logic
  - Example: VAD detects speech at 8000ms, Whisper returns Start=1600ms → adjust by +6400ms

### Technical
- Changed condition from `Whisper.Start == 0` to `Whisper.Start < VAD.Start`
- Applied fix to all three transcription paths: WAV, MP3 fallback, and re-transcription
- Added detailed logging: `VAD=Xms, Whisper=Yms, adjusting by +Zms`

## [1.2.3] - 2024-12-03

### Fixed
- **Re-transcription VAD Offset**: Applied VAD offset fix to re-transcription path

## [1.2.2] - 2024-12-03

### Fixed
- **Smart VAD Offset for Silent Starts**: Fixed timestamps when channel starts with silence
  - **Problem**: Whisper returns `Start=0ms` even when speech starts later in the audio
  - **Solution**: Use VAD to find real speech start, but only when Whisper returns `Start=0ms`

### Changed
- **Removed Large V3 Russian model** from registry (inconsistent quality)
- **Large V3 now recommended** alongside Turbo (best quality for complex dialogues)

## [1.2.1] - 2024-12-03

### Fixed
- **Double Timestamp Offset Bug**: Removed unconditional `DetectSpeechStart` usage
  - Was causing double-counting of offsets in some cases

## [1.2.0] - 2024-12-03

### Fixed
- **Timestamp Synchronization**: Added global chunk offset to segment timestamps
  - New function `convertSegmentsWithGlobalOffset()` ensures consistent timestamp handling
  - Affects: initial transcription, MP3 fallback extraction, and re-transcription

### Technical
- Added `convertSegmentsWithGlobalOffset()` function in `backend/main.go`
- Updated all three transcription paths to use global offset

## [1.1.0] - 2024-12-02

### Changed
- **BREAKING: Removed Python Dependencies**: Application is now fully self-contained
  - Removed `faster-whisper` Python backend
  - Removed `faster_whisper_server.py` and `faster_whisper_cli.py`
  - All models now use GGML format with whisper.cpp (Metal GPU acceleration)
  - No Python installation required

### Added
- **GGML Russian Model**: Added `ggml-large-v3-russian` model
  - Source: `Limtech/whisper-large-v3-russian-ggml` on HuggingFace
  - Size: 2.9 GB
  - WER: 6.4% (same quality as faster-whisper version)
  - Uses Metal GPU on Apple Silicon for fast inference

### Removed
- `ModelTypeFasterWhisper` - all models are now GGML
- `RequiresPython` and `HuggingFaceRepo` fields from model registry
- `DownloadHuggingFaceModel` function (no longer needed)
- Python status callbacks in main.go

### Technical
- Simplified `backend/models/manager.go` - removed faster-whisper logic
- Simplified `backend/models/downloader.go` - removed HuggingFace multi-file download
- Simplified `backend/ai/whisper.go` - single unified engine
- Updated `scripts/build-macos.sh` - removed Python file copying

## [1.0.15] - 2024-12-02

### Added
- **Persistent Faster-Whisper Server**: Model stays loaded in memory
  - New `faster_whisper_server.py` - long-running Python process
  - Model loaded once, reused for all transcriptions
  - ~10x faster for subsequent transcriptions (no model reload)
  - JSON protocol over stdin/stdout for communication
  - Automatic fallback to CLI mode if server fails

### Improved
- **Unified Segment Format**: Faster-whisper now returns segments with timestamps
  - Same format as Go whisper.cpp binding
  - Proper `start`/`end` timestamps in milliseconds
  - Better dialogue reconstruction with timing info
  - Consistent behavior between GGML and faster-whisper models

## [1.0.14] - 2024-12-02

### Fixed
- **Re-transcription Error Display**: Error message now clears when starting new re-transcription
  - UI immediately shows "transcribing" status and clears previous error/text
  
### Improved
- **Transcription Queue**: Added sequential processing for re-transcription requests
  - Only one transcription runs at a time (prevents GPU/CPU overload)
  - Stereo channels now processed sequentially instead of parallel
  - Queue with semaphore ensures predictable resource usage
  
- **Faster-Whisper Speed Optimization**: Significantly faster transcription
  - Changed `beam_size` from 5 to 1 (greedy decoding)
  - Changed `best_of` from 5 to 1 (single pass)
  - Disabled `word_timestamps` (not needed for basic transcription)
  - Large-v3-russian model now ~3-5x faster

## [1.0.13] - 2024-12-02

### Fixed
- **Faster-Whisper VAD Error (Complete Fix)**: Fixed `window_size_samples` error in all code paths
  - Removed from `faster_whisper_cli.py` (external script)
  - Removed from inline Python script in `whisper.go` (Go backend)
  - Large-v3-russian model now works correctly for both initial and re-transcription

## [1.0.12] - 2024-12-02

### Fixed
- **Faster-Whisper VAD Error**: Fixed `VadOptions.__init__() got an unexpected keyword argument 'window_size_samples'`
  - Removed unsupported `window_size_samples` parameter from Silero VAD configuration
  - Re-transcription now works correctly with newer faster-whisper versions

## [1.0.11] - 2024-12-02

### Fixed
- **Summary Generation**: Fixed truncated responses from Ollama/Gemini models
  - Increased `num_predict` from 1500 to 4096 tokens for complete summaries
  - Increased HTTP timeout from 2 to 3 minutes for large models
  - Added detailed logging for debugging (response status, content length, done_reason)

## [1.0.10] - 2024-12-02

### Added
- **Summary Export**: New export functionality for generated summaries
  - Copy to clipboard button with visual feedback ("✓ Скопировано")
  - Download as Markdown file (.md) with auto-generated filename
  - Dropdown menu with export options

## [1.0.9] - 2024-12-02

### Added
- **Collapsible Console**: Console panel now collapses to save screen space
  - Click header to expand/collapse
  - Shows last message preview when collapsed
  - Displays entry count
  - Smooth animation transition

### Fixed
- **Audio Buffer Cleanup**: Clear audio buffers when starting new recording
  - Prevents old audio data from leaking into new sessions
  - New `ClearBuffers()` method in audio capture

### Improved
- **Visual Design Overhaul**: Modern UI with enhanced aesthetics
  - New color palette with CSS variables
  - Gradient buttons and text effects
  - Smooth animations (fadeIn, slideIn, pulse, glow)
  - Styled scrollbars
  - Recording button pulse animation
  - Gradient audio level indicators
  - Improved dialogue segment styling

## [1.0.8] - 2024-12-02

### Added
- **Ollama Model Selector**: Dropdown for selecting Ollama models
  - Fetches available models from Ollama API
  - Cloud models (☁️) listed first, local models (💻) after
  - Shows parameter size (3.2B, 8B, etc.)
  - Refresh button to reload model list

### Improved
- **Summary Generation**: Better structured output
  - Switched from `/api/generate` to `/api/chat` endpoint
  - New system prompt for Markdown-formatted summaries
  - Sections: Тема встречи, Ключевые моменты, Решения, Следующие шаги
  - Added `react-markdown` for rendering

### UI Improvements
- Draggable window header for native macOS feel
- Gradient styling for app title
- Improved record button with shadow effects
- Hide Summary tab during recording
- Auto-open recorded session after stopping
- Better fallback dialogue display with speaker labels

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
