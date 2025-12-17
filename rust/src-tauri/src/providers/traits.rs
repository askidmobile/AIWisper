//! Provider traits and common types
//!
//! Defines the core traits for STT and LLM providers.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::types::{LLMProviderId, STTProviderId};

// ============================================================================
// Transcription Types
// ============================================================================

/// A segment of transcribed audio
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegment {
    /// Start time in seconds
    pub start: f64,
    /// End time in seconds
    pub end: f64,
    /// Transcribed text
    pub text: String,
    /// Confidence score (0.0 - 1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// Speaker ID (if diarization enabled)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// Language detected
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// Full transcription result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    /// Full text concatenation
    pub text: String,
    /// Segments with timestamps
    pub segments: Vec<TranscriptionSegment>,
    /// Detected language
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Audio duration in seconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// Provider that performed transcription
    pub provider_id: String,
}

/// Options for transcription request
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptions {
    /// Language hint (ISO 639-1 code, e.g., "ru", "en")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Prompt/context to guide transcription
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Temperature for sampling (0.0 - 1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Enable word-level timestamps
    #[serde(default)]
    pub word_timestamps: bool,
    /// Enable speaker diarization
    #[serde(default)]
    pub diarize: bool,
    /// Maximum number of speakers (for diarization)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_speakers: Option<u32>,
    /// Hotwords to boost
    #[serde(default)]
    pub hotwords: Vec<String>,
}

// ============================================================================
// Generation Types (LLM)
// ============================================================================

/// LLM generation result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationResult {
    /// Generated text
    pub text: String,
    /// Tokens used in prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u32>,
    /// Tokens in completion
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u32>,
    /// Total tokens used
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u32>,
    /// Provider that generated
    pub provider_id: String,
    /// Model used
    pub model: String,
    /// Finish reason (stop, length, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

/// Options for LLM generation
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationOptions {
    /// Model to use (overrides provider default)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Temperature (0.0 - 2.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Maximum tokens to generate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Top-p (nucleus) sampling
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    /// System message/prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Stop sequences
    #[serde(default)]
    pub stop: Vec<String>,
}

/// Chat message for conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// Role: "system", "user", "assistant"
    pub role: String,
    /// Message content
    pub content: String,
}

// ============================================================================
// Health Check Types
// ============================================================================

/// Result of a provider health check
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckResult {
    /// Provider is healthy
    pub healthy: bool,
    /// Latency in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Error message if unhealthy
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Available models (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
}

// ============================================================================
// Provider Traits
// ============================================================================

/// Error type for provider operations
#[derive(Debug, Clone)]
pub struct ProviderError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ProviderError {}

impl ProviderError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: true,
        }
    }

    pub fn not_configured(provider: impl Into<String>) -> Self {
        Self::new(
            "NOT_CONFIGURED",
            format!("Provider {} is not configured", provider.into()),
        )
    }

    pub fn api_error(message: impl Into<String>) -> Self {
        Self::retryable("API_ERROR", message)
    }

    pub fn network_error(message: impl Into<String>) -> Self {
        Self::retryable("NETWORK_ERROR", message)
    }

    pub fn rate_limited() -> Self {
        Self::retryable("RATE_LIMITED", "Rate limit exceeded")
    }

    pub fn auth_error(message: impl Into<String>) -> Self {
        Self::new("AUTH_ERROR", message)
    }
}

/// Speech-to-Text provider trait
#[async_trait]
pub trait STTProvider: Send + Sync {
    /// Get provider identifier
    fn id(&self) -> STTProviderId;

    /// Get human-readable name
    fn name(&self) -> &str;

    /// Check if this is a cloud provider
    fn is_cloud(&self) -> bool;

    /// Check if provider is configured (API key set, etc.)
    fn is_configured(&self) -> bool;

    /// Transcribe audio data
    ///
    /// # Arguments
    /// * `audio_data` - Raw audio bytes (WAV, MP3, etc.)
    /// * `options` - Transcription options
    ///
    /// # Returns
    /// Transcription result or error
    async fn transcribe(
        &self,
        audio_data: Vec<u8>,
        options: TranscriptionOptions,
    ) -> Result<TranscriptionResult, ProviderError>;

    /// Perform health check
    async fn health_check(&self) -> HealthCheckResult;
}

/// Large Language Model provider trait
#[async_trait]
pub trait LLMProvider: Send + Sync {
    /// Get provider identifier
    fn id(&self) -> LLMProviderId;

    /// Get human-readable name
    fn name(&self) -> &str;

    /// Check if this is a cloud provider
    fn is_cloud(&self) -> bool;

    /// Check if provider is configured
    fn is_configured(&self) -> bool;

    /// Generate text from a prompt
    ///
    /// # Arguments
    /// * `prompt` - The user prompt
    /// * `options` - Generation options
    ///
    /// # Returns
    /// Generated text or error
    async fn generate(
        &self,
        prompt: &str,
        options: GenerationOptions,
    ) -> Result<GenerationResult, ProviderError>;

    /// Generate from chat messages
    ///
    /// # Arguments
    /// * `messages` - Chat history
    /// * `options` - Generation options
    ///
    /// # Returns
    /// Generated text or error
    async fn chat(
        &self,
        messages: Vec<ChatMessage>,
        options: GenerationOptions,
    ) -> Result<GenerationResult, ProviderError>;

    /// List available models
    async fn list_models(&self) -> Result<Vec<String>, ProviderError>;

    /// Perform health check
    async fn health_check(&self) -> HealthCheckResult;
}
