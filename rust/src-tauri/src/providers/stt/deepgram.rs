//! Deepgram Nova-2 API Provider
//!
//! Implements STT using Deepgram's Nova-2 API.
//! Docs: https://developers.deepgram.com/reference/listen-file

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::Deserialize;

use crate::providers::traits::{
    HealthCheckResult, ProviderError, STTProvider, TranscriptionOptions, TranscriptionResult,
    TranscriptionSegment,
};
use crate::providers::types::{DeepgramConfig, STTProviderId};

const DEEPGRAM_API_BASE: &str = "https://api.deepgram.com/v1";

/// Deepgram API response structure
#[derive(Debug, Deserialize)]
struct DeepgramResponse {
    metadata: Option<DeepgramMetadata>,
    results: Option<DeepgramResults>,
}

#[derive(Debug, Deserialize)]
struct DeepgramMetadata {
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    #[allow(dead_code)]
    channels: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct DeepgramResults {
    channels: Vec<DeepgramChannel>,
}

#[derive(Debug, Deserialize)]
struct DeepgramChannel {
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, Deserialize)]
struct DeepgramAlternative {
    transcript: String,
    #[allow(dead_code)]
    confidence: f64,
    #[serde(default)]
    words: Vec<DeepgramWord>,
}

#[derive(Debug, Clone, Deserialize)]
struct DeepgramWord {
    word: String,
    start: f64,
    end: f64,
    confidence: f64,
    #[serde(default)]
    speaker: Option<u32>,
}

/// Deepgram Nova-2 STT provider
pub struct DeepgramSTTProvider {
    /// Configuration
    config: RwLock<DeepgramConfig>,
    /// API key (loaded from keychain)
    api_key: RwLock<Option<String>>,
    /// HTTP client
    client: reqwest::Client,
}

impl DeepgramSTTProvider {
    /// Create a new Deepgram STT provider
    pub fn new() -> Self {
        Self {
            config: RwLock::new(DeepgramConfig::default()),
            api_key: RwLock::new(None),
            client: reqwest::Client::new(),
        }
    }

    /// Create with specific configuration
    pub fn with_config(config: DeepgramConfig) -> Self {
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
    pub fn set_config(&self, config: DeepgramConfig) {
        *self.config.write() = config;
    }

    /// Get current configuration
    pub fn config(&self) -> DeepgramConfig {
        self.config.read().clone()
    }

    /// Build query parameters for the API request
    fn build_query_params(&self, options: &TranscriptionOptions) -> Vec<(&'static str, String)> {
        let config = self.config.read();
        let mut params = vec![
            ("model", config.model.clone()),
        ];

        // Language
        if let Some(lang) = options.language.as_ref().or(config.language.as_ref()) {
            params.push(("language", lang.clone()));
        }

        // Punctuation
        if config.punctuate {
            params.push(("punctuate", "true".to_string()));
        }

        // Diarization
        if options.diarize || config.diarize {
            params.push(("diarize", "true".to_string()));
            if let Some(max_speakers) = options.max_speakers {
                params.push(("diarize_version", "2".to_string()));
                // Note: Deepgram uses different param name
                params.push(("max_speakers", max_speakers.to_string()));
            }
        }

        // Smart formatting
        if config.smart_format {
            params.push(("smart_format", "true".to_string()));
        }

        // Word timestamps (Deepgram includes by default, but let's be explicit)
        if options.word_timestamps {
            params.push(("timestamps", "true".to_string()));
        }

        // Hotwords/keywords
        if !options.hotwords.is_empty() {
            for word in &options.hotwords {
                params.push(("keywords", word.clone()));
            }
        }

        params
    }

    /// Convert words to segments (group by time gaps or speakers)
    fn words_to_segments(words: &[DeepgramWord], diarize: bool) -> Vec<TranscriptionSegment> {
        if words.is_empty() {
            return vec![];
        }

        let mut segments = vec![];
        let mut current_segment = TranscriptionSegment {
            start: words[0].start,
            end: words[0].end,
            text: words[0].word.clone(),
            confidence: Some(words[0].confidence),
            speaker: words[0].speaker.map(|s| format!("SPEAKER_{}", s)),
            language: None,
        };

        // Gap threshold in seconds to split segments
        const GAP_THRESHOLD: f64 = 1.0;

        for word in words.iter().skip(1) {
            let gap = word.start - current_segment.end;
            let speaker_changed = diarize && word.speaker != words.iter()
                .find(|w| w.start == current_segment.start)
                .and_then(|w| w.speaker);

            // Start new segment if gap is too large or speaker changed
            if gap > GAP_THRESHOLD || speaker_changed {
                segments.push(current_segment);
                current_segment = TranscriptionSegment {
                    start: word.start,
                    end: word.end,
                    text: word.word.clone(),
                    confidence: Some(word.confidence),
                    speaker: word.speaker.map(|s| format!("SPEAKER_{}", s)),
                    language: None,
                };
            } else {
                // Extend current segment
                current_segment.end = word.end;
                current_segment.text.push(' ');
                current_segment.text.push_str(&word.word);
                // Update confidence as average
                if let Some(conf) = current_segment.confidence {
                    current_segment.confidence = Some((conf + word.confidence) / 2.0);
                }
            }
        }

        // Don't forget the last segment
        segments.push(current_segment);
        segments
    }
}

impl Default for DeepgramSTTProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl STTProvider for DeepgramSTTProvider {
    fn id(&self) -> STTProviderId {
        STTProviderId::Deepgram
    }

    fn name(&self) -> &str {
        "Deepgram Nova-2"
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
        let api_key = api_key.ok_or_else(|| ProviderError::not_configured("Deepgram"))?;

        let config = self.config.read().clone();

        if !config.enabled {
            return Err(ProviderError::new("DISABLED", "Deepgram provider is disabled"));
        }

        // Build URL with query parameters
        let query_params = self.build_query_params(&options);
        let url = format!("{}/listen", DEEPGRAM_API_BASE);

        tracing::debug!(
            "Deepgram transcription request: model={}, params={:?}",
            config.model,
            query_params
        );

        // Make API request
        // Deepgram accepts raw audio bytes in the body with Content-Type header
        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Token {}", api_key))
            .header("Content-Type", "audio/wav")
            .query(&query_params)
            .body(audio_data)
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
                401 | 403 => ProviderError::auth_error("Invalid API key"),
                429 => ProviderError::rate_limited(),
                500..=599 => ProviderError::retryable("SERVER_ERROR", error_text),
                _ => ProviderError::api_error(format!("HTTP {}: {}", status, error_text)),
            });
        }

        // Parse response
        let deepgram_response: DeepgramResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        // Extract transcript from first channel, first alternative
        let (text, words): (String, Vec<DeepgramWord>) = deepgram_response
            .results
            .as_ref()
            .and_then(|r| r.channels.first())
            .and_then(|c| c.alternatives.first())
            .map(|a| (a.transcript.clone(), a.words.clone()))
            .unwrap_or_default();

        // Convert words to segments
        let diarize = options.diarize || config.diarize;
        let segments = Self::words_to_segments(&words, diarize);

        // Get duration from metadata
        let duration = deepgram_response
            .metadata
            .and_then(|m| m.duration);

        Ok(TranscriptionResult {
            text: text.trim().to_string(),
            segments,
            language: options.language.or(config.language),
            duration,
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

        // Try to make a simple request to verify API key works
        // Deepgram doesn't have a simple /models endpoint, so we'll use a minimal audio request
        // Instead, we just verify the key format and network connectivity
        let api_key = self.api_key.read().clone().unwrap();
        let start = std::time::Instant::now();

        // Use Deepgram's projects endpoint to verify the API key
        let response = self
            .client
            .get("https://api.deepgram.com/v1/projects")
            .header("Authorization", format!("Token {}", api_key))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;

        let latency = start.elapsed().as_millis() as u64;

        match response {
            Ok(resp) if resp.status().is_success() => HealthCheckResult {
                healthy: true,
                latency_ms: Some(latency),
                error: None,
                models: Some(vec![
                    "nova-2".to_string(),
                    "nova-2-general".to_string(),
                    "nova-2-meeting".to_string(),
                    "nova-2-phonecall".to_string(),
                ]),
            },
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
    fn test_deepgram_provider_creation() {
        let provider = DeepgramSTTProvider::new();
        assert_eq!(provider.id(), STTProviderId::Deepgram);
        assert!(provider.is_cloud());
        assert!(!provider.is_configured()); // No API key
    }

    #[test]
    fn test_deepgram_provider_with_key() {
        let provider = DeepgramSTTProvider::new();
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
    fn test_query_params_building() {
        let provider = DeepgramSTTProvider::new();
        
        let mut config = provider.config();
        config.punctuate = true;
        config.diarize = true;
        config.language = Some("ru".to_string());
        provider.set_config(config);

        let options = TranscriptionOptions {
            word_timestamps: true,
            ..Default::default()
        };

        let params = provider.build_query_params(&options);
        
        // Check essential params are present
        assert!(params.iter().any(|(k, v)| *k == "model" && v == "nova-2"));
        assert!(params.iter().any(|(k, v)| *k == "language" && v == "ru"));
        assert!(params.iter().any(|(k, v)| *k == "punctuate" && v == "true"));
        assert!(params.iter().any(|(k, v)| *k == "diarize" && v == "true"));
    }

    #[test]
    fn test_words_to_segments() {
        let words = vec![
            DeepgramWord {
                word: "Hello".to_string(),
                start: 0.0,
                end: 0.5,
                confidence: 0.95,
                speaker: Some(0),
            },
            DeepgramWord {
                word: "world".to_string(),
                start: 0.5,
                end: 1.0,
                confidence: 0.98,
                speaker: Some(0),
            },
            DeepgramWord {
                word: "test".to_string(),
                start: 2.5, // Gap > 1.0s
                end: 3.0,
                confidence: 0.90,
                speaker: Some(1),
            },
        ];

        let segments = DeepgramSTTProvider::words_to_segments(&words, true);
        
        assert_eq!(segments.len(), 2);
        assert!(segments[0].text.contains("Hello"));
        assert!(segments[0].text.contains("world"));
        assert_eq!(segments[1].text, "test");
    }
}
