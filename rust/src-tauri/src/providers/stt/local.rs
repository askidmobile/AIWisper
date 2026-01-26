//! Local STT Provider
//!
//! Wraps the local ML transcription engines (Whisper, GigaAM, Parakeet).
//! Always available, no API key required.

use async_trait::async_trait;
use parking_lot::RwLock;

use crate::providers::traits::{
    HealthCheckResult, ProviderError, STTProvider, TranscriptionOptions, TranscriptionResult,
    TranscriptionSegment,
};
use crate::providers::types::{LocalSTTConfig, STTProviderId};
use aiwisper_ml::get_recommended_model_for_language;
use std::io::Cursor;

/// Local STT provider using on-device ML models
pub struct LocalSTTProvider {
    /// Configuration
    config: RwLock<LocalSTTConfig>,
    /// Whether the provider is initialized
    initialized: RwLock<bool>,
}

impl LocalSTTProvider {
    /// Create a new local STT provider
    pub fn new() -> Self {
        Self {
            config: RwLock::new(LocalSTTConfig::default()),
            initialized: RwLock::new(true), // Local is always "initialized"
        }
    }

    /// Create with specific configuration
    pub fn with_config(config: LocalSTTConfig) -> Self {
        Self {
            config: RwLock::new(config),
            initialized: RwLock::new(true),
        }
    }

    /// Update configuration
    pub fn set_config(&self, config: LocalSTTConfig) {
        *self.config.write() = config;
    }

    /// Get current configuration
    pub fn config(&self) -> LocalSTTConfig {
        self.config.read().clone()
    }
}

impl Default for LocalSTTProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn decode_wav_bytes(audio_data: &[u8]) -> Result<Vec<f32>, ProviderError> {
    let reader = hound::WavReader::new(Cursor::new(audio_data))
        .map_err(|e| ProviderError::new("invalid_wav", format!("Invalid WAV data: {}", e)))?;

    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels as usize;

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .filter_map(|s| s.ok())
            .collect(),
        hound::SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            let max_val = (1 << (bits - 1)) as f32;
            reader
                .into_samples::<i32>()
                .filter_map(|s| s.ok())
                .map(|s| s as f32 / max_val)
                .collect()
        }
    };

    let mono: Vec<f32> = if channels > 1 {
        samples
            .chunks(channels)
            .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        samples
    };

    if sample_rate != 16000 {
        aiwisper_audio::resampling::resample(&mono, sample_rate, 16000)
            .map_err(|e| ProviderError::new("resample_failed", e.to_string()))
    } else {
        Ok(mono)
    }
}

#[async_trait]
impl STTProvider for LocalSTTProvider {
    fn id(&self) -> STTProviderId {
        STTProviderId::Local
    }

    fn name(&self) -> &str {
        "Local (Whisper/GigaAM/Parakeet)"
    }

    fn is_cloud(&self) -> bool {
        false
    }

    fn is_configured(&self) -> bool {
        *self.initialized.read()
    }

    async fn transcribe(
        &self,
        audio_data: Vec<u8>,
        options: TranscriptionOptions,
    ) -> Result<TranscriptionResult, ProviderError> {
        let config = self.config.read().clone();
        let language = options.language.unwrap_or(config.language.clone());
        let model_id = if config.model_id.is_empty() {
            get_recommended_model_for_language(&language).to_string()
        } else {
            config.model_id
        };

        tracing::info!(
            "Local transcription requested: model={}, language={}, audio_size={}",
            model_id,
            language,
            audio_data.len()
        );

        let samples = decode_wav_bytes(&audio_data)?;
        let duration = samples.len() as f64 / 16000.0;

        let engine = aiwisper_ml::get_or_create_engine_cached(&model_id, &language)
            .map_err(|e| ProviderError::new("engine_error", e.to_string()))?;
        let segments = engine
            .transcribe_with_segments(&samples)
            .map_err(|e| ProviderError::new("transcription_failed", e.to_string()))?;

        let text = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        let provider_segments = segments
            .into_iter()
            .map(|seg| TranscriptionSegment {
                start: seg.start as f64 / 1000.0,
                end: seg.end as f64 / 1000.0,
                text: seg.text,
                confidence: Some(seg.confidence as f64),
                speaker: seg.speaker,
                language: None,
            })
            .collect();

        Ok(TranscriptionResult {
            text,
            segments: provider_segments,
            language: if language == "auto" { None } else { Some(language) },
            duration: Some(duration),
            provider_id: self.id().to_string(),
        })
    }

    async fn health_check(&self) -> HealthCheckResult {
        // Check if any model is downloaded
        let config = self.config.read();
        
        // For now, assume healthy if we have a model_id configured
        let healthy = !config.model_id.is_empty();
        
        HealthCheckResult {
            healthy,
            latency_ms: Some(0), // Local has no network latency
            error: if healthy {
                None
            } else {
                Some("No model configured".to_string())
            },
            models: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_provider_creation() {
        let provider = LocalSTTProvider::new();
        assert_eq!(provider.id(), STTProviderId::Local);
        assert!(!provider.is_cloud());
        assert!(provider.is_configured());
    }

    #[test]
    fn test_local_provider_config() {
        let config = LocalSTTConfig {
            model_id: "ggml-large-v3-turbo".to_string(),
            language: "ru".to_string(),
            hybrid_enabled: true,
            hybrid_secondary_model_id: "gigaam-v3-ctc".to_string(),
        };
        
        let provider = LocalSTTProvider::with_config(config.clone());
        let current = provider.config();
        
        assert_eq!(current.model_id, config.model_id);
        assert_eq!(current.language, config.language);
        assert!(current.hybrid_enabled);
    }
}
