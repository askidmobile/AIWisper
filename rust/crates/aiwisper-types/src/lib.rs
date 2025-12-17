//! Shared types for AIWisper
//!
//! This crate contains all shared data structures used across
//! the AIWisper application.

use serde::{Deserialize, Serialize};

/// Transcription result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResult {
    /// Full transcribed text
    pub text: String,
    /// Segments with timestamps
    pub segments: Vec<TranscriptSegment>,
    /// Detected language (ISO 639-1 code)
    pub language: Option<String>,
    /// Processing time in milliseconds
    pub processing_time_ms: u64,
    /// Real-time factor (audio_duration / processing_time)
    pub rtf: f32,
}

/// A segment of transcribed text with timing information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    /// Start time in milliseconds
    pub start: i64,
    /// End time in milliseconds
    pub end: i64,
    /// Transcribed text
    pub text: String,
    /// Speaker identifier (e.g., "Speaker 0")
    pub speaker: Option<String>,
    /// Word-level timestamps
    pub words: Vec<TranscriptWord>,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f32,
}

/// A single word with timing information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptWord {
    /// Start time in milliseconds
    pub start: i64,
    /// End time in milliseconds  
    pub end: i64,
    /// The word text
    pub text: String,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f32,
}

/// Speaker segment from diarization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerSegment {
    /// Start time in seconds
    pub start: f32,
    /// End time in seconds
    pub end: f32,
    /// Speaker ID (0, 1, 2...)
    pub speaker: i32,
}

/// Audio input device information
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Recording state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingState {
    /// Duration in milliseconds
    pub duration_ms: u64,
    /// Number of samples recorded
    pub sample_count: usize,
}

/// Application settings
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

/// Model type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ModelType {
    Ggml,
    Onnx,
    Coreml,
}

/// Engine type for transcription
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

/// Diarization model type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiarizationType {
    Segmentation,
    Embedding,
}

/// Model status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ModelStatus {
    NotDownloaded,
    Downloading,
    Downloaded,
    Active,
    Error,
}

/// Model information with all fields matching frontend expectations
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Vocabulary URL (for ONNX models)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vocab_url: Option<String>,
    /// Is RNNT model (requires 3 files)
    #[serde(default)]
    pub is_rnnt: bool,
    /// Decoder URL for RNNT
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoder_url: Option<String>,
    /// Joint URL for RNNT
    #[serde(skip_serializing_if = "Option::is_none")]
    pub joint_url: Option<String>,
    /// Diarization model type (segmentation or embedding)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diarization_type: Option<String>,
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
