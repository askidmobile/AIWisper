//! Application state management
//!
//! Manages global state for the Tauri application including
//! audio capture, ML engines, and settings.
//!
//! Note: AudioCapture is NOT stored in state because cpal::Stream is not Send+Sync.
//! Audio capture is managed through a dedicated thread via tokio::spawn_blocking.

pub mod recording;

#[allow(unused_imports)]
use aiwisper_audio::AudioCapture;
use aiwisper_ml::TranscriptionEngine;
use aiwisper_types::{
    AudioDevice, ModelInfo, RecordingState, Settings, TranscriptSegment, TranscriptionResult,
};
use anyhow::Result;
use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot};
#[allow(unused_imports)]
use uuid::Uuid;

use crate::providers::ProviderRegistry;

/// Get the base data directory for aiwisper (legacy path for Go backend compatibility)
fn get_data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|p| p.join("aiwisper"))
}

/// Get the sessions directory
fn get_sessions_dir() -> Option<PathBuf> {
    get_data_dir().map(|p| p.join("sessions"))
}

/// Get path to settings file (using config.json for compatibility with Go/Electron backend)
fn get_settings_path() -> Option<PathBuf> {
    get_data_dir().map(|p| p.join("config.json"))
}

/// Config file structure (compatible with Go/Electron backend)
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ConfigFile {
    settings: ConfigSettings,
}

/// Settings in config.json format (camelCase for compatibility)
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigSettings {
    language: String,
    model_id: String,
    #[serde(default)]
    echo_cancel: f32,
    #[serde(default)]
    use_voice_isolation: bool,
    #[serde(default)]
    capture_system: bool,
    #[serde(default)]
    ollama_model: String,
    #[serde(default)]
    ollama_url: String,
    #[serde(default)]
    auto_retranscribe: bool,
    #[serde(default)]
    theme: String,
    #[serde(default)]
    hybrid_enabled: bool,
    #[serde(default)]
    hybrid_secondary_model_id: String,
}

/// Load settings from disk (config.json format)
fn load_settings_from_disk() -> Settings {
    if let Some(path) = get_settings_path() {
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str::<ConfigFile>(&content) {
                    Ok(config) => {
                        tracing::info!("Loaded settings from {:?}", path);
                        let cs = config.settings;
                        return Settings {
                            language: cs.language,
                            hotwords: vec![],
                            enable_diarization: true,
                            transcription_engine: "whisper".to_string(),
                            whisper_model: cs.model_id,
                            enable_vad: true,
                            audio_device_id: None,
                            echo_cancellation: cs.echo_cancel > 0.0,
                            hybrid_enabled: cs.hybrid_enabled,
                            hybrid_secondary_model_id: cs.hybrid_secondary_model_id,
                        };
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse config.json: {}", e);
                    }
                },
                Err(e) => {
                    tracing::warn!("Failed to read config.json: {}", e);
                }
            }
        } else {
            tracing::debug!("config.json not found at {:?}, using defaults", path);
        }
    }
    Settings::default()
}

/// Save settings to disk (config.json format, preserving existing fields)
fn save_settings_to_disk(settings: &Settings) -> anyhow::Result<()> {
    if let Some(path) = get_settings_path() {
        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        
        // Read existing config to preserve other fields
        let mut config_value: serde_json::Value = if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| {
                    serde_json::json!({"settings": {}})
                }),
                Err(_) => serde_json::json!({"settings": {}}),
            }
        } else {
            serde_json::json!({"settings": {}})
        };
        
        // Update only the settings we manage
        if let Some(obj) = config_value.get_mut("settings") {
            if let Some(settings_obj) = obj.as_object_mut() {
                settings_obj.insert("language".to_string(), serde_json::json!(settings.language));
                settings_obj.insert("modelId".to_string(), serde_json::json!(settings.whisper_model));
                settings_obj.insert("hybridEnabled".to_string(), serde_json::json!(settings.hybrid_enabled));
                settings_obj.insert("hybridSecondaryModelId".to_string(), serde_json::json!(settings.hybrid_secondary_model_id));
            }
        }
        
        let content = serde_json::to_string_pretty(&config_value)?;
        std::fs::write(&path, content)?;
        tracing::info!("Saved settings to {:?}", path);
    }
    Ok(())
}

// ============================================================================
// Structures for parsing Go backend's meta.json format
// ============================================================================

/// Go backend session metadata (from meta.json)
/// Fields are needed for JSON deserialization even if not all are used
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct GoSessionMeta {
    id: String,
    start_time: String,
    #[serde(default)]
    end_time: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    total_duration: i64, // nanoseconds in Go, but sometimes stored as milliseconds
    #[serde(default)]
    sample_count: i64,
    #[serde(default)]
    chunks_count: usize,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    chunks: Vec<GoChunkMeta>,
}

/// Go backend chunk metadata
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct GoChunkMeta {
    id: String,
    #[serde(default)]
    index: i32,
    #[serde(default)]
    start_ms: i64,
    #[serde(default)]
    end_ms: i64,
    #[serde(default)]
    transcription: Option<String>,
    #[serde(default)]
    mic_text: Option<String>,
    #[serde(default)]
    sys_text: Option<String>,
    #[serde(default)]
    dialogue: Vec<GoDialogueSegment>,
}

/// Go backend dialogue segment
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoDialogueSegment {
    #[serde(default)]
    start: i64,
    #[serde(default)]
    end: i64,
    #[serde(default)]
    text: String,
    #[serde(default)]
    speaker: String,
}

/// Load sessions from disk (Go backend format)
fn load_sessions_from_disk() -> Vec<crate::commands::session::Session> {
    let sessions_dir = match get_sessions_dir() {
        Some(dir) => dir,
        None => {
            tracing::warn!("Could not determine sessions directory");
            return Vec::new();
        }
    };

    if !sessions_dir.exists() {
        tracing::info!("Sessions directory does not exist: {:?}", sessions_dir);
        return Vec::new();
    }

    let mut sessions = Vec::new();

    // Read all subdirectories
    let entries = match std::fs::read_dir(&sessions_dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!("Failed to read sessions directory: {}", e);
            return Vec::new();
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let meta_path = path.join("meta.json");
        if !meta_path.exists() {
            continue;
        }

        // Read and parse meta.json
        match std::fs::read_to_string(&meta_path) {
            Ok(content) => match serde_json::from_str::<GoSessionMeta>(&content) {
                Ok(meta) => {
                    let session = convert_go_session_to_rust(meta, &path);
                    sessions.push(session);
                }
                Err(e) => {
                    tracing::warn!("Failed to parse {:?}: {}", meta_path, e);
                }
            },
            Err(e) => {
                tracing::warn!("Failed to read {:?}: {}", meta_path, e);
            }
        }
    }

    // Sort by created_at descending (newest first)
    sessions.sort_by(|a, b| b.start_time.cmp(&a.start_time));

    tracing::info!("Loaded {} sessions from disk", sessions.len());
    sessions
}

/// Convert Go session format to Rust format (matching frontend Session interface)
fn convert_go_session_to_rust(
    meta: GoSessionMeta,
    session_dir: &std::path::Path,
) -> crate::commands::session::Session {
    use crate::commands::session::Session;

    // Duration: Go stores totalDuration in milliseconds (e.g., 1220666 = ~20 min)
    let total_duration = meta.total_duration as u64;

    // Load chunks from chunks/ directory
    let chunks = load_chunks_from_dir(session_dir);
    tracing::debug!(
        "Session {} loaded with {} chunks",
        meta.id,
        chunks.len()
    );

    // Read summary from separate file if exists
    let summary = meta.summary.or_else(|| {
        let summary_path = session_dir.join("summary.txt");
        std::fs::read_to_string(summary_path).ok()
    });

    Session {
        id: meta.id,
        start_time: meta.start_time,
        end_time: meta.end_time,
        status: "completed".to_string(),
        chunks,
        data_dir: session_dir.to_string_lossy().to_string(),
        total_duration,
        title: meta.title,
        tags: meta.tags,
        summary,
        language: Some(meta.language),
        model: Some(meta.model),
    }
}

/// Load chunks from chunks/ directory
fn load_chunks_from_dir(
    session_dir: &std::path::Path,
) -> Vec<crate::commands::session::SessionChunk> {
    let chunks_dir = session_dir.join("chunks");
    if !chunks_dir.exists() {
        return Vec::new();
    }

    let mut all_chunks = Vec::new();

    // Read all JSON files in chunks directory, sorted by name
    let mut entries: Vec<_> = match std::fs::read_dir(&chunks_dir) {
        Ok(e) => e.flatten().collect(),
        Err(_) => return Vec::new(),
    };
    entries.sort_by_key(|e| e.file_name());

    for (idx, entry) in entries.iter().enumerate() {
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    match serde_json::from_str::<GoChunkMeta>(&content) {
                        Ok(chunk) => {
                            // Convert chunk to our format
                            let converted = convert_chunk_to_rust(chunk, idx as i32);
                            tracing::trace!(
                                "Loaded chunk {} with {} dialogue entries, transcription len={}",
                                converted.id,
                                converted.dialogue.len(),
                                converted.transcription.len()
                            );
                            all_chunks.push(converted);
                        }
                        Err(e) => {
                            tracing::warn!("Failed to parse chunk {:?}: {}", path, e);
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to read chunk {:?}: {}", path, e);
                }
            }
        }
    }

    all_chunks
}

/// Convert a Go chunk to Rust SessionChunk (matching frontend Chunk interface)
fn convert_chunk_to_rust(chunk: GoChunkMeta, index: i32) -> crate::commands::session::SessionChunk {
    use crate::commands::session::{DialogueSegment, SessionChunk};

    // Convert dialogue segments
    let dialogue: Vec<DialogueSegment> = chunk
        .dialogue
        .into_iter()
        .map(|seg| DialogueSegment {
            start: seg.start,
            end: seg.end,
            text: seg.text,
            speaker: Some(seg.speaker),
        })
        .collect();

    // Get transcription text
    let transcription = chunk.transcription.clone().unwrap_or_default();

    SessionChunk {
        id: chunk.id,
        index,
        start_ms: chunk.start_ms,
        end_ms: chunk.end_ms,
        duration: chunk.end_ms - chunk.start_ms,
        transcription,
        mic_text: chunk.mic_text,
        sys_text: chunk.sys_text,
        dialogue,
        is_stereo: true, // Go backend uses stereo
        status: "completed".to_string(),
        speaker: None,
    }
}

/// Handle to control audio capture running in a dedicated thread
pub struct AudioCaptureHandle {
    /// Stop flag (atomic bool for thread-safe signaling)
    stop_flag: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// Stop signal sender (legacy, kept for compatibility)
    stop_tx: Option<oneshot::Sender<()>>,
    /// Join handle for the capture thread
    join_handle: Option<std::thread::JoinHandle<Vec<f32>>>,
}

impl AudioCaptureHandle {
    /// Stop recording and get captured samples
    pub fn stop(mut self) -> Vec<f32> {
        // Set stop flag
        if let Some(flag) = self.stop_flag.take() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        // Also send stop signal (legacy)
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }

        // Wait for thread to finish and get samples
        if let Some(handle) = self.join_handle.take() {
            handle.join().unwrap_or_default()
        } else {
            Vec::new()
        }
    }
}

/// Main application state
#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    /// Audio capture handle (managed in separate thread for Send+Sync)
    /// Legacy: kept for potential future direct capture mode
    #[allow(dead_code)]
    audio_handle: RwLock<Option<AudioCaptureHandle>>,

    /// New recording handle (with MP3 writer and chunk buffer)
    recording_handle: RwLock<Option<recording::RecordingHandle>>,

    /// Primary transcription engine
    transcriber: RwLock<Option<Box<dyn TranscriptionEngine>>>,

    /// Application settings
    settings: RwLock<Settings>,

    /// Broadcast channel for transcript segments
    transcript_tx: broadcast::Sender<TranscriptSegment>,

    /// Flag indicating if engines are initialized
    initialized: RwLock<bool>,

    /// In-memory sessions
    sessions: RwLock<Vec<crate::commands::session::Session>>,

    /// Diarization state
    diarization_enabled: RwLock<bool>,
    diarization_provider: RwLock<String>,
    
    /// Cancellation token for full retranscription
    retranscription_cancel: RwLock<Option<tokio_util::sync::CancellationToken>>,
    
    /// Provider registry for STT and LLM cloud/local providers
    provider_registry: ProviderRegistry,
}

impl AppState {
    /// Create new application state
    pub fn new() -> Self {
        let (transcript_tx, _) = broadcast::channel(100);

        // Load existing sessions from disk
        let sessions = load_sessions_from_disk();

        // Load settings from disk (persisted between restarts)
        let settings = load_settings_from_disk();
        tracing::info!(
            "Loaded settings: language={}, model={}",
            settings.language,
            settings.whisper_model
        );

        Self {
            inner: Arc::new(AppStateInner {
                audio_handle: RwLock::new(None),
                recording_handle: RwLock::new(None),
                transcriber: RwLock::new(None),
                settings: RwLock::new(settings),
                transcript_tx,
                initialized: RwLock::new(false),
                sessions: RwLock::new(sessions),
                diarization_enabled: RwLock::new(false),
                diarization_provider: RwLock::new(String::new()),
                retranscription_cancel: RwLock::new(None),
                provider_registry: ProviderRegistry::new(),
            }),
        }
    }

    /// Get the provider registry for STT/LLM cloud providers
    pub fn provider_registry(&self) -> &ProviderRegistry {
        &self.inner.provider_registry
    }

    /// Initialize ML engines
    pub async fn initialize_engines(&self) -> Result<()> {
        tracing::info!("Initializing ML engines...");

        // Initialize all providers (STT and LLM)
        self.inner.provider_registry.initialize_all_providers().await;

        // TODO: Initialize whisper-rs and other engines
        // This will be implemented in the ML module

        *self.inner.initialized.write() = true;
        tracing::info!("ML engines initialized");

        Ok(())
    }

    /// Start audio recording with MP3 saving and chunk detection
    ///
    /// Audio capture runs in a dedicated thread because cpal::Stream is not Send+Sync.
    /// Now includes:
    /// - MP3 recording to disk via FFmpeg
    /// - Automatic chunk segmentation via VAD
    /// - Session metadata persistence
    /// - Auto-transcription of chunks during recording
    pub async fn start_recording(
        &self,
        device_id: Option<String>,
        capture_system: bool,
        language_override: Option<String>,
        app_handle: tauri::AppHandle,
    ) -> Result<()> {
        // Check if already recording
        {
            let recording_handle = self.inner.recording_handle.read();
            if recording_handle.is_some() {
                anyhow::bail!("Recording already in progress");
            }
        }

        // Get settings for language and model
        let settings = self.inner.settings.read().clone();
        let language = language_override.unwrap_or_else(|| settings.language.clone());
        let model_id = if settings.whisper_model.is_empty() {
            "ggml-large-v3-turbo".to_string()
        } else {
            settings.whisper_model.clone()
        };

        // Build transcription config from settings
        let transcription_config = recording::TranscriptionConfig {
            model_id: model_id.clone(),
            language: language.clone(),
            hybrid_enabled: settings.hybrid_enabled,
            hybrid_secondary_model_id: settings.hybrid_secondary_model_id.clone(),
            hotwords: settings.hotwords.clone(),
        };

        // Start new recording with full MP3/chunk support
        let handle = recording::start_recording(
            device_id,
            &language,
            &model_id,
            capture_system,
            transcription_config,
            app_handle,
        )?;

        // Store handle
        *self.inner.recording_handle.write() = Some(handle);

        Ok(())
    }

    /// Set mute state for a specific channel during recording
    /// 
    /// channel: "mic" or "sys"
    /// muted: true to mute, false to unmute
    pub fn set_channel_mute(&self, channel: &str, muted: bool) -> Result<()> {
        let recording_handle = self.inner.recording_handle.read();
        let handle = recording_handle
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No recording in progress"))?;
        
        match channel {
            "mic" => handle.set_mic_muted(muted),
            "sys" => handle.set_sys_muted(muted),
            _ => return Err(anyhow::anyhow!("Unknown channel: {}", channel)),
        }
        
        Ok(())
    }

    /// Get current mute state for a channel
    pub fn get_channel_mute(&self, channel: &str) -> Result<bool> {
        let recording_handle = self.inner.recording_handle.read();
        let handle = recording_handle
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No recording in progress"))?;
        
        match channel {
            "mic" => Ok(handle.is_mic_muted()),
            "sys" => Ok(handle.is_sys_muted()),
            _ => Err(anyhow::anyhow!("Unknown channel: {}", channel)),
        }
    }

    /// Stop recording and create session
    ///
    /// Stops the recording, finalizes MP3 file, and creates a session with all chunks.
    /// Returns recording state with duration and sample count.
    pub async fn stop_recording(&self) -> Result<RecordingState> {
        use crate::commands::session::{DialogueSegment, Session, SessionChunk};

        // Take recording handle
        let handle = self
            .inner
            .recording_handle
            .write()
            .take()
            .ok_or_else(|| anyhow::anyhow!("No recording in progress"))?;

        // Stop recording and get result
        let result = handle.stop()?;

        // Update session meta
        let session_dir = dirs::data_local_dir()
            .map(|p| p.join("aiwisper").join("sessions").join(&result.session_id))
            .ok_or_else(|| anyhow::anyhow!("Could not determine sessions directory"))?;

        // Build session for in-memory store
        let now = chrono::Utc::now();
        let chunks: Vec<SessionChunk> = result
            .chunks
            .iter()
            .map(|chunk| SessionChunk {
                id: chunk.id.clone(),
                index: chunk.index,
                start_ms: chunk.start_ms,
                end_ms: chunk.end_ms,
                duration: chunk.end_ms - chunk.start_ms,
                transcription: chunk.transcription.clone(),
                mic_text: chunk.mic_text.clone(),
                sys_text: chunk.sys_text.clone(),
                dialogue: chunk
                    .dialogue
                    .iter()
                    .map(|d| DialogueSegment {
                        start: d.start,
                        end: d.end,
                        text: d.text.clone(),
                        speaker: Some(d.speaker.clone()),
                    })
                    .collect(),
                is_stereo: false,
                status: chunk.status.clone(),
                speaker: Some("mic".to_string()),
            })
            .collect();

        // Формируем title с учётом длительности в минутах и секундах
        let total_secs = result.duration_ms / 1000;
        let mins = total_secs / 60;
        let secs = total_secs % 60;
        let title = if mins > 0 {
            format!(
                "Запись {} · {} мин {} сек",
                now.format("%d.%m %H:%M"),
                mins,
                secs
            )
        } else {
            format!(
                "Запись {} · {} сек",
                now.format("%d.%m %H:%M"),
                secs
            )
        };

        let session = Session {
            id: result.session_id.clone(),
            start_time: now.to_rfc3339(),
            end_time: Some(now.to_rfc3339()),
            status: "completed".to_string(),
            chunks,
            data_dir: session_dir.to_string_lossy().to_string(),
            total_duration: result.duration_ms,
            title: Some(title),
            tags: vec![],
            summary: None,
            language: Some(self.inner.settings.read().language.clone()),
            model: Some(self.inner.settings.read().whisper_model.clone()),
        };

        // Add to in-memory sessions
        tracing::info!("Adding session {} to in-memory store", result.session_id);
        self.inner.sessions.write().push(session);
        let total_sessions = self.inner.sessions.read().len();
        tracing::info!("Total sessions in memory after push: {}", total_sessions);

        // Reload sessions from disk to ensure consistency
        // (in case meta.json was updated)

        Ok(RecordingState {
            session_id: result.session_id.clone(),
            duration_ms: result.duration_ms,
            sample_count: result.sample_count,
        })
    }

    /// Get available audio devices
    pub async fn get_audio_devices(&self) -> Result<Vec<AudioDevice>> {
        // Run in blocking thread because cpal may not be Send+Sync
        tokio::task::spawn_blocking(|| aiwisper_audio::list_input_devices()).await?
    }

    /// Transcribe an audio file
    pub async fn transcribe_file(&self, path: &str) -> Result<TranscriptionResult> {
        let transcriber = self.inner.transcriber.read();

        let engine = transcriber
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Transcription engine not initialized"))?;

        // Load audio from file
        let samples = aiwisper_audio::load_audio_file(path)?;

        // Transcribe
        engine.transcribe(&samples)
    }

    /// Subscribe to transcript segments
    pub fn subscribe_transcripts(&self) -> broadcast::Receiver<TranscriptSegment> {
        self.inner.transcript_tx.subscribe()
    }

    /// Get waveform for session - computes from audio file or loads from cache
    pub async fn get_waveform(&self, session_id: &str) -> Result<serde_json::Value> {
        let sessions = self.inner.sessions.read();
        let session = sessions
            .iter()
            .find(|s| s.id == session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;
        let session_duration = session.total_duration;
        drop(sessions);

        let sessions_dir =
            get_sessions_dir().ok_or_else(|| anyhow::anyhow!("Sessions directory not found"))?;
        let session_path = sessions_dir.join(session_id);

        // 1. Try to load cached waveform from meta.json
        let meta_path = session_path.join("meta.json");
        if meta_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&meta_path) {
                #[derive(serde::Deserialize)]
                struct MetaWithWaveform {
                    waveform: Option<serde_json::Value>,
                }

                if let Ok(meta) = serde_json::from_str::<MetaWithWaveform>(&content) {
                    if let Some(waveform) = meta.waveform {
                        tracing::debug!("Loaded waveform from meta.json cache");
                        return Ok(waveform);
                    }
                }
            }
        }

        // 2. Try to compute waveform from audio file
        let mp3_path = session_path.join("full.mp3");
        if mp3_path.exists() {
            match Self::compute_waveform_from_file(&mp3_path) {
                Ok(waveform) => {
                    tracing::info!("Computed waveform from {}", mp3_path.display());

                    // Cache waveform to meta.json for next time
                    Self::cache_waveform_to_meta(&meta_path, &waveform);

                    return Ok(waveform);
                }
                Err(e) => {
                    tracing::warn!("Failed to compute waveform from MP3: {}", e);
                }
            }
        }

        // 3. Fallback: build minimal fake waveform based on duration
        tracing::debug!("Using fallback waveform for session {}", session_id);
        let duration = session_duration as f32 / 1000.0;
        let sample_duration = 0.05; // 50ms bins
        let bins = (duration / sample_duration).max(1.0) as usize;
        let channels = 2;
        let mut peaks = vec![vec![0.05f32; bins], vec![0.05f32; bins]];
        if bins > 0 {
            peaks[0][0] = 0.2;
            peaks[1][0] = 0.15;
        }

        let waveform = serde_json::json!({
            "peaks": peaks,
            "rms": peaks.clone(),
            "rmsAbsolute": peaks,
            "sampleDuration": sample_duration,
            "sampleCount": bins,
            "duration": duration,
            "channelCount": channels,
        });

        Ok(waveform)
    }

    /// Compute waveform from audio file using symphonia
    fn compute_waveform_from_file(path: &std::path::Path) -> Result<serde_json::Value> {
        use symphonia::core::audio::SampleBuffer;
        use symphonia::core::codecs::DecoderOptions;
        use symphonia::core::formats::FormatOptions;
        use symphonia::core::io::MediaSourceStream;
        use symphonia::core::meta::MetadataOptions;
        use symphonia::core::probe::Hint;

        const SAMPLE_COUNT: usize = 400; // Number of waveform bins

        let file = std::fs::File::open(path)?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions::default();
        let decoder_opts = DecoderOptions::default();

        let probed =
            symphonia::default::get_probe().format(&hint, mss, &format_opts, &metadata_opts)?;

        let mut format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
            .ok_or_else(|| anyhow::anyhow!("No audio track found"))?;

        let track_id = track.id;
        let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
        let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

        let mut decoder =
            symphonia::default::get_codecs().make(&track.codec_params, &decoder_opts)?;

        // Collect all samples
        let mut all_samples: Vec<Vec<f32>> = vec![Vec::new(); channels];

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break
                }
                Err(e) => return Err(e.into()),
            };

            if packet.track_id() != track_id {
                continue;
            }

            let decoded = decoder.decode(&packet)?;
            let spec = *decoded.spec();
            let duration = decoded.capacity() as u64;

            let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
            sample_buf.copy_interleaved_ref(decoded);
            let samples = sample_buf.samples();

            // De-interleave samples into channels
            for (i, sample) in samples.iter().enumerate() {
                let ch = i % channels;
                all_samples[ch].push(*sample);
            }
        }

        if all_samples[0].is_empty() {
            return Err(anyhow::anyhow!("No audio samples found"));
        }

        let total_samples = all_samples[0].len();
        let duration_sec = total_samples as f32 / sample_rate as f32;
        let samples_per_bin = (total_samples / SAMPLE_COUNT).max(1);
        let sample_duration = duration_sec / SAMPLE_COUNT as f32;

        let mut peaks: Vec<Vec<f32>> = vec![vec![0.0; SAMPLE_COUNT]; channels];
        let mut rms: Vec<Vec<f32>> = vec![vec![0.0; SAMPLE_COUNT]; channels];
        let mut rms_absolute: Vec<Vec<f32>> = vec![vec![0.0; SAMPLE_COUNT]; channels];

        let mut max_peak: f32 = 1e-9;
        let mut max_rms: f32 = 1e-9;

        for ch in 0..channels {
            for bin in 0..SAMPLE_COUNT {
                let start = bin * samples_per_bin;
                let end = ((bin + 1) * samples_per_bin).min(total_samples);

                let mut peak: f32 = 0.0;
                let mut sum_squares: f32 = 0.0;
                let mut count = 0;

                for i in start..end {
                    let sample = all_samples[ch][i].abs();
                    if sample > peak {
                        peak = sample;
                    }
                    sum_squares += all_samples[ch][i] * all_samples[ch][i];
                    count += 1;
                }

                let rms_value = if count > 0 {
                    (sum_squares / count as f32).sqrt()
                } else {
                    0.0
                };

                peaks[ch][bin] = peak;
                rms[ch][bin] = rms_value;
                rms_absolute[ch][bin] = rms_value;

                if peak > max_peak {
                    max_peak = peak;
                }
                if rms_value > max_rms {
                    max_rms = rms_value;
                }
            }
        }

        // Normalize peaks and rms for display
        let peak_norm = if max_peak > 0.0 { max_peak } else { 1.0 };
        let rms_norm = if max_rms > 0.0 { max_rms } else { 1.0 };

        let peaks_normalized: Vec<Vec<f32>> = peaks
            .iter()
            .map(|ch| ch.iter().map(|v| v / peak_norm).collect())
            .collect();
        let rms_normalized: Vec<Vec<f32>> = rms
            .iter()
            .map(|ch| ch.iter().map(|v| v / rms_norm).collect())
            .collect();

        Ok(serde_json::json!({
            "peaks": peaks_normalized,
            "rms": rms_normalized,
            "rmsAbsolute": rms_absolute,
            "sampleDuration": sample_duration,
            "sampleCount": SAMPLE_COUNT,
            "duration": duration_sec,
            "channelCount": channels,
        }))
    }

    /// Cache waveform to meta.json
    fn cache_waveform_to_meta(meta_path: &std::path::Path, waveform: &serde_json::Value) {
        if let Ok(content) = std::fs::read_to_string(meta_path) {
            if let Ok(mut meta) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(obj) = meta.as_object_mut() {
                    obj.insert("waveform".to_string(), waveform.clone());
                    if let Ok(updated) = serde_json::to_string_pretty(&meta) {
                        if let Err(e) = std::fs::write(meta_path, updated) {
                            tracing::warn!("Failed to cache waveform: {}", e);
                        } else {
                            tracing::debug!("Cached waveform to meta.json");
                        }
                    }
                }
            }
        }
    }

    /// Set transcription language
    pub async fn set_language(&self, language: &str) -> Result<()> {
        {
            let mut settings = self.inner.settings.write();
            settings.language = language.to_string();
            
            // Persist to disk
            if let Err(e) = save_settings_to_disk(&settings) {
                tracing::error!("Failed to save settings to disk: {}", e);
            }
        }

        // Update active transcription engine with new language
        if let Some(engine) = self.inner.transcriber.write().as_mut() {
            if let Err(e) = engine.set_language(language) {
                tracing::warn!("Failed to set language on transcriber: {}", e);
            }
        }

        tracing::info!("Language set to: {}", language);
        Ok(())
    }

    /// Set hotwords
    pub async fn set_hotwords(&self, hotwords: Vec<String>) -> Result<()> {
        let mut settings = self.inner.settings.write();
        settings.hotwords = hotwords;

        // TODO: Update transcription engine

        Ok(())
    }

    /// Get current settings
    pub async fn get_settings(&self) -> Result<Settings> {
        Ok(self.inner.settings.read().clone())
    }

    /// Update settings
    pub async fn set_settings(&self, settings: Settings) -> Result<()> {
        tracing::info!(
            "Saving settings: language={}, model={}",
            settings.language,
            settings.whisper_model
        );
        *self.inner.settings.write() = settings.clone();
        
        // Persist to disk
        if let Err(e) = save_settings_to_disk(&settings) {
            tracing::error!("Failed to save settings to disk: {}", e);
        }
        
        Ok(())
    }

    /// List available models from static registry with actual download status
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let mut models = Self::get_model_registry();

        // Get models directory - use Application Support on macOS
        let models_dir = dirs::data_local_dir().map(|p| p.join("aiwisper").join("models"));

        tracing::info!("Models directory: {:?}", models_dir);

        if let Some(ref models_dir) = models_dir {
            // Check if directory exists
            if models_dir.exists() {
                tracing::info!("Models directory exists, checking for downloaded models");

                // List files in directory for debugging
                if let Ok(entries) = std::fs::read_dir(models_dir) {
                    let files: Vec<_> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .collect();
                    tracing::info!("Files in models dir: {:?}", files);
                }
            } else {
                tracing::warn!("Models directory does not exist: {:?}", models_dir);
            }

            for model in models.iter_mut() {
                // Check multiple possible file names for each model
                let possible_names =
                    Self::get_model_file_names(&model.id, model.download_url.as_deref());

                for file_name in &possible_names {
                    let model_path = models_dir.join(file_name);
                    if model_path.exists() {
                        tracing::info!("Found model {} at {:?}", model.id, model_path);
                        model.status = "downloaded".to_string();
                        model.progress = 100.0;
                        model.path = Some(model_path.to_string_lossy().to_string());
                        break;
                    }
                }
            }
        }

        Ok(models)
    }

    /// Get possible file names for a model (handles both Go and Rust naming conventions)
    fn get_model_file_names(model_id: &str, download_url: Option<&str>) -> Vec<String> {
        let mut names = Vec::new();

        // First, add name from URL if available
        if let Some(url) = download_url {
            if let Some(file_name) = url.split('/').last() {
                names.push(file_name.to_string());
            }
        }

        // Add model ID-based names (Go backend naming convention)
        match model_id {
            // GigaAM models - Go backend uses different naming
            "gigaam-v3-ctc" => {
                names.push("gigaam-v3-ctc.onnx".to_string());
                names.push("v3_ctc.int8.onnx".to_string());
            }
            "gigaam-v3-e2e-ctc" => {
                names.push("gigaam-v3-e2e-ctc.onnx".to_string());
                names.push("v3_e2e_ctc.int8.onnx".to_string());
            }
            // Whisper GGML models
            "ggml-large-v3-turbo" => {
                names.push("ggml-large-v3-turbo.bin".to_string());
            }
            "ggml-large-v3" => {
                names.push("ggml-large-v3.bin".to_string());
            }
            "ggml-medium" => {
                names.push("ggml-medium.bin".to_string());
            }
            "ggml-small" => {
                names.push("ggml-small.bin".to_string());
            }
            "ggml-base" => {
                names.push("ggml-base.bin".to_string());
            }
            "ggml-tiny" => {
                names.push("ggml-tiny.bin".to_string());
            }
            // VAD model
            "silero-vad-v5" => {
                names.push("silero_vad.onnx".to_string());
            }
            // Diarization models
            "wespeaker-voxceleb-resnet34" => {
                names.push("wespeaker_en_voxceleb_resnet34.onnx".to_string());
            }
            // Parakeet - managed by FluidAudio, always "downloaded"
            "parakeet-tdt-v3" => {
                // Parakeet is downloaded by FluidAudio on first use
                // We mark it as downloaded since FluidAudio handles this
            }
            _ => {}
        }

        // Add model_id.bin and model_id.onnx as fallbacks
        names.push(format!("{}.bin", model_id));
        names.push(format!("{}.onnx", model_id));

        names
    }

    /// Static model registry matching Go backend
    fn get_model_registry() -> Vec<ModelInfo> {
        vec![
            // ===== GGML модели (whisper.cpp) =====
            ModelInfo {
                id: "ggml-tiny".to_string(),
                name: "Tiny".to_string(),
                model_type: "ggml".to_string(),
                engine: "whisper".to_string(),
                size: "74 MB".to_string(),
                size_bytes: 77_691_713,
                description: "Самая быстрая модель, базовое качество".to_string(),
                languages: vec!["multi".to_string()],
                wer: None,
                speed: "~10x".to_string(),
                recommended: false,
                download_url: Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin".to_string()),
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            ModelInfo {
                id: "ggml-base".to_string(),
                name: "Base".to_string(),
                model_type: "ggml".to_string(),
                engine: "whisper".to_string(),
                size: "141 MB".to_string(),
                size_bytes: 147_951_465,
                description: "Хороший баланс скорости и качества".to_string(),
                languages: vec!["multi".to_string()],
                wer: None,
                speed: "~7x".to_string(),
                recommended: false,
                download_url: Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin".to_string()),
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            ModelInfo {
                id: "ggml-small".to_string(),
                name: "Small".to_string(),
                model_type: "ggml".to_string(),
                engine: "whisper".to_string(),
                size: "465 MB".to_string(),
                size_bytes: 487_601_967,
                description: "Хорошее качество распознавания".to_string(),
                languages: vec!["multi".to_string()],
                wer: None,
                speed: "~4x".to_string(),
                recommended: false,
                download_url: Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin".to_string()),
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            ModelInfo {
                id: "ggml-medium".to_string(),
                name: "Medium".to_string(),
                model_type: "ggml".to_string(),
                engine: "whisper".to_string(),
                size: "1.4 GB".to_string(),
                size_bytes: 1_533_774_781,
                description: "Высокое качество распознавания".to_string(),
                languages: vec!["multi".to_string()],
                wer: None,
                speed: "~2x".to_string(),
                recommended: false,
                download_url: Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin".to_string()),
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            ModelInfo {
                id: "ggml-large-v3-turbo".to_string(),
                name: "Large V3 Turbo".to_string(),
                model_type: "ggml".to_string(),
                engine: "whisper".to_string(),
                size: "1.5 GB".to_string(),
                size_bytes: 1_624_417_792,
                description: "Быстрая модель с высоким качеством".to_string(),
                languages: vec!["multi".to_string()],
                wer: None,
                speed: "~8x".to_string(),
                recommended: true,
                download_url: Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin".to_string()),
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            ModelInfo {
                id: "ggml-large-v3".to_string(),
                name: "Large V3".to_string(),
                model_type: "ggml".to_string(),
                engine: "whisper".to_string(),
                size: "2.9 GB".to_string(),
                size_bytes: 3_094_623_691,
                description: "Максимальное качество распознавания".to_string(),
                languages: vec!["multi".to_string()],
                wer: None,
                speed: "~1x".to_string(),
                recommended: true,
                download_url: Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin".to_string()),
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            // ===== CoreML модели (FluidAudio) =====
            ModelInfo {
                id: "parakeet-tdt-v3".to_string(),
                name: "Parakeet TDT v3 (Multilingual)".to_string(),
                model_type: "coreml".to_string(),
                engine: "fluid-asr".to_string(),
                size: "~640 MB".to_string(),
                size_bytes: 640_000_000,
                description: "NVIDIA Parakeet 0.6B - 25 европейских языков, WER 1.93%, работает на Apple Neural Engine".to_string(),
                languages: vec!["multi".to_string(), "en".to_string(), "ru".to_string(), "de".to_string(), "es".to_string(), "fr".to_string()],
                wer: Some("1.93%".to_string()),
                speed: "~110x".to_string(),
                recommended: true,
                download_url: None, // Managed by FluidAudio - downloads automatically on first use
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                // Parakeet is always "downloaded" because FluidAudio manages it automatically
                status: "downloaded".to_string(),
                progress: 100.0,
                error: None,
                path: Some("managed-by-fluidaudio".to_string()),
            },
            // ===== ONNX модели (GigaAM) =====
            ModelInfo {
                id: "gigaam-v3-ctc".to_string(),
                name: "GigaAM V3 CTC".to_string(),
                model_type: "onnx".to_string(),
                engine: "gigaam".to_string(),
                size: "225 MB".to_string(),
                size_bytes: 225_000_000,
                description: "Быстрая модель для русского языка (Sber GigaAM v3)".to_string(),
                languages: vec!["ru".to_string()],
                wer: Some("9.2%".to_string()),
                speed: "~50x (быстрая)".to_string(),
                recommended: true,
                download_url: Some("https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/main/v3_ctc.int8.onnx".to_string()),
                vocab_url: Some("https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/main/v3_vocab.txt".to_string()),
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            ModelInfo {
                id: "gigaam-v3-e2e-ctc".to_string(),
                name: "GigaAM V3 E2E CTC (с пунктуацией)".to_string(),
                model_type: "onnx".to_string(),
                engine: "gigaam".to_string(),
                size: "225 MB".to_string(),
                size_bytes: 225_000_000,
                description: "Быстрая модель с пунктуацией для русского (Sber GigaAM v3)".to_string(),
                languages: vec!["ru".to_string()],
                wer: Some("12.0%".to_string()),
                speed: "~50x (быстрая)".to_string(),
                recommended: true,
                download_url: Some("https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/main/v3_e2e_ctc.int8.onnx".to_string()),
                vocab_url: Some("https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/main/v3_e2e_ctc_vocab.txt".to_string()),
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            // ===== Модели диаризации =====
            ModelInfo {
                id: "pyannote-segmentation-3.0".to_string(),
                name: "Pyannote Segmentation 3.0".to_string(),
                model_type: "onnx".to_string(),
                engine: "diarization".to_string(),
                size: "5.9 MB".to_string(),
                size_bytes: 5_900_000,
                description: "Сегментация спикеров (pyannote.audio)".to_string(),
                languages: vec!["multi".to_string()],
                wer: None,
                speed: "~100x".to_string(),
                recommended: false,
                download_url: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2".to_string()),
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: Some("segmentation".to_string()),
                is_archive: true,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            ModelInfo {
                id: "wespeaker-voxceleb-resnet34".to_string(),
                name: "WeSpeaker ResNet34".to_string(),
                model_type: "onnx".to_string(),
                engine: "diarization".to_string(),
                size: "26 MB".to_string(),
                size_bytes: 26_851_029,
                description: "Speaker embedding (WeSpeaker ResNet34)".to_string(),
                languages: vec!["multi".to_string()],
                wer: None,
                speed: "~40x".to_string(),
                recommended: true,
                download_url: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx".to_string()),
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: Some("embedding".to_string()),
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
            // ===== VAD модель =====
            ModelInfo {
                id: "silero-vad-v5".to_string(),
                name: "Silero VAD v5".to_string(),
                model_type: "onnx".to_string(),
                engine: "vad".to_string(),
                size: "2.2 MB".to_string(),
                size_bytes: 2_327_524,
                description: "Enterprise-grade Voice Activity Detector (Silero)".to_string(),
                languages: vec!["multi".to_string()],
                wer: None,
                speed: "~1000x".to_string(),
                recommended: true,
                download_url: Some("https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx".to_string()),
                vocab_url: None,
                is_rnnt: false,
                decoder_url: None,
                joint_url: None,
                diarization_type: None,
                is_archive: false,
                status: "not_downloaded".to_string(),
                progress: 0.0,
                error: None,
                path: None,
            },
        ]
    }

    /// Download a model
    pub async fn download_model(&self, model_id: &str) -> Result<()> {
        let registry = Self::get_model_registry();
        let model = registry
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        let download_url = model
            .download_url
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Model has no download URL"))?;

        // Get models directory (legacy path for compatibility with Go backend)
        let models_dir = dirs::data_local_dir()
            .map(|p| p.join("aiwisper").join("models"))
            .ok_or_else(|| anyhow::anyhow!("Could not determine data directory"))?;

        // Create models directory if not exists
        std::fs::create_dir_all(&models_dir)?;

        let file_name = download_url.split('/').last().unwrap_or(&model.id);
        let model_path = models_dir.join(file_name);

        tracing::info!(
            "Downloading model {} from {} to {:?}",
            model_id,
            download_url,
            model_path
        );

        // Download using reqwest
        let client = reqwest::Client::new();
        let response = client
            .get(download_url)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to download model: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "Download failed with status: {}",
                response.status()
            ));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to read model bytes: {}", e))?;

        std::fs::write(&model_path, &bytes)?;

        tracing::info!("Model {} downloaded successfully", model_id);

        Ok(())
    }

    /// Cancel model download (stub - reqwest does not support cancellation easily)
    pub async fn cancel_download(&self, model_id: &str) -> Result<()> {
        tracing::info!("Cancel download requested for model: {}", model_id);
        // TODO: Implement download cancellation with CancellationToken
        Ok(())
    }

    /// Delete model
    pub async fn delete_model(&self, model_id: &str) -> Result<()> {
        let registry = Self::get_model_registry();
        let model = registry
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        if let Some(download_url) = &model.download_url {
            // Legacy path for compatibility with Go backend
            let models_dir = dirs::data_local_dir()
                .map(|p| p.join("aiwisper").join("models"))
                .ok_or_else(|| anyhow::anyhow!("Could not determine data directory"))?;

            let file_name = download_url.split('/').last().unwrap_or(&model.id);
            let model_path = models_dir.join(file_name);

            if model_path.exists() {
                std::fs::remove_file(&model_path)?;
                tracing::info!("Model {} deleted", model_id);
            }
        }

        Ok(())
    }

    /// Set active model
    pub async fn set_active_model(&self, model_id: &str) -> Result<()> {
        tracing::info!("Setting active model: {}", model_id);
        
        // Update in settings
        {
            let mut settings = self.inner.settings.write();
            settings.whisper_model = model_id.to_string();
            
            // Persist to disk
            if let Err(e) = save_settings_to_disk(&settings) {
                tracing::error!("Failed to save settings to disk: {}", e);
            }
        }
        
        // TODO: Actually load the model into the transcription engine
        Ok(())
    }

    /// Get Ollama models from Ollama API
    pub async fn get_ollama_models(&self, url: &str) -> Result<Vec<ModelInfo>> {
        let url = if url.is_empty() {
            "http://localhost:11434"
        } else {
            url
        };
        let api_url = format!("{}/api/tags", url.trim_end_matches('/'));

        tracing::info!("Fetching Ollama models from: {}", api_url);

        // Use reqwest to fetch models
        let client = reqwest::Client::new();
        let response = client
            .get(&api_url)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;

        match response {
            Ok(resp) => {
                if !resp.status().is_success() {
                    tracing::warn!("Ollama API returned error: {}", resp.status());
                    return Ok(vec![]);
                }

                #[derive(serde::Deserialize)]
                struct OllamaTagsResponse {
                    models: Option<Vec<OllamaModelInfo>>,
                }

                #[derive(serde::Deserialize)]
                struct OllamaModelInfo {
                    name: String,
                    size: Option<u64>,
                }

                let tags: OllamaTagsResponse = resp
                    .json()
                    .await
                    .unwrap_or(OllamaTagsResponse { models: None });

                let models = tags
                    .models
                    .unwrap_or_default()
                    .into_iter()
                    .map(|m| {
                        let size_bytes = m.size.unwrap_or(0);
                        let size = if size_bytes > 1_000_000_000 {
                            format!("{:.1} GB", size_bytes as f64 / 1_000_000_000.0)
                        } else if size_bytes > 1_000_000 {
                            format!("{:.0} MB", size_bytes as f64 / 1_000_000.0)
                        } else {
                            format!("{} bytes", size_bytes)
                        };

                        ModelInfo {
                            id: m.name.clone(),
                            name: m.name.clone(),
                            model_type: "ollama".to_string(),
                            engine: "ollama".to_string(),
                            size,
                            size_bytes,
                            description: "Ollama LLM for summaries".to_string(),
                            languages: vec!["multi".to_string()],
                            wer: None,
                            speed: "varies".to_string(),
                            recommended: false,
                            download_url: None,
                            vocab_url: None,
                            is_rnnt: false,
                            decoder_url: None,
                            joint_url: None,
                            diarization_type: None,
                            is_archive: false,
                            status: "downloaded".to_string(),
                            progress: 100.0,
                            error: None,
                            path: None,
                        }
                    })
                    .collect();

                Ok(models)
            }
            Err(e) => {
                tracing::warn!("Failed to connect to Ollama: {}", e);
                Ok(vec![])
            }
        }
    }

    // ========================================================================
    // Session management
    // ========================================================================

    /// List all sessions (in-memory)
    pub async fn list_sessions(&self) -> Result<Vec<crate::commands::session::SessionInfo>> {
        let sessions = self.inner.sessions.read();
        Ok(sessions
            .iter()
            .map(|s| crate::commands::session::SessionInfo {
                id: s.id.clone(),
                start_time: s.start_time.clone(),
                status: s.status.clone(),
                total_duration: s.total_duration,
                chunks_count: s.chunks.len(),
                title: s.title.clone(),
                tags: s.tags.clone(),
            })
            .collect())
    }

    /// Get a specific session (in-memory)
    pub async fn get_session(&self, session_id: &str) -> Result<crate::commands::session::Session> {
        let sessions = self.inner.sessions.read();
        let session = sessions
            .iter()
            .find(|s| s.id == session_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;
        
        // Debug: log if session has summary
        tracing::debug!(
            "get_session {}: summary={}, chunks={}",
            session_id,
            session.summary.as_ref().map(|s| s.len()).unwrap_or(0),
            session.chunks.len()
        );
        
        Ok(session)
    }

    /// Delete a session (from memory and disk)
    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        // First, delete from disk
        if let Some(sessions_dir) = get_sessions_dir() {
            let session_path = sessions_dir.join(session_id);
            if session_path.exists() {
                std::fs::remove_dir_all(&session_path)
                    .map_err(|e| anyhow::anyhow!("Failed to delete session folder: {}", e))?;
                tracing::info!("Deleted session folder: {:?}", session_path);
            }
        }

        // Then, remove from memory
        let mut sessions = self.inner.sessions.write();
        sessions.retain(|s| s.id != session_id);
        Ok(())
    }

    /// Rename a session (in-memory and persist to meta.json)
    pub async fn rename_session(&self, session_id: &str, new_title: &str) -> Result<()> {
        // Update in-memory
        {
            let mut sessions = self.inner.sessions.write();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == session_id) {
                s.title = Some(new_title.to_string());
            } else {
                anyhow::bail!("Session not found");
            }
        }

        // Persist to meta.json
        if let Some(sessions_dir) = get_sessions_dir() {
            let meta_path = sessions_dir.join(session_id).join("meta.json");
            if meta_path.exists() {
                // Read existing meta
                let content = std::fs::read_to_string(&meta_path)?;
                let mut meta: serde_json::Value = serde_json::from_str(&content)?;

                // Update title field
                meta["title"] = serde_json::Value::String(new_title.to_string());

                // Write back
                let updated = serde_json::to_string_pretty(&meta)?;
                std::fs::write(&meta_path, updated)?;

                tracing::info!("Saved title '{}' to {:?}", new_title, meta_path);
            }
        }

        Ok(())
    }

    /// Update session tags (in-memory and persist to meta.json)
    pub async fn update_session_tags(&self, session_id: &str, tags: Vec<String>) -> Result<()> {
        // Update in-memory
        {
            let mut sessions = self.inner.sessions.write();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == session_id) {
                s.tags = tags.clone();
            } else {
                anyhow::bail!("Session not found");
            }
        }

        // Persist to meta.json
        if let Some(sessions_dir) = get_sessions_dir() {
            let meta_path = sessions_dir.join(session_id).join("meta.json");
            if meta_path.exists() {
                // Read existing meta
                let content = std::fs::read_to_string(&meta_path)?;
                let mut meta: serde_json::Value = serde_json::from_str(&content)?;

                // Update tags field
                meta["tags"] = serde_json::json!(tags);

                // Write back
                let updated = serde_json::to_string_pretty(&meta)?;
                std::fs::write(&meta_path, updated)?;

                tracing::info!("Saved tags {:?} to {:?}", tags, meta_path);
            }
        }

        Ok(())
    }

    /// Set session summary (in-memory and persist to meta.json)
    pub async fn set_session_summary(&self, session_id: &str, summary: &str) -> Result<()> {
        // Update in-memory
        {
            let mut sessions = self.inner.sessions.write();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == session_id) {
                s.summary = Some(summary.to_string());
            } else {
                anyhow::bail!("Session not found");
            }
        }

        // Persist to meta.json
        if let Some(sessions_dir) = get_sessions_dir() {
            let meta_path = sessions_dir.join(session_id).join("meta.json");
            if meta_path.exists() {
                // Read existing meta
                let content = std::fs::read_to_string(&meta_path)?;
                let mut meta: serde_json::Value = serde_json::from_str(&content)?;

                // Update summary field
                meta["summary"] = serde_json::Value::String(summary.to_string());

                // Write back
                let updated = serde_json::to_string_pretty(&meta)?;
                std::fs::write(&meta_path, updated)?;

                tracing::info!("Saved summary to {:?}", meta_path);
            }
        }

        Ok(())
    }

    /// Export a session to file (stub)
    pub async fn export_session(
        &self,
        _session_id: &str,
        _format: &str,
        _path: &str,
    ) -> Result<()> {
        // TODO: Implement session export
        Ok(())
    }

    /// Get speakers from a session (extracted from dialogue segments)
    pub async fn get_session_speakers(
        &self,
        session_id: &str,
    ) -> Result<Vec<crate::commands::session::SessionSpeaker>> {
        use crate::commands::session::SessionSpeaker;
        use std::collections::HashMap;

        let sessions = self.inner.sessions.read();
        let session = sessions
            .iter()
            .find(|s| s.id == session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

        // Extract unique speakers from dialogue segments
        let mut speakers_map: HashMap<String, (usize, f64)> = HashMap::new();

        for chunk in &session.chunks {
            for segment in &chunk.dialogue {
                if let Some(speaker) = &segment.speaker {
                    let duration_sec = (segment.end - segment.start) as f64 / 1000.0;
                    let entry = speakers_map.entry(speaker.clone()).or_insert((0, 0.0));
                    entry.0 += 1; // segment count
                    entry.1 += duration_sec; // total duration
                }
            }

            // Also check mic_text and sys_text for legacy sessions
            if chunk.mic_text.is_some() && !speakers_map.contains_key("mic") {
                let duration_sec = chunk.duration as f64 / 1000.0;
                speakers_map
                    .entry("mic".to_string())
                    .or_insert((1, duration_sec));
            }
            if chunk.sys_text.is_some() && !speakers_map.contains_key("sys") {
                let duration_sec = chunk.duration as f64 / 1000.0;
                speakers_map
                    .entry("sys".to_string())
                    .or_insert((1, duration_sec));
            }
        }

        // Convert to SessionSpeaker objects
        let mut speakers: Vec<SessionSpeaker> = speakers_map
            .into_iter()
            .enumerate()
            .map(|(idx, (speaker_key, (segment_count, total_duration)))| {
                let is_mic = speaker_key == "mic"
                    || speaker_key.starts_with("SPEAKER_00")
                    || speaker_key.to_lowercase().contains("вы");
                let local_id = if is_mic { -1 } else { idx as i32 };

                let display_name = if is_mic {
                    "Вы".to_string()
                } else if speaker_key.starts_with("SPEAKER_") {
                    // Convert SPEAKER_01 -> Собеседник 1
                    let num = speaker_key
                        .trim_start_matches("SPEAKER_")
                        .parse::<i32>()
                        .unwrap_or(0);
                    format!("Собеседник {}", num + 1)
                } else if speaker_key == "sys" {
                    "Собеседник 1".to_string()
                } else {
                    speaker_key.clone()
                };

                SessionSpeaker {
                    local_id,
                    global_id: None,
                    display_name,
                    is_recognized: false,
                    is_mic,
                    segment_count,
                    total_duration,
                    has_sample: false, // TODO: Check if sample audio exists
                }
            })
            .collect();

        // Sort: mic first, then by segment count
        speakers.sort_by(|a, b| {
            if a.is_mic && !b.is_mic {
                return std::cmp::Ordering::Less;
            }
            if !a.is_mic && b.is_mic {
                return std::cmp::Ordering::Greater;
            }
            b.segment_count.cmp(&a.segment_count)
        });

        tracing::debug!(
            "Found {} speakers in session {}",
            speakers.len(),
            session_id
        );
        Ok(speakers)
    }

    // ========================================================================
    // Voiceprints management
    // ========================================================================

    /// List all voiceprints from speakers.json file
    pub async fn list_voiceprints(&self) -> Result<Vec<crate::commands::voiceprints::VoicePrint>> {
        use crate::commands::voiceprints::VoicePrint;

        // Get path to speakers.json
        let speakers_path =
            dirs::data_local_dir().map(|p| p.join("aiwisper").join("speakers.json"));

        if let Some(path) = speakers_path {
            if path.exists() {
                tracing::info!("Loading voiceprints from: {:?}", path);

                if let Ok(content) = std::fs::read_to_string(&path) {
                    // Parse speakers.json format: { "version": 1, "voiceprints": [...] }
                    #[derive(serde::Deserialize)]
                    struct SpeakersFile {
                        #[allow(dead_code)]
                        version: Option<i32>,
                        voiceprints: Vec<VoicePrintFile>,
                    }

                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct VoicePrintFile {
                        id: String,
                        name: String,
                        embedding: Vec<f32>,
                        #[serde(default)]
                        created_at: Option<String>,
                        #[serde(default)]
                        updated_at: Option<String>,
                        #[serde(default)]
                        last_seen_at: Option<String>,
                        #[serde(default)]
                        seen_count: Option<i32>,
                        #[serde(default)]
                        sample_path: Option<String>,
                        #[serde(default)]
                        source: Option<String>,
                        #[serde(default)]
                        notes: Option<String>,
                    }

                    if let Ok(speakers_file) = serde_json::from_str::<SpeakersFile>(&content) {
                        let now = chrono::Utc::now().to_rfc3339();
                        let voiceprints: Vec<VoicePrint> = speakers_file
                            .voiceprints
                            .into_iter()
                            .map(|vp| VoicePrint {
                                id: vp.id,
                                name: vp.name,
                                embedding: vp.embedding,
                                created_at: vp.created_at.unwrap_or_else(|| now.clone()),
                                updated_at: vp.updated_at.unwrap_or_else(|| now.clone()),
                                last_seen_at: vp.last_seen_at.unwrap_or_else(|| now.clone()),
                                seen_count: vp.seen_count.unwrap_or(1),
                                sample_path: vp.sample_path,
                                source: vp.source,
                                notes: vp.notes,
                            })
                            .collect();

                        tracing::info!("Loaded {} voiceprints", voiceprints.len());
                        return Ok(voiceprints);
                    } else {
                        tracing::warn!("Failed to parse speakers.json");
                    }
                }
            } else {
                tracing::debug!("speakers.json not found at {:?}", path);
            }
        }

        Ok(vec![])
    }

    /// Create a new voiceprint (stub)
    pub async fn create_voiceprint(
        &self,
        name: &str,
        embedding: Vec<f32>,
        source: Option<String>,
    ) -> Result<crate::commands::voiceprints::VoicePrint> {
        use crate::commands::voiceprints::VoicePrint;

        let now = chrono::Utc::now().to_rfc3339();
        let voiceprint = VoicePrint {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            embedding,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_seen_at: now,
            seen_count: 1,
            sample_path: None,
            source,
            notes: None,
        };

        // TODO: Save to storage
        tracing::info!("Created voiceprint: {} (id: {})", name, voiceprint.id);

        Ok(voiceprint)
    }

    /// Rename a voiceprint (stub)
    pub async fn rename_voiceprint(&self, _id: &str, _name: &str) -> Result<()> {
        // TODO: Implement voiceprint rename
        Ok(())
    }

    /// Delete a voiceprint (stub)
    pub async fn delete_voiceprint(&self, _id: &str) -> Result<()> {
        // TODO: Implement voiceprint deletion
        Ok(())
    }

    /// Get audio sample for a speaker (stub - returns silence)
    pub async fn get_speaker_sample(&self, session_id: &str, speaker_id: i32) -> Result<String> {
        let sessions = self.inner.sessions.read();
        let _session = sessions
            .iter()
            .find(|s| s.id == session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

        tracing::debug!(
            "Generating speaker sample for session: {}, speaker: {}",
            session_id,
            speaker_id
        );

        // Generate 2 seconds of silence as a sample
        let wav_data = Self::generate_silence_wav(2.0);

        // Encode as base64 data URL
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav_data);
        Ok(format!("data:audio/wav;base64,{}", base64))
    }

    // ========================================================================
    // Audio playback
    // ========================================================================

    /// Get full audio for a session as base64-encoded data
    /// Returns a data URL that can be used directly in an <audio> element
    /// Tries to load full.mp3 from disk first, falls back to generated silence
    pub async fn get_full_audio(&self, session_id: &str) -> Result<String> {
        let sessions = self.inner.sessions.read();
        let session = sessions
            .iter()
            .find(|s| s.id == session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

        // Try to load full.mp3 from disk
        if let Some(sessions_dir) = get_sessions_dir() {
            let mp3_path = sessions_dir.join(session_id).join("full.mp3");
            if mp3_path.exists() {
                if let Ok(mp3_data) = std::fs::read(&mp3_path) {
                    let base64 = base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &mp3_data,
                    );
                    return Ok(format!("data:audio/mpeg;base64,{}", base64));
                }
            }
        }

        // Fallback: Generate silence based on session duration
        let duration_sec = (session.total_duration as f32) / 1000.0;
        let wav_data = Self::generate_silence_wav(duration_sec);

        // Encode as base64 data URL
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav_data);
        Ok(format!("data:audio/wav;base64,{}", base64))
    }

    /// Get chunk audio as base64-encoded WAV
    /// Returns a data URL that can be used directly in an <audio> element
    pub async fn get_chunk_audio(&self, session_id: &str, chunk_index: usize) -> Result<String> {
        let sessions = self.inner.sessions.read();
        let session = sessions
            .iter()
            .find(|s| s.id == session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

        let chunk = session
            .chunks
            .get(chunk_index)
            .ok_or_else(|| anyhow::anyhow!("Chunk not found"))?;

        // Calculate chunk duration from timestamps
        let duration_ms = chunk.end_ms - chunk.start_ms;
        let duration_sec = (duration_ms as f32) / 1000.0;

        let wav_data = Self::generate_silence_wav(duration_sec);

        // Encode as base64 data URL
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav_data);
        Ok(format!("data:audio/wav;base64,{}", base64))
    }

    /// Generate a minimal WAV file with silence
    /// Format: 16kHz, mono, 16-bit PCM
    fn generate_silence_wav(duration_sec: f32) -> Vec<u8> {
        const SAMPLE_RATE: u32 = 16000;
        const BITS_PER_SAMPLE: u16 = 16;
        const CHANNELS: u16 = 1;

        let num_samples = (SAMPLE_RATE as f32 * duration_sec) as u32;
        let data_size = num_samples * (BITS_PER_SAMPLE / 8) as u32 * CHANNELS as u32;
        let file_size = 36 + data_size;

        let mut wav = Vec::with_capacity(44 + data_size as usize);

        // RIFF header
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&file_size.to_le_bytes());
        wav.extend_from_slice(b"WAVE");

        // fmt chunk
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format
        wav.extend_from_slice(&CHANNELS.to_le_bytes());
        wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        let byte_rate = SAMPLE_RATE * CHANNELS as u32 * (BITS_PER_SAMPLE / 8) as u32;
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());

        // data chunk
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());

        // Silent samples (all zeros)
        wav.resize(44 + data_size as usize, 0);

        wav
    }

    // ========================================================================
    // Diarization management
    // ========================================================================

    /// Enable diarization
    pub async fn enable_diarization(
        &self,
        _segmentation_model_path: &str,
        _embedding_model_path: &str,
        provider: &str,
    ) -> Result<crate::commands::diarization::DiarizationStatus> {
        // For CoreML/FluidAudio, models are downloaded automatically
        // For Sherpa-ONNX, we would load the models here

        *self.inner.diarization_enabled.write() = true;
        *self.inner.diarization_provider.write() = provider.to_string();

        tracing::info!("Diarization enabled with provider: {}", provider);

        Ok(crate::commands::diarization::DiarizationStatus {
            enabled: true,
            provider: provider.to_string(),
        })
    }

    /// Disable diarization
    pub async fn disable_diarization(&self) -> Result<()> {
        *self.inner.diarization_enabled.write() = false;
        *self.inner.diarization_provider.write() = String::new();

        tracing::info!("Diarization disabled");

        Ok(())
    }

    /// Get diarization status
    pub async fn get_diarization_status(
        &self,
    ) -> Result<crate::commands::diarization::DiarizationStatus> {
        let enabled = *self.inner.diarization_enabled.read();
        let provider = self.inner.diarization_provider.read().clone();

        Ok(crate::commands::diarization::DiarizationStatus { enabled, provider })
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Retranscription implementation
// ============================================================================

impl AppState {
    /// Retranscribe a single chunk using stereo channel separation (like Go backend)
    pub async fn retranscribe_chunk(
        &self,
        session_id: &str,
        chunk_id: &str,
        model_id: &str,
        language: &str,
        stt_provider: &str,
        hybrid_enabled: bool,
        hybrid_secondary_model_id: &str,
        hybrid_use_llm: bool,
        hybrid_mode: &str,
        ollama_model: &str,
        ollama_url: &str,
        window: &tauri::Window,
    ) -> Result<serde_json::Value> {
        use crate::commands::session::DialogueSegment;
        use tauri::Emitter;

        tracing::info!(
            "Retranscribing chunk: session={}, chunk={}, model={}, lang={}, stt_provider={}, hybrid={}, use_llm={}, mode={}",
            session_id,
            chunk_id,
            model_id,
            language,
            stt_provider,
            hybrid_enabled,
            hybrid_use_llm,
            hybrid_mode
        );

        // 1. Get session and chunk info (extract data before any await)
        let (start_ms, end_ms, chunk_index) = {
            let sessions = self.inner.sessions.read();
            let session = sessions
                .iter()
                .find(|s| s.id == session_id)
                .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?;

            let chunk = session
                .chunks
                .iter()
                .find(|c| c.id == chunk_id)
                .ok_or_else(|| anyhow::anyhow!("Chunk not found: {}", chunk_id))?;

            (chunk.start_ms, chunk.end_ms, chunk.index)
            // sessions guard dropped here
        };

        // 2. Extract stereo audio segment (left=mic, right=sys)
        let (mic_samples, sys_samples) = self
            .extract_audio_segment_stereo(session_id, start_ms, end_ms)
            .await?;

        // 3. Check if channels are similar (duplicated mono)
        let is_stereo = !Self::are_channels_similar(&mic_samples, &sys_samples);
        
        tracing::info!(
            "Extracted audio: mic={} samples, sys={} samples, is_stereo={}",
            mic_samples.len(),
            sys_samples.len(),
            is_stereo
        );

        let mut dialogue: Vec<DialogueSegment> = Vec::new();
        let mut mic_text = String::new();
        let mut sys_text = String::new();

        // Check if using cloud provider
        let use_cloud = stt_provider != "local" && !stt_provider.is_empty();

        if is_stereo {
            // Stereo mode: transcribe channels separately (like Go backend)
            
            // 3a. Transcribe MIC channel -> "Вы"
            if !mic_samples.is_empty() {
                tracing::info!("Transcribing MIC channel (Вы): {} samples, cloud={}", mic_samples.len(), use_cloud);
                let result = if use_cloud {
                    self.transcribe_samples_with_cloud_provider(&mic_samples, language, stt_provider).await
                } else {
                    self.transcribe_samples_with_hybrid(
                        &mic_samples,
                        model_id,
                        language,
                        hybrid_enabled,
                        hybrid_secondary_model_id,
                        hybrid_use_llm,
                        hybrid_mode,
                        ollama_model,
                        ollama_url,
                        &[],
                    ).await
                };
                
                match result {
                    Ok(segments) => {
                        mic_text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                        tracing::info!("MIC transcription: {} segments, {} chars", segments.len(), mic_text.len());
                        
                        for seg in segments {
                            dialogue.push(DialogueSegment {
                                start: seg.start + start_ms,
                                end: seg.end + start_ms,
                                text: seg.text,
                                speaker: Some("Вы".to_string()),
                            });
                        }
                    }
                    Err(e) => {
                        tracing::error!("MIC transcription error: {}", e);
                    }
                }
            }

            // 3b. Transcribe SYS channel -> "Собеседник" (TODO: add diarization for multiple speakers)
            if !sys_samples.is_empty() {
                tracing::info!("Transcribing SYS channel (Собеседник): {} samples, cloud={}", sys_samples.len(), use_cloud);
                let result = if use_cloud {
                    self.transcribe_samples_with_cloud_provider(&sys_samples, language, stt_provider).await
                } else {
                    self.transcribe_samples_with_hybrid(
                        &sys_samples,
                        model_id,
                        language,
                        hybrid_enabled,
                        hybrid_secondary_model_id,
                        hybrid_use_llm,
                        hybrid_mode,
                        ollama_model,
                        ollama_url,
                        &[],
                    ).await
                };
                
                match result {
                    Ok(segments) => {
                        sys_text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                        tracing::info!("SYS transcription: {} segments, {} chars", segments.len(), sys_text.len());
                        
                        for seg in segments {
                            dialogue.push(DialogueSegment {
                                start: seg.start + start_ms,
                                end: seg.end + start_ms,
                                text: seg.text,
                                speaker: Some("Собеседник".to_string()),
                            });
                        }
                    }
                    Err(e) => {
                        tracing::error!("SYS transcription error: {}", e);
                    }
                }
            }

            // 3c. Sort dialogue by timestamp
            dialogue.sort_by_key(|d| d.start);
            
        } else {
            // Mono mode: transcribe mixed audio
            tracing::info!("Mono mode: transcribing mixed audio, cloud={}", use_cloud);
            
            let samples = self
                .extract_audio_segment(session_id, start_ms, end_ms)
                .await?;

            if samples.is_empty() {
                return Err(anyhow::anyhow!("No audio samples extracted for chunk"));
            }

            let segments = if use_cloud {
                self.transcribe_samples_with_cloud_provider(&samples, language, stt_provider).await?
            } else {
                self.transcribe_samples_with_hybrid(
                    &samples,
                    model_id,
                    language,
                    hybrid_enabled,
                    hybrid_secondary_model_id,
                    hybrid_use_llm,
                    hybrid_mode,
                    ollama_model,
                    ollama_url,
                    &[],
                ).await?
            };

            dialogue = segments
                .into_iter()
                .map(|seg| DialogueSegment {
                    start: seg.start + start_ms,
                    end: seg.end + start_ms,
                    text: seg.text,
                    speaker: seg.speaker,
                })
                .collect();
        }

        // 4. Update chunk in session
        {
            let mut sessions = self.inner.sessions.write();
            if let Some(session) = sessions.iter_mut().find(|s| s.id == session_id) {
                if let Some(chunk) = session.chunks.iter_mut().find(|c| c.id == chunk_id) {
                    chunk.dialogue = dialogue.clone();
                    chunk.transcription = dialogue
                        .iter()
                        .map(|d| d.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    chunk.mic_text = if mic_text.is_empty() { None } else { Some(mic_text.clone()) };
                    chunk.sys_text = if sys_text.is_empty() { None } else { Some(sys_text.clone()) };

                    // Save to disk
                    let _ = Self::save_chunk_to_disk(session_id, chunk);
                }
            }
        }

        // 5. Build response matching Go backend format
        let result = serde_json::json!({
            "sessionId": session_id,
            "chunk": {
                "id": chunk_id,
                "index": chunk_index,
                "startMs": start_ms,
                "endMs": end_ms,
                "dialogue": dialogue,
                "micText": mic_text,
                "sysText": sys_text,
            }
        });

        // Emit event
        let _ = window.emit("chunk_transcribed", &result);

        Ok(result)
    }

    /// Cancel ongoing full retranscription
    pub async fn cancel_full_transcription(&self, window: &tauri::Window) -> Result<()> {
        use tauri::Emitter;
        
        tracing::info!("Cancelling full retranscription");
        
        // Get and cancel the token
        let token = self.inner.retranscription_cancel.write().take();
        if let Some(token) = token {
            token.cancel();
            tracing::info!("Retranscription cancellation requested");
            
            let _ = window.emit(
                "full_transcription_cancelled",
                serde_json::json!({
                    "reason": "user_cancelled"
                }),
            );
        } else {
            tracing::warn!("No active retranscription to cancel");
        }
        
        Ok(())
    }
    
    /// Retranscribe entire session
    pub async fn retranscribe_full(
        &self,
        session_id: &str,
        model_id: &str,
        language: &str,
        stt_provider: &str,
        hybrid_enabled: bool,
        hybrid_secondary_model_id: &str,
        hybrid_use_llm: bool,
        hybrid_mode: &str,
        ollama_model: &str,
        ollama_url: &str,
        window: &tauri::Window,
    ) -> Result<()> {
        use crate::commands::session::DialogueSegment;
        use tauri::Emitter;

        tracing::info!(
            "Retranscribing full session: {}, model={}, lang={}, stt_provider={}",
            session_id,
            model_id,
            language,
            stt_provider
        );

        // Create cancellation token
        let cancel_token = tokio_util::sync::CancellationToken::new();
        *self.inner.retranscription_cancel.write() = Some(cancel_token.clone());

        // 1. Emit start event
        let _ = window.emit(
            "full_transcription_started",
            serde_json::json!({
                "sessionId": session_id,
            }),
        );

        // 2. Get session chunks info
        let chunk_infos: Vec<(String, i32, i64, i64)> = {
            let sessions = self.inner.sessions.read();
            let session = sessions
                .iter()
                .find(|s| s.id == session_id)
                .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?;

            session
                .chunks
                .iter()
                .map(|c| (c.id.clone(), c.index, c.start_ms, c.end_ms))
                .collect()
        };

        let total_chunks = chunk_infos.len();

        // 3. Process each chunk
        for (idx, (chunk_id, chunk_index, start_ms, end_ms)) in chunk_infos.into_iter().enumerate()
        {
            // Check for cancellation at the start of each chunk
            if cancel_token.is_cancelled() {
                tracing::info!("Retranscription cancelled by user at chunk {}/{}", idx + 1, total_chunks);
                let _ = window.emit(
                    "full_transcription_cancelled",
                    serde_json::json!({
                        "sessionId": session_id,
                        "reason": "user_cancelled",
                        "progress": idx as f32 / total_chunks as f32,
                    }),
                );
                // Clear the token
                *self.inner.retranscription_cancel.write() = None;
                return Ok(());
            }
            
            // Emit progress
            let progress = (idx as f32 + 0.5) / total_chunks as f32;
            let _ = window.emit(
                "full_transcription_progress",
                serde_json::json!({
                    "sessionId": session_id,
                    "progress": progress,
                    "data": format!("Обработка чанка {}/{}", idx + 1, total_chunks),
                }),
            );

            // Extract stereo audio (left=mic, right=sys)
            let (mic_samples, sys_samples) = match self
                .extract_audio_segment_stereo(&session_id, start_ms, end_ms)
                .await
            {
                Ok((m, s)) if !m.is_empty() || !s.is_empty() => (m, s),
                Ok(_) => {
                    tracing::warn!("Empty audio for chunk {}", chunk_id);
                    continue;
                }
                Err(e) => {
                    tracing::error!("Failed to extract audio for chunk {}: {}", chunk_id, e);
                    continue;
                }
            };

            // Check if channels are similar (duplicated mono)
            let is_stereo = !Self::are_channels_similar(&mic_samples, &sys_samples);
            
            // Check if using cloud provider
            let use_cloud = stt_provider != "local" && !stt_provider.is_empty();
            
            let mut dialogue: Vec<DialogueSegment> = Vec::new();
            let mut mic_text = String::new();
            let mut sys_text = String::new();

            if is_stereo {
                // Stereo mode: transcribe channels separately
                
                // Transcribe MIC channel -> "Вы"
                if !mic_samples.is_empty() {
                    let result = if use_cloud {
                        self.transcribe_samples_with_cloud_provider(&mic_samples, language, stt_provider).await
                    } else {
                        self.transcribe_samples_with_hybrid(
                            &mic_samples,
                            model_id,
                            language,
                            hybrid_enabled,
                            hybrid_secondary_model_id,
                            hybrid_use_llm,
                            hybrid_mode,
                            ollama_model,
                            ollama_url,
                            &[],
                        ).await
                    };
                    
                    if let Ok(segments) = result {
                        mic_text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                        for seg in segments {
                            dialogue.push(DialogueSegment {
                                start: seg.start + start_ms,
                                end: seg.end + start_ms,
                                text: seg.text,
                                speaker: Some("Вы".to_string()),
                            });
                        }
                    }
                }

                // Transcribe SYS channel -> "Собеседник"
                if !sys_samples.is_empty() {
                    let result = if use_cloud {
                        self.transcribe_samples_with_cloud_provider(&sys_samples, language, stt_provider).await
                    } else {
                        self.transcribe_samples_with_hybrid(
                            &sys_samples,
                            model_id,
                            language,
                            hybrid_enabled,
                            hybrid_secondary_model_id,
                            hybrid_use_llm,
                            hybrid_mode,
                            ollama_model,
                            ollama_url,
                            &[],
                        ).await
                    };
                    
                    if let Ok(segments) = result {
                        sys_text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                        for seg in segments {
                            dialogue.push(DialogueSegment {
                                start: seg.start + start_ms,
                                end: seg.end + start_ms,
                                text: seg.text,
                                speaker: Some("Собеседник".to_string()),
                            });
                        }
                    }
                }

                // Sort dialogue by timestamp
                dialogue.sort_by_key(|d| d.start);
                
            } else {
                // Mono mode: transcribe mixed audio
                let samples = match self
                    .extract_audio_segment(&session_id, start_ms, end_ms)
                    .await
                {
                    Ok(s) if !s.is_empty() => s,
                    _ => continue,
                };

                let result = if use_cloud {
                    self.transcribe_samples_with_cloud_provider(&samples, language, stt_provider).await
                } else {
                    self.transcribe_samples_with_hybrid(
                        &samples,
                        model_id,
                        language,
                        hybrid_enabled,
                        hybrid_secondary_model_id,
                        hybrid_use_llm,
                        hybrid_mode,
                        ollama_model,
                        ollama_url,
                        &[],
                    ).await
                };
                
                if let Ok(segments) = result {
                    dialogue = segments
                        .into_iter()
                        .map(|seg| DialogueSegment {
                            start: seg.start + start_ms,
                            end: seg.end + start_ms,
                            text: seg.text,
                            speaker: seg.speaker,
                        })
                        .collect();
                }
            }

            // Update chunk
            {
                let mut sessions = self.inner.sessions.write();
                if let Some(session) = sessions.iter_mut().find(|s| s.id == session_id) {
                    if let Some(chunk) = session.chunks.iter_mut().find(|c| c.id == chunk_id) {
                        chunk.dialogue = dialogue.clone();
                        chunk.transcription = dialogue
                            .iter()
                            .map(|d| d.text.as_str())
                            .collect::<Vec<_>>()
                            .join(" ");
                        chunk.mic_text = if mic_text.is_empty() { None } else { Some(mic_text.clone()) };
                        chunk.sys_text = if sys_text.is_empty() { None } else { Some(sys_text.clone()) };

                        let _ = Self::save_chunk_to_disk(session_id, chunk);
                    }
                }
            }

            // Emit chunk_transcribed event
            let _ = window.emit(
                "chunk_transcribed",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunk": {
                        "id": chunk_id,
                        "index": chunk_index,
                        "startMs": start_ms,
                        "endMs": end_ms,
                        "dialogue": dialogue,
                        "micText": mic_text,
                        "sysText": sys_text,
                    }
                }),
            );
        }

        // Clear cancellation token
        *self.inner.retranscription_cancel.write() = None;
        
        // 4. Get updated session for final event
        let session = {
            let sessions = self.inner.sessions.read();
            sessions.iter().find(|s| s.id == session_id).cloned()
        };

        // 5. Emit completion event
        let _ = window.emit(
            "full_transcription_completed",
            serde_json::json!({
                "sessionId": session_id,
                "session": session,
            }),
        );

        tracing::info!("Full retranscription completed for session: {}", session_id);

        Ok(())
    }

    /// Extract audio segment from session's MP3 file
    async fn extract_audio_segment(
        &self,
        session_id: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<f32>> {
        use symphonia::core::audio::SampleBuffer;
        use symphonia::core::codecs::DecoderOptions;
        use symphonia::core::formats::FormatOptions;
        use symphonia::core::io::MediaSourceStream;
        use symphonia::core::meta::MetadataOptions;
        use symphonia::core::probe::Hint;

        let sessions_dir =
            get_sessions_dir().ok_or_else(|| anyhow::anyhow!("Sessions directory not found"))?;

        let mp3_path = sessions_dir.join(session_id).join("full.mp3");

        if !mp3_path.exists() {
            return Err(anyhow::anyhow!("Audio file not found: {:?}", mp3_path));
        }

        // Open and decode MP3
        let file = std::fs::File::open(&mp3_path)?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        hint.with_extension("mp3");

        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions::default();
        let decoder_opts = DecoderOptions::default();

        let probed =
            symphonia::default::get_probe().format(&hint, mss, &format_opts, &metadata_opts)?;

        let mut format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
            .ok_or_else(|| anyhow::anyhow!("No audio track found"))?;

        let track_id = track.id;
        let source_sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
        let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

        let mut decoder =
            symphonia::default::get_codecs().make(&track.codec_params, &decoder_opts)?;

        // Calculate sample positions
        let start_sample = (start_ms as f64 * source_sample_rate as f64 / 1000.0) as usize;
        let end_sample = (end_ms as f64 * source_sample_rate as f64 / 1000.0) as usize;

        // Decode all samples and extract the segment
        let mut all_samples: Vec<f32> = Vec::new();
        let mut current_sample = 0usize;

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break
                }
                Err(_) => break,
            };

            if packet.track_id() != track_id {
                continue;
            }

            let decoded = match decoder.decode(&packet) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let spec = *decoded.spec();
            let duration = decoded.capacity() as u64;

            let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
            sample_buf.copy_interleaved_ref(decoded);
            let samples = sample_buf.samples();

            // Process samples (de-interleave and mix to mono for ASR)
            let frame_samples = samples.len() / channels;

            for i in 0..frame_samples {
                let sample_idx = current_sample + i;

                // Only keep samples in our range
                if sample_idx >= start_sample && sample_idx < end_sample {
                    // Mix channels to mono (average)
                    let mut sum = 0.0;
                    for ch in 0..channels {
                        sum += samples[i * channels + ch];
                    }
                    all_samples.push(sum / channels as f32);
                }
            }

            current_sample += frame_samples;

            // Early exit if we've passed the end
            if current_sample >= end_sample {
                break;
            }
        }

        // Resample to 16kHz if needed
        const TARGET_SAMPLE_RATE: u32 = 16000;

        if source_sample_rate != TARGET_SAMPLE_RATE {
            let ratio = TARGET_SAMPLE_RATE as f64 / source_sample_rate as f64;
            let new_len = (all_samples.len() as f64 * ratio) as usize;
            let mut resampled = vec![0.0f32; new_len];

            for (i, sample) in resampled.iter_mut().enumerate() {
                let src_idx = i as f64 / ratio;
                let src_idx_floor = src_idx.floor() as usize;
                let src_idx_ceil = (src_idx_floor + 1).min(all_samples.len() - 1);
                let frac = src_idx - src_idx_floor as f64;

                *sample = if src_idx_floor < all_samples.len() {
                    all_samples[src_idx_floor] * (1.0 - frac as f32)
                        + all_samples[src_idx_ceil] * frac as f32
                } else {
                    0.0
                };
            }

            return Ok(resampled);
        }

        Ok(all_samples)
    }

    /// Transcribe audio samples with optional hybrid mode
    /// Runs in a blocking thread since ML inference is CPU-intensive
    async fn transcribe_samples_with_hybrid(
        &self,
        samples: &[f32],
        model_id: &str,
        language: &str,
        hybrid_enabled: bool,
        hybrid_secondary_model_id: &str,
        hybrid_use_llm: bool,
        hybrid_mode: &str,
        ollama_model: &str,
        ollama_url: &str,
        hotwords: &[String],
    ) -> Result<Vec<aiwisper_types::TranscriptSegment>> {
        let samples = samples.to_vec();
        let model_id = model_id.to_string();
        let language = language.to_string();
        let hybrid_secondary = hybrid_secondary_model_id.to_string();
        let hybrid_mode = hybrid_mode.to_string();
        let ollama_model = ollama_model.to_string();
        let ollama_url = ollama_url.to_string();
        let hotwords = hotwords.to_vec();

        // Run ML inference in blocking thread
        let segments = tokio::task::spawn_blocking(move || {
            Self::transcribe_samples_sync_with_hybrid(
                &samples,
                &model_id,
                &language,
                hybrid_enabled,
                &hybrid_secondary,
                false, // LLM is called async after this
                &hybrid_mode,
                "", // not used in sync
                "", // not used in sync
                &hotwords,
            )
        })
        .await
        .map_err(|e| anyhow::anyhow!("Transcription task failed: {}", e))??;

        // If LLM enhancement requested, call it asynchronously
        tracing::debug!(
            "[transcribe_samples_with_hybrid] LLM check: use_llm={}, ollama_model='{}', segments={}",
            hybrid_use_llm,
            ollama_model,
            segments.len()
        );
        
        if hybrid_use_llm && !ollama_model.is_empty() && !segments.is_empty() {
            let text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
            if !text.trim().is_empty() {
                tracing::info!(
                    "[transcribe_samples_with_hybrid] Enhancing with LLM: model={}, text_len={}",
                    ollama_model,
                    text.len()
                );
                
                match aiwisper_ml::llm::LLMSelector::with_model_url(&ollama_model, &ollama_url) {
                    Ok(llm) => {
                        match llm.enhance_transcription(&text).await {
                            Ok(enhanced) => {
                                if enhanced.trim() != text.trim() {
                                    tracing::info!(
                                        "[transcribe_samples_with_hybrid] LLM enhanced: {} -> {} chars",
                                        text.len(),
                                        enhanced.len()
                                    );
                                    // Return single segment with enhanced text
                                    // Preserve timing from first and last segments
                                    let start = segments.first().map(|s| s.start).unwrap_or(0);
                                    let end = segments.last().map(|s| s.end).unwrap_or(0);
                                    return Ok(vec![aiwisper_types::TranscriptSegment {
                                        start,
                                        end,
                                        text: enhanced,
                                        words: vec![], // Words are lost after LLM enhancement
                                        confidence: 0.0,
                                        speaker: None,
                                    }]);
                                }
                            }
                            Err(e) => {
                                tracing::error!("[transcribe_samples_with_hybrid] LLM enhancement failed: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("[transcribe_samples_with_hybrid] Failed to create LLM selector: {}", e);
                    }
                }
            }
        }

        Ok(segments)
    }

    /// Synchronous transcription with optional hybrid mode (called from blocking thread)
    /// Note: LLM enhancement is NOT done here - it's async and called after spawn_blocking
    fn transcribe_samples_sync_with_hybrid(
        samples: &[f32],
        model_id: &str,
        language: &str,
        hybrid_enabled: bool,
        hybrid_secondary_model_id: &str,
        _hybrid_use_llm: bool, // Not used in sync - LLM is called async after this
        hybrid_mode: &str,
        _ollama_model: &str, // Not used in sync
        _ollama_url: &str,   // Not used in sync
        hotwords: &[String],
    ) -> Result<Vec<aiwisper_types::TranscriptSegment>> {
        use aiwisper_ml::{
            FluidASREngine, GigaAMEngine, HybridMode, HybridTranscriber, HybridTranscriptionConfig,
            TranscriptionEngine, VotingConfig, WhisperEngine,
        };
        use std::sync::Arc;

        // Get models directory
        let models_dir = dirs::data_local_dir()
            .map(|p| p.join("aiwisper").join("models"))
            .ok_or_else(|| anyhow::anyhow!("Models directory not found"))?;

        // Helper to create engine from model ID
        let create_engine = |mid: &str| -> Result<Arc<dyn TranscriptionEngine>> {
            let is_gigaam = mid.starts_with("gigaam");
            let is_whisper = mid.starts_with("ggml");
            let is_parakeet = mid.starts_with("parakeet") || mid.contains("fluid");

            if is_parakeet {
                // FluidASR (Parakeet TDT v3) - uses subprocess
                tracing::info!("Creating FluidASR engine for model: {}", mid);
                let mut engine = FluidASREngine::new()?;
                if !language.is_empty() && language != "auto" {
                    engine.set_language(language)?;
                }
                Ok(Arc::new(engine))
            } else if is_gigaam {
                // Пробуем разные варианты имён модели
                let model_candidates: &[&str] = if mid.contains("e2e") {
                    &["gigaam-v3-e2e-ctc.onnx", "v3_e2e_ctc.int8.onnx", "gigaam-v3-e2e-ctc.int8.onnx"]
                } else {
                    &["gigaam-v3-ctc.onnx", "v3_ctc.int8.onnx", "gigaam-v3-ctc.int8.onnx"]
                };
                
                let model_path = model_candidates
                    .iter()
                    .map(|m| models_dir.join(m))
                    .find(|p| p.exists());
                    
                let _model_file = model_path
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or(model_candidates[0]);
                
                // Пробуем разные варианты имён vocab файлов
                let vocab_candidates: &[&str] = if mid.contains("e2e") {
                    &["gigaam-v3-e2e-ctc_vocab.txt", "v3_e2e_ctc_vocab.txt"]
                } else {
                    &["gigaam-v3-ctc_vocab.txt", "v3_vocab.txt", "v3_ctc_vocab.txt"]
                };

                let model_path = model_path
                    .ok_or_else(|| anyhow::anyhow!("GigaAM model not found. Tried: {:?}", model_candidates))?;
                
                let vocab_path = vocab_candidates
                    .iter()
                    .map(|v| models_dir.join(v))
                    .find(|p| p.exists())
                    .ok_or_else(|| anyhow::anyhow!("GigaAM vocab not found. Tried: {:?}", vocab_candidates))?;

                let engine =
                    GigaAMEngine::new(model_path.to_str().unwrap(), vocab_path.to_str().unwrap())?;
                Ok(Arc::new(engine))
            } else if is_whisper {
                let model_file = format!("{}.bin", mid);
                let model_path = models_dir.join(&model_file);

                if !model_path.exists() {
                    return Err(anyhow::anyhow!("Whisper model not found: {}", model_file));
                }

                let mut engine = WhisperEngine::new(model_path.to_str().unwrap())?;
                if !language.is_empty() && language != "auto" {
                    engine.set_language(language)?;
                }
                Ok(Arc::new(engine))
            } else {
                // Default to large-v3-turbo (fallback)
                tracing::warn!("Unknown model type '{}', falling back to Whisper large-v3-turbo", mid);
                let model_path = models_dir.join("ggml-large-v3-turbo.bin");
                if !model_path.exists() {
                    return Err(anyhow::anyhow!("Default Whisper model not found"));
                }

                let mut engine = WhisperEngine::new(model_path.to_str().unwrap())?;
                if !language.is_empty() && language != "auto" {
                    engine.set_language(language)?;
                }
                Ok(Arc::new(engine))
            }
        };

        // Create primary engine
        let primary_engine = create_engine(model_id)?;

        // If hybrid enabled, create secondary engine and use HybridTranscriber
        if hybrid_enabled && !hybrid_secondary_model_id.is_empty() {
            tracing::info!(
                "Using hybrid transcription: primary={}, secondary={}",
                model_id,
                hybrid_secondary_model_id
            );

            let secondary_engine = match create_engine(hybrid_secondary_model_id) {
                Ok(e) => Some(e),
                Err(e) => {
                    tracing::warn!(
                        "Failed to create secondary engine: {}, using primary only",
                        e
                    );
                    None
                }
            };

            // Parse hybrid mode
            // Note: full_compare is deprecated, now LLM is controlled by use_llm_for_merge
            #[allow(deprecated)]
            let mode = match hybrid_mode {
                "full_compare" | "fullCompare" => HybridMode::Parallel, // Legacy: map to Parallel
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
                use_llm_for_merge: false, // LLM is called async after sync transcription
                ollama_model: String::new(),
                ollama_url: String::new(),
            };

            tracing::info!(
                "HybridTranscription config: mode={:?}",
                mode
            );

            let transcriber = HybridTranscriber::new(primary_engine, secondary_engine, config);
            
            // Sync transcription (without LLM - LLM is called async after this)
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

    /// Transcribe audio samples using cloud STT provider
    async fn transcribe_samples_with_cloud_provider(
        &self,
        samples: &[f32],
        language: &str,
        stt_provider: &str,
    ) -> Result<Vec<aiwisper_types::TranscriptSegment>> {
        use crate::providers::types::STTProviderId;
        use crate::providers::traits::TranscriptionOptions;
        
        tracing::info!(
            "Cloud transcription: provider={}, samples={}, language={}",
            stt_provider,
            samples.len(),
            language
        );

        // Parse provider ID
        let provider_id = match stt_provider {
            "openai" => STTProviderId::OpenAI,
            "deepgram" => STTProviderId::Deepgram,
            "groq" => STTProviderId::Groq,
            other => {
                return Err(anyhow::anyhow!("Unknown cloud STT provider: {}", other));
            }
        };

        // Get the provider from registry
        let provider = self.provider_registry()
            .get_stt_provider(provider_id.clone())
            .await
            .ok_or_else(|| anyhow::anyhow!("STT provider {:?} not registered", provider_id))?;

        // Check if provider is configured
        if !provider.is_configured() {
            return Err(anyhow::anyhow!(
                "STT provider {:?} is not configured (missing API key?)",
                provider_id
            ));
        }

        // Convert samples to WAV bytes (16kHz mono)
        let wav_bytes = aiwisper_audio::samples_to_wav_bytes(samples, 16000)?;

        // Build transcription options
        let options = TranscriptionOptions {
            language: if language.is_empty() || language == "auto" {
                None
            } else {
                Some(language.to_string())
            },
            ..Default::default()
        };

        // Call the cloud provider
        let result = provider.transcribe(wav_bytes, options).await
            .map_err(|e| anyhow::anyhow!("Cloud transcription failed: {}", e))?;

        tracing::info!(
            "Cloud transcription complete: {} segments, {} chars",
            result.segments.len(),
            result.text.len()
        );

        // Convert provider segments to our TranscriptSegment format
        let segments: Vec<aiwisper_types::TranscriptSegment> = result.segments
            .into_iter()
            .map(|seg| aiwisper_types::TranscriptSegment {
                start: (seg.start * 1000.0) as i64, // Convert seconds to ms
                end: (seg.end * 1000.0) as i64,
                text: seg.text,
                words: vec![],
                confidence: seg.confidence.unwrap_or(0.0) as f32,
                speaker: seg.speaker,
            })
            .collect();

        // If no segments but we have text, create a single segment
        if segments.is_empty() && !result.text.is_empty() {
            let duration_ms = (samples.len() as f64 / 16.0) as i64; // samples @ 16kHz to ms
            return Ok(vec![aiwisper_types::TranscriptSegment {
                start: 0,
                end: duration_ms,
                text: result.text,
                words: vec![],
                confidence: 0.0,
                speaker: None,
            }]);
        }

        Ok(segments)
    }

    /// Extract stereo audio segment from session's MP3 file (separate channels)
    /// Returns (mic_samples, sys_samples) - left channel is mic, right is system
    async fn extract_audio_segment_stereo(
        &self,
        session_id: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<(Vec<f32>, Vec<f32>)> {
        use symphonia::core::audio::SampleBuffer;
        use symphonia::core::codecs::DecoderOptions;
        use symphonia::core::formats::FormatOptions;
        use symphonia::core::io::MediaSourceStream;
        use symphonia::core::meta::MetadataOptions;
        use symphonia::core::probe::Hint;

        let sessions_dir =
            get_sessions_dir().ok_or_else(|| anyhow::anyhow!("Sessions directory not found"))?;

        let mp3_path = sessions_dir.join(session_id).join("full.mp3");

        if !mp3_path.exists() {
            return Err(anyhow::anyhow!("Audio file not found: {:?}", mp3_path));
        }

        // Open and decode MP3
        let file = std::fs::File::open(&mp3_path)?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        hint.with_extension("mp3");

        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions::default();
        let decoder_opts = DecoderOptions::default();

        let probed =
            symphonia::default::get_probe().format(&hint, mss, &format_opts, &metadata_opts)?;

        let mut format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
            .ok_or_else(|| anyhow::anyhow!("No audio track found"))?;

        let track_id = track.id;
        let source_sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
        let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

        let mut decoder =
            symphonia::default::get_codecs().make(&track.codec_params, &decoder_opts)?;

        // Calculate sample positions
        let start_sample = (start_ms as f64 * source_sample_rate as f64 / 1000.0) as usize;
        let end_sample = (end_ms as f64 * source_sample_rate as f64 / 1000.0) as usize;

        // Separate buffers for left (mic) and right (sys) channels
        let mut mic_samples: Vec<f32> = Vec::new();
        let mut sys_samples: Vec<f32> = Vec::new();
        let mut current_sample = 0usize;

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break
                }
                Err(_) => break,
            };

            if packet.track_id() != track_id {
                continue;
            }

            let decoded = match decoder.decode(&packet) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let spec = *decoded.spec();
            let duration = decoded.capacity() as u64;

            let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
            sample_buf.copy_interleaved_ref(decoded);
            let samples = sample_buf.samples();

            // Process samples (de-interleave to separate channels)
            let frame_samples = samples.len() / channels;

            for i in 0..frame_samples {
                let sample_idx = current_sample + i;

                // Only keep samples in our range
                if sample_idx >= start_sample && sample_idx < end_sample {
                    if channels >= 2 {
                        // Stereo: left = mic, right = sys
                        mic_samples.push(samples[i * channels]);     // left channel
                        sys_samples.push(samples[i * channels + 1]); // right channel
                    } else {
                        // Mono: duplicate to both channels
                        mic_samples.push(samples[i * channels]);
                        sys_samples.push(samples[i * channels]);
                    }
                }
            }

            current_sample += frame_samples;

            // Early exit if we've passed the end
            if current_sample >= end_sample {
                break;
            }
        }

        // Resample to 16kHz if needed
        const TARGET_SAMPLE_RATE: u32 = 16000;

        let resample = |samples: Vec<f32>| -> Vec<f32> {
            if source_sample_rate == TARGET_SAMPLE_RATE || samples.is_empty() {
                return samples;
            }
            let ratio = TARGET_SAMPLE_RATE as f64 / source_sample_rate as f64;
            let new_len = (samples.len() as f64 * ratio) as usize;
            let mut resampled = vec![0.0f32; new_len];

            for (i, sample) in resampled.iter_mut().enumerate() {
                let src_idx = i as f64 / ratio;
                let src_idx_floor = src_idx.floor() as usize;
                let src_idx_ceil = (src_idx_floor + 1).min(samples.len().saturating_sub(1));
                let frac = src_idx - src_idx_floor as f64;

                *sample = if src_idx_floor < samples.len() {
                    samples[src_idx_floor] * (1.0 - frac as f32)
                        + samples[src_idx_ceil] * frac as f32
                } else {
                    0.0
                };
            }

            resampled
        };

        Ok((resample(mic_samples), resample(sys_samples)))
    }

    /// Check if two audio channels are similar (duplicated mono)
    fn are_channels_similar(mic: &[f32], sys: &[f32]) -> bool {
        if mic.len() != sys.len() || mic.is_empty() {
            return false;
        }
        
        // Sample every 100th sample for efficiency
        let step = (mic.len() / 1000).max(1);
        let mut similar_count = 0;
        let mut total_count = 0;
        
        for i in (0..mic.len()).step_by(step) {
            let diff = (mic[i] - sys[i]).abs();
            if diff < 0.01 {
                similar_count += 1;
            }
            total_count += 1;
        }
        
        // If more than 95% of samples are similar, channels are duplicated
        total_count > 0 && similar_count as f32 / total_count as f32 > 0.95
    }

    /// Save chunk to disk
    fn save_chunk_to_disk(
        session_id: &str,
        chunk: &crate::commands::session::SessionChunk,
    ) -> Result<()> {
        let sessions_dir =
            get_sessions_dir().ok_or_else(|| anyhow::anyhow!("Sessions directory not found"))?;

        let chunks_dir = sessions_dir.join(session_id).join("chunks");

        if !chunks_dir.exists() {
            std::fs::create_dir_all(&chunks_dir)?;
        }

        // Format: chunk_0000.json, chunk_0001.json, etc.
        let chunk_file = chunks_dir.join(format!("chunk_{:04}.json", chunk.index));

        // Convert to Go backend format for compatibility
        let chunk_json = serde_json::json!({
            "id": chunk.id,
            "index": chunk.index,
            "startMs": chunk.start_ms,
            "endMs": chunk.end_ms,
            "transcription": chunk.transcription,
            "micText": chunk.mic_text,
            "sysText": chunk.sys_text,
            "dialogue": chunk.dialogue.iter().map(|d| serde_json::json!({
                "start": d.start,
                "end": d.end,
                "text": d.text,
                "speaker": d.speaker.as_deref().unwrap_or(""),
            })).collect::<Vec<_>>(),
        });

        std::fs::write(&chunk_file, serde_json::to_string_pretty(&chunk_json)?)?;

        tracing::debug!("Saved chunk to {:?}", chunk_file);

        Ok(())
    }
}
