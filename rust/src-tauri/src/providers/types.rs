//! Provider types and configurations
//!
//! Defines all provider identifiers and their configuration structures.

use serde::{Deserialize, Serialize};

// ============================================================================
// Provider Identifiers
// ============================================================================

/// Speech-to-Text provider identifiers
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum STTProviderId {
    /// Local models (Whisper/GigaAM/Parakeet)
    #[default]
    Local,
    /// OpenAI Whisper API
    OpenAI,
    /// Deepgram Nova-2
    Deepgram,
    /// AssemblyAI
    AssemblyAI,
    /// Groq (Whisper)
    Groq,
}

impl std::fmt::Display for STTProviderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            STTProviderId::Local => write!(f, "local"),
            STTProviderId::OpenAI => write!(f, "openai"),
            STTProviderId::Deepgram => write!(f, "deepgram"),
            STTProviderId::AssemblyAI => write!(f, "assemblyai"),
            STTProviderId::Groq => write!(f, "groq"),
        }
    }
}

/// LLM provider identifiers
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum LLMProviderId {
    /// Local Ollama
    #[default]
    Ollama,
    /// OpenAI GPT
    OpenAI,
    /// OpenRouter (Claude, GPT, Llama, etc.)
    OpenRouter,
}

impl std::fmt::Display for LLMProviderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LLMProviderId::Ollama => write!(f, "ollama"),
            LLMProviderId::OpenAI => write!(f, "openai"),
            LLMProviderId::OpenRouter => write!(f, "openrouter"),
        }
    }
}

// ============================================================================
// STT Provider Configurations
// ============================================================================

/// Local STT provider configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSTTConfig {
    /// Model ID (e.g., "ggml-large-v3-turbo")
    pub model_id: String,
    /// Language code ("ru", "en", "auto")
    pub language: String,
    /// Enable hybrid transcription
    #[serde(default)]
    pub hybrid_enabled: bool,
    /// Secondary model ID for hybrid mode
    #[serde(default)]
    pub hybrid_secondary_model_id: String,
}

impl Default for LocalSTTConfig {
    fn default() -> Self {
        Self {
            model_id: "ggml-large-v3-turbo".to_string(),
            language: "ru".to_string(),
            hybrid_enabled: false,
            hybrid_secondary_model_id: String::new(),
        }
    }
}

/// OpenAI Whisper API configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAISTTConfig {
    /// Provider enabled
    pub enabled: bool,
    /// API key is set (key itself stored in keychain)
    #[serde(default)]
    pub api_key_set: bool,
    /// Model name (default: "whisper-1")
    #[serde(default = "default_whisper_model")]
    pub model: String,
    /// Language hint (optional, auto-detect if not set)
    #[serde(default)]
    pub language: Option<String>,
    /// Response format (json, text, srt, vtt, verbose_json)
    #[serde(default)]
    pub response_format: Option<String>,
    /// Temperature (0-1)
    #[serde(default)]
    pub temperature: Option<f32>,
}

fn default_whisper_model() -> String {
    "whisper-1".to_string()
}

impl Default for OpenAISTTConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key_set: false,
            model: default_whisper_model(),
            language: None,
            response_format: Some("verbose_json".to_string()),
            temperature: Some(0.0),
        }
    }
}

/// Deepgram Nova-2 configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepgramConfig {
    /// Provider enabled
    pub enabled: bool,
    /// API key is set
    #[serde(default)]
    pub api_key_set: bool,
    /// Model name (nova-2, nova, enhanced, base)
    #[serde(default = "default_deepgram_model")]
    pub model: String,
    /// Language code
    #[serde(default)]
    pub language: Option<String>,
    /// Add punctuation
    #[serde(default = "default_true")]
    pub punctuate: bool,
    /// Enable diarization
    #[serde(default)]
    pub diarize: bool,
    /// Smart formatting
    #[serde(default)]
    pub smart_format: bool,
}

fn default_deepgram_model() -> String {
    "nova-2".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for DeepgramConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key_set: false,
            model: default_deepgram_model(),
            language: None,
            punctuate: true,
            diarize: false,
            smart_format: false,
        }
    }
}

/// AssemblyAI configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssemblyAIConfig {
    /// Provider enabled
    pub enabled: bool,
    /// API key is set
    #[serde(default)]
    pub api_key_set: bool,
    /// Model type (default, best)
    #[serde(default = "default_assemblyai_model")]
    pub model: String,
    /// Language code
    #[serde(default)]
    pub language: Option<String>,
    /// Enable speaker labels (diarization)
    #[serde(default)]
    pub speaker_labels: bool,
    /// Auto chapters
    #[serde(default)]
    pub auto_chapters: bool,
    /// Entity detection
    #[serde(default)]
    pub entity_detection: bool,
}

fn default_assemblyai_model() -> String {
    "default".to_string()
}

impl Default for AssemblyAIConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key_set: false,
            model: default_assemblyai_model(),
            language: None,
            speaker_labels: false,
            auto_chapters: false,
            entity_detection: false,
        }
    }
}

/// Groq Whisper configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroqSTTConfig {
    /// Provider enabled
    pub enabled: bool,
    /// API key is set
    #[serde(default)]
    pub api_key_set: bool,
    /// Model name (whisper-large-v3)
    #[serde(default = "default_groq_model")]
    pub model: String,
    /// Language code
    #[serde(default)]
    pub language: Option<String>,
}

fn default_groq_model() -> String {
    "whisper-large-v3".to_string()
}

impl Default for GroqSTTConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key_set: false,
            model: default_groq_model(),
            language: None,
        }
    }
}

// ============================================================================
// LLM Provider Configurations
// ============================================================================

/// Ollama configuration (local LLM)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaConfig {
    /// Provider enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Ollama server URL
    #[serde(default = "default_ollama_url")]
    pub url: String,
    /// Model name (llama3.2, qwen2.5, etc.)
    #[serde(default = "default_ollama_model")]
    pub model: String,
    /// Context size in thousands of tokens
    #[serde(default = "default_context_size")]
    pub context_size: u32,
}

fn default_ollama_url() -> String {
    "http://localhost:11434".to_string()
}

fn default_ollama_model() -> String {
    "llama3.2".to_string()
}

fn default_context_size() -> u32 {
    8
}

impl Default for OllamaConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            url: default_ollama_url(),
            model: default_ollama_model(),
            context_size: default_context_size(),
        }
    }
}

/// OpenAI LLM configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAILLMConfig {
    /// Provider enabled
    pub enabled: bool,
    /// API key is set
    #[serde(default)]
    pub api_key_set: bool,
    /// Model name (gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo)
    #[serde(default = "default_gpt_model")]
    pub model: String,
    /// Temperature (0-2)
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Max tokens
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

fn default_gpt_model() -> String {
    "gpt-4o-mini".to_string()
}

impl Default for OpenAILLMConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key_set: false,
            model: default_gpt_model(),
            temperature: Some(0.7),
            max_tokens: Some(1000),
        }
    }
}

/// OpenRouter configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterConfig {
    /// Provider enabled
    pub enabled: bool,
    /// API key is set
    #[serde(default)]
    pub api_key_set: bool,
    /// Model name (anthropic/claude-3.5-sonnet, openai/gpt-4o, etc.)
    #[serde(default = "default_openrouter_model")]
    pub model: String,
    /// Temperature
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Max tokens
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

fn default_openrouter_model() -> String {
    "anthropic/claude-3.5-sonnet".to_string()
}

impl Default for OpenRouterConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key_set: false,
            model: default_openrouter_model(),
            temperature: Some(0.7),
            max_tokens: Some(1000),
        }
    }
}

// ============================================================================
// Aggregated Provider Settings
// ============================================================================

/// STT providers settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct STTProvidersSettings {
    /// Active provider
    pub active_provider: STTProviderId,
    /// Fallback provider when cloud fails
    #[serde(default)]
    pub fallback_provider: Option<STTProviderId>,
    /// Local provider config
    pub local: LocalSTTConfig,
    /// OpenAI config
    #[serde(default)]
    pub openai: Option<OpenAISTTConfig>,
    /// Deepgram config
    #[serde(default)]
    pub deepgram: Option<DeepgramConfig>,
    /// AssemblyAI config
    #[serde(default)]
    pub assemblyai: Option<AssemblyAIConfig>,
    /// Groq config
    #[serde(default)]
    pub groq: Option<GroqSTTConfig>,
}

impl Default for STTProvidersSettings {
    fn default() -> Self {
        Self {
            active_provider: STTProviderId::Local,
            fallback_provider: None,
            local: LocalSTTConfig::default(),
            openai: None,
            deepgram: None,
            assemblyai: None,
            groq: None,
        }
    }
}

/// LLM providers settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LLMProvidersSettings {
    /// Active provider
    pub active_provider: LLMProviderId,
    /// Fallback provider when cloud fails
    #[serde(default)]
    pub fallback_provider: Option<LLMProviderId>,
    /// Ollama config
    pub ollama: OllamaConfig,
    /// OpenAI config
    #[serde(default)]
    pub openai: Option<OpenAILLMConfig>,
    /// OpenRouter config
    #[serde(default)]
    pub openrouter: Option<OpenRouterConfig>,
}

impl Default for LLMProvidersSettings {
    fn default() -> Self {
        Self {
            active_provider: LLMProviderId::Ollama,
            fallback_provider: None,
            ollama: OllamaConfig::default(),
            openai: None,
            openrouter: None,
        }
    }
}

// ============================================================================
// API Response Types
// ============================================================================

/// Provider status information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// Provider ID
    pub id: String,
    /// Human-readable name
    pub name: String,
    /// Provider type (stt or llm)
    #[serde(rename = "type")]
    pub provider_type: String,
    /// Is cloud provider
    pub is_cloud: bool,
    /// API key is configured
    pub is_configured: bool,
    /// Provider is available (passed health check)
    pub is_available: bool,
    /// Last error message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// Connection test result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    /// Test successful
    pub success: bool,
    /// Latency in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Error message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Available models (for LLM providers)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
}

/// Provider model information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    /// Model ID
    pub id: String,
    /// Human-readable name
    pub name: String,
    /// Description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Context length (for LLM)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u32>,
}
