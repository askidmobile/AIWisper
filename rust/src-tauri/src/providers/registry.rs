//! Provider Registry
//!
//! Central registry for managing STT and LLM providers.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::keystore::KeyStore;
use super::traits::{LLMProvider, STTProvider};
use super::types::{
    ConnectionTestResult, LLMProviderId, LLMProvidersSettings, ProviderStatus, STTProviderId,
    STTProvidersSettings,
};

/// Central registry for all providers
pub struct ProviderRegistry {
    /// STT providers
    stt_providers: RwLock<HashMap<STTProviderId, Arc<dyn STTProvider>>>,
    /// LLM providers
    llm_providers: RwLock<HashMap<LLMProviderId, Arc<dyn LLMProvider>>>,
    /// Key storage
    keystore: KeyStore,
    /// STT settings
    stt_settings: RwLock<STTProvidersSettings>,
    /// LLM settings
    llm_settings: RwLock<LLMProvidersSettings>,
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderRegistry {
    /// Create a new provider registry
    pub fn new() -> Self {
        Self {
            stt_providers: RwLock::new(HashMap::new()),
            llm_providers: RwLock::new(HashMap::new()),
            keystore: KeyStore::new(),
            stt_settings: RwLock::new(STTProvidersSettings::default()),
            llm_settings: RwLock::new(LLMProvidersSettings::default()),
        }
    }

    /// Get the keystore
    pub fn keystore(&self) -> &KeyStore {
        &self.keystore
    }

    // ========================================================================
    // STT Provider Management
    // ========================================================================

    /// Register an STT provider
    pub async fn register_stt_provider(&self, provider: Arc<dyn STTProvider>) {
        let id = provider.id();
        let mut providers = self.stt_providers.write().await;
        tracing::info!("Registering STT provider: {:?}", id);
        providers.insert(id, provider);
    }

    /// Get an STT provider by ID
    pub async fn get_stt_provider(&self, id: STTProviderId) -> Option<Arc<dyn STTProvider>> {
        let providers = self.stt_providers.read().await;
        providers.get(&id).cloned()
    }

    /// Get the active STT provider
    pub async fn get_active_stt_provider(&self) -> Option<Arc<dyn STTProvider>> {
        let settings = self.stt_settings.read().await;
        self.get_stt_provider(settings.active_provider.clone()).await
    }

    /// Get the fallback STT provider
    pub async fn get_fallback_stt_provider(&self) -> Option<Arc<dyn STTProvider>> {
        let settings = self.stt_settings.read().await;
        if let Some(ref fallback_id) = settings.fallback_provider {
            self.get_stt_provider(fallback_id.clone()).await
        } else {
            None
        }
    }

    /// List all registered STT providers
    pub async fn list_stt_providers(&self) -> Vec<STTProviderId> {
        let providers = self.stt_providers.read().await;
        providers.keys().cloned().collect()
    }

    /// Get STT providers settings
    pub async fn get_stt_settings(&self) -> STTProvidersSettings {
        self.stt_settings.read().await.clone()
    }

    /// Update STT providers settings
    pub async fn set_stt_settings(&self, settings: STTProvidersSettings) {
        let mut current = self.stt_settings.write().await;
        *current = settings;
    }

    // ========================================================================
    // LLM Provider Management
    // ========================================================================

    /// Register an LLM provider
    pub async fn register_llm_provider(&self, provider: Arc<dyn LLMProvider>) {
        let id = provider.id();
        let mut providers = self.llm_providers.write().await;
        tracing::info!("Registering LLM provider: {:?}", id);
        providers.insert(id, provider);
    }

    /// Get an LLM provider by ID
    pub async fn get_llm_provider(&self, id: LLMProviderId) -> Option<Arc<dyn LLMProvider>> {
        let providers = self.llm_providers.read().await;
        providers.get(&id).cloned()
    }

    /// Get the active LLM provider
    pub async fn get_active_llm_provider(&self) -> Option<Arc<dyn LLMProvider>> {
        let settings = self.llm_settings.read().await;
        self.get_llm_provider(settings.active_provider.clone()).await
    }

    /// Get the fallback LLM provider
    pub async fn get_fallback_llm_provider(&self) -> Option<Arc<dyn LLMProvider>> {
        let settings = self.llm_settings.read().await;
        if let Some(ref fallback_id) = settings.fallback_provider {
            self.get_llm_provider(fallback_id.clone()).await
        } else {
            None
        }
    }

    /// List all registered LLM providers
    pub async fn list_llm_providers(&self) -> Vec<LLMProviderId> {
        let providers = self.llm_providers.read().await;
        providers.keys().cloned().collect()
    }

    /// Get LLM providers settings
    pub async fn get_llm_settings(&self) -> LLMProvidersSettings {
        self.llm_settings.read().await.clone()
    }

    /// Update LLM providers settings
    pub async fn set_llm_settings(&self, settings: LLMProvidersSettings) {
        let mut current = self.llm_settings.write().await;
        *current = settings;
    }

    // ========================================================================
    // Status and Health Checks
    // ========================================================================

    /// Get status of all STT providers
    pub async fn get_stt_providers_status(&self) -> Vec<ProviderStatus> {
        let providers = self.stt_providers.read().await;
        let mut statuses = Vec::new();

        for (id, provider) in providers.iter() {
            let health = provider.health_check().await;
            let has_key = match id {
                STTProviderId::Local => true, // Local doesn't need API key
                _ => self.keystore.has_stt_api_key(id.clone()).await,
            };

            statuses.push(ProviderStatus {
                id: id.to_string(),
                name: provider.name().to_string(),
                provider_type: "stt".to_string(),
                is_cloud: provider.is_cloud(),
                is_configured: provider.is_configured() && (has_key || !provider.is_cloud()),
                is_available: health.healthy,
                last_error: health.error,
            });
        }

        statuses
    }

    /// Get status of all LLM providers
    pub async fn get_llm_providers_status(&self) -> Vec<ProviderStatus> {
        let providers = self.llm_providers.read().await;
        let mut statuses = Vec::new();

        for (id, provider) in providers.iter() {
            let health = provider.health_check().await;
            let has_key = match id {
                LLMProviderId::Ollama => true, // Ollama doesn't need API key
                _ => self.keystore.has_llm_api_key(id.clone()).await,
            };

            statuses.push(ProviderStatus {
                id: id.to_string(),
                name: provider.name().to_string(),
                provider_type: "llm".to_string(),
                is_cloud: provider.is_cloud(),
                is_configured: provider.is_configured() && (has_key || !provider.is_cloud()),
                is_available: health.healthy,
                last_error: health.error,
            });
        }

        statuses
    }

    /// Test connection to a specific STT provider
    pub async fn test_stt_connection(&self, provider_id: STTProviderId) -> ConnectionTestResult {
        let providers = self.stt_providers.read().await;

        if let Some(provider) = providers.get(&provider_id) {
            let start = std::time::Instant::now();
            let health = provider.health_check().await;
            let latency = start.elapsed().as_millis() as u64;

            ConnectionTestResult {
                success: health.healthy,
                latency_ms: Some(latency),
                error: health.error,
                models: None,
            }
        } else {
            ConnectionTestResult {
                success: false,
                latency_ms: None,
                error: Some(format!("Provider {:?} not registered", provider_id)),
                models: None,
            }
        }
    }

    /// Test connection to a specific LLM provider
    pub async fn test_llm_connection(&self, provider_id: LLMProviderId) -> ConnectionTestResult {
        let providers = self.llm_providers.read().await;

        if let Some(provider) = providers.get(&provider_id) {
            let start = std::time::Instant::now();
            let health = provider.health_check().await;
            let latency = start.elapsed().as_millis() as u64;

            // Try to list models
            let models = match provider.list_models().await {
                Ok(m) => Some(m),
                Err(_) => health.models,
            };

            ConnectionTestResult {
                success: health.healthy,
                latency_ms: Some(latency),
                error: health.error,
                models,
            }
        } else {
            ConnectionTestResult {
                success: false,
                latency_ms: None,
                error: Some(format!("Provider {:?} not registered", provider_id)),
                models: None,
            }
        }
    }

    // ========================================================================
    // Provider Initialization
    // ========================================================================

    /// Initialize all STT providers
    ///
    /// Registers all available STT providers (local and cloud).
    /// Cloud providers start in unconfigured state until API keys are set.
    pub async fn initialize_stt_providers(&self) {
        use super::stt::{
            DeepgramSTTProvider, GroqSTTProvider, LocalSTTProvider, OpenAISTTProvider,
        };

        tracing::info!("Initializing STT providers...");

        // Register local provider (always available)
        self.register_stt_provider(Arc::new(LocalSTTProvider::new()))
            .await;

        // Register cloud providers (will need API keys to work)
        self.register_stt_provider(Arc::new(OpenAISTTProvider::new()))
            .await;
        self.register_stt_provider(Arc::new(DeepgramSTTProvider::new()))
            .await;
        self.register_stt_provider(Arc::new(GroqSTTProvider::new()))
            .await;

        tracing::info!(
            "Registered {} STT providers",
            self.stt_providers.read().await.len()
        );
    }

    /// Initialize all LLM providers
    ///
    /// Registers all available LLM providers (local and cloud).
    /// Cloud providers start in unconfigured state until API keys are set.
    pub async fn initialize_llm_providers(&self) {
        use super::llm::{OllamaLLMProvider, OpenAILLMProvider, OpenRouterLLMProvider};

        tracing::info!("Initializing LLM providers...");

        // Register Ollama (local, always available if Ollama is running)
        self.register_llm_provider(Arc::new(OllamaLLMProvider::new()))
            .await;

        // Register cloud providers (will need API keys to work)
        self.register_llm_provider(Arc::new(OpenAILLMProvider::new()))
            .await;
        self.register_llm_provider(Arc::new(OpenRouterLLMProvider::new()))
            .await;

        tracing::info!(
            "Registered {} LLM providers",
            self.llm_providers.read().await.len()
        );
    }

    /// Load API keys from keychain for registered STT providers
    ///
    /// This method creates new provider instances with API keys set.
    /// Due to Rust's trait object limitations, we recreate providers with keys.
    pub async fn load_stt_api_keys(&self) {
        use super::stt::{DeepgramSTTProvider, GroqSTTProvider, OpenAISTTProvider};

        tracing::info!("Loading STT API keys from keychain...");

        // Load OpenAI STT API key
        if let Some(key) = self.keystore.get_stt_api_key(STTProviderId::OpenAI).await {
            let provider = OpenAISTTProvider::new();
            provider.set_api_key(Some(key.clone()));
            // Enable the provider when we have a key
            let mut config = provider.config();
            config.enabled = true;
            config.api_key_set = true;
            provider.set_config(config);
            self.register_stt_provider(Arc::new(provider)).await;
            tracing::info!("Loaded OpenAI STT API key from keychain (enabled=true)");
        }

        // Load Deepgram API key
        if let Some(key) = self.keystore.get_stt_api_key(STTProviderId::Deepgram).await {
            let provider = DeepgramSTTProvider::new();
            provider.set_api_key(Some(key.clone()));
            // Enable the provider when we have a key
            let mut config = provider.config();
            config.enabled = true;
            config.api_key_set = true;
            provider.set_config(config);
            self.register_stt_provider(Arc::new(provider)).await;
            tracing::info!("Loaded Deepgram API key from keychain (enabled=true)");
        }

        // Load Groq STT API key
        if let Some(key) = self.keystore.get_stt_api_key(STTProviderId::Groq).await {
            let provider = GroqSTTProvider::new();
            provider.set_api_key(Some(key.clone()));
            // Enable the provider when we have a key
            let mut config = provider.config();
            config.enabled = true;
            config.api_key_set = true;
            provider.set_config(config);
            self.register_stt_provider(Arc::new(provider)).await;
            tracing::info!("Loaded Groq STT API key from keychain (enabled=true)");
        }
    }

    /// Load API keys from keychain for registered LLM providers
    ///
    /// This method creates new provider instances with API keys set.
    pub async fn load_llm_api_keys(&self) {
        use super::llm::{OpenAILLMProvider, OpenRouterLLMProvider};

        tracing::info!("Loading LLM API keys from keychain...");

        // Load OpenAI LLM API key
        if let Some(key) = self.keystore.get_llm_api_key(LLMProviderId::OpenAI).await {
            let provider = OpenAILLMProvider::new();
            provider.set_api_key(Some(key));
            self.register_llm_provider(Arc::new(provider)).await;
            tracing::info!("Loaded OpenAI LLM API key from keychain");
        }

        // Load OpenRouter API key
        if let Some(key) = self.keystore.get_llm_api_key(LLMProviderId::OpenRouter).await {
            let provider = OpenRouterLLMProvider::new();
            provider.set_api_key(Some(key));
            self.register_llm_provider(Arc::new(provider)).await;
            tracing::info!("Loaded OpenRouter API key from keychain");
        }
    }

    /// Load all API keys from keychain (both STT and LLM)
    pub async fn load_api_keys(&self) {
        self.load_stt_api_keys().await;
        self.load_llm_api_keys().await;
    }

    /// Initialize all providers (STT and LLM)
    pub async fn initialize_all_providers(&self) {
        self.initialize_stt_providers().await;
        self.initialize_llm_providers().await;
        self.load_api_keys().await;
    }
}

