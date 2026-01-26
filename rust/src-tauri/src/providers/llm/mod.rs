//! Large Language Model providers
//!
//! Contains implementations for various LLM providers:
//! - Ollama: Local LLM inference
//! - OpenAI: GPT-4, GPT-4o, GPT-4o-mini
//! - OpenRouter: Aggregator (Claude, GPT, Llama, Mistral, etc.)

pub mod ollama;
pub mod openai;
pub mod openrouter;

// Re-export provider types
pub use ollama::OllamaLLMProvider;
pub use openai::OpenAILLMProvider;
pub use openrouter::OpenRouterLLMProvider;

use super::types::LLMProviderId;

/// Get human-readable name for an LLM provider
pub fn provider_name(id: &LLMProviderId) -> &'static str {
    match id {
        LLMProviderId::Ollama => "Ollama (Local)",
        LLMProviderId::OpenAI => "OpenAI GPT",
        LLMProviderId::OpenRouter => "OpenRouter",
    }
}

/// Check if provider is a cloud service
pub fn is_cloud_provider(id: &LLMProviderId) -> bool {
    match id {
        LLMProviderId::Ollama => false,
        LLMProviderId::OpenAI => true,
        LLMProviderId::OpenRouter => true,
    }
}

/// Get default models for each provider
pub fn default_models(id: &LLMProviderId) -> Vec<&'static str> {
    match id {
        LLMProviderId::Ollama => vec![
            "llama3.2",
            "llama3.2:1b",
            "qwen2.5",
            "qwen2.5-coder",
            "mistral",
            "gemma2",
        ],
        LLMProviderId::OpenAI => vec![
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4-turbo",
            "gpt-3.5-turbo",
        ],
        LLMProviderId::OpenRouter => vec![
            "anthropic/claude-3.5-sonnet",
            "anthropic/claude-3-haiku",
            "openai/gpt-4o",
            "openai/gpt-4o-mini",
            "meta-llama/llama-3.1-70b-instruct",
            "mistralai/mistral-large",
            "google/gemini-pro-1.5",
        ],
    }
}

/// Get pricing info (cost per 1M tokens in USD, input/output)
pub fn pricing_per_million_tokens(id: &LLMProviderId, model: &str) -> Option<(f64, f64)> {
    match id {
        LLMProviderId::Ollama => None, // Free (local)
        LLMProviderId::OpenAI => match model {
            "gpt-4o" => Some((2.50, 10.00)),
            "gpt-4o-mini" => Some((0.15, 0.60)),
            "gpt-4-turbo" => Some((10.00, 30.00)),
            "gpt-3.5-turbo" => Some((0.50, 1.50)),
            _ => Some((2.50, 10.00)), // Default to gpt-4o pricing
        },
        LLMProviderId::OpenRouter => {
            // OpenRouter adds a small markup, prices vary by model
            // These are approximate
            if model.contains("claude-3.5-sonnet") {
                Some((3.00, 15.00))
            } else if model.contains("claude-3-haiku") {
                Some((0.25, 1.25))
            } else if model.contains("gpt-4o") {
                Some((2.75, 11.00))
            } else {
                Some((1.00, 2.00)) // Default estimate
            }
        }
    }
}
