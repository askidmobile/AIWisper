//! Groq Whisper API Provider
//!
//! Implements STT using Groq's Whisper API (OpenAI-compatible).
//! Docs: https://console.groq.com/docs/speech-to-text
//!
//! Groq offers extremely fast inference (~10x faster than real-time)
//! with a generous free tier.

use async_trait::async_trait;
use parking_lot::RwLock;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;

use crate::providers::traits::{
    HealthCheckResult, ProviderError, STTProvider, TranscriptionOptions, TranscriptionResult,
    TranscriptionSegment,
};
use crate::providers::types::{GroqSTTConfig, STTProviderId};

const GROQ_API_BASE: &str = "https://api.groq.com/openai/v1";

/// Groq Whisper API response (OpenAI-compatible verbose_json format)
#[derive(Debug, Deserialize)]
struct GroqWhisperResponse {
    text: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    segments: Option<Vec<GroqSegment>>,
    /// X-Groq header info (speed of transcription)
    #[serde(default)]
    #[allow(dead_code)]
    x_groq: Option<GroqMetadata>,
}

/// Groq API segment (OpenAI-compatible)
#[derive(Debug, Deserialize)]
struct GroqSegment {
    #[serde(default)]
    #[allow(dead_code)]
    id: i32,
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    avg_logprob: Option<f64>,
    #[serde(default)]
    #[allow(dead_code)]
    no_speech_prob: Option<f64>,
}

/// Groq-specific metadata
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GroqMetadata {
    #[serde(default)]
    id: Option<String>,
}

/// Groq models list response
#[derive(Debug, Deserialize)]
struct GroqModelsResponse {
    data: Vec<GroqModel>,
}

#[derive(Debug, Deserialize)]
struct GroqModel {
    id: String,
}

/// Groq Whisper STT provider
///
/// Provides fast, affordable transcription using Groq's LPU inference.
/// Uses OpenAI-compatible API format.
pub struct GroqSTTProvider {
    /// Configuration
    config: RwLock<GroqSTTConfig>,
    /// API key (loaded from keychain)
    api_key: RwLock<Option<String>>,
    /// HTTP client
    client: reqwest::Client,
}

impl GroqSTTProvider {
    /// Create a new Groq STT provider
    pub fn new() -> Self {
        Self {
            config: RwLock::new(GroqSTTConfig::default()),
            api_key: RwLock::new(None),
            client: reqwest::Client::new(),
        }
    }

    /// Create with specific configuration
    pub fn with_config(config: GroqSTTConfig) -> Self {
        Self {
            config: RwLock::new(config),
            api_key: RwLock::new(None),
            client: reqwest::Client::new(),
        }
    }

    /// Set the API key
    pub fn set_api_key(&self, api_key: Option<String>) {
        let mut key = self.api_key.write();
        *key = api_key.clone();

        // Update config to reflect key status
        let mut config = self.config.write();
        config.api_key_set = api_key.is_some();
    }

    /// Update configuration
    pub fn set_config(&self, config: GroqSTTConfig) {
        *self.config.write() = config;
    }

    /// Get current configuration
    pub fn config(&self) -> GroqSTTConfig {
        self.config.read().clone()
    }

    /// Convert logprob to confidence (0-1)
    fn logprob_to_confidence(logprob: f64) -> f64 {
        // logprob is log probability, typically -1 to 0
        // exp(logprob) gives probability 0-1
        (logprob.exp()).clamp(0.0, 1.0)
    }

    /// Get available Whisper models on Groq
    pub fn available_models() -> Vec<&'static str> {
        vec![
            "whisper-large-v3",
            "whisper-large-v3-turbo",
            "distil-whisper-large-v3-en", // English only, faster
        ]
    }
}

impl Default for GroqSTTProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl STTProvider for GroqSTTProvider {
    fn id(&self) -> STTProviderId {
        STTProviderId::Groq
    }

    fn name(&self) -> &str {
        "Groq Whisper"
    }

    fn is_cloud(&self) -> bool {
        true
    }

    fn is_configured(&self) -> bool {
        let config = self.config.read();
        config.enabled && self.api_key.read().is_some()
    }

    async fn transcribe(
        &self,
        audio_data: Vec<u8>,
        options: TranscriptionOptions,
    ) -> Result<TranscriptionResult, ProviderError> {
        // Check if configured
        let api_key = self.api_key.read().clone();
        let api_key = api_key.ok_or_else(|| ProviderError::not_configured("Groq"))?;

        let config = self.config.read().clone();

        if !config.enabled {
            return Err(ProviderError::new("DISABLED", "Groq provider is disabled"));
        }

        // Build multipart form (OpenAI-compatible format)
        let file_part = Part::bytes(audio_data)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|e| ProviderError::new("FORM_ERROR", e.to_string()))?;

        let mut form = Form::new()
            .part("file", file_part)
            .text("model", config.model.clone())
            .text("response_format", "verbose_json");

        // Add optional parameters
        if let Some(lang) = options.language.or(config.language) {
            form = form.text("language", lang);
        }

        if let Some(temp) = options.temperature {
            form = form.text("temperature", temp.to_string());
        }

        if let Some(prompt) = options.prompt {
            form = form.text("prompt", prompt);
        }

        // Make API request
        let url = format!("{}/audio/transcriptions", GROQ_API_BASE);

        tracing::debug!("Groq transcription request: model={}", config.model);

        let response = self
            .client
            .post(&url)
            .bearer_auth(&api_key)
            .multipart(form)
            .timeout(std::time::Duration::from_secs(60)) // Groq is fast, shorter timeout
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ProviderError::retryable("TIMEOUT", "Request timed out")
                } else if e.is_connect() {
                    ProviderError::network_error(e.to_string())
                } else {
                    ProviderError::api_error(e.to_string())
                }
            })?;

        let status = response.status();

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();

            return Err(match status.as_u16() {
                401 => ProviderError::auth_error("Invalid API key"),
                429 => {
                    // Groq has aggressive rate limiting on free tier
                    ProviderError::retryable(
                        "RATE_LIMITED",
                        format!("Rate limit exceeded. {}", error_text),
                    )
                }
                413 => ProviderError::new(
                    "FILE_TOO_LARGE",
                    "Audio file too large (max 25MB for Groq)",
                ),
                500..=599 => ProviderError::retryable("SERVER_ERROR", error_text),
                _ => ProviderError::api_error(format!("HTTP {}: {}", status, error_text)),
            });
        }

        // Parse response
        let groq_response: GroqWhisperResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        // Convert to our format
        let segments: Vec<TranscriptionSegment> = groq_response
            .segments
            .unwrap_or_default()
            .into_iter()
            .map(|seg| TranscriptionSegment {
                start: seg.start,
                end: seg.end,
                text: seg.text.trim().to_string(),
                confidence: seg.avg_logprob.map(Self::logprob_to_confidence),
                speaker: None, // Groq doesn't support diarization
                language: groq_response.language.clone(),
            })
            .collect();

        Ok(TranscriptionResult {
            text: groq_response.text.trim().to_string(),
            segments,
            language: groq_response.language,
            duration: groq_response.duration,
            provider_id: self.id().to_string(),
        })
    }

    async fn health_check(&self) -> HealthCheckResult {
        // Check if we have an API key
        let has_key = self.api_key.read().is_some();

        if !has_key {
            return HealthCheckResult {
                healthy: false,
                latency_ms: None,
                error: Some("API key not configured".to_string()),
                models: None,
            };
        }

        // Try to list models to verify API key works
        let api_key = self.api_key.read().clone().unwrap();
        let start = std::time::Instant::now();

        let response = self
            .client
            .get(format!("{}/models", GROQ_API_BASE))
            .bearer_auth(&api_key)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;

        let latency = start.elapsed().as_millis() as u64;

        match response {
            Ok(resp) if resp.status().is_success() => {
                // Parse models to filter whisper models
                let models_response: Result<GroqModelsResponse, _> = resp.json().await;

                let whisper_models: Vec<String> = models_response
                    .map(|r| {
                        r.data
                            .into_iter()
                            .filter(|m| m.id.contains("whisper"))
                            .map(|m| m.id)
                            .collect()
                    })
                    .unwrap_or_else(|_| {
                        Self::available_models()
                            .into_iter()
                            .map(String::from)
                            .collect()
                    });

                HealthCheckResult {
                    healthy: true,
                    latency_ms: Some(latency),
                    error: None,
                    models: Some(whisper_models),
                }
            }
            Ok(resp) => {
                let status = resp.status();
                let error = resp.text().await.unwrap_or_default();
                HealthCheckResult {
                    healthy: false,
                    latency_ms: Some(latency),
                    error: Some(format!("HTTP {}: {}", status, error)),
                    models: None,
                }
            }
            Err(e) => HealthCheckResult {
                healthy: false,
                latency_ms: Some(latency),
                error: Some(e.to_string()),
                models: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_groq_provider_creation() {
        let provider = GroqSTTProvider::new();
        assert_eq!(provider.id(), STTProviderId::Groq);
        assert!(provider.is_cloud());
        assert!(!provider.is_configured()); // No API key
    }

    #[test]
    fn test_groq_provider_with_key() {
        let provider = GroqSTTProvider::new();
        provider.set_api_key(Some("gsk_test-key".to_string()));

        // Still not configured because enabled=false by default
        assert!(!provider.is_configured());

        let mut config = provider.config();
        config.enabled = true;
        provider.set_config(config);

        // Now it should be configured
        assert!(provider.is_configured());
    }

    #[test]
    fn test_default_model() {
        let provider = GroqSTTProvider::new();
        let config = provider.config();
        assert_eq!(config.model, "whisper-large-v3");
    }

    #[test]
    fn test_available_models() {
        let models = GroqSTTProvider::available_models();
        assert!(models.contains(&"whisper-large-v3"));
        assert!(models.contains(&"whisper-large-v3-turbo"));
    }

    #[test]
    fn test_logprob_to_confidence() {
        // logprob of 0 = probability of 1
        assert!((GroqSTTProvider::logprob_to_confidence(0.0) - 1.0).abs() < 0.001);

        // logprob of -1 ≈ probability of 0.368
        let conf = GroqSTTProvider::logprob_to_confidence(-1.0);
        assert!(conf > 0.3 && conf < 0.4);

        // Very negative logprob = very low confidence
        let conf = GroqSTTProvider::logprob_to_confidence(-10.0);
        assert!(conf < 0.001);
    }
}
