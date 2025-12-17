//! LLM integration for hybrid transcription
//!
//! Supports Ollama API for selecting best transcription variant.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// LLM configuration for transcription selection
#[derive(Debug, Clone)]
pub struct LLMConfig {
    /// Ollama model name (e.g., "llama3.2", "qwen2.5")
    pub model: String,
    /// Ollama API URL (e.g., "http://localhost:11434")
    pub url: String,
    /// Temperature for generation (0.0-1.0, lower = more deterministic)
    pub temperature: f32,
    /// Max tokens to generate
    pub max_tokens: u32,
    /// Request timeout
    pub timeout: Duration,
}

impl Default for LLMConfig {
    fn default() -> Self {
        Self {
            model: "llama3.2".to_string(),
            url: "http://localhost:11434".to_string(),
            temperature: 0.1,
            // Large enough for thinking models (Qwen3, DeepSeek) which may use
            // many tokens for reasoning before producing the final answer
            max_tokens: 4096,
            // Thinking models can take 1-2 minutes to respond
            timeout: Duration::from_secs(180),
        }
    }
}

/// LLM-based transcription selector
pub struct LLMSelector {
    config: LLMConfig,
    client: reqwest::Client,
}

#[derive(Serialize)]
struct OllamaRequest {
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
    /// Max tokens to generate. Must be large enough for thinking models
    /// which may use many tokens for reasoning before the final answer.
    num_predict: u32,
}

#[derive(Deserialize)]
struct OllamaResponse {
    message: Option<OllamaResponseMessage>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct OllamaResponseMessage {
    content: String,
    /// Some models (like Qwen3) return thinking process in a separate field
    #[serde(default)]
    thinking: Option<String>,
}

impl OllamaResponseMessage {
    /// Get the actual response content, handling thinking models
    /// 
    /// Some models (like Qwen3) include their reasoning in the content field
    /// wrapped in `<think>...</think>` tags, with the final answer after.
    /// This method extracts just the final answer.
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

impl LLMSelector {
    /// Create new LLM selector with given configuration
    pub fn new(config: LLMConfig) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .context("Failed to create HTTP client")?;

        Ok(Self { config, client })
    }

    /// Create with model and URL
    pub fn with_model_url(model: &str, url: &str) -> Result<Self> {
        Self::new(LLMConfig {
            model: model.to_string(),
            url: url.to_string(),
            ..Default::default()
        })
    }

    /// Check if Ollama is available
    pub async fn is_available(&self) -> bool {
        let url = format!("{}/api/tags", self.config.url);
        self.client.get(&url).send().await.is_ok()
    }

    /// Select best transcription from two variants using LLM
    ///
    /// Returns the selected/improved transcription or original on error
    pub async fn select_best_transcription(
        &self,
        original: &str,
        alternative: &str,
        context: &str,
    ) -> Result<String> {
        // Check Ollama availability
        if !self.is_available().await {
            tracing::warn!("Ollama not available at {}, returning original", self.config.url);
            return Ok(original.to_string());
        }

        let system_prompt = r#"Ты — эксперт по улучшению транскрипций русской речи.

ТВОЯ ЗАДАЧА:
Создать наилучшую транскрипцию на основе двух вариантов от разных моделей распознавания речи.

ВАЖНО: Модели часто ошибаются по-разному:
- Одна модель может лучше распознать имена и термины
- Другая может лучше расставить пунктуацию
- Обе могут пропустить или исказить разные слова

КРИТЕРИИ (в порядке приоритета):
1. ПРАВИЛЬНОСТЬ СЛОВ — выбирай слова, которые имеют смысл в контексте
2. ПОЛНОТА — не теряй слова, которые есть в одном варианте
3. Имена собственные — "Люха", "Лёша" лучше чем "Ильюха" если контекст неформальный
4. Технические термины — "notify", "API", "B2C" должны быть корректны
5. Пунктуация — добавь точки, запятые, вопросительные знаки

ЧТО МОЖНО ДЕЛАТЬ:
- Выбрать один из вариантов целиком
- Взять слова из разных вариантов и объединить
- Исправить очевидные ошибки (например "протиФ" → "про notify")
- Добавить пунктуацию

ФОРМАТ ОТВЕТА:
Верни ТОЛЬКО итоговый текст транскрипции, без объяснений."#;

        let user_prompt = format!(
            r#"Контекст (предыдущие реплики):
{}

Вариант 1:
{}

Вариант 2:
{}

Создай лучшую транскрипцию:"#,
            context, original, alternative
        );

        let request = OllamaRequest {
            model: self.config.model.clone(),
            messages: vec![
                OllamaMessage {
                    role: "system".to_string(),
                    content: system_prompt.to_string(),
                },
                OllamaMessage {
                    role: "user".to_string(),
                    content: user_prompt,
                },
            ],
            stream: false,
            think: false, // Disable thinking mode for faster responses
            options: OllamaOptions {
                temperature: self.config.temperature,
                num_predict: self.config.max_tokens,
            },
        };

        let url = format!("{}/api/chat", self.config.url);
        
        tracing::debug!(
            "[LLMSelector] Calling Ollama: model={}, url={}",
            self.config.model,
            url
        );

        let response = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .context("Failed to send request to Ollama")?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            tracing::error!("[LLMSelector] Ollama error: {} - {}", status, error_text);
            return Ok(original.to_string());
        }

        let ollama_response: OllamaResponse = response
            .json()
            .await
            .context("Failed to parse Ollama response")?;

        if let Some(error) = ollama_response.error {
            tracing::error!("[LLMSelector] Ollama API error: {}", error);
            return Ok(original.to_string());
        }

        let content = ollama_response
            .message
            .map(|m| m.get_response())
            .unwrap_or_default();

        tracing::debug!(
            "[LLMSelector] LLM response: {:?}",
            content
        );

        // Validate response
        if content.is_empty() {
            tracing::warn!("[LLMSelector] Empty response from LLM, returning original");
            return Ok(original.to_string());
        }

        // Check response is not too short (hallucination protection)
        if content.len() < original.len() / 3 {
            tracing::warn!(
                "[LLMSelector] Response too short ({} vs {}), returning original",
                content.len(),
                original.len()
            );
            return Ok(original.to_string());
        }

        // Check similarity with variants
        let orig_sim = text_similarity(&content.to_lowercase(), &original.to_lowercase());
        let alt_sim = text_similarity(&content.to_lowercase(), &alternative.to_lowercase());

        tracing::debug!(
            "[LLMSelector] Similarity: orig={:.2}, alt={:.2}",
            orig_sim,
            alt_sim
        );

        // If response is not similar to either variant (<30%) - it's hallucination
        if orig_sim < 0.3 && alt_sim < 0.3 {
            tracing::warn!(
                "[LLMSelector] Response not similar to either variant, returning original"
            );
            return Ok(original.to_string());
        }

        tracing::info!(
            "[LLMSelector] Selected transcription (orig_sim={:.2}, alt_sim={:.2})",
            orig_sim,
            alt_sim
        );

        Ok(content)
    }

    /// Enhance a single transcription using LLM
    ///
    /// Improves grammar, punctuation, and fixes obvious errors
    pub async fn enhance_transcription(&self, text: &str) -> Result<String> {
        // Check Ollama availability
        if !self.is_available().await {
            tracing::warn!("Ollama not available at {}, returning original", self.config.url);
            return Ok(text.to_string());
        }

        let system_prompt = r#"Ты — эксперт по исправлению ошибок автоматического распознавания речи (ASR).

КОНТЕКСТ:
Тебе дана транскрипция, созданная системой распознавания речи. Она может содержать:
- Неправильно распознанные слова (например "алй" вместо "али", "дат" вместо "дать")
- Бессмысленные фрагменты из-за шума или нечёткой речи
- Пропущенную или неправильную пунктуацию
- Токены <unk> (неизвестные слова)

ТВОЯ ЗАДАЧА:
Исправить ошибки распознавания, чтобы текст стал осмысленным и читаемым.

ПРАВИЛА:
1. ИСПРАВЛЯЙ явные ошибки распознавания на правильные слова по контексту
2. УДАЛЯЙ бессмысленные фрагменты и токены <unk>
3. ДОБАВЛЯЙ правильную пунктуацию
4. УБИРАЙ междометия (ммм, ээ, ааа, а?)
5. СОХРАНЯЙ общий смысл и структуру высказывания
6. НЕ добавляй информацию, которой не было в оригинале

ПРИМЕРЫ ИСПРАВЛЕНИЙ:
- "алй даёт" → "али даёт" или убрать если бессмысленно
- "да<unk>т" → "дать" или "даёт"
- "немножко дома коллапс" → "немножко дома коллапс" (если имеет смысл) или "немного, дома коллапс"
- "Что я" в конце → убрать если это обрыв

ФОРМАТ ОТВЕТА:
Верни ТОЛЬКО исправленный текст. Никаких пояснений, комментариев или форматирования."#;

        let user_prompt = format!(
            "Улучши эту транскрипцию:\n\n{}",
            text
        );

        let request = OllamaRequest {
            model: self.config.model.clone(),
            messages: vec![
                OllamaMessage {
                    role: "system".to_string(),
                    content: system_prompt.to_string(),
                },
                OllamaMessage {
                    role: "user".to_string(),
                    content: user_prompt,
                },
            ],
            stream: false,
            think: false, // Disable thinking mode for faster responses
            options: OllamaOptions {
                temperature: self.config.temperature,
                num_predict: self.config.max_tokens,
            },
        };

        let url = format!("{}/api/chat", self.config.url);
        
        tracing::debug!(
            "[LLMSelector] Enhancing with Ollama: model={}, url={}, text_len={}",
            self.config.model,
            url,
            text.len()
        );

        let response = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .context("Failed to send request to Ollama")?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            tracing::error!("[LLMSelector] Ollama error: {} - {}", status, error_text);
            return Ok(text.to_string());
        }

        let ollama_response: OllamaResponse = response
            .json()
            .await
            .context("Failed to parse Ollama response")?;

        if let Some(error) = ollama_response.error {
            tracing::error!("[LLMSelector] Ollama API error: {}", error);
            return Ok(text.to_string());
        }

        let content = ollama_response
            .message
            .map(|m| m.get_response())
            .unwrap_or_default();

        tracing::debug!(
            "[LLMSelector] LLM response: {:?}",
            content
        );

        // Validate response
        if content.is_empty() {
            tracing::warn!("[LLMSelector] Empty response from LLM, returning original");
            return Ok(text.to_string());
        }

        // Check response is not too different in length (hallucination protection)
        let len_ratio = content.len() as f64 / text.len() as f64;
        if len_ratio < 0.5 || len_ratio > 2.0 {
            tracing::warn!(
                "[LLMSelector] Response length too different ({} vs {}), returning original",
                content.len(),
                text.len()
            );
            return Ok(text.to_string());
        }

        // Check similarity with original
        let similarity = text_similarity(&content.to_lowercase(), &text.to_lowercase());
        
        tracing::debug!(
            "[LLMSelector] Enhancement similarity: {:.2}",
            similarity
        );

        // If response is not similar enough (<40%) - it's hallucination
        if similarity < 0.4 {
            tracing::warn!(
                "[LLMSelector] Enhanced text not similar enough to original ({:.2}), returning original",
                similarity
            );
            return Ok(text.to_string());
        }

        tracing::info!(
            "[LLMSelector] Enhanced transcription (similarity={:.2})",
            similarity
        );

        Ok(content)
    }
}

/// Calculate text similarity (Jaccard index on words)
fn text_similarity(a: &str, b: &str) -> f64 {
    let words_a: std::collections::HashSet<&str> = a.split_whitespace().collect();
    let words_b: std::collections::HashSet<&str> = b.split_whitespace().collect();

    if words_a.is_empty() && words_b.is_empty() {
        return 1.0;
    }
    if words_a.is_empty() || words_b.is_empty() {
        return 0.0;
    }

    let intersection = words_a.intersection(&words_b).count();
    let union = words_a.union(&words_b).count();

    if union == 0 {
        return 0.0;
    }

    intersection as f64 / union as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_similarity() {
        assert!((text_similarity("hello world", "hello world") - 1.0).abs() < 0.01);
        assert!((text_similarity("hello world", "hello") - 0.5).abs() < 0.01);
        assert!((text_similarity("hello", "world") - 0.0).abs() < 0.01);
        assert!((text_similarity("", "") - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_default_config() {
        let config = LLMConfig::default();
        assert_eq!(config.model, "llama3.2");
        assert_eq!(config.url, "http://localhost:11434");
    }
}
