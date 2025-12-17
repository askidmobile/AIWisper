//! FluidASR transcription engine using subprocess (Swift/CoreML)
//!
//! Parakeet TDT v3 (multilingual) via FluidAudio framework.
//! Uses subprocess for stable execution without memory leaks.

use crate::traits::TranscriptionEngine;
use aiwisper_types::{TranscriptSegment, TranscriptWord, TranscriptionResult};
use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::Deserialize;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

/// Версия модели Parakeet TDT
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FluidModelVersion {
    /// Parakeet TDT v2 (English-only, higher recall)
    V2,
    /// Parakeet TDT v3 (Multilingual: 25 European languages)
    #[default]
    V3,
}

impl FluidModelVersion {
    fn as_str(&self) -> &'static str {
        match self {
            FluidModelVersion::V2 => "v2",
            FluidModelVersion::V3 => "v3",
        }
    }
}

/// Результат JSON от transcription-fluid subprocess
#[derive(Debug, Deserialize)]
struct FluidTranscriptionResult {
    segments: Vec<FluidSegment>,
    #[serde(default)]
    language: String,
    #[serde(default)]
    #[allow(dead_code)]
    model_version: String,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FluidSegment {
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    words: Vec<FluidWord>,
}

#[derive(Debug, Deserialize)]
struct FluidWord {
    start: f64,
    end: f64,
    text: String,
    confidence: Option<f32>,
}

/// FluidASR engine using subprocess for transcription
/// 
/// Uses transcription-fluid binary (Swift/CoreML) for Parakeet TDT v3 model.
/// Each transcription runs in isolated subprocess for stability.
pub struct FluidASREngine {
    binary_path: PathBuf,
    model_version: FluidModelVersion,
    pause_threshold: f64,
    language: Mutex<String>,
    hotwords: Mutex<Vec<String>>,
}

// Минимальное количество samples для FluidASR (1 секунда при 16kHz)
const MIN_SAMPLES_FOR_FLUID_ASR: usize = 16000;

impl FluidASREngine {
    /// Создать новый FluidASR engine
    pub fn new() -> Result<Self> {
        let binary_path = Self::find_binary_path()
            .context("transcription-fluid binary not found. Build it with: cd backend/audio/transcription && swift build -c release")?;

        tracing::info!("FluidASREngine: using binary at {:?}", binary_path);

        Ok(Self {
            binary_path,
            model_version: FluidModelVersion::V3,
            pause_threshold: 0.5,
            language: Mutex::new("multi".to_string()),
            hotwords: Mutex::new(Vec::new()),
        })
    }

    /// Создать engine с custom путём к binary
    pub fn with_binary_path(binary_path: PathBuf) -> Result<Self> {
        if !binary_path.exists() {
            anyhow::bail!(
                "transcription-fluid binary not found at {:?}",
                binary_path
            );
        }

        tracing::info!("FluidASREngine: using binary at {:?}", binary_path);

        Ok(Self {
            binary_path,
            model_version: FluidModelVersion::V3,
            pause_threshold: 0.5,
            language: Mutex::new("multi".to_string()),
            hotwords: Mutex::new(Vec::new()),
        })
    }

    /// Установить порог паузы для сегментации (в секундах)
    pub fn set_pause_threshold(&mut self, threshold: f64) {
        if threshold > 0.0 {
            self.pause_threshold = threshold;
            tracing::info!("FluidASREngine: pause threshold set to {:.2}s", threshold);
        }
    }

    /// Установить версию модели
    pub fn set_model_version(&mut self, version: FluidModelVersion) {
        self.model_version = version;
        tracing::info!(
            "FluidASREngine: model version set to {}",
            version.as_str()
        );
    }

    /// Найти binary в стандартных местах
    fn find_binary_path() -> Option<PathBuf> {
        let exe_path = std::env::current_exe().ok()?;
        let exe_dir = exe_path.parent()?;

        let candidates = [
            // Tauri resources (production macOS app bundle)
            exe_dir.join("../Resources/transcription-fluid"),
            // Tauri development resources
            exe_dir.join("resources/transcription-fluid"),
            // Рядом с executable (packaged app)
            exe_dir.join("transcription-fluid"),
            // rust/src-tauri/resources для разработки
            PathBuf::from("rust/src-tauri/resources/transcription-fluid"),
            // Development paths - Swift build directory
            PathBuf::from("backend/audio/transcription/.build/release/transcription-fluid"),
            PathBuf::from("../backend/audio/transcription/.build/release/transcription-fluid"),
            PathBuf::from("../../backend/audio/transcription/.build/release/transcription-fluid"),
            // Абсолютный путь для разработки (fallback)
            PathBuf::from(
                "/Users/askid/Projects/AIWisper/backend/audio/transcription/.build/release/transcription-fluid",
            ),
            PathBuf::from(
                "/Users/askid/Projects/AIWisper/rust/src-tauri/resources/transcription-fluid",
            ),
        ];

        for path in &candidates {
            if path.exists() {
                tracing::debug!("FluidASR: found binary at {:?}", path);
                return Some(path.canonicalize().unwrap_or_else(|_| path.clone()));
            }
        }

        tracing::warn!("FluidASR: transcription-fluid binary not found in any standard location");
        None
    }

    /// Конвертировать samples в bytes для stdin
    fn samples_to_bytes(samples: &[f32]) -> Vec<u8> {
        let mut buf = vec![0u8; samples.len() * 4];
        for (i, &sample) in samples.iter().enumerate() {
            let bytes = sample.to_le_bytes();
            buf[i * 4..i * 4 + 4].copy_from_slice(&bytes);
        }
        buf
    }
}

impl TranscriptionEngine for FluidASREngine {
    fn name(&self) -> &str {
        "fluid-asr"
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
            language: Some(self.language.lock().clone()),
            processing_time_ms: 0,
            rtf: 0.0,
        })
    }

    fn transcribe_with_segments(&self, samples: &[f32]) -> Result<Vec<TranscriptSegment>> {
        if samples.is_empty() {
            tracing::warn!("FluidASREngine: received 0 samples, returning empty result");
            return Ok(Vec::new());
        }

        tracing::info!(
            "FluidASREngine: transcribing {} samples ({:.2}s)",
            samples.len(),
            samples.len() as f64 / 16000.0
        );

        // Parakeet требует минимум 1 секунду аудио
        if samples.len() < MIN_SAMPLES_FOR_FLUID_ASR {
            tracing::warn!(
                "FluidASREngine: audio too short ({} samples = {:.2}s), minimum 1 second required",
                samples.len(),
                samples.len() as f64 / 16000.0
            );
            return Ok(Vec::new());
        }

        let start = Instant::now();

        // Подготавливаем аргументы
        let mut args = vec!["--samples".to_string()];
        args.push("--pause-threshold".to_string());
        args.push(format!("{:.3}", self.pause_threshold));
        args.push("--model".to_string());
        args.push(self.model_version.as_str().to_string());

        // Запускаем subprocess
        let mut child = Command::new(&self.binary_path)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to start transcription-fluid")?;

        // Пишем samples в stdin как binary float32
        let stdin = child.stdin.as_mut().context("Failed to get stdin")?;
        let bytes = Self::samples_to_bytes(samples);
        stdin.write_all(&bytes).context("Failed to write samples")?;
        drop(child.stdin.take()); // Закрываем stdin

        // Ждём результат
        let output = child.wait_with_output().context("Failed to wait for process")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::error!("FluidASREngine stderr: {}", stderr);
            anyhow::bail!("transcription-fluid failed: {}", stderr);
        }

        // Парсим JSON результат
        let result: FluidTranscriptionResult = serde_json::from_slice(&output.stdout)
            .context("Failed to parse transcription result")?;

        if let Some(error) = result.error {
            anyhow::bail!("Transcription error: {}", error);
        }

        // Конвертируем в наш формат
        let mut segments = Vec::with_capacity(result.segments.len());
        let mut unk_count = 0;

        for seg in result.segments {
            // Фильтруем <unk> токены и собираем слова
            let mut words = Vec::new();
            let mut filtered_text = Vec::new();

            for w in seg.words {
                // Пропускаем <unk> токены
                if w.text == "<unk>" || w.text == "[unk]" {
                    unk_count += 1;
                    continue;
                }

                words.push(TranscriptWord {
                    start: (w.start * 1000.0) as i64, // секунды -> мс
                    end: (w.end * 1000.0) as i64,
                    text: w.text.clone(),
                    confidence: w.confidence.unwrap_or(0.0),
                });
                filtered_text.push(w.text);
            }

            // Фильтруем <unk> из текста сегмента
            let seg_text = if seg.text.contains("<unk>") {
                if !filtered_text.is_empty() {
                    filtered_text.join(" ")
                } else {
                    seg.text.replace("<unk>", "").trim().to_string()
                }
            } else {
                seg.text
            };

            // Пропускаем пустые сегменты
            if seg_text.is_empty() && words.is_empty() {
                continue;
            }

            segments.push(TranscriptSegment {
                start: (seg.start * 1000.0) as i64,
                end: (seg.end * 1000.0) as i64,
                text: seg_text,
                speaker: None,
                words,
                confidence: 0.95, // Parakeet обычно высококачественный
            });
        }

        if unk_count > 0 {
            tracing::info!("FluidASREngine: filtered {} <unk> tokens", unk_count);
        }

        let elapsed = start.elapsed();
        let audio_duration = samples.len() as f64 / 16000.0;
        let rtf = audio_duration / elapsed.as_secs_f64();

        tracing::info!(
            "FluidASREngine: processed {:.1}s audio in {:.2}s (RTFx: {:.1}), {} segments, language={}",
            audio_duration,
            elapsed.as_secs_f64(),
            rtf,
            segments.len(),
            result.language
        );

        Ok(segments)
    }

    fn supported_languages(&self) -> &[&str] {
        match self.model_version {
            FluidModelVersion::V2 => &["en"],
            FluidModelVersion::V3 => &[
                "multi", "en", "de", "es", "fr", "it", "pt", "pl", "nl", "ru", "uk", "cs", "sk",
                "hr", "sl", "bg", "ro", "hu", "el", "lt", "lv", "et", "fi", "sv", "da", "no", "is",
            ],
        }
    }

    fn set_language(&mut self, language: &str) -> Result<()> {
        *self.language.lock() = language.to_string();
        tracing::info!(
            "FluidASREngine: language set to {} (note: Parakeet v3 auto-detects language)",
            language
        );
        Ok(())
    }

    fn set_hotwords(&mut self, hotwords: &[String]) -> Result<()> {
        *self.hotwords.lock() = hotwords.to_vec();
        // Parakeet TDT не поддерживает hotwords на уровне модели,
        // они применяются в пост-обработке гибридной транскрипции
        if !hotwords.is_empty() {
            tracing::info!(
                "FluidASREngine: hotwords will be applied as post-processing: {:?}",
                hotwords
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_binary_path() {
        // В тестовой среде binary может не быть, просто проверяем что не паникует
        let _ = FluidASREngine::find_binary_path();
    }

    #[test]
    fn test_samples_to_bytes() {
        let samples = [1.0f32, -1.0, 0.5, 0.0];
        let bytes = FluidASREngine::samples_to_bytes(&samples);
        assert_eq!(bytes.len(), 16); // 4 samples * 4 bytes each
    }
}
