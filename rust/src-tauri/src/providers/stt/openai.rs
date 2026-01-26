//! OpenAI Whisper API Provider
//!
//! Implements STT using OpenAI's Whisper API.
//! Docs: https://platform.openai.com/docs/api-reference/audio/createTranscription

use async_trait::async_trait;
use parking_lot::RwLock;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;

use crate::providers::traits::{
    HealthCheckResult, ProviderError, STTProvider, TranscriptionOptions, TranscriptionResult,
    TranscriptionSegment,
};
use crate::providers::types::{OpenAISTTConfig, STTProviderId};

const OPENAI_API_BASE: &str = "https://api.openai.com/v1";

/// OpenAI Whisper API response (verbose_json format)
#[derive(Debug, Deserialize)]
struct WhisperResponse {
    text: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    segments: Option<Vec<WhisperSegment>>,
}

/// Whisper API segment
#[derive(Debug, Deserialize)]
struct WhisperSegment {
    #[serde(default)]
    #[allow(dead_code)]
    id: i32,
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    avg_logprob: Option<f64>,
}

/// OpenAI Whisper STT provider
pub struct OpenAISTTProvider {
    /// Configuration
    config: RwLock<OpenAISTTConfig>,
    /// API key (loaded from keychain)
    api_key: RwLock<Option<String>>,
    /// HTTP client
    client: reqwest::Client,
}

impl OpenAISTTProvider {
    /// Create a new OpenAI STT provider
    pub fn new() -> Self {
        Self {
            config: RwLock::new(OpenAISTTConfig::default()),
            api_key: RwLock::new(None),
            client: reqwest::Client::new(),
        }
    }

    /// Create with specific configuration
    pub fn with_config(config: OpenAISTTConfig) -> Self {
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
    pub fn set_config(&self, config: OpenAISTTConfig) {
        *self.config.write() = config;
    }

    /// Get current configuration
    pub fn config(&self) -> OpenAISTTConfig {
        self.config.read().clone()
    }

    /// Convert logprob to confidence (0-1)
    fn logprob_to_confidence(logprob: f64) -> f64 {
        // logprob is log probability, typically -1 to 0
        // exp(logprob) gives probability 0-1
        (logprob.exp()).clamp(0.0, 1.0)
    }
}

impl Default for OpenAISTTProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl STTProvider for OpenAISTTProvider {
    fn id(&self) -> STTProviderId {
        STTProviderId::OpenAI
    }

    fn name(&self) -> &str {
        "OpenAI Whisper"
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
        let api_key = api_key.ok_or_else(|| ProviderError::not_configured("OpenAI"))?;

        let config = self.config.read().clone();
        
        if !config.enabled {
            return Err(ProviderError::new("DISABLED", "OpenAI provider is disabled"));
        }

        // Build multipart form
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

        if let Some(temp) = options.temperature.or(config.temperature) {
            form = form.text("temperature", temp.to_string());
        }

        if let Some(prompt) = options.prompt {
            form = form.text("prompt", prompt);
        }

        // Make API request
        // Note: gpt-4o-transcribe and gpt-4o-mini-transcribe use the same endpoint as whisper-1
        let url = format!("{}/audio/transcriptions", OPENAI_API_BASE);
        
        tracing::debug!("OpenAI transcription request: model={}", config.model);

        let response = self.client
            .post(&url)
            .bearer_auth(&api_key)
            .multipart(form)
            .timeout(std::time::Duration::from_secs(120))
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
                429 => ProviderError::rate_limited(),
                500..=599 => ProviderError::retryable("SERVER_ERROR", error_text),
                _ => ProviderError::api_error(format!("HTTP {}: {}", status, error_text)),
            });
        }

        // Parse response
        let whisper_response: WhisperResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        // Convert to our format
        let segments: Vec<TranscriptionSegment> = whisper_response
            .segments
            .unwrap_or_default()
            .into_iter()
            .map(|seg| TranscriptionSegment {
                start: seg.start,
                end: seg.end,
                text: seg.text.trim().to_string(),
                confidence: seg.avg_logprob.map(Self::logprob_to_confidence),
                speaker: None,
                language: whisper_response.language.clone(),
            })
            .collect();

        Ok(TranscriptionResult {
            text: whisper_response.text.trim().to_string(),
            segments,
            language: whisper_response.language,
            duration: whisper_response.duration,
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

        let response = self.client
            .get(format!("{}/models", OPENAI_API_BASE))
            .bearer_auth(&api_key)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;

        let latency = start.elapsed().as_millis() as u64;

        match response {
            Ok(resp) if resp.status().is_success() => {
                HealthCheckResult {
                    healthy: true,
                    latency_ms: Some(latency),
                    error: None,
                    models: Some(vec![
                        "gpt-4o-transcribe".to_string(),
                        "gpt-4o-mini-transcribe".to_string(),
                        "whisper-1".to_string(),
                    ]),
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
            Err(e) => {
                HealthCheckResult {
                    healthy: false,
                    latency_ms: Some(latency),
                    error: Some(e.to_string()),
                    models: None,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_openai_provider_creation() {
        let provider = OpenAISTTProvider::new();
        assert_eq!(provider.id(), STTProviderId::OpenAI);
        assert!(provider.is_cloud());
        assert!(!provider.is_configured()); // No API key
    }

    #[test]
    fn test_openai_provider_with_key() {
        let provider = OpenAISTTProvider::new();
        provider.set_api_key(Some("test-key".to_string()));
        
        // Still not configured because enabled=false by default
        assert!(!provider.is_configured());
        
        let mut config = provider.config();
        config.enabled = true;
        provider.set_config(config);
        
        // Now it should be configured
        assert!(provider.is_configured());
    }

    #[test]
    fn test_logprob_to_confidence() {
        // logprob of 0 = probability of 1
        assert!((OpenAISTTProvider::logprob_to_confidence(0.0) - 1.0).abs() < 0.001);
        
        // logprob of -1 ≈ probability of 0.368
        let conf = OpenAISTTProvider::logprob_to_confidence(-1.0);
        assert!(conf > 0.3 && conf < 0.4);
        
        // Very negative logprob = very low confidence
        let conf = OpenAISTTProvider::logprob_to_confidence(-10.0);
        assert!(conf < 0.001);
    }
}
