//! OpenAI LLM Provider
//!
//! OpenAI GPT models (GPT-4o, GPT-4o-mini, GPT-4-turbo, GPT-3.5-turbo).
//! Requires API key from https://platform.openai.com/

use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use std::time::Duration;

use crate::providers::traits::{
    ChatMessage, GenerationOptions, GenerationResult, HealthCheckResult, LLMProvider, ProviderError,
};
use crate::providers::types::LLMProviderId;

/// OpenAI API base URL
const OPENAI_API_URL: &str = "https://api.openai.com/v1";
/// Default model
const DEFAULT_MODEL: &str = "gpt-4o-mini";
/// Request timeout
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// OpenAI LLM provider
pub struct OpenAILLMProvider {
    /// HTTP client
    client: Client,
    /// API key (stored in memory, loaded from keychain)
    api_key: RwLock<Option<String>>,
    /// Default model
    model: RwLock<String>,
}

// ============================================================================
// OpenAI API Types
// ============================================================================

#[derive(Serialize)]
struct OpenAIChatRequest {
    model: String,
    messages: Vec<OpenAIMessage>,
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
struct OpenAIMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct OpenAIChatResponse {
    choices: Option<Vec<OpenAIChoice>>,
    usage: Option<OpenAIUsage>,
    error: Option<OpenAIError>,
}

#[derive(Deserialize)]
struct OpenAIChoice {
    message: OpenAIMessage,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

#[derive(Deserialize)]
struct OpenAIError {
    message: String,
    #[serde(rename = "type")]
    #[allow(dead_code)]
    error_type: Option<String>,
    #[allow(dead_code)]
    code: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModelInfo>,
}

#[derive(Deserialize)]
struct OpenAIModelInfo {
    id: String,
}

// ============================================================================
// Provider Implementation
// ============================================================================

impl OpenAILLMProvider {
    /// Create new OpenAI provider without API key
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

    /// Convert ChatMessage to OpenAIMessage
    fn to_openai_messages(messages: &[ChatMessage]) -> Vec<OpenAIMessage> {
        messages
            .iter()
            .map(|m| OpenAIMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect()
    }

    /// Get available models (curated list)
    fn available_models() -> Vec<String> {
        vec![
            "gpt-4o".to_string(),
            "gpt-4o-mini".to_string(),
            "gpt-4-turbo".to_string(),
            "gpt-4".to_string(),
            "gpt-3.5-turbo".to_string(),
        ]
    }
}

impl Default for OpenAILLMProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl LLMProvider for OpenAILLMProvider {
    fn id(&self) -> LLMProviderId {
        LLMProviderId::OpenAI
    }

    fn name(&self) -> &str {
        "OpenAI GPT"
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
            .ok_or_else(|| ProviderError::not_configured("OpenAI"))?;

        let model = options.model.unwrap_or_else(|| self.get_model());

        // Build messages with optional system message
        let mut openai_messages = Vec::new();
        if let Some(system) = &options.system {
            openai_messages.push(OpenAIMessage {
                role: "system".to_string(),
                content: system.clone(),
            });
        }
        openai_messages.extend(Self::to_openai_messages(&messages));

        let request = OpenAIChatRequest {
            model: model.clone(),
            messages: openai_messages,
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
            .post(format!("{}/chat/completions", OPENAI_API_URL))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
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
        if status == 401 {
            return Err(ProviderError::auth_error("Invalid API key"));
        }

        let openai_response: OpenAIChatResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        // Check for API errors
        if let Some(error) = openai_response.error {
            return Err(ProviderError::api_error(error.message));
        }

        // Extract response
        let choice = openai_response
            .choices
            .and_then(|c| c.into_iter().next())
            .ok_or_else(|| ProviderError::api_error("No response from OpenAI"))?;

        let usage = openai_response.usage;

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
        let api_key = match self.get_api_key() {
            Some(key) => key,
            None => {
                // Return curated list if no API key
                return Ok(Self::available_models());
            }
        };

        let response = self
            .client
            .get(format!("{}/models", OPENAI_API_URL))
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| ProviderError::network_error(e.to_string()))?;

        if !response.status().is_success() {
            // Fallback to curated list
            return Ok(Self::available_models());
        }

        let models_response: OpenAIModelsResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        // Filter to only GPT models
        let models: Vec<String> = models_response
            .data
            .into_iter()
            .map(|m| m.id)
            .filter(|id| id.starts_with("gpt-"))
            .collect();

        if models.is_empty() {
            Ok(Self::available_models())
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
                models: Some(Self::available_models()),
            };
        }

        let api_key = self.get_api_key().unwrap();
        let start = std::time::Instant::now();

        match self
            .client
            .get(format!("{}/models", OPENAI_API_URL))
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
                        models: Some(Self::available_models()),
                    }
                } else if response.status() == 401 {
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
    fn test_openai_provider_creation() {
        let provider = OpenAILLMProvider::new();
        assert_eq!(provider.id(), LLMProviderId::OpenAI);
        assert_eq!(provider.name(), "OpenAI GPT");
        assert!(provider.is_cloud());
        assert!(!provider.is_configured());
    }

    #[test]
    fn test_openai_with_key() {
        let provider = OpenAILLMProvider::with_api_key("sk-test-key");
        assert!(provider.is_configured());
        assert!(provider.has_api_key());
    }

    #[test]
    fn test_available_models() {
        let models = OpenAILLMProvider::available_models();
        assert!(models.contains(&"gpt-4o".to_string()));
        assert!(models.contains(&"gpt-4o-mini".to_string()));
    }
}
