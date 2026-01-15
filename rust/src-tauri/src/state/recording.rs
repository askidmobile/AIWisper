//! Recording session management
//!
//! Handles audio recording with:
//! - MP3 writing via FFmpeg
//! - ChunkBuffer for automatic segmentation
//! - Session and chunk metadata persistence
//! - Transcription of chunks during recording

use aiwisper_audio::{
    calculate_rms, is_silent, resample, AudioCapture, AudioChannel, ChunkBuffer, SegmentedMp3Writer,
    SystemAudioCapture, SystemCaptureConfig, SystemCaptureMethod, VadConfig,
};
use aiwisper_ml::{SileroVad, SileroVadConfig};
use std::sync::mpsc;
use anyhow::Result;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use parking_lot::RwLock;
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use uuid::Uuid;

/// Sample rate for recording (matches Go backend)
const SAMPLE_RATE: u32 = 24000;
/// Sample rate for transcription
const TRANSCRIPTION_SAMPLE_RATE: u32 = 16000;

/// Максимальное количество параллельных транскрипций
/// Увеличено с 2 до 3 для лучшей производительности при длинных записях
const MAX_CONCURRENT_TRANSCRIPTIONS: usize = 3;

/// Счётчик активных транскрипций (глобальный семафор)
static ACTIVE_TRANSCRIPTIONS: LazyLock<Arc<AtomicUsize>> = LazyLock::new(|| Arc::new(AtomicUsize::new(0)));

/// Попытка захватить слот для транскрипции
/// Возвращает true если слот захвачен, false если достигнут лимит
fn try_acquire_transcription_slot() -> bool {
    let mut current = ACTIVE_TRANSCRIPTIONS.load(Ordering::SeqCst);
    loop {
        if current >= MAX_CONCURRENT_TRANSCRIPTIONS {
            return false;
        }

        match ACTIVE_TRANSCRIPTIONS.compare_exchange(
            current,
            current + 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

/// Освободить слот транскрипции
fn release_transcription_slot() {
    let prev = ACTIVE_TRANSCRIPTIONS.fetch_sub(1, Ordering::SeqCst);
    if prev == 0 {
        // Защита от underflow
        ACTIVE_TRANSCRIPTIONS.store(0, Ordering::SeqCst);
    }
}

/// Получить количество активных транскрипций
pub fn get_active_transcriptions() -> usize {
    ACTIVE_TRANSCRIPTIONS.load(Ordering::SeqCst)
}

/// Известные паттерны галлюцинаций Whisper на тишине
/// Модель часто генерирует эти фразы когда на входе тишина или очень тихий звук
const HALLUCINATION_PATTERNS: &[&str] = &[
    "продолжение следует",
    "субтитры сделал",
    "субтитры делал",
    "подписывайтесь на канал",
    "спасибо за просмотр",
    "до новых встреч",
    "редактор субтитров",
    "не забывайте подписываться",
    "ставьте лайки",
    "нажмите на колокольчик",
    // Короткие бессмысленные фразы
    "пвет",
    "идеаль",
    "приветствую",
    "привет всем",
    // Английские галлюцинации
    "thank you for watching",
    "subscribe to the channel",
    "see you next time",
    "please subscribe",
    "thanks for watching",
];

/// Проверяет, является ли текст галлюцинацией модели
/// 
/// Галлюцинацией считается:
/// 1. Текст содержит известные паттерны галлюцинаций
/// 2. Очень короткий текст (< 5 символов) — скорее всего артефакт
fn is_hallucination(text: &str) -> bool {
    let text_lower = text.to_lowercase();
    let text_trimmed = text_lower.trim();
    
    // Очень короткий текст — подозрительно
    if text_trimmed.len() < 5 {
        tracing::debug!("Hallucination detected: too short text '{}'", text);
        return true;
    }
    
    // Проверяем известные паттерны
    for pattern in HALLUCINATION_PATTERNS {
        if text_trimmed.contains(pattern) {
            tracing::info!("Hallucination detected: '{}' matches pattern '{}'", text, pattern);
            return true;
        }
    }
    
    false
}

fn find_vad_model_path() -> Option<PathBuf> {
    let models_dir = dirs::data_local_dir()?.join("aiwisper").join("models");
    let candidates = [
        "silero_vad.onnx",
        "silero-vad-v5.onnx",
        "silero-vad-v5.bin",
        "silero-vad-v5",
    ];

    for file_name in candidates {
        let model_path = models_dir.join(file_name);
        if model_path.exists() {
            return Some(model_path);
        }
    }

    None
}

fn get_vad_engine() -> Result<parking_lot::RwLockReadGuard<'static, Option<SileroVad>>> {
    static VAD_ENGINE: LazyLock<RwLock<Option<SileroVad>>> =
        LazyLock::new(|| RwLock::new(None));

    if VAD_ENGINE.read().is_none() {
        let model_path = find_vad_model_path()
            .ok_or_else(|| anyhow::anyhow!("VAD модель не найдена"))?;
        let mut config = SileroVadConfig::default();
        config.model_path = model_path.to_string_lossy().to_string();
        let vad = SileroVad::new(config)?;
        *VAD_ENGINE.write() = Some(vad);
    }

    Ok(VAD_ENGINE.read())
}

fn is_silent_with_vad(samples: &[f32], sample_rate: u32) -> bool {
    if samples.is_empty() {
        return true;
    }

    let rms = calculate_rms(samples);
    let rms_silent = is_silent(samples, Some(0.008));
    let resampled = if sample_rate != TRANSCRIPTION_SAMPLE_RATE {
        resample(samples, sample_rate, TRANSCRIPTION_SAMPLE_RATE)
            .unwrap_or_else(|_| samples.to_vec())
    } else {
        samples.to_vec()
    };

    match get_vad_engine() {
        Ok(engine_guard) => {
            let vad = match engine_guard.as_ref() {
                Some(vad) => vad,
                None => {
                    tracing::warn!(
                        "VAD не инициализирован, fallback на RMS (rms={:.5}, silent={})",
                        rms,
                        rms_silent
                    );
                    return rms_silent;
                }
            };

            match vad.detect_segments(&resampled) {
                Ok(segments) => {
                    let vad_silent = segments.is_empty();
                    tracing::info!(
                        "VAD тишина: segments={} rms={:.5} silent={}",
                        segments.len(),
                        rms,
                        vad_silent
                    );
                    vad_silent
                }
                Err(err) => {
                    tracing::warn!(
                        "VAD ошибка, fallback на RMS: {} (rms={:.5}, silent={})",
                        err,
                        rms,
                        rms_silent
                    );
                    rms_silent
                }
            }
        }
        Err(err) => {
            tracing::warn!(
                "VAD недоступен, fallback на RMS: {} (rms={:.5}, silent={})",
                err,
                rms,
                rms_silent
            );
            rms_silent
        }
    }
}

/// Configuration for transcription during recording
#[derive(Debug, Clone)]
pub struct TranscriptionConfig {
    /// Primary model ID (e.g., "ggml-large-v3-turbo")
    pub model_id: String,
    /// Language code (e.g., "ru", "en", "auto")
    pub language: String,
    /// Enable hybrid transcription
    pub hybrid_enabled: bool,
    /// Secondary model ID for hybrid mode
    pub hybrid_secondary_model_id: String,
    /// Hotwords for improved accuracy
    pub hotwords: Vec<String>,
    /// Enable diarization for sys channel
    pub diarization_enabled: bool,
    /// Diarization provider ("coreml" for FluidAudio)
    pub diarization_provider: String,
    /// Use LLM for merging hybrid transcription results
    pub hybrid_use_llm: bool,
    /// Hybrid transcription mode ("parallel" or "confidence")
    pub hybrid_mode: String,
    /// Ollama model for LLM enhancement
    pub ollama_model: String,
    /// Ollama URL
    pub ollama_url: String,
    /// Data directory for voiceprint matching (speakers.json)
    pub voiceprint_data_dir: Option<std::path::PathBuf>,
}

impl Default for TranscriptionConfig {
    fn default() -> Self {
        Self {
            model_id: "ggml-large-v3-turbo".to_string(),
            language: "ru".to_string(),
            hybrid_enabled: false,
            hybrid_secondary_model_id: String::new(),
            hotwords: Vec::new(),
            diarization_enabled: false,
            diarization_provider: String::new(),
            hybrid_use_llm: false,
            hybrid_mode: "parallel".to_string(),
            ollama_model: String::new(),
            ollama_url: "http://localhost:11434".to_string(),
            voiceprint_data_dir: None,
        }
    }
}

/// Recording session data
pub struct RecordingSession {
    pub id: String,
    pub data_dir: PathBuf,
    pub start_time: chrono::DateTime<chrono::Utc>,
    pub language: String,
    pub model_id: String,
    pub is_stereo: bool,
}

impl RecordingSession {
    /// Create a new recording session
    pub fn new(language: &str, model_id: &str, _is_stereo: bool) -> Result<Self> {
        let id = Uuid::new_v4().to_string();
        let start_time = chrono::Utc::now();

        // Get sessions directory
        let sessions_dir = dirs::data_local_dir()
            .map(|p| p.join("aiwisper").join("sessions"))
            .ok_or_else(|| anyhow::anyhow!("Could not determine data directory"))?;

        let data_dir = sessions_dir.join(&id);

        // Create session directory and chunks subdirectory
        std::fs::create_dir_all(data_dir.join("chunks"))?;

        Ok(Self {
            id,
            data_dir,
            start_time,
            language: language.to_string(),
            model_id: model_id.to_string(),
            is_stereo: false,
        })
    }

    /// Get MP3 file path
    pub fn mp3_path(&self) -> PathBuf {
        self.data_dir.join("full.mp3")
    }

    /// Get meta.json path
    pub fn meta_path(&self) -> PathBuf {
        self.data_dir.join("meta.json")
    }

    /// Get chunk file path
    pub fn chunk_path(&self, index: usize) -> PathBuf {
        self.data_dir
            .join("chunks")
            .join(format!("chunk_{:04}.json", index))
    }

    /// Save session metadata
    pub fn save_meta(
        &self,
        end_time: Option<chrono::DateTime<chrono::Utc>>,
        duration_ms: u64,
        chunks_count: usize,
    ) -> Result<()> {
        // При записи (end_time = None) используем простой формат без длительности
        // При завершении показываем длительность в минутах/секундах
        let title = if end_time.is_none() {
            format!("Запись {}", self.start_time.format("%d.%m %H:%M"))
        } else {
            let total_secs = duration_ms / 1000;
            let mins = total_secs / 60;
            let secs = total_secs % 60;
            if mins > 0 {
                format!(
                    "Запись {} · {} мин {} сек",
                    self.start_time.format("%d.%m %H:%M"),
                    mins,
                    secs
                )
            } else {
                format!(
                    "Запись {} · {} сек",
                    self.start_time.format("%d.%m %H:%M"),
                    secs
                )
            }
        };

        let meta = serde_json::json!({
            "version": 2,  // Rust backend format
            "id": self.id,
            "startTime": self.start_time.to_rfc3339(),
            "endTime": end_time.map(|t| t.to_rfc3339()),
            "status": if end_time.is_some() { "completed" } else { "recording" },
            "language": self.language,
            "model": self.model_id,
            "title": title,
            "tags": [],
            "totalDuration": duration_ms,
            "chunksCount": chunks_count,
        });

        std::fs::write(self.meta_path(), serde_json::to_string_pretty(&meta)?)?;

        Ok(())
    }
}

/// Saved chunk metadata (for JSON)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMeta {
    pub id: String,
    pub index: i32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub status: String,
    #[serde(default)]
    pub transcription: String,
    #[serde(default)]
    pub mic_text: Option<String>,
    #[serde(default)]
    pub sys_text: Option<String>,
    #[serde(default)]
    pub dialogue: Vec<DialogueEntry>,
    /// Исключён из экспорта/сводки (галлюцинация или ручное исключение)
    #[serde(default)]
    pub excluded: bool,
}

/// Dialogue entry for JSON (with optional word-level timestamps)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DialogueEntry {
    pub start: i64,
    pub end: i64,
    pub text: String,
    #[serde(default)]
    pub speaker: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<aiwisper_types::TranscriptWord>,
}

impl ChunkMeta {
    /// Create from ChunkEvent
    pub fn from_event(event: &aiwisper_audio::ChunkEvent, _session_id: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            index: event.index as i32,
            start_ms: event.start_ms,
            end_ms: event.end_ms,
            status: "pending".to_string(),
            transcription: String::new(),
            mic_text: None,
            sys_text: None,
            dialogue: Vec::new(),
            excluded: false,
        }
    }

    /// Save to file
    pub fn save(&self, path: &std::path::Path) -> Result<()> {
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

/// Handle to control active recording
pub struct RecordingHandle {
    /// Stop flag
    pub stop_flag: Arc<AtomicBool>,
    /// Microphone mute flag
    pub mic_muted: Arc<AtomicBool>,
    /// System audio mute flag
    pub sys_muted: Arc<AtomicBool>,
    /// Join handle for recording thread
    pub join_handle: Option<std::thread::JoinHandle<RecordingResult>>,
    /// Session info
    pub session: RecordingSession,
}

/// Result of recording
pub struct RecordingResult {
    pub session_id: String,
    pub duration_ms: u64,
    pub sample_count: usize,
    pub chunks: Vec<ChunkMeta>,
}

impl RecordingHandle {
    /// Set mute state for microphone channel
    pub fn set_mic_muted(&self, muted: bool) {
        self.mic_muted.store(muted, Ordering::SeqCst);
        tracing::info!("Mic mute set to: {}", muted);
    }

    /// Set mute state for system audio channel
    pub fn set_sys_muted(&self, muted: bool) {
        self.sys_muted.store(muted, Ordering::SeqCst);
        tracing::info!("Sys mute set to: {}", muted);
    }

    /// Get current mic mute state
    pub fn is_mic_muted(&self) -> bool {
        self.mic_muted.load(Ordering::SeqCst)
    }

    /// Get current sys mute state
    pub fn is_sys_muted(&self) -> bool {
        self.sys_muted.load(Ordering::SeqCst)
    }

    /// Stop recording and get result
    pub fn stop(mut self) -> Result<RecordingResult> {
        // Signal stop
        self.stop_flag.store(true, Ordering::SeqCst);

        // Wait for thread
        let result = if let Some(handle) = self.join_handle.take() {
            handle
                .join()
                .map_err(|_| anyhow::anyhow!("Recording thread panicked"))?
        } else {
            return Err(anyhow::anyhow!("Recording already stopped"));
        };

        // Update session metadata with final state
        let end_time = chrono::Utc::now();
        self.session.save_meta(
            Some(end_time),
            result.duration_ms,
            result.chunks.len(),
        )?;

        Ok(result)
    }
}

/// Start recording session
///
/// Returns a handle to control the recording.
/// Recording runs in a separate thread due to cpal::Stream not being Send+Sync.
pub fn start_recording(
    device_id: Option<String>,
    language: &str,
    model_id: &str,
    capture_system: bool,
    transcription_config: TranscriptionConfig,
    app_handle: tauri::AppHandle,
) -> Result<RecordingHandle> {
    // Create session (фиксируем стерео-флаг из capture_system)
    let mut session = RecordingSession::new(language, model_id, capture_system)?;
    session.is_stereo = capture_system;
    let session_id = session.id.clone();
    let mp3_path = session.mp3_path();

    // Save initial meta
    session.save_meta(None, 0, 0)?;

    // Create stop flag
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();

    // Create mute flags
    let mic_muted = Arc::new(AtomicBool::new(false));
    let sys_muted = Arc::new(AtomicBool::new(false));
    let mic_muted_clone = mic_muted.clone();
    let sys_muted_clone = sys_muted.clone();

    // Clone for thread
    let data_dir = session.data_dir.clone();

    // Spawn recording thread
    let join_handle = std::thread::spawn(move || {
        recording_thread(
            session_id,
            mp3_path,
            data_dir,
            device_id,
            capture_system,
            stop_flag_clone,
            mic_muted_clone,
            sys_muted_clone,
            app_handle,
            transcription_config,
        )
    });

    Ok(RecordingHandle {
        stop_flag,
        mic_muted,
        sys_muted,
        join_handle: Some(join_handle),
        session,
    })
}

/// Recording thread function
fn recording_thread(
    session_id: String,
    _mp3_path: PathBuf,  // Теперь используется SegmentedMp3Writer с data_dir
    data_dir: PathBuf,
    device_id: Option<String>,
    capture_system: bool,
    stop_flag: Arc<AtomicBool>,
    mic_muted: Arc<AtomicBool>,
    sys_muted: Arc<AtomicBool>,
    app_handle: tauri::AppHandle,
    transcription_config: TranscriptionConfig,
) -> RecordingResult {
    use tauri::Emitter;

    // Create microphone capture
    let mut mic_capture = match AudioCapture::new(device_id.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Failed to create audio capture: {}", e);
            return RecordingResult {
                session_id,
                duration_ms: 0,
                sample_count: 0,
                chunks: Vec::new(),
            };
        }
    };

    // На macOS жёстко используем ScreenCaptureKit, чтобы не падать в VirtualLoopback
    let sys_config = if capture_system {
        SystemCaptureConfig {
            method: SystemCaptureMethod::ScreenCaptureKit,
            sample_rate: SAMPLE_RATE,
            capture_microphone: false,
        }
    } else {
        SystemCaptureConfig::default()
    };

    // Create system audio capture if requested
    let mut sys_capture: Option<Box<dyn SystemAudioCapture>> = if capture_system {
        match aiwisper_audio::create_system_capture(sys_config) {
            Ok(c) => {
                tracing::info!("System audio capture создан");
                Some(c)
            }
            Err(e) => {
                tracing::warn!("Failed to create system audio capture: {}", e);
                None
            }
        }
    } else {
        None
    };

    // MP3 channels: 1 for mic only, 2 for stereo (mic + sys)
    let channels = if sys_capture.is_some() { 2 } else { 1 };

    // Create segmented MP3 writer (15 минут = 900 сек на сегмент)
    // Это предотвращает бесконечный рост памяти при длительных записях
    let mut mp3_writer = match SegmentedMp3Writer::new(&data_dir, SAMPLE_RATE, channels, "128k", 900) {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("Failed to create segmented MP3 writer: {}", e);
            return RecordingResult {
                session_id,
                duration_ms: 0,
                sample_count: 0,
                chunks: Vec::new(),
            };
        }
    };

    // Канал для сигналов очистки буфера после транскрипции
    let (drain_tx, drain_rx) = mpsc::channel::<i64>();

    // Create chunk buffer with VAD config
    let vad_config = if capture_system {
        VadConfig::fixed_interval()
    } else {
        VadConfig::default()
    };
    let mut chunk_buffer = ChunkBuffer::new(vad_config, SAMPLE_RATE);

    // Start mic capture
    tracing::info!("Starting microphone capture...");
    if let Err(e) = mic_capture.start() {
        tracing::error!("Failed to start audio capture: {}", e);
        return RecordingResult {
            session_id,
            duration_ms: 0,
            sample_count: 0,
            chunks: Vec::new(),
        };
    }
    // Get mic sample rate for resampling
    let mic_sample_rate = mic_capture.sample_rate();
    let need_resample = mic_sample_rate != SAMPLE_RATE;

    tracing::info!(
        "Microphone capture started: rate={} Hz, target_rate={} Hz, need_resample={}",
        mic_sample_rate,
        SAMPLE_RATE,
        need_resample
    );

    // Start system capture
    if let Some(ref mut sys) = sys_capture {
        if let Err(e) = sys.start() {
            tracing::warn!("Failed to start system audio capture: {}", e);
            sys_capture = None;
        }
    }

    tracing::info!(
        "Recording started: session={}, capture_system={}",
        session_id,
        sys_capture.is_some()
    );

    // Emit session_started event with full session info
    // Must match Session interface from rust/ui/src/types/session.ts
    let _ = app_handle.emit(
        "session_started",
        serde_json::json!({
            "sessionId": session_id.clone(),
            "session": {
                "id": session_id.clone(),
                "startTime": chrono::Utc::now().to_rfc3339(),
                "endTime": null,
                "status": "recording",
                "chunks": [],
                "dataDir": data_dir.to_string_lossy().to_string(),
                "totalDuration": 0,
                "title": null,
                "tags": [],
                "summary": null,
                "language": null,
                "model": null,
                "sampleCount": 0,
            }
        }),
    );

    let start_time = Instant::now();
    let mut chunks: Vec<ChunkMeta> = Vec::new();
    // УДАЛЕНО: last_mic_sample_count больше не нужен, т.к. используем clear() после чтения

    // Create VoicePrintMatcher for speaker recognition (wrapped in Arc for thread-safe sharing)
    let voiceprint_matcher: Option<Arc<aiwisper_ml::VoicePrintMatcher>> = 
        transcription_config.voiceprint_data_dir.as_ref().and_then(|data_dir| {
            match aiwisper_ml::VoicePrintMatcher::new(data_dir.clone()) {
                Ok(matcher) => {
                    let count = matcher.get_all().len();
                    tracing::info!("VoicePrintMatcher initialized with {} voiceprints", count);
                    Some(Arc::new(matcher))
                }
                Err(e) => {
                    tracing::warn!("Failed to initialize VoicePrintMatcher: {}", e);
                    None
                }
            }
        });

    // Buffers for stereo recording (микрофон и система накапливаются до выравнивания)
    let mut sys_buffer: Vec<f32> = Vec::new();
    let mut mic_buffer: Vec<f32> = Vec::new();

    // For debug logging
    let mut loop_count: u64 = 0;
    
    // Счётчик итераций без новых системных данных (для детекции застоя)
    let mut sys_empty_streak: u32 = 0;
    const SYS_EMPTY_WARNING_THRESHOLD: u32 = 40; // 2 секунды (40 * 50ms)
    let mut sys_disconnected = false;
    let mut sys_fallback_logged = false;
    
    // Очередь pending транскрипций для retry когда слоты заняты
    struct PendingTranscription {
        chunk_meta: ChunkMeta,
        chunk_path: PathBuf,
        mic_samples: Vec<f32>,
        sys_samples: Vec<f32>,
        sample_rate: u32,
        is_stereo: bool,
    }
    let mut pending_transcriptions: std::collections::VecDeque<PendingTranscription> = std::collections::VecDeque::new();

    // Main recording loop
    loop {
        // Check stop flag
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }

        // Sleep briefly
        std::thread::sleep(std::time::Duration::from_millis(50));
        
        // Обработка pending транскрипций (retry для тех, что не смогли захватить слот)
        while !pending_transcriptions.is_empty() {
            if !try_acquire_transcription_slot() {
                break; // Слоты всё ещё заняты, попробуем на следующей итерации
            }
            
            let pending = pending_transcriptions.pop_front().unwrap();
            tracing::info!(
                "Retrying transcription for chunk {} (pending queue: {} remaining)",
                pending.chunk_meta.index,
                pending_transcriptions.len()
            );
            
            // Emit chunk_transcribing event
            let _ = app_handle.emit(
                "chunk_transcribing",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunkId": pending.chunk_meta.id,
                    "chunkIndex": pending.chunk_meta.index,
                }),
            );
            
            // Клонируем данные для фонового потока
            let bg_chunk_meta = pending.chunk_meta;
            let bg_chunk_path = pending.chunk_path;
            let bg_session_id = session_id.clone();
            let bg_app_handle = app_handle.clone();
            let bg_transcription_config = transcription_config.clone();
            let bg_drain_tx = drain_tx.clone();
            let bg_voiceprint_matcher = voiceprint_matcher.clone();
            let chunk_end_ms = bg_chunk_meta.end_ms;
            
            if pending.is_stereo {
                let mic_samples = pending.mic_samples;
                let sys_samples = pending.sys_samples;
                let sample_rate = pending.sample_rate;
                
                std::thread::spawn(move || {
                    let transcribed = transcribe_chunk_stereo(
                        bg_chunk_meta,
                        &mic_samples,
                        &sys_samples,
                        sample_rate,
                        &bg_transcription_config,
                        &bg_session_id,
                        &bg_app_handle,
                        bg_voiceprint_matcher.as_deref(),
                    );
                    if let Err(e) = transcribed.save(&bg_chunk_path) {
                        tracing::error!("Failed to save transcribed chunk: {}", e);
                    }
                    let _ = bg_drain_tx.send(chunk_end_ms);
                    release_transcription_slot();
                });
            } else {
                let chunk_samples = pending.mic_samples; // В моно режиме mic_samples содержит все данные
                let sample_rate = pending.sample_rate;
                
                std::thread::spawn(move || {
                    let transcribed = transcribe_chunk_samples(
                        bg_chunk_meta,
                        &chunk_samples,
                        sample_rate,
                        &bg_transcription_config,
                        &bg_session_id,
                        &bg_app_handle,
                    );
                    if let Err(e) = transcribed.save(&bg_chunk_path) {
                        tracing::error!("Failed to save transcribed chunk: {}", e);
                    }
                    let _ = bg_drain_tx.send(chunk_end_ms);
                    release_transcription_slot();
                });
            }
        }

        // Get new mic samples (at mic_sample_rate)
        // ВАЖНО: используем get_samples() + clear() вместо индексации,
        // потому что в capture.rs есть sliding window buffer,
        // который удаляет старые сэмплы после 30 секунд
        let new_mic_samples_raw = mic_capture.get_samples();
        mic_capture.clear(); // Очищаем буфер после чтения

        // Resample if needed
        let new_mic_samples: Vec<f32> = if need_resample && !new_mic_samples_raw.is_empty() {
            match resample(&new_mic_samples_raw, mic_sample_rate, SAMPLE_RATE) {
                Ok(resampled) => resampled,
                Err(e) => {
                    tracing::warn!("Resample failed: {}, using raw samples", e);
                    new_mic_samples_raw.clone()
                }
            }
        } else {
            new_mic_samples_raw.clone()
        };

        // Collect system audio samples if available
        let mut sys_level: f32 = 0.0;
        let mut sys_recv_count = 0u32;
        if let Some(ref sys) = sys_capture {
            loop {
                match sys.get_receiver().try_recv() {
                    Ok(data) => {
                        if data.channel == AudioChannel::System {
                            sys_buffer.extend_from_slice(&data.samples);
                            sys_recv_count += 1;
                            // Calculate RMS for sys level
                            if !data.samples.is_empty() {
                                let rms: f32 = (data.samples.iter().map(|s| s * s).sum::<f32>()
                                    / data.samples.len() as f32)
                                    .sqrt();
                                sys_level = (rms * 300.0).min(100.0);
                            }
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        // Нормально - канал пуст, выходим из цикла
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        // КРИТИЧНО: Swift процесс завершился или упал!
                        if !sys_disconnected {
                            tracing::error!("❌ System audio channel DISCONNECTED! Swift screencapture-audio process likely crashed.");
                            sys_disconnected = true;
                        }
                        break;
                    }
                }
            }
            
            // Отслеживание застоя системного аудио
            if sys_recv_count > 0 {
                sys_empty_streak = 0; // Сброс счётчика
            } else {
                sys_empty_streak += 1;
                if sys_empty_streak == SYS_EMPTY_WARNING_THRESHOLD {
                    tracing::warn!("⚠️ No system audio for {} iterations (~2 sec)! sys_buffer={}, mic_buffer={}", 
                        sys_empty_streak, sys_buffer.len(), mic_buffer.len());
                }
            }
        }

        // Накапливаем микрофонные семплы, выравниваем по системным
        if !new_mic_samples.is_empty() {
            mic_buffer.extend_from_slice(&new_mic_samples);
        }

        // Check mute flags
        let is_mic_muted = mic_muted.load(Ordering::Relaxed);
        let is_sys_muted = sys_muted.load(Ordering::Relaxed);

        // Log every 20 iterations (1 second)
        loop_count += 1;
        if loop_count % 20 == 0 {
            tracing::info!(
                "Recording loop #{}: new_raw={}, new_resampled={}, mic_buf={}, sys_buf={}, muted=({},{})",
                loop_count,
                new_mic_samples_raw.len(),
                new_mic_samples.len(),
                mic_buffer.len(),
                sys_buffer.len(),
                is_mic_muted,
                is_sys_muted
            );
        }
        
        // Log mute state changes (only when they change)
        static LAST_MIC_MUTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        static LAST_SYS_MUTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        
        let last_mic = LAST_MIC_MUTED.swap(is_mic_muted, Ordering::Relaxed);
        let last_sys = LAST_SYS_MUTED.swap(is_sys_muted, Ordering::Relaxed);
        
        if last_mic != is_mic_muted || last_sys != is_sys_muted {
            tracing::info!("🔇 Mute state changed: mic_muted={}, sys_muted={}", is_mic_muted, is_sys_muted);
        }

        if sys_capture.is_some() {
            // FALLBACK: Если системный канал отключился или долго не отвечает,
            // генерируем тишину для системного аудио чтобы не блокировать запись
            if (sys_disconnected || sys_empty_streak >= SYS_EMPTY_WARNING_THRESHOLD) && sys_buffer.is_empty() && !mic_buffer.is_empty() {
                // Генерируем тишину в размере микрофонного буфера
                let silence_len = mic_buffer.len();
                sys_buffer.extend(std::iter::repeat(0.0f32).take(silence_len));
                
                // Логируем только первый раз после обнаружения проблемы
                if !sys_fallback_logged {
                    tracing::warn!("🔇 System audio unavailable, using silence fallback ({} samples)", silence_len);
                    sys_fallback_logged = true;
                }
            }
            
            // Стерео режим: пишем и обрабатываем только выровненные пары mic/sys
            let min_len = mic_buffer.len().min(sys_buffer.len());
            if min_len > 0 {
                let mic_chunk = mic_buffer.drain(..min_len).collect::<Vec<_>>();
                let sys_chunk = sys_buffer.drain(..min_len).collect::<Vec<_>>();

                // Apply mute: replace with silence (zeros) if muted
                let mic_chunk_final: Vec<f32> = if is_mic_muted {
                    vec![0.0; mic_chunk.len()]
                } else {
                    mic_chunk.clone()
                };
                let sys_chunk_final: Vec<f32> = if is_sys_muted {
                    vec![0.0; sys_chunk.len()]
                } else {
                    sys_chunk.clone()
                };

                if let Err(e) = mp3_writer.write_stereo(&mic_chunk_final, &sys_chunk_final) {
                    tracing::error!("Failed to write stereo MP3: {}", e);
                }

                // Process through chunk buffer (стерео всегда при наличии capture_system)
                // Use muted samples for chunk buffer too, so transcription sees silence
                chunk_buffer.process_stereo(&mic_chunk_final, &sys_chunk_final);
            }
        } else if !new_mic_samples.is_empty() {
            // Моно режим: только микрофон
            // Apply mute for mono mode too
            let mic_samples_final: Vec<f32> = if is_mic_muted {
                vec![0.0; new_mic_samples.len()]
            } else {
                new_mic_samples.clone()
            };
            
            if let Err(e) = mp3_writer.write(&mic_samples_final) {
                tracing::error!("Failed to write MP3: {}", e);
            }
            chunk_buffer.process(&mic_samples_final);
        }

        // УДАЛЕНО: больше не нужно отслеживать last_mic_sample_count

        // Check for completed chunks
        while let Some(event) = chunk_buffer.try_recv() {
            // ИСПРАВЛЕНО: Всегда транскрибируем чанки, даже при остановке
            // Чанк уже создан и должен быть обработан для полноты данных
            
            let chunk_meta = ChunkMeta::from_event(&event, &session_id);
            let chunk_path = data_dir
                .join("chunks")
                .join(format!("chunk_{:04}.json", event.index));

            tracing::info!(
                "Chunk created: {} ({}-{} ms)",
                event.index,
                event.start_ms,
                event.end_ms
            );

            // Emit chunk_created event (status: pending)
            let duration_ns = (chunk_meta.end_ms - chunk_meta.start_ms) as u64 * 1_000_000;
            let _ = app_handle.emit(
                "chunk_created",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunk": {
                        "id": chunk_meta.id,
                        "index": chunk_meta.index,
                        "startMs": chunk_meta.start_ms,
                        "endMs": chunk_meta.end_ms,
                        "duration": duration_ns,
                        "status": "pending",
                        "isStereo": chunk_buffer.has_separate_channels(),
                    }
                }),
            );

            // ИСПРАВЛЕНО: Всегда запускаем транскрипцию (убрали условие is_stopping)
            // ✅ Транскрипция в ФОНОВОМ ПОТОКЕ, чтобы не блокировать запись и audio_level
            // Emit chunk_transcribing event
            let _ = app_handle.emit(
                "chunk_transcribing",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunkId": chunk_meta.id,
                    "chunkIndex": chunk_meta.index,
                }),
            );

            // Проверяем доступность слота для транскрипции (семафор)
            if !try_acquire_transcription_slot() {
                tracing::warn!(
                    "Transcription slot not available (max {} concurrent), chunk {} added to pending queue",
                    MAX_CONCURRENT_TRANSCRIPTIONS,
                    chunk_meta.index
                );
                
                // Добавляем в очередь pending для retry на следующей итерации
                let is_stereo = chunk_buffer.has_separate_channels();
                let (mic_samples, sys_samples, sample_rate) = if is_stereo {
                    let mic = chunk_buffer.get_mic_samples_range(event.start_ms, event.end_ms);
                    let sys = chunk_buffer.get_sys_samples_range(event.start_ms, event.end_ms);
                    (mic, sys, chunk_buffer.sample_rate())
                } else {
                    let samples = chunk_buffer.get_samples_range(event.start_ms, event.end_ms);
                    (samples, Vec::new(), chunk_buffer.sample_rate())
                };
                
                pending_transcriptions.push_back(PendingTranscription {
                    chunk_meta: chunk_meta.clone(),
                    chunk_path: chunk_path.clone(),
                    mic_samples,
                    sys_samples,
                    sample_rate,
                    is_stereo,
                });
                
                // Сохраняем чанк как pending
                if let Err(e) = chunk_meta.save(&chunk_path) {
                    tracing::error!("Failed to save chunk meta: {}", e);
                }
                chunks.push(chunk_meta);
                continue;
            }

            // Клонируем все необходимые данные для фонового потока
            let bg_chunk_meta = chunk_meta.clone();
            let bg_chunk_path = chunk_path.clone();
            let bg_session_id = session_id.clone();
            let bg_app_handle = app_handle.clone();
            let bg_transcription_config = transcription_config.clone();
            let bg_drain_tx = drain_tx.clone();
            let bg_voiceprint_matcher = voiceprint_matcher.clone();
            let chunk_end_ms = event.end_ms;
            
            if chunk_buffer.has_separate_channels() {
                // Stereo mode: transcribe each channel separately
                let mic_samples = chunk_buffer.get_mic_samples_range(event.start_ms, event.end_ms);
                let sys_samples = chunk_buffer.get_sys_samples_range(event.start_ms, event.end_ms);
                let sample_rate = chunk_buffer.sample_rate();
                
                if !mic_samples.is_empty() || !sys_samples.is_empty() {
                    std::thread::spawn(move || {
                        let transcribed = transcribe_chunk_stereo(
                            bg_chunk_meta,
                            &mic_samples,
                            &sys_samples,
                            sample_rate,
                            &bg_transcription_config,
                            &bg_session_id,
                            &bg_app_handle,
                            bg_voiceprint_matcher.as_deref(),
                        );
                        // Сохраняем результат транскрипции
                        if let Err(e) = transcribed.save(&bg_chunk_path) {
                            tracing::error!("Failed to save transcribed chunk: {}", e);
                        }
                        // Сигнал на очистку буфера после транскрипции
                        let _ = bg_drain_tx.send(chunk_end_ms);
                        // Освобождаем слот транскрипции
                        release_transcription_slot();
                    });
                } else {
                    // Нет данных для транскрипции - освобождаем слот
                    release_transcription_slot();
                }
            } else {
                // Mono mode
                let chunk_samples = chunk_buffer.get_samples_range(event.start_ms, event.end_ms);
                let sample_rate = chunk_buffer.sample_rate();
                
                if !chunk_samples.is_empty() {
                    std::thread::spawn(move || {
                        let transcribed = transcribe_chunk_samples(
                            bg_chunk_meta,
                            &chunk_samples,
                            sample_rate,
                            &bg_transcription_config,
                            &bg_session_id,
                            &bg_app_handle,
                        );
                        // Сохраняем результат транскрипции
                        if let Err(e) = transcribed.save(&bg_chunk_path) {
                            tracing::error!("Failed to save transcribed chunk: {}", e);
                        }
                        // Сигнал на очистку буфера после транскрипции
                        let _ = bg_drain_tx.send(chunk_end_ms);
                        // Освобождаем слот транскрипции
                        release_transcription_slot();
                    });
                } else {
                    // Нет данных для транскрипции - освобождаем слот
                    release_transcription_slot();
                }
            }

            // Save chunk meta
            if let Err(e) = chunk_meta.save(&chunk_path) {
                tracing::error!("Failed to save chunk meta: {}", e);
            }

            chunks.push(chunk_meta);
        }

        // Обработка сигналов очистки буфера от фоновых потоков транскрипции
        // Это критически важно для предотвращения бесконечного роста памяти
        while let Ok(drain_up_to_ms) = drain_rx.try_recv() {
            chunk_buffer.drain_processed_samples(drain_up_to_ms);
        }

        // Emit audio level (always emit, even if no samples yet)
        // When muted, show 0 level (but show actual level in logs for debugging)
        let elapsed = start_time.elapsed().as_secs_f64();
        // Используем последние ~800 сэмплов из свежих данных для расчёта уровня
        let recent_start = new_mic_samples_raw.len().saturating_sub(800);
        let recent = &new_mic_samples_raw[recent_start..];
        let actual_mic_level = if !recent.is_empty() {
            let rms: f32 = (recent.iter().map(|s| s * s).sum::<f32>() / recent.len() as f32).sqrt();
            (rms * 300.0).min(100.0)
        } else {
            0.0
        };
        
        // Apply mute to displayed levels
        let mic_level = if is_mic_muted { 0.0 } else { actual_mic_level };
        let sys_level_final = if is_sys_muted { 0.0 } else { sys_level };

        // Log first few emissions for debugging
        if loop_count <= 5 {
            tracing::info!(
                "Emitting audio-level: mic_level={:.1}, sys_level={:.1}, mic_muted={}, sys_muted={}, elapsed={:.2}s",
                mic_level,
                sys_level_final,
                is_mic_muted,
                is_sys_muted,
                elapsed
            );
        }

        let _ = app_handle.emit(
            "audio_level",
            serde_json::json!({
                "micLevel": mic_level,
                "sysLevel": sys_level_final,
                "duration": elapsed,
                "micMuted": is_mic_muted,
                "sysMuted": is_sys_muted,
            }),
        );
    }

    // ===== ОБРАБОТКА PENDING ТРАНСКРИПЦИЙ =====
    // Перед финальной обработкой буферов обрабатываем все pending транскрипции
    if !pending_transcriptions.is_empty() {
        tracing::info!(
            "Processing {} pending transcriptions before session end",
            pending_transcriptions.len()
        );
        
        while let Some(pending) = pending_transcriptions.pop_front() {
            // Ждём слот (блокирующе, т.к. сессия уже останавливается)
            while !try_acquire_transcription_slot() {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            
            tracing::info!(
                "Processing pending chunk {} (remaining: {})",
                pending.chunk_meta.index,
                pending_transcriptions.len()
            );
            
            // Emit chunk_transcribing event
            let _ = app_handle.emit(
                "chunk_transcribing",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunkId": pending.chunk_meta.id,
                    "chunkIndex": pending.chunk_meta.index,
                }),
            );
            
            let bg_chunk_meta = pending.chunk_meta;
            let bg_chunk_path = pending.chunk_path;
            let bg_session_id = session_id.clone();
            let bg_app_handle = app_handle.clone();
            let bg_transcription_config = transcription_config.clone();
            let bg_drain_tx = drain_tx.clone();
            let bg_voiceprint_matcher = voiceprint_matcher.clone();
            let chunk_end_ms = bg_chunk_meta.end_ms;
            
            if pending.is_stereo {
                let mic_samples = pending.mic_samples;
                let sys_samples = pending.sys_samples;
                let sample_rate = pending.sample_rate;
                
                std::thread::spawn(move || {
                    let transcribed = transcribe_chunk_stereo(
                        bg_chunk_meta,
                        &mic_samples,
                        &sys_samples,
                        sample_rate,
                        &bg_transcription_config,
                        &bg_session_id,
                        &bg_app_handle,
                        bg_voiceprint_matcher.as_deref(),
                    );
                    if let Err(e) = transcribed.save(&bg_chunk_path) {
                        tracing::error!("Failed to save transcribed chunk: {}", e);
                    }
                    let _ = bg_drain_tx.send(chunk_end_ms);
                    release_transcription_slot();
                });
            } else {
                let chunk_samples = pending.mic_samples;
                let sample_rate = pending.sample_rate;
                
                std::thread::spawn(move || {
                    let transcribed = transcribe_chunk_samples(
                        bg_chunk_meta,
                        &chunk_samples,
                        sample_rate,
                        &bg_transcription_config,
                        &bg_session_id,
                        &bg_app_handle,
                    );
                    if let Err(e) = transcribed.save(&bg_chunk_path) {
                        tracing::error!("Failed to save transcribed chunk: {}", e);
                    }
                    let _ = bg_drain_tx.send(chunk_end_ms);
                    release_transcription_slot();
                });
            }
        }
    }
    
    // ===== ФИНАЛЬНАЯ ОБРАБОТКА БУФЕРОВ =====
    // После break из цикла могут остаться необработанные семплы:
    // 1. В mic_buffer/sys_buffer (невыровненные данные)
    // 2. В capture (последние семплы, которые не были прочитаны)
    tracing::info!(
        "Final buffer flush: mic_buffer={}, sys_buffer={} samples before processing",
        mic_buffer.len(),
        sys_buffer.len()
    );

    // Получаем последние семплы из capture устройств
    let final_mic_samples_raw = mic_capture.get_samples();
    if !final_mic_samples_raw.is_empty() {
        // Ресэмплируем микрофон к 24kHz если нужно
        let final_mic_samples = if mic_sample_rate != 24000 {
            match crate::audio::resample(&final_mic_samples_raw, mic_sample_rate, 24000) {
                Ok(resampled) => resampled,
                Err(e) => {
                    tracing::error!("Failed to resample final mic samples: {}", e);
                    final_mic_samples_raw.clone()
                }
            }
        } else {
            final_mic_samples_raw.clone()
        };
        mic_buffer.extend_from_slice(&final_mic_samples);
        tracing::info!(
            "Final mic samples: raw={}, resampled={}, mic_buffer now={}",
            final_mic_samples_raw.len(),
            final_mic_samples.len(),
            mic_buffer.len()
        );
    }

    // Получаем последние семплы из системного аудио
    if let Some(ref sys) = sys_capture {
        while let Ok(channel_data) = sys.get_receiver().try_recv() {
            sys_buffer.extend_from_slice(&channel_data.samples);
        }
        tracing::info!("Final sys_buffer after drain: {} samples", sys_buffer.len());
    }

    // Обрабатываем оставшиеся выровненные данные
    if sys_capture.is_some() {
        let min_len = mic_buffer.len().min(sys_buffer.len());
        if min_len > 0 {
            let mic_final: Vec<f32> = mic_buffer.drain(..min_len).collect();
            let sys_final: Vec<f32> = sys_buffer.drain(..min_len).collect();

            // Записываем в MP3
            if let Err(e) = mp3_writer.write_stereo(&mic_final, &sys_final) {
                tracing::error!("Failed to write final stereo samples to MP3: {}", e);
            }

            // Передаём в chunk_buffer
            chunk_buffer.process_stereo(&mic_final, &sys_final);
            tracing::info!(
                "Final stereo samples processed: {} samples, remaining mic={}, sys={}",
                min_len,
                mic_buffer.len(),
                sys_buffer.len()
            );
        }

        // Если остались только микрофонные семплы (системный канал отстал) - добавляем тишину
        if !mic_buffer.is_empty() {
            let remaining_mic = mic_buffer.len();
            let silence = vec![0.0f32; remaining_mic];
            if let Err(e) = mp3_writer.write_stereo(&mic_buffer, &silence) {
                tracing::error!("Failed to write final mic+silence to MP3: {}", e);
            }
            chunk_buffer.process_stereo(&mic_buffer, &silence);
            mic_buffer.clear();
            tracing::info!("Final mic samples (with silence for sys): {} samples", remaining_mic);
        }
    } else {
        // Моно режим - обрабатываем только микрофон
        if !mic_buffer.is_empty() {
            if let Err(e) = mp3_writer.write(&mic_buffer) {
                tracing::error!("Failed to write final mono samples to MP3: {}", e);
            }
            chunk_buffer.process(&mic_buffer);
            tracing::info!("Final mono samples processed: {}", mic_buffer.len());
            mic_buffer.clear();
        }
    }

    tracing::info!(
        "ChunkBuffer after final processing: total_duration={}ms",
        chunk_buffer.total_duration_ms()
    );

    // Flush remaining audio as final chunk
    // ИСПРАВЛЕНО: Ожидаем завершения транскрипции финального чанка
    let final_transcription_handle: Option<std::thread::JoinHandle<()>> = if let Some(event) = chunk_buffer.flush_all() {
        let chunk_meta = ChunkMeta::from_event(&event, &session_id);
        let chunk_path = data_dir
            .join("chunks")
            .join(format!("chunk_{:04}.json", event.index));

        tracing::info!(
            "Final chunk created: {} ({}-{} ms), starting transcription",
            event.index,
            event.start_ms,
            event.end_ms
        );

        // Emit chunk_created event (status: pending)
        let final_duration_ns = (chunk_meta.end_ms - chunk_meta.start_ms) as u64 * 1_000_000;
        let _ = app_handle.emit(
            "chunk_created",
            serde_json::json!({
                "sessionId": session_id,
                "chunk": {
                    "id": chunk_meta.id,
                    "index": chunk_meta.index,
                    "startMs": chunk_meta.start_ms,
                    "endMs": chunk_meta.end_ms,
                    "duration": final_duration_ns,
                    "status": "pending",
                    "isStereo": chunk_buffer.has_separate_channels(),
                }
            }),
        );

        // Клонируем данные для фонового потока
        let bg_chunk_meta = chunk_meta.clone();
        let bg_chunk_path = chunk_path.clone();
        let bg_session_id = session_id.clone();
        let bg_app_handle = app_handle.clone();
        let bg_transcription_config = transcription_config.clone();
        let bg_voiceprint_matcher = voiceprint_matcher.clone();
        
        // Отправляем событие о начале транскрипции
        let _ = app_handle.emit(
            "chunk_transcribing",
            serde_json::json!({
                "sessionId": session_id,
                "chunkId": chunk_meta.id,
                "chunkIndex": chunk_meta.index,
            }),
        );
        
        // Запускаем транскрипцию и сохраняем handle для ожидания
        let handle = if chunk_buffer.has_separate_channels() {
            let mic_samples = chunk_buffer.get_mic_samples_range(event.start_ms, event.end_ms);
            let sys_samples = chunk_buffer.get_sys_samples_range(event.start_ms, event.end_ms);
            let sample_rate = chunk_buffer.sample_rate();
            
            if !mic_samples.is_empty() || !sys_samples.is_empty() {
                Some(std::thread::spawn(move || {
                    let transcribed = transcribe_chunk_stereo(
                        bg_chunk_meta,
                        &mic_samples,
                        &sys_samples,
                        sample_rate,
                        &bg_transcription_config,
                        &bg_session_id,
                        &bg_app_handle,
                        bg_voiceprint_matcher.as_deref(),
                    );
                    let _ = transcribed.save(&bg_chunk_path);
                }))
            } else {
                None
            }
        } else {
            let chunk_samples = chunk_buffer.get_samples_range(event.start_ms, event.end_ms);
            let sample_rate = chunk_buffer.sample_rate();
            
            if !chunk_samples.is_empty() {
                Some(std::thread::spawn(move || {
                    let transcribed = transcribe_chunk_samples(
                        bg_chunk_meta,
                        &chunk_samples,
                        sample_rate,
                        &bg_transcription_config,
                        &bg_session_id,
                        &bg_app_handle,
                    );
                    let _ = transcribed.save(&bg_chunk_path);
                }))
            } else {
                None
            }
        };

        // Сохраняем чанк со статусом pending (транскрипция обновит файл)
        let _ = chunk_meta.save(&chunk_path);
        chunks.push(chunk_meta);
        
        handle
    } else {
        None
    };

    // Stop system audio capture first
    if let Some(ref mut sys) = sys_capture {
        let _ = sys.stop();
    }

    // Stop mic capture
    let samples = mic_capture.stop();
    let sample_count = samples.len();
    
    let duration_ms = mp3_writer.duration_ms();
    let segment_count = mp3_writer.segment_count();

    tracing::info!(
        "Recording stopped: session={}, {} samples, {} ms, {} chunks, {} MP3 segments",
        session_id,
        sample_count,
        duration_ms,
        chunks.len(),
        segment_count
    );

    // Если несколько сегментов - нужна склейка
    if segment_count > 1 {
        // Emit finalizing event
        let _ = app_handle.emit(
            "session_finalizing",
            serde_json::json!({
                "sessionId": session_id,
                "stage": "concatenating",
                "message": "Сохранение записи...",
            }),
        );

        tracing::info!("Concatenating {} MP3 segments...", segment_count);
        
        match mp3_writer.concatenate() {
            Ok(final_path) => {
                tracing::info!("MP3 segments concatenated successfully: {:?}", final_path);
            }
            Err(e) => {
                tracing::error!("Failed to concatenate MP3 segments: {}", e);
                // Сегменты остаются на диске, можно склеить позже
            }
        }
    } else {
        // Один сегмент - просто закрываем и переименовываем
        if let Err(e) = mp3_writer.concatenate() {
            tracing::error!("Failed to finalize single segment: {}", e);
        }
    }

    // ИСПРАВЛЕНО: Ожидаем завершения транскрипции финального чанка
    // перед отправкой session_stopped
    if let Some(handle) = final_transcription_handle {
        tracing::info!("Waiting for final chunk transcription to complete...");
        
        // Emit event что ждём завершения транскрипции
        let _ = app_handle.emit(
            "session_finalizing",
            serde_json::json!({
                "sessionId": session_id,
                "stage": "final_transcription",
                "message": "Завершение транскрипции...",
            }),
        );
        
        match handle.join() {
            Ok(_) => {
                tracing::info!("Final chunk transcription completed successfully");
            }
            Err(e) => {
                tracing::error!("Final chunk transcription thread panicked: {:?}", e);
            }
        }
    }

    // ИСПРАВЛЕНО: Ожидаем завершения ВСЕХ pending транскрипций
    // (не только финального чанка, но и тех что были запущены ранее)
    let mut wait_count = 0;
    while get_active_transcriptions() > 0 {
        if wait_count == 0 {
            let pending = get_active_transcriptions();
            tracing::info!("Waiting for {} pending transcription(s) to complete...", pending);
            
            let _ = app_handle.emit(
                "session_finalizing",
                serde_json::json!({
                    "sessionId": session_id,
                    "stage": "pending_transcriptions",
                    "message": format!("Завершение транскрипции ({})...", pending),
                    "pendingCount": pending,
                }),
            );
        }
        
        std::thread::sleep(std::time::Duration::from_millis(100));
        wait_count += 1;
        
        // Логируем прогресс каждые 5 секунд
        if wait_count % 50 == 0 {
            let remaining = get_active_transcriptions();
            tracing::info!("Still waiting for {} pending transcription(s)...", remaining);
        }
        
        // Таймаут 5 минут чтобы не застрять навечно
        if wait_count > 3000 {
            tracing::warn!("Timeout waiting for pending transcriptions, {} still active", get_active_transcriptions());
            break;
        }
    }
    
    if wait_count > 0 {
        tracing::info!("All pending transcriptions completed after {}ms", wait_count * 100);
    }

    // Emit session_stopped event
    let _ = app_handle.emit(
        "session_stopped",
        serde_json::json!({
            "sessionId": session_id,
        }),
    );

    RecordingResult {
        session_id,
        duration_ms,
        sample_count,
        chunks,
    }
}

/// Transcribe chunk samples and update ChunkMeta
/// This function resamples audio if needed and runs transcription
fn transcribe_chunk_samples(
    mut chunk_meta: ChunkMeta,
    samples: &[f32],
    source_sample_rate: u32,
    config: &TranscriptionConfig,
    session_id: &str,
    app_handle: &tauri::AppHandle,
) -> ChunkMeta {
    #[allow(unused_imports)]
    use tauri::Emitter;

    tracing::info!(
        "Transcribing chunk {}: {} samples @ {}Hz, model={}",
        chunk_meta.index,
        samples.len(),
        source_sample_rate,
        config.model_id
    );

    // Resample to 16kHz if needed
    let samples_16k = if source_sample_rate != TRANSCRIPTION_SAMPLE_RATE {
        resample(samples, source_sample_rate, TRANSCRIPTION_SAMPLE_RATE)
            .unwrap_or_else(|_| samples.to_vec())
    } else {
        samples.to_vec()
    };

    // Run transcription
    match transcribe_samples_sync(
        &samples_16k,
        &config.model_id,
        &config.language,
        config.hybrid_enabled,
        &config.hybrid_secondary_model_id,
        &config.hotwords,
        config.hybrid_use_llm,
        &config.hybrid_mode,
        &config.ollama_model,
        &config.ollama_url,
    ) {
        Ok(segments) => {
            // Convert segments to dialogue with word-level timestamps
            let dialogue: Vec<DialogueEntry> = segments
                .into_iter()
                .map(|seg| {
                    // Offset word timestamps by chunk start
                    let words_with_offset: Vec<aiwisper_types::TranscriptWord> = seg
                        .words
                        .into_iter()
                        .map(|mut w| {
                            w.start += chunk_meta.start_ms;
                            w.end += chunk_meta.start_ms;
                            w
                        })
                        .collect();

                    DialogueEntry {
                        start: seg.start + chunk_meta.start_ms,
                        end: seg.end + chunk_meta.start_ms,
                        text: seg.text,
                        speaker: seg.speaker.unwrap_or_else(|| "mic".to_string()),
                        words: words_with_offset,
                    }
                })
                .collect();

            // Update chunk meta
            chunk_meta.transcription = dialogue
                .iter()
                .map(|d| d.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            chunk_meta.dialogue = dialogue.clone();
            chunk_meta.status = "completed".to_string();

            // Проверяем на галлюцинации и автоматически исключаем чанк
            if is_hallucination(&chunk_meta.transcription) {
                chunk_meta.excluded = true;
                tracing::warn!(
                    "Chunk {} auto-excluded: hallucination detected in '{}'",
                    chunk_meta.index,
                    chunk_meta.transcription
                );
            }

            tracing::info!(
                "Chunk {} transcribed: {} segments, {} chars{}",
                chunk_meta.index,
                dialogue.len(),
                chunk_meta.transcription.len(),
                if chunk_meta.excluded { " (auto-excluded)" } else { "" }
            );

            // Emit chunk_transcribed event
            let duration_ns = (chunk_meta.end_ms - chunk_meta.start_ms) as u64 * 1_000_000;
            let _ = app_handle.emit(
                "chunk_transcribed",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunk": {
                        "id": chunk_meta.id,
                        "index": chunk_meta.index,
                        "startMs": chunk_meta.start_ms,
                        "endMs": chunk_meta.end_ms,
                        "duration": duration_ns,
                        "status": "completed",
                        "transcription": chunk_meta.transcription,
                        "dialogue": dialogue,
                        "isStereo": false,
                        "excluded": chunk_meta.excluded,
                    }
                }),
            );
        }
        Err(e) => {
            tracing::error!("Failed to transcribe chunk {}: {}", chunk_meta.index, e);
            chunk_meta.status = "error".to_string();

            // Emit chunk_error event
            let _ = app_handle.emit(
                "chunk_error",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunkId": chunk_meta.id,
                    "error": e.to_string(),
                }),
            );
        }
    }

    chunk_meta
}

/// Transcribe stereo chunk (separate mic and sys channels)
fn transcribe_chunk_stereo(
    mut chunk_meta: ChunkMeta,
    mic_samples: &[f32],
    sys_samples: &[f32],
    source_sample_rate: u32,
    config: &TranscriptionConfig,
    session_id: &str,
    app_handle: &tauri::AppHandle,
    voiceprint_matcher: Option<&aiwisper_ml::VoicePrintMatcher>,
) -> ChunkMeta {
    #[allow(unused_imports)]
    use tauri::Emitter;

    // Check for silent channels to avoid hallucinations like "Продолжение следует..."
    let mic_is_silent = is_silent_with_vad(mic_samples, source_sample_rate);
    let sys_is_silent = is_silent_with_vad(sys_samples, source_sample_rate);
    
    // Calculate RMS for debugging
    let mic_rms = calculate_rms(mic_samples);
    let sys_rms = calculate_rms(sys_samples);
    
    tracing::info!(
        "Transcribing stereo chunk {}: mic={} sys={} samples @ {}Hz, rms=(mic:{:.6}, sys:{:.6}), silent=(mic:{}, sys:{})",
        chunk_meta.index,
        mic_samples.len(),
        sys_samples.len(),
        source_sample_rate,
        mic_rms,
        sys_rms,
        mic_is_silent,
        sys_is_silent
    );

    // Collect segments from both channels for word-level merge
    let mut mic_segments: Vec<aiwisper_types::TranscriptSegment> = Vec::new();
    let mut sys_segments: Vec<aiwisper_types::TranscriptSegment> = Vec::new();

    // Transcribe mic channel (skip if silent)
    if !mic_samples.is_empty() && !mic_is_silent {
        let mic_16k = if source_sample_rate != TRANSCRIPTION_SAMPLE_RATE {
            resample(mic_samples, source_sample_rate, TRANSCRIPTION_SAMPLE_RATE)
                .unwrap_or_else(|_| mic_samples.to_vec())
        } else {
            mic_samples.to_vec()
        };

        if let Ok(segments) = transcribe_samples_sync(
            &mic_16k,
            &config.model_id,
            &config.language,
            config.hybrid_enabled,
            &config.hybrid_secondary_model_id,
            &config.hotwords,
            config.hybrid_use_llm,
            &config.hybrid_mode,
            &config.ollama_model,
            &config.ollama_url,
        ) {
            // Tag segments with "mic" speaker for merge algorithm
            for mut seg in segments {
                seg.speaker = Some("mic".to_string());
                mic_segments.push(seg);
            }
        }
    } else if mic_is_silent {
        tracing::debug!("Skipping MIC channel for chunk {} - silent", chunk_meta.index);
    }

    // Transcribe sys channel with optional diarization (skip if silent)
    if !sys_samples.is_empty() && !sys_is_silent {
        let sys_16k = if source_sample_rate != TRANSCRIPTION_SAMPLE_RATE {
            resample(sys_samples, source_sample_rate, TRANSCRIPTION_SAMPLE_RATE)
                .unwrap_or_else(|_| sys_samples.to_vec())
        } else {
            sys_samples.to_vec()
        };

        // First transcribe
        if let Ok(segments) = transcribe_samples_sync(
            &sys_16k,
            &config.model_id,
            &config.language,
            config.hybrid_enabled,
            &config.hybrid_secondary_model_id,
            &config.hotwords,
            config.hybrid_use_llm,
            &config.hybrid_mode,
            &config.ollama_model,
            &config.ollama_url,
        ) {
            // If diarization enabled, apply speaker labels
            if config.diarization_enabled && config.diarization_provider == "coreml" {
                // Run diarization on sys channel with embeddings for voiceprint matching
                match diarize_samples_with_embeddings(&sys_16k) {
                    Ok(diarization_result) if !diarization_result.segments.is_empty() => {
                        tracing::info!(
                            "Diarization found {} speaker segments, {} embeddings in sys channel",
                            diarization_result.segments.len(),
                            diarization_result.speaker_embeddings.len()
                        );
                        
                        // Build speaker_id -> recognized name mapping using voiceprints
                        let mut speaker_names: std::collections::HashMap<i32, String> = std::collections::HashMap::new();
                        
                        if let Some(matcher) = voiceprint_matcher {
                            for emb in &diarization_result.speaker_embeddings {
                                // Try to match embedding against saved voiceprints
                                if let Some(match_result) = matcher.match_with_auto_update(&emb.embedding) {
                                    tracing::info!(
                                        "Speaker {} matched to '{}' (similarity={:.2}, confidence={:?})",
                                        emb.speaker,
                                        match_result.voiceprint.name,
                                        match_result.similarity,
                                        match_result.confidence
                                    );
                                    speaker_names.insert(emb.speaker, match_result.voiceprint.name.clone());
                                } else {
                                    tracing::debug!(
                                        "Speaker {} not matched to any voiceprint (embedding len={})",
                                        emb.speaker,
                                        emb.embedding.len()
                                    );
                                }
                            }
                        }
                        
                        // Apply speaker labels to transcription segments
                        for mut seg in segments {
                            let speaker_id = find_speaker_for_segment(
                                seg.start as f32 / 1000.0,  // convert ms to seconds
                                seg.end as f32 / 1000.0,
                                &diarization_result.segments,
                            );
                            // Use recognized name if available, otherwise "Собеседник N"
                            let speaker_name = speaker_names
                                .get(&speaker_id)
                                .cloned()
                                .unwrap_or_else(|| format!("Собеседник {}", speaker_id + 1));
                            seg.speaker = Some(speaker_name);
                            sys_segments.push(seg);
                        }
                    }
                    Ok(_) => {
                        // No diarization segments, use default "sys"
                        tracing::debug!("No diarization segments found, using 'sys'");
                        for mut seg in segments {
                            seg.speaker = Some("sys".to_string());
                            sys_segments.push(seg);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Diarization failed, falling back to 'sys': {}", e);
                        for mut seg in segments {
                            seg.speaker = Some("sys".to_string());
                            sys_segments.push(seg);
                        }
                    }
                }
            } else {
                // No diarization, use simple "sys" label
                for mut seg in segments {
                    seg.speaker = Some("sys".to_string());
                    sys_segments.push(seg);
                }
            }
        }
    }

    // Use word-level dialogue merge algorithm
    let merged_segments = aiwisper_ml::merge_words_to_dialogue(mic_segments, sys_segments);
    
    tracing::debug!(
        "Dialogue merge for chunk {}: {} merged segments",
        chunk_meta.index,
        merged_segments.len()
    );

    // Convert merged segments to DialogueEntry with chunk offset
    let all_dialogue: Vec<DialogueEntry> = merged_segments
        .into_iter()
        .map(|seg| {
            // Offset words timestamps by chunk start
            let words_with_offset: Vec<aiwisper_types::TranscriptWord> = seg
                .words
                .into_iter()
                .map(|mut w| {
                    w.start += chunk_meta.start_ms;
                    w.end += chunk_meta.start_ms;
                    w
                })
                .collect();

            DialogueEntry {
                start: seg.start + chunk_meta.start_ms,
                end: seg.end + chunk_meta.start_ms,
                text: seg.text,
                speaker: seg.speaker.unwrap_or_else(|| "unknown".to_string()),
                words: words_with_offset,
            }
        })
        .collect();

    // Update chunk meta
    chunk_meta.transcription = all_dialogue
        .iter()
        .map(|d| d.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    chunk_meta.dialogue = all_dialogue.clone();
    chunk_meta.status = "completed".to_string();

    // Проверяем на галлюцинации и автоматически исключаем чанк
    // Галлюцинации часто возникают на тихих участках записи
    if is_hallucination(&chunk_meta.transcription) {
        chunk_meta.excluded = true;
        tracing::warn!(
            "Chunk {} auto-excluded: hallucination detected in '{}'",
            chunk_meta.index,
            chunk_meta.transcription
        );
    }

    tracing::info!(
        "Stereo chunk {} transcribed: {} segments total{}",
        chunk_meta.index,
        all_dialogue.len(),
        if chunk_meta.excluded { " (auto-excluded)" } else { "" }
    );

    // Emit chunk_transcribed event
    let stereo_duration_ns = (chunk_meta.end_ms - chunk_meta.start_ms) as u64 * 1_000_000;
    let _ = app_handle.emit(
        "chunk_transcribed",
        serde_json::json!({
            "sessionId": session_id,
            "chunk": {
                "id": chunk_meta.id,
                "index": chunk_meta.index,
                "startMs": chunk_meta.start_ms,
                "endMs": chunk_meta.end_ms,
                "duration": stereo_duration_ns,
                "status": "completed",
                "transcription": chunk_meta.transcription,
                "dialogue": all_dialogue,
                "isStereo": true,
                "excluded": chunk_meta.excluded,
            }
        }),
    );

    chunk_meta
}

/// Synchronous transcription (called from recording thread)
///
/// Использует глобальный кэш движков для избежания многократной загрузки модели.
/// Теперь поддерживает полные настройки hybrid/LLM из конфига пользователя.
fn transcribe_samples_sync(
    samples: &[f32],
    model_id: &str,
    language: &str,
    hybrid_enabled: bool,
    hybrid_secondary_model_id: &str,
    hotwords: &[String],
    // Новые параметры для LLM enhancement
    hybrid_use_llm: bool,
    hybrid_mode: &str,
    ollama_model: &str,
    ollama_url: &str,
) -> Result<Vec<aiwisper_types::TranscriptSegment>> {
    use aiwisper_ml::{
        get_or_create_engine_cached, HybridMode, HybridTranscriber, HybridTranscriptionConfig,
        VotingConfig,
    };

    // Get primary engine from cache (or create if first time)
    let primary_engine = get_or_create_engine_cached(model_id, language)?;

    // If hybrid enabled, create secondary engine and use HybridTranscriber
    if hybrid_enabled && !hybrid_secondary_model_id.is_empty() {
        tracing::info!(
            "Using hybrid transcription: primary={}, secondary={}, mode={}, use_llm={}",
            model_id,
            hybrid_secondary_model_id,
            hybrid_mode,
            hybrid_use_llm
        );

        let secondary_engine = match get_or_create_engine_cached(hybrid_secondary_model_id, language) {
            Ok(e) => Some(e),
            Err(e) => {
                tracing::warn!(
                    "Failed to create secondary engine: {}, using primary only",
                    e
                );
                None
            }
        };

        // Парсим режим из настроек
        let mode = match hybrid_mode.to_lowercase().as_str() {
            "confidence" => HybridMode::Confidence,
            _ => HybridMode::Parallel,
        };

        let config = HybridTranscriptionConfig {
            enabled: true,
            secondary_model_id: hybrid_secondary_model_id.to_string(),
            confidence_threshold: 0.5,
            mode,
            hotwords: hotwords.to_vec(),
            voting: VotingConfig::default(),
            // Теперь используем настройки пользователя вместо hardcoded значений
            use_llm_for_merge: hybrid_use_llm,
            ollama_model: ollama_model.to_string(),
            ollama_url: ollama_url.to_string(),
        };

        let transcriber = HybridTranscriber::new(primary_engine, secondary_engine, config);
        let result = transcriber.transcribe(samples)?;

        tracing::info!(
            "Hybrid transcription complete: {} segments, {} improvements",
            result.segments.len(),
            result.improvements.len()
        );

        Ok(result.segments)
    } else {
        // Single engine mode
        primary_engine.transcribe_with_segments(samples)
    }
}

/// Run diarization on audio samples and return full result with speaker embeddings
/// Used for voiceprint matching
fn diarize_samples_with_embeddings(samples: &[f32]) -> Result<aiwisper_ml::DiarizationResult> {
    use aiwisper_ml::{DiarizationResult, FluidDiarizationConfig, FluidDiarizationEngine};

    // Check if diarization engine is available
    if !FluidDiarizationEngine::is_available() {
        tracing::debug!("FluidDiarization not available, skipping");
        return Ok(DiarizationResult {
            segments: vec![],
            num_speakers: 0,
            speaker_embeddings: vec![],
        });
    }

    let config = FluidDiarizationConfig {
        binary_path: None,  // Auto-detect
        clustering_threshold: 0.70,
        min_segment_duration: 0.2,
        vbx_max_iterations: 30,
        min_gap_duration: 0.15,
        debug: false,
    };

    let engine = FluidDiarizationEngine::new(config)?;
    engine.diarize_with_embeddings(samples)
}

/// Find the speaker ID for a given time range based on diarization segments
fn find_speaker_for_segment(
    start_sec: f32,
    end_sec: f32,
    speaker_segments: &[aiwisper_types::SpeakerSegment],
) -> i32 {
    let mid_point = (start_sec + end_sec) / 2.0;
    
    // Find segment that contains the midpoint
    for seg in speaker_segments {
        if seg.start <= mid_point && mid_point <= seg.end {
            return seg.speaker;
        }
    }
    
    // Fallback: find closest segment
    let mut closest_speaker = 0;
    let mut min_distance = f32::MAX;
    
    for seg in speaker_segments {
        let seg_mid = (seg.start + seg.end) / 2.0;
        let distance = (mid_point - seg_mid).abs();
        if distance < min_distance {
            min_distance = distance;
            closest_speaker = seg.speaker;
        }
    }
    
    closest_speaker
}
