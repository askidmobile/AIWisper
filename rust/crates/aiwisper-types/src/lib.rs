//! Shared types for AIWisper
//!
//! This crate contains all shared data structures used across
//! the AIWisper application.
//!
//! Types are annotated with `#[ts(export)]` for TypeScript generation via ts-rs.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ============================================================================
// Session Types
// ============================================================================

/// Session status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Active,
    Recording,
    Completed,
    Failed,
}

/// Session information (lightweight, for lists)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub start_time: String,
    pub status: String,
    pub total_duration: u64,
    pub chunks_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// Full session data
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub start_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<String>,
    pub status: String,
    pub chunks: Vec<Chunk>,
    pub data_dir: String,
    pub total_duration: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_count: Option<u64>,
}

/// Chunk status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum ChunkStatus {
    Pending,
    Transcribing,
    Completed,
    Error,
}

/// Audio chunk with transcription
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub id: String,
    pub index: i32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub duration: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mic_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sys_text: Option<String>,
    #[serde(default)]
    pub dialogue: Vec<DialogueEntry>,
    #[serde(default)]
    pub is_stereo: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Dialogue entry with speaker information
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DialogueEntry {
    pub start: i64,
    pub end: i64,
    pub text: String,
    #[serde(default)]
    pub speaker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<TranscriptWord>>,
}

// ============================================================================
// Transcription Types
// ============================================================================

/// Transcription result
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    /// Full transcribed text
    pub text: String,
    /// Segments with timestamps
    pub segments: Vec<TranscriptSegment>,
    /// Detected language (ISO 639-1 code)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Processing time in milliseconds
    pub processing_time_ms: u64,
    /// Real-time factor (audio_duration / processing_time)
    pub rtf: f32,
}

/// A segment of transcribed text with timing information
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    /// Start time in milliseconds
    pub start: i64,
    /// End time in milliseconds
    pub end: i64,
    /// Transcribed text
    pub text: String,
    /// Speaker identifier (e.g., "Speaker 0")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// Word-level timestamps
    #[serde(default)]
    pub words: Vec<TranscriptWord>,
    /// Confidence score (0.0 - 1.0)
    #[serde(default)]
    pub confidence: f32,
}

/// A single word with timing information
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    /// Start time in milliseconds
    pub start: i64,
    /// End time in milliseconds  
    pub end: i64,
    /// The word text
    pub text: String,
    /// Confidence score (0.0 - 1.0)
    #[serde(default)]
    pub confidence: f32,
}

// ============================================================================
// Speaker & Diarization Types
// ============================================================================

/// Speaker segment from diarization
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SpeakerSegment {
    /// Start time in seconds
    pub start: f32,
    /// End time in seconds
    pub end: f32,
    /// Speaker ID (0, 1, 2...)
    pub speaker: i32,
}

/// Session speaker info (for UI)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpeaker {
    /// Speaker ID within session (e.g., "mic", "sys", "Собеседник 1")
    pub id: String,
    /// Display name (can be renamed by user)
    pub display_name: String,
    /// Whether this is the microphone user
    pub is_mic: bool,
    /// Whether speaker was recognized via voiceprint
    pub is_recognized: bool,
    /// Associated voiceprint ID (if recognized)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voiceprint_id: Option<String>,
    /// Number of dialogue entries for this speaker
    pub entry_count: u32,
    /// Total duration in milliseconds
    pub total_duration_ms: u64,
}

/// VoicePrint for speaker recognition
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct VoicePrint {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    /// Speaker embedding vector (for matching)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(skip)]
    pub embedding: Option<Vec<f32>>,
    /// Number of samples used to create this voiceprint
    pub sample_count: u32,
}

// ============================================================================
// Audio Types
// ============================================================================

/// Audio input device information
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    /// Device ID
    pub id: String,
    /// Human-readable device name
    pub name: String,
    /// Whether this is the default device
    pub is_default: bool,
    /// Number of input channels
    pub channels: u16,
    /// Sample rate in Hz
    pub sample_rate: u32,
}

/// Waveform data for visualization
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct WaveformData {
    pub peaks: Vec<Vec<f32>>,
    pub rms: Vec<Vec<f32>>,
    pub rms_absolute: Vec<Vec<f32>>,
    pub sample_duration: f64,
    pub duration: f64,
    pub sample_count: u64,
    pub channel_count: u32,
}

/// Audio level event (for VU meters)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevelEvent {
    pub mic_level: f32,
    pub sys_level: f32,
    pub duration: f64,
    #[serde(default)]
    pub mic_muted: bool,
    #[serde(default)]
    pub sys_muted: bool,
}

// ============================================================================
// Model Types
// ============================================================================

/// Model type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum ModelType {
    Ggml,
    Onnx,
    Coreml,
}

/// Engine type for transcription
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum EngineType {
    Whisper,
    Gigaam,
    #[serde(rename = "fluid-asr")]
    FluidAsr,
    Speaker,
    Diarization,
    Vad,
}

/// Model status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ModelStatus {
    NotDownloaded,
    Downloading,
    Downloaded,
    Active,
    Error,
}

/// Model information with all fields matching frontend expectations
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Model ID (e.g., "ggml-base")
    pub id: String,
    /// Human-readable name
    pub name: String,
    /// Model type (ggml, onnx, coreml)
    #[serde(rename = "type")]
    pub model_type: String,
    /// Engine type (whisper, gigaam, fluid-asr, diarization, vad)
    pub engine: String,
    /// Human-readable size (e.g., "141 MB")
    pub size: String,
    /// Size in bytes
    pub size_bytes: u64,
    /// Description
    pub description: String,
    /// Supported languages
    pub languages: Vec<String>,
    /// Word Error Rate (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wer: Option<String>,
    /// Speed multiplier (e.g., "~7x")
    pub speed: String,
    /// Is this a recommended model?
    #[serde(default)]
    pub recommended: bool,
    /// Download URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    /// Is model in archive format
    #[serde(default)]
    pub is_archive: bool,
    /// Model status
    pub status: String,
    /// Download progress (0-100)
    #[serde(default)]
    pub progress: f64,
    /// Error message if any
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Path to downloaded model
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

// ============================================================================
// Settings Types
// ============================================================================

/// Application settings
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub language: String,
    pub model_id: String,
    #[serde(default)]
    pub echo_cancel: i32,
    #[serde(default)]
    pub use_voice_isolation: bool,
    #[serde(default)]
    pub capture_system: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vad_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vad_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default = "default_ollama_model")]
    pub ollama_model: String,
    #[serde(default = "default_ollama_url")]
    pub ollama_url: String,
    #[serde(default)]
    pub diarization_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diarization_provider: Option<String>,
    #[serde(default)]
    pub show_session_stats: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hybrid_transcription: Option<HybridSettings>,
}

fn default_ollama_model() -> String {
    "llama3.2".to_string()
}

fn default_ollama_url() -> String {
    "http://localhost:11434".to_string()
}

/// Hybrid transcription settings
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct HybridSettings {
    pub enabled: bool,
    pub secondary_model_id: String,
    #[serde(default = "default_confidence_threshold")]
    pub confidence_threshold: f32,
    #[serde(default = "default_context_words")]
    pub context_words: u32,
    #[serde(default)]
    pub use_llm_for_merge: bool,
    #[serde(default = "default_hybrid_mode")]
    pub mode: String,
    #[serde(default)]
    pub hotwords: Vec<String>,
}

fn default_confidence_threshold() -> f32 {
    0.5
}

fn default_context_words() -> u32 {
    3
}

fn default_hybrid_mode() -> String {
    "parallel".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: "auto".to_string(),
            model_id: "ggml-large-v3-turbo".to_string(),
            echo_cancel: 0,
            use_voice_isolation: false,
            capture_system: true,
            vad_mode: None,
            vad_method: None,
            theme: None,
            ollama_model: default_ollama_model(),
            ollama_url: default_ollama_url(),
            diarization_enabled: true,
            diarization_provider: Some("coreml".to_string()),
            show_session_stats: false,
            hybrid_transcription: None,
        }
    }
}

// ============================================================================
// Event Types (for Tauri events)
// ============================================================================

/// Session started event payload
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartedEvent {
    pub session_id: String,
    pub session: Session,
}

/// Session stopped event payload
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SessionStoppedEvent {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<Session>,
}

/// Chunk created event payload
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChunkCreatedEvent {
    pub session_id: String,
    pub chunk: Chunk,
}

/// Chunk transcribed event payload
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChunkTranscribedEvent {
    pub session_id: String,
    pub chunk: Chunk,
}

/// Model download progress event
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgressEvent {
    pub model_id: String,
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

/// Recording result (returned when stopping recording)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RecordingResult {
    pub session_id: String,
    pub duration_ms: u64,
    pub sample_count: usize,
    pub chunks_count: usize,
}

// ============================================================================
// Command Argument Types (for Tauri commands)
// ============================================================================

/// Arguments for start_recording command
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub capture_system: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// Arguments for import_audio command
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ImportAudioArgs {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// Arguments for rename_session_speaker command
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RenameSpeakerArgs {
    pub session_id: String,
    pub speaker_id: String,
    pub new_name: String,
}

/// Arguments for merge_session_speakers command
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MergeSpeakersArgs {
    pub session_id: String,
    pub source_speaker_id: String,
    pub target_speaker_id: String,
}

/// Arguments for search_sessions command
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SearchSessionsArgs {
    pub query: String,
}

// ============================================================================
// Worker IPC Types
// ============================================================================

/// Worker command for IPC
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WorkerCommand {
    /// Diarize audio samples
    Diarize { samples: Vec<f32> },
    /// Transcribe with specific engine
    Transcribe { samples: Vec<f32>, engine: String },
    /// Shutdown worker
    Shutdown,
}

/// Worker response for IPC
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WorkerResponse {
    /// Diarization result
    Diarization {
        segments: Vec<SpeakerSegment>,
        num_speakers: i32,
    },
    /// Transcription result
    Transcription(TranscriptionResult),
    /// Error
    Error { message: String },
    /// Acknowledgement
    Ok,
}

// ============================================================================
// Recording State (legacy compatibility)
// ============================================================================

/// Recording state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingState {
    /// Session ID
    pub session_id: String,
    /// Duration in milliseconds
    pub duration_ms: u64,
    /// Number of samples recorded
    pub sample_count: usize,
}

/// Diarization model type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiarizationType {
    Segmentation,
    Embedding,
}

/// Settings (legacy format, kept for compatibility)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Transcription language (ISO 639-1 code, or "auto" for auto-detection)
    pub language: String,
    /// Hotwords for improved recognition
    pub hotwords: Vec<String>,
    /// Enable speaker diarization
    pub enable_diarization: bool,
    /// Primary transcription engine ("whisper", "gigaam", "hybrid")
    pub transcription_engine: String,
    /// Whisper model size ("tiny", "base", "small", "medium", "large")
    pub whisper_model: String,
    /// Enable VAD (Voice Activity Detection)
    pub enable_vad: bool,
    /// Audio input device ID (None for default)
    pub audio_device_id: Option<String>,
    /// Enable echo cancellation
    pub echo_cancellation: bool,
    /// Enable hybrid transcription (dual-model)
    #[serde(default)]
    pub hybrid_enabled: bool,
    /// Secondary model ID for hybrid transcription
    #[serde(default)]
    pub hybrid_secondary_model_id: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "auto".to_string(),
            hotwords: vec![],
            enable_diarization: true,
            transcription_engine: "whisper".to_string(),
            whisper_model: "base".to_string(),
            enable_vad: true,
            audio_device_id: None,
            echo_cancellation: false,
            hybrid_enabled: false,
            hybrid_secondary_model_id: String::new(),
        }
    }
}

// ============================================================================
// TypeScript export helper
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_typescript_bindings() {
        // This test generates TypeScript files when run with:
        // cargo test --features ts-bindings export_typescript_bindings -- --nocapture
        
        // The ts-rs crate will export to the default location (./bindings/)
        // or you can use TS::export_all() for custom paths
        
        println!("TypeScript bindings would be exported to ./bindings/");
        println!("Run: cargo test --features ts-bindings");
    }
}
