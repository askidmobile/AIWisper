# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.35.0] - 2025-12-12

### Added
- **Voting System for Hybrid Transcription**: Intelligent word selection using 4-criteria voting
  - **Problem**: GigaAM model inflates confidence scores (~25% higher), causing wrong word selection (e.g., "джинезис" instead of "Genesis")
  - **Solution**: 4-criteria voting system where model with 2+ votes wins:
    - **A. Calibrated Confidence**: GigaAM × 0.75, Whisper/Parakeet × 1.0 (based on NVIDIA research)
    - **B. Latin Detection**: Prefer model that recognized Latin characters for foreign terms
    - **C. Hotwords**: Match against user's terminology dictionary with fuzzy matching (Levenshtein distance ≤2)
    - **D. Grammar Check**: Validate against embedded dictionaries (~2600 words)
  - Tie-breaker: primary model wins
  - Integrated into `mergeWordsByTime()` function in parallel mode

- **Grammar Checker**: Embedded dictionary-based word validation
  - `SimpleGrammarChecker` with Russian (~1100 words) and English (~1500 words) dictionaries
  - Auto-detection of language based on character set (Cyrillic vs Latin)
  - Runtime word addition via `AddWord()` / `AddWords()`
  - Embedded using Go's `embed.FS` for zero external dependencies

- **Hotwords Support**: User-defined terminology for better recognition
  - Fuzzy matching with Levenshtein distance threshold
  - Case-insensitive comparison
  - Configurable via `HybridTranscriptionConfig.Hotwords`

- **Confidence Calibration**: Model-specific confidence scaling
  - `DefaultCalibrations` with regex patterns for model identification
  - GigaAM: 0.75 factor (compensates for CTC loss overconfidence)
  - Whisper/Parakeet/Fluid: 1.0 factor (well-calibrated)

### Technical
- `backend/ai/hybrid_transcription.go`:
  - Added `VotingConfig`, `VoteResult`, `VoteDetails` types
  - Added `voteForBestWord()`, `calibrateConfidence()`, `containsLatin()`, `matchesHotword()` functions
  - Integrated voting into `mergeWordsByTime()` for parallel mode
- `backend/ai/grammar_checker.go`: New file with `SimpleGrammarChecker` implementation
- `backend/ai/voting_test.go`: Unit tests for voting system (all passing)
- `backend/ai/dictionaries/english_words.txt`: ~1500 common English words
- `backend/ai/dictionaries/russian_words.txt`: ~1100 common Russian words
- `docs/plan_voting_hybrid_merge_2025-12-12.md`: Implementation plan

## [1.32.0] - 2025-12-12

### Added
- **Speaker Embedding API**: Access speaker voice embeddings from Pipeline
  - `GetSpeakerEmbedding()` - get embedding by speaker ID
  - `GetAllSpeakerProfiles()` - get all speaker profiles
  - `GetSpeakerCount()` - count registered speakers
  - `ResetSpeakerProfiles()` - clear speaker profiles for new session
  - Enables VoicePrint feature for speaker identification

- **Whisper Token Data**: Full token information in transcription segments
  - `Segments()` now includes token data with timestamps and confidence
  - `Tokens()` method returns all tokens from all segments
  - Enables word-level timestamp analysis

- **Mono Transcription with Timestamps**: Proper segment distribution
  - New `UpdateFullTranscriptionMonoWithSegments()` function
  - Distributes segments to chunks based on timestamps
  - Fixes mono transcription chunk assignment

### Fixed
- **Import Cycle in Tests**: Resolved circular dependency between `ai` and `session` packages
  - Removed `session` import from `silero_vad_test.go`
  - Added `integration` build tag to regression tests
  - Run integration tests with: `go test -tags=integration`

### Technical
- `backend/ai/pipeline.go`: Added speaker profile access methods
- `backend/ai/binding/context.go`: Use `toSegment()` for token data
- `backend/session/manager.go`: Added `UpdateFullTranscriptionMonoWithSegments()`
- `backend/ai/silero_vad_test.go`: Synthetic-only tests (no external dependencies)
- `backend/ai/transcription_regression_test.go`: Added `integration` build tag

## [1.31.0] - 2025-12-12

### Added
- **Silero VAD Integration**: Neural network-based Voice Activity Detection
  - Silero VAD v5 model (~2MB) with 97% ROC-AUC accuracy
  - Significantly better than energy-based VAD in noisy environments
  - Auto-download model on first use from GitHub
  - Global cached instance for efficient reuse

- **VAD Method Selector in Settings**: Choose voice detection algorithm
  - **Auto** (default): Uses Silero if available, falls back to Energy
  - **Silero VAD**: Neural network detector (more accurate, requires model)
  - **Energy-based**: Fast traditional detector (less accurate in noise)
  - Setting persists across app restarts

### Technical
- `backend/ai/silero_vad.go`: Silero VAD v5 engine with ONNX Runtime
- `backend/ai/silero_vad_test.go`: Unit tests with synthetic and real audio
- `backend/session/silero_vad_wrapper.go`: Session integration with caching
- `backend/session/types.go`: Added `VADMethod` type (energy/silero/auto)
- `backend/internal/api/types.go`: Added `vadMethod` to Message
- `backend/internal/service/transcription.go`: `SetVADMethod()`, `getEffectiveVADMethod()`
- `backend/models/registry.go`: Registered `silero-vad-v5` model
- `frontend/src/types/models.ts`: Added `VADMethod` type to AppSettings
- `frontend/src/components/SettingsModal.tsx`: VAD method dropdown
- `frontend/src/App.tsx`: `vadMethod` state with persistence

### Fixed
- Silero VAD context handling: Added 64-sample context buffer for correct model input
- VAD probabilities now correctly range 0.0-1.0 (was 0.001-0.003 due to missing context)

## [1.30.0] - 2025-12-12

### Added
- **Batch Export**: Export multiple sessions at once to ZIP archive
  - Multi-select sessions with `⌘+Click` (Mac) or `Ctrl+Click` (Windows/Linux)
  - Visual indicator for selected sessions (purple highlight + checkmark)
  - Batch export panel showing selection count
  - Modal dialog for format selection (TXT, SRT, VTT, JSON, Markdown)
  - Backend endpoint `/api/export/batch` for ZIP generation

### Technical
- `backend/internal/api/server.go`: Add batch export endpoint with format converters
- `frontend/src/App.tsx`: Add multi-select state, BatchExportModal component
- `frontend/src/index.css`: Add `.multi-selected` styles for session items

## [1.29.0] - 2025-12-12

### Added
- **Session Statistics**: Detailed metrics for each recording session
  - Total words, segments, speakers count
  - Words per minute, average segment length
  - Speaker activity breakdown with visual progress bars
  - Recognition quality metrics (average confidence, low confidence word count)
  - Compact stats in dialogue header, full stats in dedicated tab

- **Extended Keyboard Shortcuts**: Enhanced navigation and productivity
  - `↑`/`↓`: Navigate between sessions
  - `⌘+1-9`: Quick access to session by number
  - `⌘+F`: Focus on search input
  - `?`: Show keyboard shortcuts help modal
  - Help modal with categorized shortcuts and visual key representation

### Technical
- `frontend/src/components/modules/SessionStats.tsx`: New statistics component
- `frontend/src/components/SessionTabs.tsx`: Added 'stats' tab type
- `frontend/src/App.tsx`: Extended keyboard handler with navigation and help modal

## [1.28.0] - 2025-12-12

### Added
- **Hybrid Transcription (Dual-Model)**: Two-pass transcription combining strengths of multiple ASR models
  - **Problem**: GigaAM v3 is SOTA for Russian (WER 8.4%) but struggles with foreign terminology (API, B2C, UMS)
  - **Solution**: Primary model transcribes everything, finds low-confidence words, secondary model (e.g., Whisper) retranscribes problem regions, LLM selects best variant
  - **Backend**: `HybridTranscriber` with confidence-based region detection, `CreateEngineForModel()` for secondary model, `SelectBestTranscription()` LLM method
  - **Frontend**: Full settings UI with model selection, confidence threshold slider, LLM toggle
  - **Settings persist** in localStorage/electron-store

- **Confidence Visualization**: Visual highlighting of low-confidence words in transcription
  - **Toggle button** "🎯 Confidence" in dialogue header
  - **Color coding**: Yellow (<70%), Orange with underline (<40%)
  - **Tooltip** shows exact confidence percentage on hover

- **HelpTooltip Component**: Reusable contextual help component
  - Click-to-open popover with detailed information
  - Supports positioning (top/bottom/left/right)
  - Used in Hybrid Transcription settings

- **GigaAM RNNT Models**: Support for RNN-T architecture models
  - `gigaam-v3-rnnt` - Best quality (WER 8.4%)
  - `gigaam-v3-e2e-rnnt` - Best quality + punctuation (WER 11.2%)
  - Three-file structure: encoder, decoder, joint network

### Technical
- `backend/ai/hybrid_transcription.go`: Full hybrid transcription logic (469 lines)
- `backend/ai/gigaam_rnnt.go`: RNNT model support with 3-session inference
- `backend/ai/engine_manager.go`: Added `CreateEngineForModel()` method
- `backend/internal/service/llm.go`: Added `SelectBestTranscription()` method
- `backend/internal/service/transcription.go`: Integrated hybrid transcription
- `backend/internal/api/server.go`: Added `set_hybrid_transcription`, `get_hybrid_transcription_status` commands
- `frontend/src/components/common/HelpTooltip.tsx`: New reusable component
- `frontend/src/components/modules/HybridTranscriptionSettings.tsx`: Full settings UI
- `frontend/src/components/modules/TranscriptionView.tsx`: Confidence visualization

## [1.27.0] - 2025-12-12

### Added
- **Word-Level Timestamps for Parakeet TDT v3**: FluidAudio now returns precise word-level timestamps
  - Enables accurate dialogue merge algorithm for Parakeet (same as Whisper)
  - `splitSegmentsByWordGaps()` now works correctly with all three ASR engines
  - Tokens (subwords) are properly grouped into words with correct timestamps

### Fixed
- **Parakeet Transcription Text**: Fixed broken text with spaces between syllables
  - **Problem**: Parakeet returns BPE tokens (subwords), displayed as "Мо же т быть" instead of "Может быть"
  - **Solution**: Added `groupTokensIntoWords()` function to merge tokens into proper words
  - Text now displays correctly: "Может быть, у меня есть смысл"

### Technical
- `backend/audio/transcription/Sources/main.swift`:
  - Added `TranscriptionWord` struct with start, end, text, confidence
  - Added `groupTokensIntoWords()` function for BPE token merging
  - `TranscriptionSegment` now includes optional `words` array
- `backend/ai/transcription_fluid.go`:
  - Added `fluidTranscriptWord` struct for JSON parsing
  - Updated segment conversion to include word-level timestamps
- `backend/ai/transcription_fluid_e2e_test.go`:
  - Added `TestFluidASREngineWordTimestamps` test
- `backend/session/dialogue_merge_test.go`:
  - Updated `TestSplitSegmentsByWordGaps_Parakeet` for new behavior

## [1.25.1] - 2025-12-11

### Improved
- **Short Segment Handling**: Improved transcription of short speech segments (<2 sec)
  - Short VAD regions are now merged with neighbors for better context
  - `mergeShortRegions()` combines segments shorter than 2 sec with gap <3 sec
  - Helps Whisper avoid hallucinations on isolated short phrases

### Technical
- `backend/internal/service/transcription.go`: Added `mergeShortRegions()` function
- Improved `transcribeRegionsSeparately()` to use merged regions

## [1.25.0] - 2025-12-11

### Added
- **Audio Filters for Channel Quality**: New preprocessing pipeline for improved transcription accuracy
  - **High-Pass Filter** (80 Hz): Removes low-frequency hum and DC offset
  - **De-Click**: Detects and removes audio clicks/pops via interpolation
  - **Noise Gate**: Attenuates quiet segments below threshold (adaptive RMS-based)
  - **Normalization**: Normalizes audio to 0.9 peak level with gain limiting
  - **Auto-analysis**: `AnalyzeAudioQuality()` automatically detects channel characteristics and applies optimal filters
  - Filters are applied after stereo channel extraction, before VAD and transcription

### Fixed
- **Dialogue Ordering in UI**: Fixed incorrect phrase order when mic and sys segments had overlapping timestamps
  - **Problem**: Segments were sorted by chunk index, then concatenated without re-sorting by time
  - **Solution**: Added final `.sort((a, b) => a.start - b.start)` to ensure chronological order
  - Fixed in both `App.tsx` and `TranscriptionView.tsx`

### Technical
- New file: `backend/session/audio_filters.go` (320 lines)
  - `ApplyAudioFilters()` - main filter chain
  - `FilterChannelForTranscription()` - auto-configuring filter based on channel analysis
  - `AudioQualityMetrics` struct for detailed channel diagnostics
- `backend/internal/service/transcription.go`: Integrated filters after `ExtractSegmentStereoGo()`
- `frontend/src/App.tsx`: Added timestamp sorting for `allDialogue`
- `frontend/src/components/modules/TranscriptionView.tsx`: Added timestamp sorting

## [1.24.0] - 2025-12-11

### Added
- **Live Транскрипция (Streaming)**: Real-time транскрипция речи во время записи с минимальной задержкой (<500ms)
  - **Volatile vs Confirmed Text**: Промежуточные гипотезы (серый, курсив) и подтверждённый текст (чёрный, нормальный)
  - **Индикатор уверенности**: Цветная индикация confidence модели (🟢🟡🔴)
  - **Автоскролл**: Плавная прокрутка к новому тексту с возможностью отключения
  - **Панель Live**: Выдвижная панель с live транскрипцией, доступная по кнопке "Live" в RecordingOverlay
  - **Настройки**: Чекбокс "Live Транскрипция (Beta)" в SettingsPanel для включения функции
  - **Автоматический запуск**: Streaming автоматически включается при старте записи (если включен в настройках)
  - **Модель**: Использует NVIDIA Parakeet TDT v3 (0.6B) через FluidAudio StreamingAsrManager
  - **Производительность**: Latency <500ms, RTFx >100x, WER 1.93%

### Technical
- **Backend**:
  - `StreamingTranscriptionService` — управление real-time streaming транскрипцией
  - WebSocket команды: `enable_streaming`, `disable_streaming`, `get_streaming_status`
  - Интеграция с `RecordingService` через `OnAudioStream` callback
  - Swift CLI `transcription-fluid-stream` для FluidAudio StreamingAsrManager
- **Frontend**:
  - Компонент `StreamingTranscription` — отображение volatile/confirmed текста
  - Hook `useStreamingTranscription` — state management для streaming
  - Интеграция в `RecordingOverlay` с кнопкой "Live" и выдвижной панелью
  - Чекбокс в `SettingsPanel` с сохранением в localStorage

## [1.23.0] - 2025-12-11

### Fixed
- **Timestamps удвоение**: Исправлена ошибка, когда временные метки в транскрипции показывали удвоенное время (149:46 вместо 75:19)
  - Backend уже применял chunk offset, frontend дублировал его
  - Убрано добавление chunkOffset в TranscriptionView и App.tsx

- **AI-диаризация теряла "Вы"**: При разбиении по собеседникам через AI пропадали реплики пользователя
  - Реализован fuzzy matching по тексту (Jaccard similarity) вместо последовательного индекса
  - Неиспользованные оригинальные реплики теперь добавляются в результат

- **AI анализировал только ~25 минут**: Исправлена обработка длинных записей
  - Fuzzy matching решает проблему рассинхронизации батчей

- **Пропадание отрезков после AI**: UpdateImprovedDialogue обновлял только первый чанк
  - Теперь улучшенный диалог распределяется по всем чанкам на основе timestamps

- **Вкладка "Собеседники" была пустой**: Исправлен сбор спикеров из диалога
  - getSessionSpeakers теперь корректно обрабатывает все форматы: mic, sys, Speaker N, Собеседник N

### Added
- **Индикатор позиции воспроизведения**: При прослушивании записи текущий сегмент подсвечивается
  - Фиолетовая подсветка текущей реплики
  - Пульсирующая полоска слева от сегмента
  - Автоскролл к текущему сегменту (с кнопкой вкл/выкл)
  - Клик по сегменту для перемотки к этому месту

- **Индикатор на скроллбаре**: Фиолетовая метка показывает позицию воспроизведения
  - Клик по метке включает автоскролл

- **Переименование собеседников**: Полноценная работа вкладки "Собеседники"
  - Список спикеров с аватарами и статистикой (количество фраз, длительность)
  - Кнопка переименования для каждого собеседника
  - Диалог ввода имени с опцией "Запомнить голос"
  - Кастомные имена отображаются во всех вкладках (Транскрипция, Отрезки, экспорт)

### Technical
- Добавлены функции textSimilarity и sortSegmentsByTime в llm.go
- getSpeakerDisplayName использует sessionSpeakers для кастомных имён
- renameSpeakerInSession пробует все варианты имени спикера

## [1.22.1] - 2025-12-10

### Fixed
- **VU Meters during playback**: Fixed audio level indicators not animating during playback
  - Used `flushSync` from React DOM to force immediate re-renders from `requestAnimationFrame`
  - React 18 batching was preventing VU meter updates

### Removed
- Removed non-functional keyboard shortcut hint (⌘+,) from welcome screen

### Technical
- Removed debug console.log statements from audio analysis code
- Cleaned up unused `frameCount` variable

## [1.21.0] - 2025-12-10

### Added
- **Welcome Screen**: Informative landing page when no recording is selected
  - App logo and description
  - 3-step quick start guide
  - Feature highlights (accuracy, speaker separation, AI summary, local processing)

- **Modern Recording Indicator**: Full-width overlay during recording
  - Animated waveform visualization
  - Large monospace timer
  - Prominent stop button
  - Glass-blur effects following 2024 UI trends

### Changed
- **Console Footer**: Now spans full application width (was limited to main content area)

- **Sidebar**: Added traffic lights offset (28px margin-top) so macOS window controls don't overlap "Все записи" header
  - Added refresh button for session list

- **Recording Lock**: Interface is now locked during recording
  - Sidebar shows lock overlay with explanation
  - Settings button disabled
  - "Новая запись" button shows recording status

- **Settings Modal**: Fixed scrollbar overflow issue
  - Scrollbar now stays within rounded corners
  - Fixed header/footer with scrollable content area

- **Model Manager**: Complete restyling to Liquid Glass design
  - Segmented control for filters
  - Glass-effect model cards
  - Status badges with gradients
  - Removed deprecated "Faster-Whisper" filter
  - Renamed filters: "GGML" → "Whisper", added "GigaAM"
  - Hidden diarization models (managed via settings)

### Technical
- New component: `RecordingOverlay.tsx`
- Updated `ModelType` to remove deprecated `faster-whisper`
- Restructured `MainLayout.tsx` for full-width console

## [1.19.0] - 2025-12-10

### Fixed
- **VAD Speech Padding**: Fixed cutting off beginning of words starting with quiet consonants
  - **Problem**: Words like "Снова" were transcribed as "нова" - initial "С" was cut off
  - **Root Cause**: VAD detected speech start at the loud part of the word, missing quiet consonants (С, К, Т, П...)
  - **Solution**: Added speech padding (150ms before, 50ms after detected speech regions)
  - New `mergeOverlappingRegions()` function to merge adjacent padded regions

### Changed
- **E2E Model Recommended**: GigaAM v3 E2E (BPE) model produces much better results than CTC
  - CTC model struggles with quiet consonants at word boundaries
  - E2E model correctly recognizes "Как говорится, снова здравствуйте"
  - E2E also adds punctuation and capitalization automatically

### Technical
- `backend/session/vad.go`:
  - Added `speechPaddingStartMs = 150` and `speechPaddingEndMs = 50` constants
  - Applied padding to all detected speech regions in `DetectSpeechRegions()`
  - New `mergeOverlappingRegions()` function

## [1.18.0] - 2025-12-10

### Added
- **GigaAM Dialogue Improvement**: Major update to speech recognition quality
  - **Phase 1: Smart Dialogue Structure**
    - `maxPhraseDurationMs = 10000` - breaks long monologues into natural phrases
    - `interleaveDialogue()` - properly interleaves mic/sys segments by timestamp
    - Handles overlapping speech with segment trimming
  - **Phase 2: LLM Auto-Improvement**
    - Enhanced prompt for splitting glued words ("вопросеянеможо" → "вопросе я не могу")
    - Support for numbered speakers (Собеседник 1, 2, ...)
    - WebSocket commands: `set_auto_improve`, `get_auto_improve_status`
    - Config flags: `--auto-improve`, `--ollama-url`, `--ollama-model`
  - **Phase 3: VAD Preprocessing**
    - `CompressSpeech()` removes silence from audio before transcription
    - Speeds up processing by ~30-50%
    - `RestoreSegmentTimestamps()` maps compressed timestamps back to original
  - **Phase 4: CTC Decoder Heuristics**
    - Confidence drop detection (`confidenceDropThreshold = 0.4`)
    - Pause detection via blank token sequences (`minBlankSequenceForPause = 2`)
    - Better word boundary detection for reduced word gluing

### Technical
- `backend/ai/gigaam.go`: CTC decoder with confidence and pause heuristics
- `backend/session/manager.go`: Dialogue interleaving and phrase segmentation
- `backend/session/vad.go`: VAD-based audio compression with timestamp mapping
- `backend/internal/service/llm.go`: Enhanced LLM prompt and response parser
- `backend/internal/service/transcription.go`: VAD integration and auto-improve
- `backend/internal/api/server.go`: WebSocket commands for auto-improve
- `docs/plan_gigaam_dialogue_improvement_2025-12-10.md`: Implementation plan

## [1.17.20] - 2025-12-10

### Changed
- **GigaAM v3 CTC**: Switched from slow v3_e2e_ctc to fast v3_ctc model
  - **5x Faster**: Basic CTC model without E2E overhead runs much faster
  - **Better Accuracy**: WER 9.1% vs 12% for E2E model (E2E accuracy is worse due to punctuation overhead)
  - **Simpler Decoder**: Character-based vocabulary (34 tokens) instead of BPE (500+ tokens)
  - **Trade-off**: No punctuation in output (lowercase text without punctuation marks)

### Technical
- `backend/models/registry.go`: Changed model URL to `v3_ctc.int8.onnx`, vocab to `v3_vocab.txt`
- `backend/ai/gigaam.go`:
  - Simplified CTC decoder for character-based vocabulary
  - Replaced `unkID` with `spaceID` for space token tracking
  - Removed BPE/punctuation handling logic
- `backend/ai/gigaam_test.go`: Updated tests for v3_ctc vocabulary format

## [1.17.19] - 2025-12-10

### Changed
- **GigaAM v3 E2E CTC (reverted in 1.17.20)**: Attempted upgrade to v3 E2E CTC model
  - Model was too slow for practical use
  - Rolled back to basic CTC in next version

## [1.17.12] - 2025-12-09

### Fixed
- **Robotic/Computerized Audio Recording**: Restored original v1.7.2 audio mixing logic
  - **Root Cause**: Regression after v1.7.2 refactoring - changed `min(micBuffer, systemBuffer)` to `max(micLen, sysLen)` 
  - Using `max()` created "holes" of zero samples when one buffer was empty, causing robotic sound
  - **Solution**: Restored `minLen` logic - write audio only when BOTH channels have data
- **Diarization Settings Persistence**: Settings now saved to localStorage and auto-restored on app start
- **Retranscription with Diarization**: Added `diarizationEnabled` flag to retranscribe_full request

### Added
- **Refresh Sessions Button**: Added circular arrows button to manually refresh sessions list

### Technical
- `backend/internal/service/recording.go`: Restored `minLen := min(micBuffer, systemBuffer)` logic
- `frontend/src/context/DiarizationContext.tsx`: Save/restore diarization settings from localStorage
- `frontend/src/App.tsx`: Added `refreshSessions` callback and UI button

## [1.17.7] - 2025-12-09

### Fixed
- **Audio Buffer Underrun - queueDepth Fix**: Added critical ScreenCaptureKit buffer configuration
  - **Root Cause**: Missing `queueDepth` parameter in `SCStreamConfiguration` caused buffer underruns
  - Apple's documentation and examples recommend `queueDepth = 6` minimum ("or it becomes very stuttery")
  - Our code had no queueDepth set, defaulting to a small value causing dropped audio frames
  - **Solution**:
    1. Added `queueDepth = 8` for both system and microphone streams
    2. Created dedicated `DispatchQueue` for each audio stream instead of shared `.global()` queue
    3. Changed audio output from async to sync to prevent backpressure and data loss

### Technical
- `backend/audio/screencapture/Sources/main.swift`:
  - Added `sysConfig.queueDepth = 8` for system audio capture
  - Added `micConfig.queueDepth = 8` for microphone capture
  - Created `DispatchQueue(label: "system.audio.capture")` for system audio
  - Created `DispatchQueue(label: "mic.audio.capture")` for microphone
  - Changed `outputQueue.async` to synchronous `writeChannelData()` call

## [1.17.6] - 2025-12-09

### Fixed
- **Audio Duration Mismatch - Root Cause Found**: Fixed 1.43x audio stretching ("robot voice")
  - **Root Cause**: Microphone outputs 24 kHz, system audio outputs 48 kHz. Linear interpolation resampling in Swift (24→48 kHz) created timing desync - recorded audio was 1.43x longer than real time!
  - **Evidence**: 54 sec recording → 77 sec WAV file (meta.totalDuration vs actual file duration)
  - **Solution**: 
    1. Removed all resampling in Swift - output native sample rate
    2. Changed system-wide SampleRate to 24 kHz (Voice Isolation native rate)
    3. Both mic and system audio now at same rate - no desync
  - 24 kHz is sufficient for speech (Whisper downsamples to 16 kHz anyway)

### Technical
- `backend/audio/screencapture/Sources/main.swift`:
  - Removed resampling code - now outputs native sample rate
  - Changed `targetSampleRate` default to 24000
  - Stream configs now request 24 kHz
- `backend/session/types.go`: `SampleRate = 24000`
- `backend/audio/capture.go`: Device configs use 24 kHz

## [1.17.5] - 2025-12-09

### Fixed
- **Audio Quality - Fundamental Architecture Fix**: Reverted to WAV-first recording approach
  - **Root Cause**: Any real-time encoding (FFmpeg pipe or shine-mp3) creates CPU load and buffer timing issues
  - **Solution**: Write raw WAV during recording, convert to MP3 only after recording stops
  - This is the original proven architecture that worked reliably
  - WAV writing is simple sequential I/O with no encoding overhead
  - MP3 conversion happens once at the end, not competing with audio capture
  - Restored 48 kHz sample rate (will be resampled by ScreenCaptureKit if needed)

### Technical
- `backend/internal/service/recording.go`:
  - Now uses `WAVWriter` instead of any MP3 writer during recording
  - Calls `ConvertWAVToMP3()` after recording stops
- `backend/session/mp3_writer.go`: Added `ConvertWAVToMP3()` function
- Restored `SampleRate = 48000` in all components
- Recording flow: Audio → WAV (real-time) → MP3 (post-processing)

## [1.17.4] - 2025-12-09

### Fixed
- **CPU Overload from FFmpeg**: Replaced FFmpeg-based MP3 encoding with pure Go implementation
  - **Root Cause**: FFmpeg process was consuming 100% CPU during recording, causing audio buffer underruns and distorted "robotic" voice
  - **Solution**: Replaced FFmpeg pipe with [shine-mp3](https://github.com/braheezy/shine-mp3) - a pure Go MP3 encoder
  - No external processes, no pipe overhead, no FFmpeg dependency for recording
  - Much lower CPU usage and stable audio quality

### Technical
- Added `github.com/braheezy/shine-mp3` dependency
- New `backend/session/mp3_writer_shine.go`: Pure Go MP3 writer implementation
- `backend/internal/service/recording.go`: Now uses `ShineMP3Writer` instead of `MP3Writer`
- FFmpeg is still used for audio extraction during retranscription (reading MP3 files)

## [1.17.3] - 2025-12-09

### Fixed
- **Audio Quality "Robot Voice" Issue**: Fixed distorted/robotic audio recording quality
  - **Root Cause**: Voice Isolation microphone on macOS outputs audio at 24 kHz, but we were requesting 48 kHz and using linear interpolation resampling which created artifacts
  - **Solution**: Changed recording sample rate from 48 kHz to 24 kHz (native rate for Voice Isolation)
  - Now both microphone and system audio streams run at 24 kHz without resampling
  - 24 kHz is sufficient for speech recognition (Whisper downsamples to 16 kHz anyway)

### Technical
- `backend/session/types.go`: Changed `SampleRate` constant from 48000 to 24000
- `backend/audio/capture.go`: Updated device configs to use 24 kHz
- `backend/audio/screencapture/Sources/main.swift`:
  - Changed `targetSampleRate` default from 48000 to 24000
  - Updated stream configurations to request 24 kHz
  - No more resampling needed (resample=false in logs)

## [1.17.2] - 2025-12-09

### Fixed
- **Empty Session Display**: Fixed dark screen when opening sessions without transcription chunks
  - Now shows informative message instead of blank screen
  - Explains that recording may have been interrupted before creating chunks

- **Session Deletion UI Sync**: Sessions now immediately disappear from list after deletion
  - Added `session_deleted` WebSocket handler to update session list in real-time
  - Previously required page refresh to see changes

- **Retranscription Progress & Completion**: Fixed retranscription not updating UI during processing
  - **Problem**: `HandleChunk` was async, so `full_transcription_completed` was sent before chunks finished processing
  - **Solution**: Added `HandleChunkSync` method for synchronous chunk processing during retranscription
  - Progress now updates correctly, and UI refreshes only after all chunks are complete

### Technical
- `frontend/src/App.tsx`:
  - Added condition for `chunks.length === 0 && selectedSession` to show empty session message
  - Added `session_deleted` case in WebSocket handler to filter deleted sessions from list
- `backend/internal/service/transcription.go`:
  - Added `HandleChunkSync()` method for synchronous transcription (used in retranscription)
- `backend/internal/api/server.go`:
  - Changed retranscription to use `HandleChunkSync` instead of async `HandleChunk`

## [1.7.2] - 2025-12-08

### Fixed
- **Audio Resource Leak on macOS**: Fixed issue where system audio quality remained degraded ("muffled") after stopping recording
  - **Problem**: When recording started, macOS ScreenCaptureKit captured system audio via audio tap, but when recording stopped, the SCStream was not properly released. This caused macOS to keep the audio tap active, resulting in muffled/degraded system audio until app restart.
  - **Root Cause**: `removeStreamOutput()` was not called before `stopCapture()`, leaving stream outputs attached and preventing proper resource cleanup
  - **Solution**: Implemented correct 6-step cleanup sequence based on Apple best practices:
    1. Stop delegates to prevent new data processing
    2. Wait for pending operations in outputQueue to complete
    3. **Call `removeStreamOutput()` BEFORE `stopCapture()`** (critical step!)
    4. Call `stopCapture()` to release audio tap
    5. Clear all object references for ARC
    6. Final delay for macOS to process resource release
  - **Result**: System audio now returns to normal quality immediately after stopping recording

### Technical
- `backend/audio/screencapture/Sources/main.swift`:
  - Added `waitForPendingOperations()` method to `AudioCaptureDelegate` for sync on outputQueue
  - New 6-step `performCleanup()` async function with proper cleanup order
  - Added `removeStreamOutput()` calls before `stopCapture()`
  - Signal handlers use semaphore to wait for async cleanup on separate queue
  - Increased cleanup delay to 200ms for resource release
- `backend/audio/screencapture_darwin.go`:
  - Increased graceful shutdown timeout to 5 seconds
  - Added wait after Kill() to ensure process termination

## [1.7.0] - 2025-12-04

### Added
- **Speaker Diarization for Sys Channel**: Implemented speaker recognition and separation for the system audio channel (Interlocutor)
  - Uses `WeSpeaker ResNet34` model (ONNX) to identify unique speakers
  - Automatically labels speakers as `[Speaker 0]`, `[Speaker 1]`, etc.
  - Works on top of any transcription model (Whisper Turbo, GigaAM)
  - Integrated into real-time transcription and re-transcription processes
  - Requires downloading `WeSpeaker ResNet34` from Model Manager

### Technical
- **New AI Architecture**:
  - Added `SpeakerEncoder` service for voice embedding extraction
  - Added `Diarizer` service for clustering speaker embeddings
  - Refactored audio processing logic into `mel_spectrogram.go` for reuse between GigaAM and Diarization
  - Updated `main.go` to support speaker diarization pipeline
  - Added `Speaker` field to `TranscriptSegment` struct

## [1.6.3] - 2025-12-04

### Fixed
- **Retranscription Quality**: Fixed quality degradation during retranscription compared to real-time transcription
  - Root cause: `TranscribeHighQuality` used `MaxContext=0` which disabled context, hurting recognition quality
  - Solution: Unified Whisper parameters between `TranscribeWithSegments` (realtime) and `TranscribeHighQuality` (retranscription)
  - Now uses `MaxContext=-1` (full context) for better accuracy
  - Unified `MaxTokensPerSegment=128` for consistency
  - Added `hasSignificantAudio` check to filter empty/quiet segments

### Changed
- **Removed Auto-Retranscription**: Removed automatic retranscription after recording stop
  - Auto-retranscription was causing confusion and unexpected behavior
  - Users now have full control - retranscription only happens when manually triggered
  - Removed "Авто-распознавание" checkbox from settings
  - Removed `autoRetranscribe` from app settings and localStorage

### Technical
- `backend/ai/whisper.go`:
  - `TranscribeHighQuality()` now uses same parameters as `TranscribeWithSegments()`
  - `MaxContext` changed from `0` to `-1` (use full context)
  - `MaxTokensPerSegment` changed from `256` to `128`
  - Added `hasSignificantAudio()` check for consistency
- `frontend/src/App.tsx`:
  - Removed auto-retranscription logic from `session_stopped` handler
  - Removed `autoRetranscribe` state and ref
  - Removed auto-retranscription checkbox from settings UI
- `frontend/src/types/models.ts`:
  - Removed `autoRetranscribe` from `AppSettings` interface

## [1.6.2] - 2025-12-03

### Fixed
- **Chunk Preservation During Retranscription**: Fixed critical bug where chunks were merged into one after full retranscription
  - Root cause: Chunks were not loaded into memory when session was retrieved
  - Solution: Added automatic chunk loading from disk in both `UpdateFullTranscription` and `retranscribe_full` handler
  - Now properly preserves original chunk structure (e.g., 27 chunks stay as 27 chunks)

### Added
- **Cancel Button for Full Retranscription**: Added ability to cancel ongoing full retranscription
  - Cancel button appears in the progress bar during retranscription
  - Properly stops the transcription goroutine with cleanup
  - Uses WaitGroup for safe goroutine synchronization

### Technical
- `backend/session/manager.go`:
  - `UpdateFullTranscription()` now loads chunks from disk if not in memory
  - Added detailed logging for chunk loading and distribution
- `backend/main.go`:
  - `retranscribe_full` goroutine loads chunks from disk before processing
  - Added `sort` import for chunk ordering
  - Added `fullTranscriptionCancel` channel and `fullTranscriptionWg` WaitGroup
  - Added `cancel_full_transcription` WebSocket handler
- `frontend/src/App.tsx`:
  - Added cancel button UI with spinner animation
  - Added `isCancellingTranscription` state for debounce
  - Handles `full_transcription_cancelled` message

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
