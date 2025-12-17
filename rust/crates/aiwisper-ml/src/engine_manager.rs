//! Engine Manager - управление движками транскрипции
//!
//! Позволяет переключаться между Whisper и GigaAM,
//! а также создавать дополнительные движки для гибридной транскрипции.

use crate::traits::TranscriptionEngine;
use crate::{FluidASREngine, GigaAMEngine, WhisperEngine};
use anyhow::{Context, Result};
use parking_lot::{Mutex, RwLock};
use std::path::PathBuf;

/// Тип движка транскрипции
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineType {
    /// OpenAI Whisper (ggml models)
    Whisper,
    /// Sber GigaAM (ONNX models)
    GigaAM,
    /// FluidAudio/Parakeet (CoreML, macOS only)
    FluidASR,
}

impl EngineType {
    /// Определить тип по ID модели
    pub fn from_model_id(model_id: &str) -> Self {
        if model_id.starts_with("gigaam") {
            EngineType::GigaAM
        } else if model_id.starts_with("parakeet") || model_id.contains("fluid") {
            EngineType::FluidASR
        } else {
            EngineType::Whisper
        }
    }
}

/// Менеджер движков транскрипции
pub struct EngineManager {
    /// Директория с моделями
    models_dir: PathBuf,
    /// Активный движок
    active_engine: RwLock<Option<Box<dyn TranscriptionEngine>>>,
    /// Текущий язык для активного движка
    active_language: Mutex<String>,
    /// ID активной модели
    active_model_id: RwLock<String>,
}

impl EngineManager {
    /// Создать новый менеджер движков
    pub fn new(models_dir: PathBuf) -> Self {
        Self {
            models_dir,
            active_engine: RwLock::new(None),
            active_model_id: RwLock::new(String::new()),
            active_language: Mutex::new("auto".to_string()),
        }
    }

    /// Получить директорию моделей
    pub fn models_dir(&self) -> &PathBuf {
        &self.models_dir
    }

    /// Получить ID активной модели
    pub fn get_active_model_id(&self) -> String {
        self.active_model_id.read().clone()
    }

    /// Установить активную модель и создать движок
    pub fn set_active_model(&self, model_id: &str) -> Result<()> {
        // Если уже активна эта модель - ничего не делаем
        {
            let current = self.active_model_id.read();
            let has_engine = self.active_engine.read().is_some();
            if *current == model_id && has_engine {
                return Ok(());
            }
        }

        // Создаём новый движок
        let mut engine = self.create_engine_for_model(model_id)?;

        // Применяем текущий язык
        let lang = self.active_language.lock().clone();
        if !lang.is_empty() {
            if let Err(e) = engine.set_language(&lang) {
                tracing::warn!("EngineManager: failed to set language {}: {}", lang, e);
            }
        }

        // Устанавливаем как активный
        *self.active_engine.write() = Some(engine);
        *self.active_model_id.write() = model_id.to_string();

        tracing::info!("EngineManager: switched to model {}", model_id);

        Ok(())
    }

    /// Создать движок для модели (без установки как активный)
    /// Используется для гибридной транскрипции (вторичная модель)
    pub fn create_engine_for_model(&self, model_id: &str) -> Result<Box<dyn TranscriptionEngine>> {
        let engine_type = EngineType::from_model_id(model_id);

        match engine_type {
            EngineType::Whisper => {
                let model_path = self.get_model_path(model_id)?;
                let engine = WhisperEngine::new(model_path.to_str().unwrap())?;
                tracing::info!("EngineManager: created Whisper engine for {}", model_id);
                Ok(Box::new(engine))
            }

            EngineType::GigaAM => {
                let model_path = self.get_model_path(model_id)?;
                let vocab_path = self.get_vocab_path(model_id)?;
                let engine =
                    GigaAMEngine::new(model_path.to_str().unwrap(), vocab_path.to_str().unwrap())?;
                tracing::info!("EngineManager: created GigaAM engine for {}", model_id);
                Ok(Box::new(engine))
            }

            EngineType::FluidASR => {
                // FluidASR использует subprocess для вызова Swift/CoreML binary
                let engine = FluidASREngine::new()
                    .context("Failed to create FluidASR engine")?;
                tracing::info!("EngineManager: created FluidASR engine for {}", model_id);
                Ok(Box::new(engine))
            }
        }
    }

    /// Получить путь к файлу модели
    fn get_model_path(&self, model_id: &str) -> Result<PathBuf> {
        let engine_type = EngineType::from_model_id(model_id);

        let file_name = match engine_type {
            EngineType::Whisper => format!("{}.bin", model_id),
            EngineType::GigaAM => {
                // GigaAM модели имеют специфичные имена файлов
                if model_id.contains("e2e") {
                    "v3_e2e_ctc.int8.onnx".to_string()
                } else {
                    "v3_ctc.int8.onnx".to_string()
                }
            }
            EngineType::FluidASR => {
                // FluidAudio управляет моделями сам
                return Ok(self.models_dir.clone());
            }
        };

        let path = self.models_dir.join(&file_name);

        if !path.exists() {
            anyhow::bail!("Model file not found: {:?}", path);
        }

        Ok(path)
    }

    /// Получить путь к vocab файлу (для GigaAM)
    fn get_vocab_path(&self, model_id: &str) -> Result<PathBuf> {
        // Пробуем разные варианты имён vocab файлов
        let vocab_candidates = if model_id.contains("e2e") {
            vec![
                "gigaam-v3-e2e-ctc_vocab.txt",
                "v3_e2e_ctc_vocab.txt",
            ]
        } else {
            vec![
                "gigaam-v3-ctc_vocab.txt",
                "v3_vocab.txt",
                "v3_ctc_vocab.txt",
            ]
        };

        for vocab_name in &vocab_candidates {
            let path = self.models_dir.join(vocab_name);
            if path.exists() {
                return Ok(path);
            }
        }

        anyhow::bail!("Vocab file not found. Tried: {:?}", vocab_candidates)
    }

    /// Транскрибировать через активный движок
    pub fn transcribe(&self, samples: &[f32]) -> Result<String> {
        let engine = self.active_engine.read();
        let engine = engine.as_ref().context("No active engine")?;

        let result = engine.transcribe(samples)?;
        Ok(result.text)
    }

    /// Транскрибировать с сегментами через активный движок
    pub fn transcribe_with_segments(
        &self,
        samples: &[f32],
    ) -> Result<Vec<aiwisper_types::TranscriptSegment>> {
        let engine = self.active_engine.read();
        let engine = engine.as_ref().context("No active engine")?;

        engine.transcribe_with_segments(samples)
    }

    /// Установить язык для активного движка
    pub fn set_language(&self, language: &str) -> Result<()> {
        {
            let mut lang_guard = self.active_language.lock();
            *lang_guard = language.to_string();
        }

        if let Some(engine) = self.active_engine.write().as_mut() {
            if let Err(e) = engine.set_language(language) {
                tracing::warn!(
                    "EngineManager: failed to set language on active engine: {}",
                    e
                );
            }
        }

        tracing::info!("EngineManager: language set to {}", language);
        Ok(())
    }

    /// Проверить, активен ли GigaAM
    pub fn is_gigaam_active(&self) -> bool {
        let model_id = self.active_model_id.read();
        model_id.starts_with("gigaam")
    }

    /// Проверить, активен ли Whisper
    pub fn is_whisper_active(&self) -> bool {
        let model_id = self.active_model_id.read();
        model_id.starts_with("ggml")
    }

    /// Закрыть активный движок
    pub fn close(&self) {
        *self.active_engine.write() = None;
        *self.active_model_id.write() = String::new();
        tracing::info!("EngineManager: closed active engine");
    }

    /// Получить информацию о движке
    pub fn get_engine_info(&self) -> serde_json::Value {
        let model_id = self.active_model_id.read();
        let has_engine = self.active_engine.read().is_some();

        let mut info = serde_json::json!({
            "activeModelId": *model_id,
            "hasEngine": has_engine,
        });

        if let Some(engine) = self.active_engine.read().as_ref() {
            info["engineName"] = serde_json::json!(engine.name());
            info["supportedLanguages"] = serde_json::json!(engine.supported_languages());
        }

        info
    }
}

/// Получить рекомендуемую модель для языка
pub fn get_recommended_model_for_language(language: &str) -> &'static str {
    match language {
        "ru" => "gigaam-v3-e2e-ctc",
        _ => "ggml-large-v3-turbo",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_type_from_model_id() {
        assert_eq!(
            EngineType::from_model_id("ggml-large-v3-turbo"),
            EngineType::Whisper
        );
        assert_eq!(EngineType::from_model_id("ggml-base"), EngineType::Whisper);
        assert_eq!(
            EngineType::from_model_id("gigaam-v3-ctc"),
            EngineType::GigaAM
        );
        assert_eq!(
            EngineType::from_model_id("gigaam-v3-e2e-ctc"),
            EngineType::GigaAM
        );
        assert_eq!(
            EngineType::from_model_id("parakeet-tdt-v3"),
            EngineType::FluidASR
        );
    }

    #[test]
    fn test_recommended_model() {
        assert_eq!(
            get_recommended_model_for_language("ru"),
            "gigaam-v3-e2e-ctc"
        );
        assert_eq!(
            get_recommended_model_for_language("en"),
            "ggml-large-v3-turbo"
        );
    }
}
