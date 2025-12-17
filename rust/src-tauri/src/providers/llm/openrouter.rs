//! OpenRouter LLM Provider
//!
//! OpenRouter aggregates multiple LLM providers (Claude, GPT, Llama, Mistral, etc.)
//! with a unified API. Requires API key from https://openrouter.ai/

use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use std::time::Duration;

use crate::providers::traits::{
    ChatMessage, GenerationOptions, GenerationResult, HealthCheckResult, LLMProvider, ProviderError,
};
use crate::providers::types::LLMProviderId;

/// OpenRouter API base URL
const OPENROUTER_API_URL: &str = "https://openrouter.ai/api/v1";
/// Default model (Claude 3.5 Sonnet - best quality/price ratio)
const DEFAULT_MODEL: &str = "anthropic/claude-3.5-sonnet";
/// Request timeout
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// OpenRouter LLM provider
pub struct OpenRouterLLMProvider {
    /// HTTP client
    client: Client,
    /// API key (stored in memory, loaded from keychain)
    api_key: RwLock<Option<String>>,
    /// Default model
    model: RwLock<String>,
}

// ============================================================================
// OpenRouter API Types (OpenAI-compatible)
// ============================================================================

#[derive(Serialize)]
struct OpenRouterChatRequest {
    model: String,
    messages: Vec<OpenRouterMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
struct OpenRouterMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct OpenRouterChatResponse {
    choices: Option<Vec<OpenRouterChoice>>,
    usage: Option<OpenRouterUsage>,
    error: Option<OpenRouterError>,
}

#[derive(Deserialize)]
struct OpenRouterChoice {
    message: OpenRouterMessage,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenRouterUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

#[derive(Deserialize)]
struct OpenRouterError {
    message: String,
    #[allow(dead_code)]
    code: Option<i32>,
}

#[derive(Deserialize)]
struct OpenRouterModelsResponse {
    data: Vec<OpenRouterModelInfo>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OpenRouterModelInfo {
    id: String,
    name: Option<String>,
    context_length: Option<u32>,
    pricing: Option<OpenRouterPricing>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OpenRouterPricing {
    prompt: Option<String>,
    completion: Option<String>,
}

// ============================================================================
// Provider Implementation
// ============================================================================

impl OpenRouterLLMProvider {
    /// Create new OpenRouter provider without API key
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("Failed to create HTTP client");

        Self {
            client,
            api_key: RwLock::new(None),
            model: RwLock::new(DEFAULT_MODEL.to_string()),
        }
    }

    /// Create with API key
    pub fn with_api_key(api_key: &str) -> Self {
        let provider = Self::new();
        provider.set_api_key(Some(api_key.to_string()));
        provider
    }

    /// Set API key
    pub fn set_api_key(&self, key: Option<String>) {
        if let Ok(mut current) = self.api_key.write() {
            *current = key;
        }
    }

    /// Check if API key is set
    fn has_api_key(&self) -> bool {
        self.api_key
            .read()
            .map(|k| k.is_some())
            .unwrap_or(false)
    }

    /// Get API key
    fn get_api_key(&self) -> Option<String> {
        self.api_key.read().ok().and_then(|k| k.clone())
    }

    /// Set default model
    pub fn set_model(&self, model: &str) {
        if let Ok(mut current) = self.model.write() {
            *current = model.to_string();
        }
    }

    /// Get current model
    fn get_model(&self) -> String {
        self.model
            .read()
            .map(|m| m.clone())
            .unwrap_or_else(|_| DEFAULT_MODEL.to_string())
    }

    /// Convert ChatMessage to OpenRouterMessage
    fn to_openrouter_messages(messages: &[ChatMessage]) -> Vec<OpenRouterMessage> {
        messages
            .iter()
            .map(|m| OpenRouterMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect()
    }

    /// Get curated list of popular models
    fn popular_models() -> Vec<String> {
        vec![
            // Anthropic Claude
            "anthropic/claude-3.5-sonnet".to_string(),
            "anthropic/claude-3.5-haiku".to_string(),
            "anthropic/claude-3-opus".to_string(),
            // OpenAI
            "openai/gpt-4o".to_string(),
            "openai/gpt-4o-mini".to_string(),
            "openai/gpt-4-turbo".to_string(),
            // Meta Llama
            "meta-llama/llama-3.1-70b-instruct".to_string(),
            "meta-llama/llama-3.1-8b-instruct".to_string(),
            "meta-llama/llama-3.2-90b-vision-instruct".to_string(),
            // Mistral
            "mistralai/mistral-large".to_string(),
            "mistralai/mistral-medium".to_string(),
            "mistralai/mixtral-8x22b-instruct".to_string(),
            // Google
            "google/gemini-pro-1.5".to_string(),
            "google/gemini-flash-1.5".to_string(),
            // DeepSeek
            "deepseek/deepseek-chat".to_string(),
            "deepseek/deepseek-coder".to_string(),
            // Qwen
            "qwen/qwen-2.5-72b-instruct".to_string(),
        ]
    }
}

impl Default for OpenRouterLLMProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl LLMProvider for OpenRouterLLMProvider {
    fn id(&self) -> LLMProviderId {
        LLMProviderId::OpenRouter
    }

    fn name(&self) -> &str {
        "OpenRouter"
    }

    fn is_cloud(&self) -> bool {
        true
    }

    fn is_configured(&self) -> bool {
        self.has_api_key()
    }

    async fn generate(
        &self,
        prompt: &str,
        options: GenerationOptions,
    ) -> Result<GenerationResult, ProviderError> {
        // Convert simple generate to chat format
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        }];
        self.chat(messages, options).await
    }

    async fn chat(
        &self,
        messages: Vec<ChatMessage>,
        options: GenerationOptions,
    ) -> Result<GenerationResult, ProviderError> {
        let api_key = self
            .get_api_key()
            .ok_or_else(|| ProviderError::not_configured("OpenRouter"))?;

        let model = options.model.unwrap_or_else(|| self.get_model());

        // Build messages with optional system message
        let mut openrouter_messages = Vec::new();
        if let Some(system) = &options.system {
            openrouter_messages.push(OpenRouterMessage {
                role: "system".to_string(),
                content: system.clone(),
            });
        }
        openrouter_messages.extend(Self::to_openrouter_messages(&messages));

        let request = OpenRouterChatRequest {
            model: model.clone(),
            messages: openrouter_messages,
            temperature: options.temperature,
            max_tokens: options.max_tokens,
            top_p: options.top_p,
            stop: if options.stop.is_empty() {
                None
            } else {
                Some(options.stop)
            },
        };

        let response = self
            .client
            .post(format!("{}/chat/completions", OPENROUTER_API_URL))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .header("HTTP-Referer", "https://aiwisper.app") // Required by OpenRouter
            .header("X-Title", "AIWisper") // App name for OpenRouter dashboard
            .json(&request)
            .send()
            .await
            .map_err(|e| ProviderError::network_error(e.to_string()))?;

        let status = response.status();

        // Handle rate limiting
        if status == 429 {
            return Err(ProviderError::rate_limited());
        }

        // Handle auth errors
        if status == 401 || status == 403 {
            return Err(ProviderError::auth_error("Invalid API key"));
        }

        let openrouter_response: OpenRouterChatResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        // Check for API errors
        if let Some(error) = openrouter_response.error {
            return Err(ProviderError::api_error(error.message));
        }

        // Extract response
        let choice = openrouter_response
            .choices
            .and_then(|c| c.into_iter().next())
            .ok_or_else(|| ProviderError::api_error("No response from OpenRouter"))?;

        let usage = openrouter_response.usage;

        Ok(GenerationResult {
            text: choice.message.content,
            prompt_tokens: usage.as_ref().map(|u| u.prompt_tokens),
            completion_tokens: usage.as_ref().map(|u| u.completion_tokens),
            total_tokens: usage.as_ref().map(|u| u.total_tokens),
            provider_id: self.id().to_string(),
            model,
            finish_reason: choice.finish_reason,
        })
    }

    async fn list_models(&self) -> Result<Vec<String>, ProviderError> {
        // OpenRouter allows listing models without API key
        let response = self
            .client
            .get(format!("{}/models", OPENROUTER_API_URL))
            .send()
            .await
            .map_err(|e| ProviderError::network_error(e.to_string()))?;

        if !response.status().is_success() {
            // Fallback to curated list
            return Ok(Self::popular_models());
        }

        let models_response: OpenRouterModelsResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        let models: Vec<String> = models_response.data.into_iter().map(|m| m.id).collect();

        if models.is_empty() {
            Ok(Self::popular_models())
        } else {
            Ok(models)
        }
    }

    async fn health_check(&self) -> HealthCheckResult {
        if !self.has_api_key() {
            return HealthCheckResult {
                healthy: false,
                latency_ms: None,
                error: Some("API key not configured".to_string()),
                models: Some(Self::popular_models()),
            };
        }

        let api_key = self.get_api_key().unwrap();
        let start = std::time::Instant::now();

        // OpenRouter doesn't have a dedicated health endpoint, use models list
        match self
            .client
            .get(format!("{}/models", OPENROUTER_API_URL))
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
        {
            Ok(response) => {
                let latency = start.elapsed().as_millis() as u64;

                if response.status().is_success() {
                    HealthCheckResult {
                        healthy: true,
                        latency_ms: Some(latency),
                        error: None,
                        models: Some(Self::popular_models()),
                    }
                } else if response.status() == 401 || response.status() == 403 {
                    HealthCheckResult {
                        healthy: false,
                        latency_ms: Some(latency),
                        error: Some("Invalid API key".to_string()),
                        models: None,
                    }
                } else {
                    HealthCheckResult {
                        healthy: false,
                        latency_ms: Some(latency),
                        error: Some(format!("HTTP {}", response.status())),
                        models: None,
                    }
                }
            }
            Err(e) => HealthCheckResult {
                healthy: false,
                latency_ms: None,
                error: Some(e.to_string()),
                models: None,
            },
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_openrouter_provider_creation() {
        let provider = OpenRouterLLMProvider::new();
        assert_eq!(provider.id(), LLMProviderId::OpenRouter);
        assert_eq!(provider.name(), "OpenRouter");
        assert!(provider.is_cloud());
        assert!(!provider.is_configured());
    }

    #[test]
    fn test_openrouter_with_key() {
        let provider = OpenRouterLLMProvider::with_api_key("sk-or-test-key");
        assert!(provider.is_configured());
        assert!(provider.has_api_key());
    }

    #[test]
    fn test_popular_models() {
        let models = OpenRouterLLMProvider::popular_models();
        assert!(models.contains(&"anthropic/claude-3.5-sonnet".to_string()));
        assert!(models.contains(&"openai/gpt-4o".to_string()));
        assert!(models.contains(&"meta-llama/llama-3.1-70b-instruct".to_string()));
    }

    #[test]
    fn test_default_model() {
        let provider = OpenRouterLLMProvider::new();
        assert_eq!(provider.get_model(), "anthropic/claude-3.5-sonnet");
    }
}
