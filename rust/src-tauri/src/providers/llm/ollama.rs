//! Ollama LLM Provider
//!
//! Local LLM inference via Ollama API.
//! Supports models like llama3.2, qwen2.5, mistral, etc.

use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use std::time::Duration;

use crate::providers::traits::{
    ChatMessage, GenerationOptions, GenerationResult, HealthCheckResult, LLMProvider, ProviderError,
};
use crate::providers::types::LLMProviderId;

/// Default Ollama API URL
const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
/// Default model name
const DEFAULT_MODEL: &str = "llama3.2";
/// Request timeout
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// Ollama LLM provider for local inference
pub struct OllamaLLMProvider {
    /// HTTP client
    client: Client,
    /// Ollama server URL
    url: RwLock<String>,
    /// Default model
    model: RwLock<String>,
}

// ============================================================================
// Ollama API Types
// ============================================================================

#[derive(Serialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<OllamaMessage>,
    stream: bool,
    /// Disable thinking mode for models that support it (e.g., Qwen3)
    think: bool,
    options: OllamaOptions,
}

#[derive(Serialize)]
struct OllamaMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct OllamaOptions {
    temperature: f32,
    num_predict: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct OllamaChatResponse {
    message: Option<OllamaResponseMessage>,
    error: Option<String>,
    #[serde(default)]
    prompt_eval_count: Option<u32>,
    #[serde(default)]
    eval_count: Option<u32>,
}

#[derive(Deserialize)]
struct OllamaResponseMessage {
    content: String,
}

impl OllamaResponseMessage {
    /// Get the actual response content, handling thinking models
    ///
    /// Some models (like Qwen3) include their reasoning in the content field
    /// wrapped in `<think>...</think>` tags, with the final answer after.
    fn get_response(&self) -> String {
        let content = self.content.trim();

        // Check if content contains </think> tag (thinking model output)
        if let Some(pos) = content.find("</think>") {
            // Extract text after </think>
            let after_think = &content[pos + 8..]; // 8 = len("</think>")
            let result = after_think.trim();
            if !result.is_empty() {
                return result.to_string();
            }
        }

        // No thinking tags, return content as-is
        content.to_string()
    }
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Option<Vec<OllamaModelInfo>>,
}

#[derive(Deserialize)]
struct OllamaModelInfo {
    name: String,
}

#[derive(Serialize)]
struct OllamaGenerateRequest {
    model: String,
    prompt: String,
    stream: bool,
    system: Option<String>,
    options: OllamaOptions,
}

#[derive(Deserialize)]
struct OllamaGenerateResponse {
    response: String,
    error: Option<String>,
    #[serde(default)]
    prompt_eval_count: Option<u32>,
    #[serde(default)]
    eval_count: Option<u32>,
}

// ============================================================================
// Provider Implementation
// ============================================================================

impl OllamaLLMProvider {
    /// Create new Ollama provider with default settings
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("Failed to create HTTP client");

        Self {
            client,
            url: RwLock::new(DEFAULT_OLLAMA_URL.to_string()),
            model: RwLock::new(DEFAULT_MODEL.to_string()),
        }
    }

    /// Create with custom URL and model
    pub fn with_config(url: &str, model: &str) -> Self {
        let provider = Self::new();
        provider.set_url(url);
        provider.set_model(model);
        provider
    }

    /// Set Ollama server URL
    pub fn set_url(&self, url: &str) {
        if let Ok(mut current) = self.url.write() {
            *current = url.to_string();
        }
    }

    /// Set default model
    pub fn set_model(&self, model: &str) {
        if let Ok(mut current) = self.model.write() {
            *current = model.to_string();
        }
    }

    /// Get current URL
    fn get_url(&self) -> String {
        self.url
            .read()
            .map(|u| u.clone())
            .unwrap_or_else(|_| DEFAULT_OLLAMA_URL.to_string())
    }

    /// Get current model
    fn get_model(&self) -> String {
        self.model
            .read()
            .map(|m| m.clone())
            .unwrap_or_else(|_| DEFAULT_MODEL.to_string())
    }

    /// Convert ChatMessage to OllamaMessage
    fn to_ollama_messages(messages: &[ChatMessage]) -> Vec<OllamaMessage> {
        messages
            .iter()
            .map(|m| OllamaMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect()
    }
}

impl Default for OllamaLLMProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl LLMProvider for OllamaLLMProvider {
    fn id(&self) -> LLMProviderId {
        LLMProviderId::Ollama
    }

    fn name(&self) -> &str {
        "Ollama (Local)"
    }

    fn is_cloud(&self) -> bool {
        false
    }

    fn is_configured(&self) -> bool {
        // Ollama doesn't need API key, just check if URL is set
        !self.get_url().is_empty()
    }

    async fn generate(
        &self,
        prompt: &str,
        options: GenerationOptions,
    ) -> Result<GenerationResult, ProviderError> {
        let url = format!("{}/api/generate", self.get_url());
        let model = options.model.unwrap_or_else(|| self.get_model());

        let request = OllamaGenerateRequest {
            model: model.clone(),
            prompt: prompt.to_string(),
            stream: false,
            system: options.system,
            options: OllamaOptions {
                temperature: options.temperature.unwrap_or(0.7),
                num_predict: options.max_tokens.unwrap_or(1000),
                top_p: options.top_p,
                stop: if options.stop.is_empty() {
                    None
                } else {
                    Some(options.stop)
                },
            },
        };

        let response = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| ProviderError::network_error(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(ProviderError::api_error(format!(
                "Ollama API error: {} - {}",
                status, error_text
            )));
        }

        let ollama_response: OllamaGenerateResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        if let Some(error) = ollama_response.error {
            return Err(ProviderError::api_error(error));
        }

        Ok(GenerationResult {
            text: ollama_response.response,
            prompt_tokens: ollama_response.prompt_eval_count,
            completion_tokens: ollama_response.eval_count,
            total_tokens: ollama_response
                .prompt_eval_count
                .zip(ollama_response.eval_count)
                .map(|(p, c)| p + c),
            provider_id: self.id().to_string(),
            model,
            finish_reason: Some("stop".to_string()),
        })
    }

    async fn chat(
        &self,
        messages: Vec<ChatMessage>,
        options: GenerationOptions,
    ) -> Result<GenerationResult, ProviderError> {
        let url = format!("{}/api/chat", self.get_url());
        let model = options.model.unwrap_or_else(|| self.get_model());

        // Add system message if provided
        let mut ollama_messages = Vec::new();
        if let Some(system) = &options.system {
            ollama_messages.push(OllamaMessage {
                role: "system".to_string(),
                content: system.clone(),
            });
        }
        ollama_messages.extend(Self::to_ollama_messages(&messages));

        let request = OllamaChatRequest {
            model: model.clone(),
            messages: ollama_messages,
            stream: false,
            think: false, // Disable thinking mode for faster responses
            options: OllamaOptions {
                temperature: options.temperature.unwrap_or(0.7),
                num_predict: options.max_tokens.unwrap_or(1000),
                top_p: options.top_p,
                stop: if options.stop.is_empty() {
                    None
                } else {
                    Some(options.stop)
                },
            },
        };

        let response = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| ProviderError::network_error(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(ProviderError::api_error(format!(
                "Ollama API error: {} - {}",
                status, error_text
            )));
        }

        let ollama_response: OllamaChatResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        if let Some(error) = ollama_response.error {
            return Err(ProviderError::api_error(error));
        }

        let text = ollama_response
            .message
            .map(|m| m.get_response())
            .unwrap_or_default();

        Ok(GenerationResult {
            text,
            prompt_tokens: ollama_response.prompt_eval_count,
            completion_tokens: ollama_response.eval_count,
            total_tokens: ollama_response
                .prompt_eval_count
                .zip(ollama_response.eval_count)
                .map(|(p, c)| p + c),
            provider_id: self.id().to_string(),
            model,
            finish_reason: Some("stop".to_string()),
        })
    }

    async fn list_models(&self) -> Result<Vec<String>, ProviderError> {
        let url = format!("{}/api/tags", self.get_url());

        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| ProviderError::network_error(e.to_string()))?;

        if !response.status().is_success() {
            return Err(ProviderError::api_error("Failed to list Ollama models"));
        }

        let tags_response: OllamaTagsResponse = response
            .json()
            .await
            .map_err(|e| ProviderError::api_error(format!("Failed to parse response: {}", e)))?;

        let models = tags_response
            .models
            .unwrap_or_default()
            .into_iter()
            .map(|m| m.name)
            .collect();

        Ok(models)
    }

    async fn health_check(&self) -> HealthCheckResult {
        let url = format!("{}/api/tags", self.get_url());
        let start = std::time::Instant::now();

        match self.client.get(&url).send().await {
            Ok(response) => {
                let latency = start.elapsed().as_millis() as u64;

                if response.status().is_success() {
                    // Try to list models for extra info
                    let models = match response.json::<OllamaTagsResponse>().await {
                        Ok(tags) => tags.models.map(|m| m.into_iter().map(|m| m.name).collect()),
                        Err(_) => None,
                    };

                    HealthCheckResult {
                        healthy: true,
                        latency_ms: Some(latency),
                        error: None,
                        models,
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
            Err(e) => {
                // Check if it's a connection error (Ollama not running)
                let error_msg = if e.is_connect() {
                    "Ollama not running. Start with: ollama serve".to_string()
                } else {
                    e.to_string()
                };

                HealthCheckResult {
                    healthy: false,
                    latency_ms: None,
                    error: Some(error_msg),
                    models: None,
                }
            }
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
    fn test_ollama_provider_creation() {
        let provider = OllamaLLMProvider::new();
        assert_eq!(provider.id(), LLMProviderId::Ollama);
        assert_eq!(provider.name(), "Ollama (Local)");
        assert!(!provider.is_cloud());
        assert!(provider.is_configured());
    }

    #[test]
    fn test_ollama_with_config() {
        let provider = OllamaLLMProvider::with_config("http://custom:11434", "qwen2.5");
        assert_eq!(provider.get_url(), "http://custom:11434");
        assert_eq!(provider.get_model(), "qwen2.5");
    }

    #[test]
    fn test_thinking_model_response() {
        let msg = OllamaResponseMessage {
            content: "<think>Some reasoning here...</think>Final answer".to_string(),
        };
        assert_eq!(msg.get_response(), "Final answer");

        let msg2 = OllamaResponseMessage {
            content: "Simple response without thinking".to_string(),
        };
        assert_eq!(msg2.get_response(), "Simple response without thinking");
    }
}
