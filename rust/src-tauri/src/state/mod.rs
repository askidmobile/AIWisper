//! Application state management
//!
//! Manages global state for the Tauri application including
//! audio capture, ML engines, and settings.
//!
//! Note: AudioCapture is NOT stored in state because cpal::Stream is not Send+Sync.
//! Audio capture is managed through a dedicated thread via tokio::spawn_blocking.

pub mod recording;

#[allow(unused_imports)]
use aiwisper_audio::{are_channels_similar, is_silent, AudioCapture};
use aiwisper_ml::{TranscriptionEngine, VoicePrintMatcher};
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

/// Current session format version
/// v1: Go backend format (no version field)
/// v2: Rust backend format (with version field, normalized fields)
const CURRENT_SESSION_VERSION: u32 = 2;

/// Go backend session metadata (from meta.json)
/// Fields are needed for JSON deserialization even if not all are used
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct GoSessionMeta {
    /// Format version (v1 = Go, v2 = Rust)
    #[serde(default = "default_version_1")]
    version: u32,
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

fn default_version_1() -> u32 {
    1 // Old Go format without version field
}

/// Go backend chunk metadata
#[derive(Debug, serde::Serialize, serde::Deserialize)]
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
#[derive(Debug, serde::Serialize, serde::Deserialize)]
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

/// Statistics from session loading/migration
#[derive(Debug, Default)]
struct SessionLoadStats {
    total_found: usize,
    loaded_ok: usize,
    migrated_v1_to_v2: usize,
    validation_errors: usize,
    parse_errors: usize,
    read_errors: usize,
}

/// Validation result for a session
#[derive(Debug)]
enum SessionValidation {
    /// Session is valid
    Valid,
    /// Session has minor issues but is usable
    Warning(String),
    /// Session has critical issues and should be skipped
    Error(String),
}

/// Validate session metadata
fn validate_session_meta(meta: &GoSessionMeta, session_dir: &std::path::Path) -> SessionValidation {
    // Check required fields
    if meta.id.is_empty() {
        return SessionValidation::Error("Missing session ID".to_string());
    }
    
    if meta.start_time.is_empty() {
        return SessionValidation::Error("Missing start_time".to_string());
    }
    
    // Validate start_time format (should be RFC3339)
    if chrono::DateTime::parse_from_rfc3339(&meta.start_time).is_err() {
        // Try to parse as other common formats
        if chrono::NaiveDateTime::parse_from_str(&meta.start_time, "%Y-%m-%dT%H:%M:%S").is_err() {
            return SessionValidation::Warning(format!(
                "Invalid start_time format: {}",
                meta.start_time
            ));
        }
    }
    
    // Check if chunks directory exists (session without chunks is suspicious)
    let chunks_dir = session_dir.join("chunks");
    if !chunks_dir.exists() {
        // Check if there are embedded chunks in meta.json (old Go format)
        if meta.chunks.is_empty() && meta.chunks_count > 0 {
            return SessionValidation::Warning(
                "Missing chunks directory but chunksCount > 0".to_string()
            );
        }
    }
    
    // Check for audio file (either full.mp3 or segments)
    let has_audio = session_dir.join("full.mp3").exists()
        || session_dir.join("segment_000.mp3").exists();
    
    if !has_audio && meta.total_duration > 0 {
        return SessionValidation::Warning("Missing audio file".to_string());
    }
    
    // Check for negative or unrealistic duration
    if meta.total_duration < 0 {
        return SessionValidation::Warning(format!(
            "Negative duration: {}",
            meta.total_duration
        ));
    }
    
    // Duration > 24 hours is suspicious
    if meta.total_duration > 24 * 60 * 60 * 1000 {
        return SessionValidation::Warning(format!(
            "Suspiciously long duration: {} ms ({:.1} hours)",
            meta.total_duration,
            meta.total_duration as f64 / 3_600_000.0
        ));
    }
    
    SessionValidation::Valid
}

/// Migrate session from v1 (Go) to v2 (Rust) format
fn migrate_session_v1_to_v2(meta: &mut GoSessionMeta, meta_path: &std::path::Path) -> bool {
    if meta.version >= CURRENT_SESSION_VERSION {
        return false; // Already migrated
    }
    
    tracing::info!(
        "Migrating session {} from v{} to v{}",
        meta.id,
        meta.version,
        CURRENT_SESSION_VERSION
    );
    
    // Update version
    meta.version = CURRENT_SESSION_VERSION;
    
    // Normalize status field
    if meta.status.is_empty() {
        meta.status = "completed".to_string();
    }
    
    // Ensure tags is not null
    // (already handled by serde default)
    
    // Save updated meta.json
    match serde_json::to_string_pretty(meta) {
        Ok(content) => {
            // Atomic write via temp file
            let temp_path = meta_path.with_extension("json.tmp");
            if let Err(e) = std::fs::write(&temp_path, &content) {
                tracing::error!("Failed to write temp meta.json: {}", e);
                return false;
            }
            if let Err(e) = std::fs::rename(&temp_path, meta_path) {
                tracing::error!("Failed to rename temp meta.json: {}", e);
                let _ = std::fs::remove_file(&temp_path);
                return false;
            }
            tracing::debug!("Session {} migrated successfully", meta.id);
            true
        }
        Err(e) => {
            tracing::error!("Failed to serialize migrated meta: {}", e);
            false
        }
    }
}

/// Load sessions from disk with validation and migration
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
    let mut stats = SessionLoadStats::default();

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
        
        stats.total_found += 1;

        // Read and parse meta.json
        let content = match std::fs::read_to_string(&meta_path) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Failed to read {:?}: {}", meta_path, e);
                stats.read_errors += 1;
                continue;
            }
        };
        
        let mut meta: GoSessionMeta = match serde_json::from_str(&content) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("Failed to parse {:?}: {}", meta_path, e);
                stats.parse_errors += 1;
                continue;
            }
        };
        
        // Validate session
        match validate_session_meta(&meta, &path) {
            SessionValidation::Valid => {}
            SessionValidation::Warning(msg) => {
                tracing::warn!("Session {} validation warning: {}", meta.id, msg);
                // Continue loading, it's just a warning
            }
            SessionValidation::Error(msg) => {
                tracing::error!("Session {} validation failed: {}", meta.id, msg);
                stats.validation_errors += 1;
                continue;
            }
        }
        
        // Migrate if needed
        if meta.version < CURRENT_SESSION_VERSION {
            if migrate_session_v1_to_v2(&mut meta, &meta_path) {
                stats.migrated_v1_to_v2 += 1;
            }
        }
        
        // Convert and add to list
        let session = convert_go_session_to_rust(meta, &path);
        sessions.push(session);
        stats.loaded_ok += 1;
    }

    // Sort by created_at descending (newest first)
    sessions.sort_by(|a, b| b.start_time.cmp(&a.start_time));

    // Log statistics
    tracing::info!(
        "Session loading complete: {} found, {} loaded, {} migrated v1->v2, {} validation errors, {} parse errors, {} read errors",
        stats.total_found,
        stats.loaded_ok,
        stats.migrated_v1_to_v2,
        stats.validation_errors,
        stats.parse_errors,
        stats.read_errors
    );
    
    if stats.validation_errors > 0 || stats.parse_errors > 0 {
        tracing::warn!(
            "Some sessions could not be loaded. Check logs for details."
        );
    }
    
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

    // Duration: convert ms to nanoseconds (frontend expects ns)
    let duration_ns = (chunk.end_ms - chunk.start_ms) * 1_000_000;
    
    SessionChunk {
        id: chunk.id,
        index,
        start_ms: chunk.start_ms,
        end_ms: chunk.end_ms,
        duration: duration_ns,
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
    
    /// VoicePrint matcher for speaker recognition
    voiceprint_matcher: Option<VoicePrintMatcher>,
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

        // Initialize voiceprint matcher
        let voiceprint_matcher = get_data_dir()
            .and_then(|data_dir| {
                match VoicePrintMatcher::new(data_dir) {
                    Ok(matcher) => Some(matcher),
                    Err(e) => {
                        tracing::warn!("Failed to initialize VoicePrintMatcher: {}", e);
                        None
                    }
                }
            });

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
                voiceprint_matcher,
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
        let diarization_enabled = *self.inner.diarization_enabled.read();
        let diarization_provider = self.inner.diarization_provider.read().clone();
        
        let transcription_config = recording::TranscriptionConfig {
            model_id: model_id.clone(),
            language: language.clone(),
            hybrid_enabled: settings.hybrid_enabled,
            hybrid_secondary_model_id: settings.hybrid_secondary_model_id.clone(),
            hotwords: settings.hotwords.clone(),
            diarization_enabled,
            diarization_provider,
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
            .map(|chunk| {
                // Duration: convert ms to nanoseconds (frontend expects ns)
                let duration_ns = (chunk.end_ms - chunk.start_ms) * 1_000_000;
                SessionChunk {
                    id: chunk.id.clone(),
                    index: chunk.index,
                    start_ms: chunk.start_ms,
                    end_ms: chunk.end_ms,
                    duration: duration_ns,
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
                }
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

    /// Compute waveform from audio file using Mp3Decoder
    fn compute_waveform_from_file(path: &std::path::Path) -> Result<serde_json::Value> {
        use aiwisper_audio::Mp3Decoder;

        const SAMPLE_COUNT: usize = 400; // Number of waveform bins

        let waveform_data = Mp3Decoder::decode_waveform(path)?;
        let all_samples = waveform_data.channels;
        let sample_rate = waveform_data.sample_rate;
        let channels = waveform_data.channel_count;

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

    /// Get a specific session (refreshes chunks from disk for latest data)
    pub async fn get_session(&self, session_id: &str) -> Result<crate::commands::session::Session> {
        // First get base session from memory
        let mut session = {
            let sessions = self.inner.sessions.read();
            sessions
                .iter()
                .find(|s| s.id == session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Session not found"))?
        };
        
        // Reload chunks from disk to get latest transcription data
        // This is important because background transcription writes to disk
        // but doesn't update in-memory state
        if let Some(sessions_dir) = get_sessions_dir() {
            let session_path = sessions_dir.join(session_id);
            if session_path.exists() {
                let fresh_chunks = load_chunks_from_dir(&session_path);
                if !fresh_chunks.is_empty() {
                    // Merge: prefer disk chunks with transcription over memory chunks without
                    let merged_chunks: Vec<_> = fresh_chunks.into_iter().map(|disk_chunk| {
                        // Find matching memory chunk
                        if let Some(mem_chunk) = session.chunks.iter().find(|c| c.id == disk_chunk.id) {
                            // If disk has transcription and memory doesn't, use disk
                            if !disk_chunk.transcription.is_empty() && mem_chunk.transcription.is_empty() {
                                tracing::debug!(
                                    "Using disk transcription for chunk {} (mem was empty)",
                                    disk_chunk.index
                                );
                                disk_chunk
                            } else if disk_chunk.status == "completed" && mem_chunk.status != "completed" {
                                tracing::debug!(
                                    "Using disk chunk {} (completed status)",
                                    disk_chunk.index
                                );
                                disk_chunk
                            } else {
                                // Otherwise use memory chunk (may have fresher inline transcription)
                                mem_chunk.clone()
                            }
                        } else {
                            // Chunk only on disk, use it
                            disk_chunk
                        }
                    }).collect();
                    
                    session.chunks = merged_chunks;
                    
                    // Also update in-memory cache so subsequent reads are consistent
                    let mut sessions = self.inner.sessions.write();
                    if let Some(s) = sessions.iter_mut().find(|s| s.id == session_id) {
                        s.chunks = session.chunks.clone();
                    }
                }
            }
        }
        
        // Debug: log session state
        tracing::debug!(
            "get_session {}: summary={}, chunks={}, transcriptions={}",
            session_id,
            session.summary.as_ref().map(|s| s.len()).unwrap_or(0),
            session.chunks.len(),
            session.chunks.iter().filter(|c| !c.transcription.is_empty()).count()
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

    /// Rename a speaker within a session
    /// Updates all dialogue entries with the old speaker name to use the new name
    pub async fn rename_session_speaker(
        &self,
        session_id: &str,
        speaker_id: &str,
        new_name: &str,
    ) -> Result<()> {
        // Update in-memory
        {
            let mut sessions = self.inner.sessions.write();
            let session = sessions
                .iter_mut()
                .find(|s| s.id == session_id)
                .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

            let mut updated_count = 0;
            for chunk in &mut session.chunks {
                for segment in &mut chunk.dialogue {
                    if let Some(speaker) = &segment.speaker {
                        if speaker == speaker_id {
                            segment.speaker = Some(new_name.to_string());
                            updated_count += 1;
                        }
                    }
                }
            }

            tracing::info!(
                "Renamed speaker '{}' to '{}' in {} dialogue segments",
                speaker_id,
                new_name,
                updated_count
            );
        }

        // Persist changes to disk (save all chunks)
        self.save_session_chunks_to_disk(session_id).await?;

        Ok(())
    }

    /// Merge two speakers in a session
    /// All dialogue entries from source_speaker_id will be reassigned to target_speaker_id
    pub async fn merge_session_speakers(
        &self,
        session_id: &str,
        source_speaker_id: &str,
        target_speaker_id: &str,
    ) -> Result<()> {
        // Update in-memory
        {
            let mut sessions = self.inner.sessions.write();
            let session = sessions
                .iter_mut()
                .find(|s| s.id == session_id)
                .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

            let mut merged_count = 0;
            for chunk in &mut session.chunks {
                for segment in &mut chunk.dialogue {
                    if let Some(speaker) = &segment.speaker {
                        if speaker == source_speaker_id {
                            segment.speaker = Some(target_speaker_id.to_string());
                            merged_count += 1;
                        }
                    }
                }
            }

            tracing::info!(
                "Merged speaker '{}' into '{}': {} dialogue segments updated",
                source_speaker_id,
                target_speaker_id,
                merged_count
            );
        }

        // Persist changes to disk
        self.save_session_chunks_to_disk(session_id).await?;

        Ok(())
    }

    /// Search sessions by query
    /// Searches in session titles, tags, and transcription text
    pub async fn search_sessions(
        &self,
        query: &str,
    ) -> Result<Vec<crate::commands::session::SessionInfo>> {
        let query_lower = query.to_lowercase();
        let sessions = self.inner.sessions.read();

        let results: Vec<crate::commands::session::SessionInfo> = sessions
            .iter()
            .filter(|s| {
                // Search in title
                if let Some(title) = &s.title {
                    if title.to_lowercase().contains(&query_lower) {
                        return true;
                    }
                }

                // Search in tags
                for tag in &s.tags {
                    if tag.to_lowercase().contains(&query_lower) {
                        return true;
                    }
                }

                // Search in transcription text
                for chunk in &s.chunks {
                    if chunk.transcription.to_lowercase().contains(&query_lower) {
                        return true;
                    }
                    // Also search in dialogue
                    for segment in &chunk.dialogue {
                        if segment.text.to_lowercase().contains(&query_lower) {
                            return true;
                        }
                    }
                }

                false
            })
            .map(|s| crate::commands::session::SessionInfo {
                id: s.id.clone(),
                start_time: s.start_time.clone(),
                status: s.status.clone(),
                total_duration: s.total_duration,
                chunks_count: s.chunks.len(),
                title: s.title.clone(),
                tags: s.tags.clone(),
            })
            .collect();

        tracing::debug!(
            "Search '{}' found {} sessions",
            query,
            results.len()
        );

        Ok(results)
    }

    /// Save all chunks of a session to disk
    async fn save_session_chunks_to_disk(&self, session_id: &str) -> Result<()> {
        let chunks = {
            let sessions = self.inner.sessions.read();
            let session = sessions
                .iter()
                .find(|s| s.id == session_id)
                .ok_or_else(|| anyhow::anyhow!("Session not found"))?;
            session.chunks.clone()
        };

        for chunk in &chunks {
            Self::save_chunk_to_disk(session_id, chunk)?;
        }

        tracing::debug!(
            "Saved {} chunks to disk for session {}",
            chunks.len(),
            session_id
        );

        Ok(())
    }

    // ========================================================================
    // Voiceprints management
    // ========================================================================

    /// List all voiceprints
    pub async fn list_voiceprints(&self) -> Result<Vec<crate::commands::voiceprints::VoicePrint>> {
        use crate::commands::voiceprints::VoicePrint;

        if let Some(ref matcher) = self.inner.voiceprint_matcher {
            let voiceprints: Vec<VoicePrint> = matcher
                .get_all()
                .into_iter()
                .map(|vp| VoicePrint {
                    id: vp.id,
                    name: vp.name,
                    embedding: vp.embedding,
                    created_at: vp.created_at,
                    updated_at: vp.updated_at,
                    last_seen_at: vp.last_seen_at,
                    seen_count: vp.seen_count,
                    sample_path: vp.sample_path,
                    source: vp.source,
                    notes: vp.notes,
                })
                .collect();

            tracing::debug!("Listed {} voiceprints", voiceprints.len());
            return Ok(voiceprints);
        }

        Ok(vec![])
    }

    /// Create a new voiceprint
    pub async fn create_voiceprint(
        &self,
        name: &str,
        embedding: Vec<f32>,
        source: Option<String>,
    ) -> Result<crate::commands::voiceprints::VoicePrint> {
        use crate::commands::voiceprints::VoicePrint;

        let matcher = self.inner.voiceprint_matcher.as_ref()
            .ok_or_else(|| anyhow::anyhow!("VoicePrintMatcher not initialized"))?;

        let vp = matcher.add(name, embedding, source)?;

        Ok(VoicePrint {
            id: vp.id,
            name: vp.name,
            embedding: vp.embedding,
            created_at: vp.created_at,
            updated_at: vp.updated_at,
            last_seen_at: vp.last_seen_at,
            seen_count: vp.seen_count,
            sample_path: vp.sample_path,
            source: vp.source,
            notes: vp.notes,
        })
    }

    /// Rename a voiceprint
    pub async fn rename_voiceprint(&self, id: &str, name: &str) -> Result<()> {
        let matcher = self.inner.voiceprint_matcher.as_ref()
            .ok_or_else(|| anyhow::anyhow!("VoicePrintMatcher not initialized"))?;

        matcher.update_name(id, name)?;
        tracing::info!("Renamed voiceprint {} to '{}'", id, name);
        Ok(())
    }

    /// Delete a voiceprint
    pub async fn delete_voiceprint(&self, id: &str) -> Result<()> {
        let matcher = self.inner.voiceprint_matcher.as_ref()
            .ok_or_else(|| anyhow::anyhow!("VoicePrintMatcher not initialized"))?;

        matcher.delete(id)?;
        Ok(())
    }

    /// Find best matching voiceprint for an embedding
    pub fn find_voiceprint_match(&self, embedding: &[f32]) -> Option<aiwisper_ml::MatchResult> {
        self.inner.voiceprint_matcher.as_ref()
            .and_then(|matcher| matcher.find_best_match(embedding))
    }

    /// Match voiceprint with auto-update on high confidence
    pub fn match_voiceprint_with_update(&self, embedding: &[f32]) -> Option<aiwisper_ml::MatchResult> {
        self.inner.voiceprint_matcher.as_ref()
            .and_then(|matcher| matcher.match_with_auto_update(embedding))
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

        // Generate 2 seconds of silence as a sample (32000 samples at 16kHz)
        let silence_samples = vec![0.0f32; 32000];
        let wav_data = Self::samples_to_wav(&silence_samples);

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
        let num_samples = (duration_sec * 16000.0) as usize;
        let silence_samples = vec![0.0f32; num_samples];
        let wav_data = Self::samples_to_wav(&silence_samples);

        // Encode as base64 data URL
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav_data);
        Ok(format!("data:audio/wav;base64,{}", base64))
    }

    /// Get chunk audio as base64-encoded WAV
    /// Returns a data URL that can be used directly in an <audio> element
    /// Preserves stereo channels (left=mic, right=system) for proper playback
    pub async fn get_chunk_audio(&self, session_id: &str, chunk_index: usize) -> Result<String> {
        // Get chunk timestamps
        let (start_ms, end_ms) = {
            let sessions = self.inner.sessions.read();
            let session = sessions
                .iter()
                .find(|s| s.id == session_id)
                .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

            let chunk = session
                .chunks
                .get(chunk_index)
                .ok_or_else(|| anyhow::anyhow!("Chunk not found"))?;
            
            (chunk.start_ms, chunk.end_ms)
        };
        
        // Extract stereo audio samples from the MP3 file (preserves channels and sample rate)
        let (left_samples, right_samples, sample_rate) = self.extract_audio_segment_for_playback(session_id, start_ms, end_ms).await?;
        
        if left_samples.is_empty() && right_samples.is_empty() {
            return Err(anyhow::anyhow!("No audio samples for chunk"));
        }
        
        // Convert stereo samples to WAV (preserves original sample rate)
        let wav_data = Self::samples_to_wav_stereo(&left_samples, &right_samples, sample_rate);

        // Encode as base64 data URL
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav_data);
        Ok(format!("data:audio/wav;base64,{}", base64))
    }
    
    /// Convert f32 samples to WAV format
    /// Format: 16kHz, mono, 16-bit PCM
    fn samples_to_wav(samples: &[f32]) -> Vec<u8> {
        const SAMPLE_RATE: u32 = 16000;
        const BITS_PER_SAMPLE: u16 = 16;
        const CHANNELS: u16 = 1;

        let num_samples = samples.len() as u32;
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

        // Convert f32 samples to i16 PCM
        for &sample in samples {
            // Clamp to [-1.0, 1.0] and scale to i16 range
            let clamped = sample.clamp(-1.0, 1.0);
            let pcm = (clamped * 32767.0) as i16;
            wav.extend_from_slice(&pcm.to_le_bytes());
        }

        wav
    }
    
    /// Convert interleaved stereo f32 samples to WAV format
    /// Format: specified sample_rate, stereo, 16-bit PCM
    fn samples_to_wav_stereo(left: &[f32], right: &[f32], sample_rate: u32) -> Vec<u8> {
        const BITS_PER_SAMPLE: u16 = 16;
        const CHANNELS: u16 = 2;

        let num_samples = left.len().min(right.len()) as u32;
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
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        let byte_rate = sample_rate * CHANNELS as u32 * (BITS_PER_SAMPLE / 8) as u32;
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());

        // data chunk
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());

        // Interleave and convert f32 samples to i16 PCM (L, R, L, R, ...)
        for i in 0..num_samples as usize {
            // Left channel
            let left_sample = left.get(i).copied().unwrap_or(0.0).clamp(-1.0, 1.0);
            let left_pcm = (left_sample * 32767.0) as i16;
            wav.extend_from_slice(&left_pcm.to_le_bytes());
            
            // Right channel
            let right_sample = right.get(i).copied().unwrap_or(0.0).clamp(-1.0, 1.0);
            let right_pcm = (right_sample * 32767.0) as i16;
            wav.extend_from_slice(&right_pcm.to_le_bytes());
        }

        wav
    }
    
    /// Extract stereo audio segment for playback (preserves original sample rate)
    /// Returns (left_samples, right_samples, sample_rate)
    async fn extract_audio_segment_for_playback(
        &self,
        session_id: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<(Vec<f32>, Vec<f32>, u32)> {
        use aiwisper_audio::Mp3Decoder;

        let sessions_dir =
            get_sessions_dir().ok_or_else(|| anyhow::anyhow!("Sessions directory not found"))?;

        let mp3_path = sessions_dir.join(session_id).join("full.mp3");

        if !mp3_path.exists() {
            return Err(anyhow::anyhow!("Audio file not found: {:?}", mp3_path));
        }

        let segment = Mp3Decoder::decode_segment_for_playback(&mp3_path, start_ms, end_ms)?;
        Ok((segment.left, segment.right, segment.sample_rate))
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

    // ========================================================================
    // Audio Import
    // ========================================================================

    /// Import an audio file (MP3/WAV/M4A/OGG/FLAC) and create a new session
    /// 
    /// This method:
    /// 1. Loads the audio file and resamples to 16kHz mono
    /// 2. Creates a new session with unique ID
    /// 3. Copies/converts the audio to full.mp3 in the session folder
    /// 4. Splits audio into ~10 second chunks
    /// 5. Creates chunk metadata files
    /// 6. Returns the created session (without transcription - that's done separately)
    pub async fn import_audio(
        &self,
        path: &str,
        language: Option<String>,
        app_handle: tauri::AppHandle,
    ) -> Result<crate::commands::session::Session> {
        use crate::commands::session::{Session, SessionChunk};
        use tauri::Emitter;
        
        tracing::info!("Importing audio file: {}", path);
        
        // 1. Validate file exists
        let source_path = std::path::Path::new(path);
        if !source_path.exists() {
            return Err(anyhow::anyhow!("Audio file not found: {}", path));
        }
        
        // 2. Get file extension for format detection
        let ext = source_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        
        let supported_formats = ["mp3", "wav", "m4a", "ogg", "flac"];
        if !supported_formats.contains(&ext.as_str()) {
            return Err(anyhow::anyhow!(
                "Unsupported audio format: {}. Supported: {:?}",
                ext,
                supported_formats
            ));
        }
        
        // 3. Load audio file (resampled to 16kHz mono)
        let samples = aiwisper_audio::load_audio_file(path)?;
        let sample_count = samples.len();
        let duration_ms = (sample_count as f64 / 16.0) as u64; // 16kHz -> ms
        
        tracing::info!(
            "Loaded audio: {} samples, {:.1} seconds",
            sample_count,
            duration_ms as f64 / 1000.0
        );
        
        // 4. Create session ID and directory
        let session_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        
        let sessions_dir = get_sessions_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine sessions directory"))?;
        let session_dir = sessions_dir.join(&session_id);
        let chunks_dir = session_dir.join("chunks");
        
        std::fs::create_dir_all(&chunks_dir)?;
        
        // 5. Copy or convert audio to full.mp3
        let mp3_path = session_dir.join("full.mp3");
        if ext == "mp3" {
            // Just copy the original MP3
            std::fs::copy(source_path, &mp3_path)?;
            tracing::info!("Copied MP3 to {:?}", mp3_path);
        } else {
            // Convert to MP3 using FFmpeg
            let mp3_path_str = mp3_path.to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid UTF-8 in path: {:?}", mp3_path))?;
            let status = std::process::Command::new("ffmpeg")
                .args([
                    "-y",           // Overwrite output
                    "-i", path,     // Input file
                    "-codec:a", "libmp3lame",
                    "-b:a", "128k", // Bitrate
                    mp3_path_str,
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            
            match status {
                Ok(s) if s.success() => {
                    tracing::info!("Converted to MP3: {:?}", mp3_path);
                }
                Ok(s) => {
                    tracing::warn!(
                        "FFmpeg exited with code {:?}, falling back to WAV",
                        s.code()
                    );
                    // Fallback: save as WAV
                    let wav_path = session_dir.join("full.wav");
                    let wav_bytes = aiwisper_audio::samples_to_wav_bytes(&samples, 16000)?;
                    std::fs::write(&wav_path, wav_bytes)?;
                }
                Err(e) => {
                    tracing::warn!("FFmpeg not available: {}, saving as WAV", e);
                    // Fallback: save as WAV
                    let wav_path = session_dir.join("full.wav");
                    let wav_bytes = aiwisper_audio::samples_to_wav_bytes(&samples, 16000)?;
                    std::fs::write(&wav_path, wav_bytes)?;
                }
            }
        }
        
        // 6. Split into chunks (~10 seconds each)
        const SAMPLES_PER_CHUNK: usize = 16000 * 10; // 10 seconds at 16kHz
        
        let mut chunks: Vec<SessionChunk> = Vec::new();
        let mut chunk_index = 0;
        let mut offset = 0usize;
        
        while offset < samples.len() {
            let end = (offset + SAMPLES_PER_CHUNK).min(samples.len());
            
            let start_ms = (offset as u64 * 1000) / 16000;
            let end_ms = (end as u64 * 1000) / 16000;
            let duration_ns = (end_ms - start_ms) as i64 * 1_000_000;
            
            let chunk_id = uuid::Uuid::new_v4().to_string();
            
            let chunk = SessionChunk {
                id: chunk_id.clone(),
                index: chunk_index,
                start_ms: start_ms as i64,
                end_ms: end_ms as i64,
                duration: duration_ns,
                transcription: String::new(),
                mic_text: None,
                sys_text: None,
                dialogue: Vec::new(),
                is_stereo: false, // Imported audio is mono
                status: "pending".to_string(),
                speaker: None,
            };
            
            // Save chunk metadata
            let chunk_file = chunks_dir.join(format!("chunk_{:04}.json", chunk_index));
            let chunk_json = serde_json::json!({
                "id": chunk.id,
                "index": chunk.index,
                "startMs": chunk.start_ms,
                "endMs": chunk.end_ms,
                "transcription": "",
                "dialogue": [],
                "status": "pending",
            });
            std::fs::write(&chunk_file, serde_json::to_string_pretty(&chunk_json)?)?;
            
            chunks.push(chunk);
            chunk_index += 1;
            offset = end;
        }
        
        tracing::info!("Created {} chunks", chunks.len());
        
        // 7. Get source filename for title
        let source_filename = source_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Импортированный файл");
        
        // 8. Create session metadata
        let settings = self.inner.settings.read().clone();
        let session = Session {
            id: session_id.clone(),
            start_time: now.to_rfc3339(),
            end_time: Some(now.to_rfc3339()),
            status: "completed".to_string(),
            chunks,
            data_dir: session_dir.to_string_lossy().to_string(),
            total_duration: duration_ms,
            title: Some(format!("{} · {:.1} мин", source_filename, duration_ms as f64 / 60000.0)),
            tags: vec!["импорт".to_string()],
            summary: None,
            language: language.or_else(|| Some(settings.language.clone())),
            model: Some(settings.whisper_model.clone()),
        };
        
        // 9. Save meta.json
        let meta_path = session_dir.join("meta.json");
        let meta_json = serde_json::json!({
            "id": session.id,
            "startTime": session.start_time,
            "endTime": session.end_time,
            "status": session.status,
            "totalDuration": session.total_duration,
            "chunksCount": session.chunks.len(),
            "title": session.title,
            "tags": session.tags,
            "language": session.language,
            "model": session.model,
            "sampleCount": sample_count,
        });
        std::fs::write(&meta_path, serde_json::to_string_pretty(&meta_json)?)?;
        
        tracing::info!("Saved session metadata to {:?}", meta_path);
        
        // 10. Add to in-memory sessions
        self.inner.sessions.write().push(session.clone());
        
        // 11. Emit events
        let _ = app_handle.emit(
            "session_started",
            serde_json::json!({
                "sessionId": session_id,
                "session": &session,
            }),
        );
        
        // Emit sessions list update
        if let Ok(sessions) = self.list_sessions().await {
            let _ = app_handle.emit(
                "sessions_list",
                serde_json::json!({ "sessions": sessions }),
            );
        }
        
        tracing::info!(
            "Audio import complete: session={}, chunks={}, duration={:.1}s",
            session_id,
            session.chunks.len(),
            duration_ms as f64 / 1000.0
        );
        
        Ok(session)
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
        let (mut start_ms, mut end_ms, chunk_index, total_chunks, session_duration) = {
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

            (chunk.start_ms, chunk.end_ms, chunk.index, session.chunks.len(), session.total_duration)
            // sessions guard dropped here
        };
        
        // WORKAROUND: Fix broken timestamps from old recordings
        // If start_ms=0 and end_ms=10000 but chunk_index > 0, recalculate
        if start_ms == 0 && chunk_index > 0 {
            const CHUNK_DURATION_MS: i64 = 10000;
            start_ms = chunk_index as i64 * CHUNK_DURATION_MS;
            end_ms = (chunk_index as i64 + 1) * CHUNK_DURATION_MS;
            
            // Adjust last chunk end_ms based on session duration
            if chunk_index as usize == total_chunks - 1 && session_duration > 0 {
                end_ms = session_duration as i64;
            }
            
            tracing::warn!(
                "Fixed broken timestamps for chunk {}: {} - {} ms",
                chunk_index, start_ms, end_ms
            );
        }

        // 2. Extract stereo audio segment (left=mic, right=sys)
        let (mic_samples, sys_samples) = self
            .extract_audio_segment_stereo(session_id, start_ms, end_ms)
            .await?;

        // 3. Check if channels are similar (duplicated mono)
        let is_stereo = !are_channels_similar(&mic_samples, &sys_samples);
        
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
        
        // Check for silent channels to avoid hallucinations like "Продолжение следует..."
        let mic_is_silent = is_silent(&mic_samples, None);
        let sys_is_silent = is_silent(&sys_samples, None);
        
        tracing::info!(
            "Retranscribe chunk {}: mic={} sys={} samples, is_stereo={}, silent=(mic:{}, sys:{})",
            chunk_index,
            mic_samples.len(),
            sys_samples.len(),
            is_stereo,
            mic_is_silent,
            sys_is_silent
        );

        if is_stereo {
            // Stereo mode: transcribe channels separately (like Go backend)
            // Skip silent channels to avoid hallucinations like "Продолжение следует..."
            
            // 3a. Transcribe MIC channel -> "Вы" (skip if silent)
            if !mic_samples.is_empty() && !mic_is_silent {
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
            } else if mic_is_silent {
                tracing::info!("Skipping MIC channel for chunk {} - silent", chunk_index);
            }

            // 3b. Transcribe SYS channel -> "Собеседник" (skip if silent)
            if !sys_samples.is_empty() && !sys_is_silent {
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
            } else if sys_is_silent {
                tracing::info!("Skipping SYS channel for chunk {} - silent", chunk_index);
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

        // 4. Update chunk in session (including corrected timestamps)
        let duration_ns = self.update_chunk_transcription(
            session_id, chunk_id, start_ms, end_ms, &dialogue, &mic_text, &sys_text
        );

        // 5. Build response and emit event
        let result = Self::build_chunk_event_payload(
            session_id, chunk_id, chunk_index, start_ms, end_ms, duration_ns, &dialogue, &mic_text, &sys_text
        );
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
        let mut chunk_infos: Vec<(String, i32, i64, i64)> = {
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
        
        // WORKAROUND: Fix broken timestamps from old recordings (all start_ms=0 bug)
        // If more than 2 chunks have the same start_ms, recalculate from indices
        if total_chunks > 2 {
            let same_start_count = chunk_infos.iter()
                .filter(|(_, _, start_ms, _)| *start_ms == 0)
                .count();
            
            if same_start_count > total_chunks / 2 {
                tracing::warn!(
                    "Detected broken timestamps ({}/{} chunks have start_ms=0), recalculating from indices",
                    same_start_count, total_chunks
                );
                
                // Assume ~10 second chunks and recalculate
                const CHUNK_DURATION_MS: i64 = 10000;
                for (idx, (_, _, start_ms, end_ms)) in chunk_infos.iter_mut().enumerate() {
                    *start_ms = idx as i64 * CHUNK_DURATION_MS;
                    *end_ms = (idx as i64 + 1) * CHUNK_DURATION_MS;
                }
                
                // Adjust last chunk end_ms based on session duration if available
                if let Some((_, _, _, end_ms)) = chunk_infos.last_mut() {
                    let sessions = self.inner.sessions.read();
                    if let Some(session) = sessions.iter().find(|s| s.id == session_id) {
                        if session.total_duration > 0 {
                            *end_ms = session.total_duration as i64;
                        }
                    }
                }
            }
        }

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
            let is_stereo = !are_channels_similar(&mic_samples, &sys_samples);
            
            // Check if using cloud provider
            let use_cloud = stt_provider != "local" && !stt_provider.is_empty();
            
            let mut dialogue: Vec<DialogueSegment> = Vec::new();
            let mut mic_text = String::new();
            let mut sys_text = String::new();

            if is_stereo {
                // Stereo mode: transcribe channels separately
                // Skip silent channels to avoid hallucinations like "Продолжение следует..."
                
                let mic_is_silent = is_silent(&mic_samples, None);
                let sys_is_silent = is_silent(&sys_samples, None);
                
                // Transcribe MIC channel -> "Вы" (skip if silent)
                if !mic_samples.is_empty() && !mic_is_silent {
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
                } else if mic_is_silent {
                    tracing::debug!("Skipping MIC channel for chunk {} - silent", chunk_index);
                }

                // Transcribe SYS channel -> "Собеседник" (skip if silent)
                if !sys_samples.is_empty() && !sys_is_silent {
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
                } else if sys_is_silent {
                    tracing::debug!("Skipping SYS channel for chunk {} - silent", chunk_index);
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

            // Update chunk (including corrected timestamps) and emit event
            let duration_ns = self.update_chunk_transcription(
                session_id, &chunk_id, start_ms, end_ms, &dialogue, &mic_text, &sys_text
            );
            let event_payload = Self::build_chunk_event_payload(
                session_id, &chunk_id, chunk_index, start_ms, end_ms, duration_ns, &dialogue, &mic_text, &sys_text
            );
            let _ = window.emit("chunk_transcribed", event_payload);
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

    /// Extract audio segment from session's MP3 file (mono mix for ASR)
    async fn extract_audio_segment(
        &self,
        session_id: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<f32>> {
        use aiwisper_audio::Mp3Decoder;

        let sessions_dir =
            get_sessions_dir().ok_or_else(|| anyhow::anyhow!("Sessions directory not found"))?;

        let mp3_path = sessions_dir.join(session_id).join("full.mp3");

        if !mp3_path.exists() {
            return Err(anyhow::anyhow!("Audio file not found: {:?}", mp3_path));
        }

        Mp3Decoder::decode_segment_mono(&mp3_path, start_ms, end_ms)
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
    ///
    /// Использует глобальный кэш движков для избежания многократной загрузки модели.
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
            get_or_create_engine_cached, HybridMode, HybridTranscriber, HybridTranscriptionConfig,
            VotingConfig,
        };

        // Get primary engine from cache (or create if first time)
        let primary_engine = get_or_create_engine_cached(model_id, language)?;

        // If hybrid enabled, create secondary engine and use HybridTranscriber
        if hybrid_enabled && !hybrid_secondary_model_id.is_empty() {
            tracing::info!(
                "Using hybrid transcription: primary={}, secondary={}",
                model_id,
                hybrid_secondary_model_id
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
        use aiwisper_audio::Mp3Decoder;

        let sessions_dir =
            get_sessions_dir().ok_or_else(|| anyhow::anyhow!("Sessions directory not found"))?;

        let mp3_path = sessions_dir.join(session_id).join("full.mp3");

        if !mp3_path.exists() {
            return Err(anyhow::anyhow!("Audio file not found: {:?}", mp3_path));
        }

        Mp3Decoder::decode_segment_stereo(&mp3_path, start_ms, end_ms)
    }

    /// Update chunk with transcription results
    /// Returns the duration in nanoseconds
    fn update_chunk_transcription(
        &self,
        session_id: &str,
        chunk_id: &str,
        start_ms: i64,
        end_ms: i64,
        dialogue: &[crate::commands::session::DialogueSegment],
        mic_text: &str,
        sys_text: &str,
    ) -> i64 {
        let duration_ns = (end_ms - start_ms) * 1_000_000;
        
        let mut sessions = self.inner.sessions.write();
        if let Some(session) = sessions.iter_mut().find(|s| s.id == session_id) {
            if let Some(chunk) = session.chunks.iter_mut().find(|c| c.id == chunk_id) {
                // Update timestamps (may have been recalculated for broken old recordings)
                chunk.start_ms = start_ms;
                chunk.end_ms = end_ms;
                chunk.duration = duration_ns;
                chunk.dialogue = dialogue.to_vec();
                chunk.transcription = dialogue
                    .iter()
                    .map(|d| d.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                chunk.mic_text = if mic_text.is_empty() { None } else { Some(mic_text.to_string()) };
                chunk.sys_text = if sys_text.is_empty() { None } else { Some(sys_text.to_string()) };

                let _ = Self::save_chunk_to_disk(session_id, chunk);
            }
        }
        
        duration_ns
    }
    
    /// Build chunk transcribed event payload
    fn build_chunk_event_payload(
        session_id: &str,
        chunk_id: &str,
        chunk_index: i32,
        start_ms: i64,
        end_ms: i64,
        duration_ns: i64,
        dialogue: &[crate::commands::session::DialogueSegment],
        mic_text: &str,
        sys_text: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "sessionId": session_id,
            "chunk": {
                "id": chunk_id,
                "index": chunk_index,
                "startMs": start_ms,
                "endMs": end_ms,
                "duration": duration_ns,
                "dialogue": dialogue,
                "micText": if mic_text.is_empty() { None } else { Some(mic_text) },
                "sysText": if sys_text.is_empty() { None } else { Some(sys_text) },
            }
        })
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
