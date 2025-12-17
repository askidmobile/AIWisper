//! Local STT Provider
//!
//! Wraps the local ML transcription engines (Whisper, GigaAM, Parakeet).
//! Always available, no API key required.

use async_trait::async_trait;
use parking_lot::RwLock;

use crate::providers::traits::{
    HealthCheckResult, ProviderError, STTProvider, TranscriptionOptions, TranscriptionResult,
};
use crate::providers::types::{LocalSTTConfig, STTProviderId};

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
        // Local provider is always configured if models are downloaded
        // For now, we assume it's configured if initialized
        *self.initialized.read()
    }

    async fn transcribe(
        &self,
        audio_data: Vec<u8>,
        options: TranscriptionOptions,
    ) -> Result<TranscriptionResult, ProviderError> {
        // Get config
        let config = self.config.read().clone();

        // For now, this is a stub implementation
        // In the future, this will call into aiwisper_ml crate
        
        // The actual transcription would:
        // 1. Load the ML model if not already loaded
        // 2. Convert audio_data (bytes) to samples
        // 3. Run inference
        // 4. Return results
        
        // Determine language
        let language = options.language.unwrap_or(config.language.clone());
        
        tracing::info!(
            "Local transcription requested: model={}, language={}, audio_size={}",
            config.model_id,
            language,
            audio_data.len()
        );

        // Stub: return empty result
        // TODO: Integrate with actual ML engine
        Ok(TranscriptionResult {
            text: String::new(),
            segments: vec![],
            language: Some(language),
            duration: None,
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
