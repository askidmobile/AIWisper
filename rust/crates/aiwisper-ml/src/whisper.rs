//! Whisper transcription engine using whisper-rs
//!
//! Supports Metal GPU acceleration on macOS Apple Silicon.

use crate::traits::TranscriptionEngine;
use aiwisper_types::{TranscriptSegment, TranscriptWord, TranscriptionResult};
use anyhow::{Context, Result};
use regex::Regex;
use std::sync::OnceLock;
use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Regex для фильтрации специальных токенов whisper
/// Включает: [_TT_xxx], [_EOT_], [_SOT_], [_TRANSLATE_], [_TRANSCRIBE_], [_LANG_xx], [_BEG_], etc.
fn special_tokens_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"\[_[A-Z]+_?\d*\]").unwrap())
}

/// Очистить текст от специальных токенов whisper
fn clean_special_tokens(text: &str) -> String {
    let cleaned = special_tokens_regex().replace_all(text, "");
    // Убираем лишние пробелы после удаления токенов
    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whisper transcription engine with Metal/GPU support
pub struct WhisperEngine {
    ctx: WhisperContext,
    language: String,
    hotwords: Vec<String>,
    use_gpu: bool,
}

impl TranscriptionEngine for WhisperEngine {
    fn name(&self) -> &str {
        "whisper"
    }

    fn transcribe(&self, samples: &[f32]) -> Result<TranscriptionResult> {
        let segments = self.transcribe_with_segments(samples)?;

        let text = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        Ok(TranscriptionResult {
            text,
            segments,
            language: if self.language == "auto" {
                None
            } else {
                Some(self.language.clone())
            },
            processing_time_ms: 0, // TODO: measure
            rtf: 0.0,              // TODO: calculate
        })
    }

    fn transcribe_with_segments(&self, samples: &[f32]) -> Result<Vec<TranscriptSegment>> {
        let start = Instant::now();

        // Create state and run inference
        let mut state = self
            .ctx
            .create_state()
            .context("Failed to create Whisper state")?;

        let params = self.create_params();

        state
            .full(params, samples)
            .context("Whisper inference failed")?;

        // Extract segments using new API (whisper-rs 0.15+)
        let num_segments = state.full_n_segments();

        let mut segments = Vec::new();

        for i in 0..num_segments {
            // Get segment using new API
            let segment = match state.get_segment(i) {
                Some(seg) => seg,
                None => continue,
            };

            let text = match segment.to_str() {
                Ok(t) => t.to_string(),
                Err(_) => {
                    // Try lossy conversion for non-UTF8 text
                    match segment.to_str_lossy() {
                        Ok(t) => t.to_string(),
                        Err(_) => continue,
                    }
                }
            };

            let start_ts = segment.start_timestamp();
            let end_ts = segment.end_timestamp();

            // Convert timestamps from centiseconds to milliseconds
            let start_ms = (start_ts * 10) as i64;
            let end_ms = (end_ts * 10) as i64;

            // Get token-level timestamps for words
            let num_tokens = segment.n_tokens();

            let mut words = Vec::new();
            let mut current_word = String::new();
            let mut word_start = start_ms;

            for j in 0..num_tokens {
                if let Some(token) = segment.get_token(j) {
                    let token_text = match token.to_str() {
                        Ok(t) => t.to_string(),
                        Err(_) => {
                            match token.to_str_lossy() {
                                Ok(t) => t.to_string(),
                                Err(_) => continue,
                            }
                        }
                    };

                    // Пропускаем специальные токены whisper [_TT_xxx], [_EOT_], etc.
                    if token_text.starts_with("[_") || token_text.starts_with(" [_") {
                        continue;
                    }

                    let token_data = token.token_data();
                    let token_prob = token.token_probability();

                    // Check if this starts a new word (has leading space)
                    if token_text.starts_with(' ') && !current_word.is_empty() {
                        // Save previous word
                        let word_end = (token_data.t0 as i64) * 10;

                        let word_text = current_word.trim().to_string();
                        if !word_text.is_empty() {
                            words.push(TranscriptWord {
                                start: word_start,
                                end: word_end,
                                text: word_text,
                                confidence: token_prob,
                            });
                        }

                        current_word = token_text.trim_start().to_string();
                        word_start = word_end;
                    } else {
                        current_word.push_str(&token_text);
                    }
                }
            }

            // Add last word
            if !current_word.is_empty() {
                let word_text = current_word.trim().to_string();
                // Проверяем что слово не является специальным токеном
                if !word_text.is_empty() && !word_text.starts_with("[_") {
                    words.push(TranscriptWord {
                        start: word_start,
                        end: end_ms,
                        text: word_text,
                        confidence: 0.8, // default confidence
                    });
                }
            }

            // Очищаем текст от специальных токенов whisper [_TT_xxx], [_EOT_], etc.
            let clean_text = clean_special_tokens(text.trim());

            // Пропускаем пустые сегменты после очистки
            if clean_text.is_empty() {
                continue;
            }

            segments.push(TranscriptSegment {
                start: start_ms,
                end: end_ms,
                text: clean_text,
                speaker: None,
                words,
                confidence: 1.0 - segment.no_speech_probability(), // Use no_speech_prob as confidence inverse
            });
        }

        let elapsed = start.elapsed();
        let audio_duration = samples.len() as f64 / 16000.0;
        let rtf = audio_duration / elapsed.as_secs_f64();

        tracing::debug!(
            "Whisper: transcribed {:.1}s audio in {:.2}s (RTFx: {:.1}), {} segments",
            audio_duration,
            elapsed.as_secs_f64(),
            rtf,
            segments.len()
        );

        Ok(segments)
    }

    fn supported_languages(&self) -> &[&str] {
        &[
            "auto", "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl",
            "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da",
            "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te",
            "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne",
            "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af",
            "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk",
            "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba",
            "jw", "su",
        ]
    }

    fn set_language(&mut self, language: &str) -> Result<()> {
        self.language = language.to_string();
        Ok(())
    }

    fn set_hotwords(&mut self, hotwords: &[String]) -> Result<()> {
        self.hotwords = hotwords.to_vec();
        Ok(())
    }
}

impl WhisperEngine {
    /// Create new Whisper engine with model path
    /// Automatically enables Metal GPU on Apple Silicon
    pub fn new(model_path: &str) -> Result<Self> {
        Self::new_with_options(model_path, true)
    }

    /// Create Whisper engine with explicit GPU option
    pub fn new_with_options(model_path: &str, use_gpu: bool) -> Result<Self> {
        tracing::info!("Loading Whisper model from: {}", model_path);

        // Detect if we're on Apple Silicon for Metal support
        let is_apple_silicon = cfg!(target_os = "macos") && cfg!(target_arch = "aarch64");
        let enable_gpu = use_gpu && is_apple_silicon;

        // Configure context parameters for GPU
        let mut params = WhisperContextParameters::default();
        params.use_gpu(enable_gpu);

        // Enable flash attention for better performance on supported hardware
        if enable_gpu {
            params.flash_attn(true);
            tracing::info!("Whisper: Metal GPU acceleration enabled (Apple Silicon)");
        } else {
            tracing::info!("Whisper: Using CPU inference");
        }

        let ctx = WhisperContext::new_with_params(model_path, params)
            .context("Failed to load Whisper model")?;

        tracing::info!("Whisper model loaded successfully");

        Ok(Self {
            ctx,
            language: "auto".to_string(),
            hotwords: vec![],
            use_gpu: enable_gpu,
        })
    }

    /// Check if GPU acceleration is enabled
    pub fn is_gpu_enabled(&self) -> bool {
        self.use_gpu
    }

    /// Create transcription parameters
    fn create_params(&self) -> FullParams<'_, '_> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

        // Set language (if not auto)
        if self.language != "auto" {
            params.set_language(Some(&self.language));
        }

        // Enable word timestamps
        params.set_token_timestamps(true);

        // Set initial prompt with hotwords if available
        if !self.hotwords.is_empty() {
            let prompt = self.hotwords.join(", ");
            params.set_initial_prompt(&prompt);
        }

        // Performance settings
        params.set_n_threads(4);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        params
    }
}
