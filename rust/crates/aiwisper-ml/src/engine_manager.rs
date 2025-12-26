//! Engine Manager - управление движками транскрипции
//!
//! Позволяет переключаться между Whisper и GigaAM,
//! а также создавать дополнительные движки для гибридной транскрипции.
//!
//! ## Глобальный кэш движков
//!
//! Для избежания многократной загрузки тяжёлых моделей (GigaAM, CoreML),
//! используйте `get_or_create_engine_cached()` вместо `create_engine_arc()`.
//! Кэш хранит движки по ключу `(model_id, language)`.

use crate::traits::TranscriptionEngine;
use crate::{FluidASREngine, GigaAMEngine, WhisperEngine};
use anyhow::{Context, Result};
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

/// Глобальный кэш движков транскрипции
/// Ключ: (model_id, language)
static ENGINE_CACHE: OnceLock<RwLock<HashMap<String, Arc<dyn TranscriptionEngine>>>> = OnceLock::new();

fn get_engine_cache() -> &'static RwLock<HashMap<String, Arc<dyn TranscriptionEngine>>> {
    ENGINE_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

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

    /// Создать движок для модели с установкой языка (возвращает Arc)
    /// 
    /// Это основной метод для использования в транскрипции.
    /// Поддерживает fallback на default модель при неизвестном типе.
    pub fn create_engine_arc(&self, model_id: &str, language: &str) -> Result<Arc<dyn TranscriptionEngine>> {
        let engine_type = EngineType::from_model_id(model_id);
        
        let mut engine: Box<dyn TranscriptionEngine> = match engine_type {
            EngineType::FluidASR => {
                tracing::info!("Creating FluidASR engine for model: {}", model_id);
                let engine = FluidASREngine::new()?;
                Box::new(engine)
            }
            EngineType::GigaAM => {
                let model_path = self.get_model_path(model_id)?;
                let vocab_path = self.get_vocab_path(model_id)?;
                let engine = GigaAMEngine::new(
                    model_path.to_str().unwrap(),
                    vocab_path.to_str().unwrap(),
                )?;
                tracing::info!("Created GigaAM engine for model: {}", model_id);
                Box::new(engine)
            }
            EngineType::Whisper => {
                match self.get_model_path(model_id) {
                    Ok(model_path) => {
                        let engine = WhisperEngine::new(model_path.to_str().unwrap())?;
                        tracing::info!("Created Whisper engine for model: {}", model_id);
                        Box::new(engine)
                    }
                    Err(_) => {
                        // Fallback на default модель
                        tracing::warn!(
                            "Unknown model type '{}', falling back to Whisper large-v3-turbo",
                            model_id
                        );
                        let default_path = self.models_dir.join("ggml-large-v3-turbo.bin");
                        if !default_path.exists() {
                            anyhow::bail!("Default Whisper model not found");
                        }
                        let engine = WhisperEngine::new(default_path.to_str().unwrap())?;
                        Box::new(engine)
                    }
                }
            }
        };
        
        // Установить язык если указан
        if !language.is_empty() && language != "auto" {
            if let Err(e) = engine.set_language(language) {
                tracing::warn!("Failed to set language '{}' on engine: {}", language, e);
            }
        }
        
        Ok(Arc::from(engine))
    }

    /// Получить путь к файлу модели
    fn get_model_path(&self, model_id: &str) -> Result<PathBuf> {
        let engine_type = EngineType::from_model_id(model_id);

        match engine_type {
            EngineType::Whisper => {
                let model_file = format!("{}.bin", model_id);
                let path = self.models_dir.join(&model_file);
                if path.exists() {
                    return Ok(path);
                }
                anyhow::bail!("Whisper model not found: {}", model_file)
            }
            EngineType::GigaAM => {
                // Пробуем разные варианты имён модели
                let model_candidates: &[&str] = if model_id.contains("e2e") {
                    &["gigaam-v3-e2e-ctc.onnx", "v3_e2e_ctc.int8.onnx", "gigaam-v3-e2e-ctc.int8.onnx"]
                } else {
                    &["gigaam-v3-ctc.onnx", "v3_ctc.int8.onnx", "gigaam-v3-ctc.int8.onnx"]
                };
                
                for candidate in model_candidates {
                    let path = self.models_dir.join(candidate);
                    if path.exists() {
                        return Ok(path);
                    }
                }
                anyhow::bail!("GigaAM model not found. Tried: {:?}", model_candidates)
            }
            EngineType::FluidASR => {
                // FluidAudio управляет моделями сам
                Ok(self.models_dir.clone())
            }
        }
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

/// Получить движок из глобального кэша или создать новый
///
/// Эта функция гарантирует, что для каждой пары (model_id, language)
/// движок создаётся только один раз. Это критично для тяжёлых моделей
/// типа GigaAM/CoreML, которые долго загружаются.
///
/// # Аргументы
/// * `model_id` - ID модели (например, "gigaam-v3-e2e-ctc")
/// * `language` - Язык (например, "ru" или "auto")
///
/// # Пример
/// ```ignore
/// let engine = get_or_create_engine_cached("gigaam-v3-e2e-ctc", "ru")?;
/// let segments = engine.transcribe_with_segments(&samples)?;
/// ```
pub fn get_or_create_engine_cached(model_id: &str, language: &str) -> Result<Arc<dyn TranscriptionEngine>> {
    // Формируем ключ кэша
    // Для GigaAM язык не влияет на движок (только русский), поэтому используем фиксированный ключ
    let cache_key = if model_id.starts_with("gigaam") {
        model_id.to_string()
    } else {
        format!("{}:{}", model_id, language)
    };
    
    // Пробуем получить из кэша (быстрый путь с read lock)
    {
        let cache = get_engine_cache().read();
        if let Some(engine) = cache.get(&cache_key) {
            tracing::debug!("Engine cache hit for: {}", cache_key);
            return Ok(Arc::clone(engine));
        }
    }
    
    // Не нашли в кэше - создаём новый движок (медленный путь с write lock)
    let mut cache = get_engine_cache().write();
    
    // Double-check после получения write lock (другой поток мог создать)
    if let Some(engine) = cache.get(&cache_key) {
        tracing::debug!("Engine cache hit (after write lock) for: {}", cache_key);
        return Ok(Arc::clone(engine));
    }
    
    tracing::info!("Creating new engine for cache: {}", cache_key);
    
    // Получаем директорию моделей
    let models_dir = dirs::data_local_dir()
        .map(|p| p.join("aiwisper").join("models"))
        .ok_or_else(|| anyhow::anyhow!("Models directory not found"))?;
    
    let manager = EngineManager::new(models_dir);
    let engine = manager.create_engine_arc(model_id, language)?;
    
    // Сохраняем в кэш
    cache.insert(cache_key.clone(), Arc::clone(&engine));
    tracing::info!("Engine cached: {}", cache_key);
    
    Ok(engine)
}

/// Очистить глобальный кэш движков
///
/// Полезно при смене настроек или для освобождения памяти.
pub fn clear_engine_cache() {
    let mut cache = get_engine_cache().write();
    let count = cache.len();
    cache.clear();
    tracing::info!("Engine cache cleared: {} engines removed", count);
}

/// Получить информацию о кэше движков
pub fn get_engine_cache_info() -> Vec<String> {
    let cache = get_engine_cache().read();
    cache.keys().cloned().collect()
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
