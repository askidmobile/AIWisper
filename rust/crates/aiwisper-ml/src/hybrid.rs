//! Гибридная транскрипция с использованием двух моделей
//!
//! Реализует parallel mode с voting merge системой.
//! Поддерживает 4 критерия голосования:
//! - A: Калиброванный confidence (GigaAM завышает на ~25%)
//! - B: Детекция латиницы (иностранные термины)
//! - C: Совпадение с hotwords (fuzzy matching)
//! - D: Грамматическая проверка (опционально)

use crate::traits::TranscriptionEngine;
use aiwisper_types::{TranscriptSegment, TranscriptWord};
use anyhow::Result;
use std::sync::Arc;

/// Режим гибридной транскрипции (слияния результатов)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HybridMode {
    /// Параллельная транскрипция обеими моделями, пословное слияние через voting
    #[default]
    Parallel,
    /// Перетранскрибировать только слова с низким confidence
    Confidence,
    /// Legacy: был режим полного сравнения через LLM
    /// Теперь LLM вызывается независимо через use_llm_for_merge
    #[deprecated(note = "Use Parallel with use_llm_for_merge=true instead")]
    FullCompare,
}

/// Конфигурация калибровки confidence
#[derive(Debug, Clone)]
pub struct ConfidenceCalibration {
    /// Regexp паттерн имени модели
    pub model_pattern: String,
    /// Множитель (GigaAM: 0.75, Whisper: 1.0)
    pub scale_factor: f32,
    /// Сдвиг (обычно 0)
    pub bias: f32,
}

impl Default for ConfidenceCalibration {
    fn default() -> Self {
        Self {
            model_pattern: String::new(),
            scale_factor: 1.0,
            bias: 0.0,
        }
    }
}

/// Дефолтные калибровки для известных моделей
pub fn default_calibrations() -> Vec<ConfidenceCalibration> {
    vec![
        ConfidenceCalibration {
            model_pattern: "(?i)gigaam".to_string(),
            scale_factor: 0.75,
            bias: 0.0,
        },
        ConfidenceCalibration {
            model_pattern: "(?i)whisper".to_string(),
            scale_factor: 1.0,
            bias: 0.0,
        },
        ConfidenceCalibration {
            model_pattern: "(?i)parakeet".to_string(),
            scale_factor: 1.0,
            bias: 0.0,
        },
        ConfidenceCalibration {
            model_pattern: "(?i)fluid".to_string(),
            scale_factor: 1.0,
            bias: 0.0,
        },
    ]
}

/// Конфигурация системы голосования
#[derive(Debug, Clone)]
pub struct VotingConfig {
    /// Включена ли voting-система
    pub enabled: bool,
    /// Критерий A: калиброванный confidence
    pub use_calibration: bool,
    /// Критерий B: предпочитать латиницу
    pub use_latin_detection: bool,
    /// Критерий C: совпадение с hotwords
    pub use_hotwords: bool,
    /// Критерий D: грамматическая проверка
    pub use_grammar_check: bool,
    /// Коэффициенты калибровки по моделям
    pub calibrations: Vec<ConfidenceCalibration>,
}

impl Default for VotingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            use_calibration: true,
            use_latin_detection: true,
            use_hotwords: true,
            use_grammar_check: true,
            calibrations: default_calibrations(),
        }
    }
}

/// Конфигурация гибридной транскрипции
#[derive(Debug, Clone)]
pub struct HybridTranscriptionConfig {
    /// Включена ли гибридная транскрипция
    pub enabled: bool,
    /// ID дополнительной модели
    pub secondary_model_id: String,
    /// Порог уверенности (0.0 - 1.0)
    pub confidence_threshold: f32,
    /// Режим работы
    pub mode: HybridMode,
    /// Словарь подсказок
    pub hotwords: Vec<String>,
    /// Конфигурация voting-системы
    pub voting: VotingConfig,
    /// Использовать LLM для выбора лучшего варианта
    pub use_llm_for_merge: bool,
    /// Модель Ollama для LLM
    pub ollama_model: String,
    /// URL Ollama API
    pub ollama_url: String,
}

impl Default for HybridTranscriptionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            secondary_model_id: String::new(),
            confidence_threshold: 0.5,
            mode: HybridMode::Parallel,
            hotwords: Vec::new(),
            voting: VotingConfig::default(),
            use_llm_for_merge: false,
            ollama_model: String::new(),
            ollama_url: "http://localhost:11434".to_string(),
        }
    }
}

/// Результат голосования для одного слова
#[derive(Debug, Clone)]
pub struct VoteResult {
    /// Слово от первичной модели
    pub primary_word: TranscriptWord,
    /// Слово от вторичной модели  
    pub secondary_word: TranscriptWord,
    /// Победитель: "primary" или "secondary"
    pub winner: String,
    /// Детали голосования
    pub votes: VoteDetails,
    /// Человекочитаемое объяснение
    pub reason: String,
}

/// Детали голосования по каждому критерию
#[derive(Debug, Clone, Default)]
pub struct VoteDetails {
    /// Голос по калибровке: "primary" | "secondary" | "tie" | "abstain"
    pub calibration_vote: String,
    /// Голос по латинице
    pub latin_vote: String,
    /// Голос по hotwords
    pub hotword_vote: String,
    /// Голос по грамматике
    pub grammar_vote: String,
    /// Голос по качеству (артефакты, <unk>, мусор)
    pub quality_vote: String,
    /// Общее количество голосов за primary
    pub primary_votes: i32,
    /// Общее количество голосов за secondary
    pub secondary_votes: i32,
}

/// Улучшение транскрипции
#[derive(Debug, Clone)]
pub struct TranscriptionImprovement {
    /// Начало участка (мс)
    pub start_ms: i64,
    /// Конец участка (мс)
    pub end_ms: i64,
    /// Оригинальный текст
    pub original_text: String,
    /// Улучшенный текст
    pub improved_text: String,
    /// Оригинальный confidence
    pub original_conf: f32,
    /// Улучшенный confidence
    pub improved_conf: f32,
    /// Источник улучшения
    pub source: String,
}

/// Результат гибридной транскрипции
#[derive(Debug, Clone)]
pub struct HybridTranscriptionResult {
    /// Финальные сегменты
    pub segments: Vec<TranscriptSegment>,
    /// Количество слов с низкой уверенностью
    pub low_confidence_count: usize,
    /// Количество перетранскрибированных участков
    pub retranscribed_count: usize,
    /// Список улучшений
    pub improvements: Vec<TranscriptionImprovement>,
}

/// Выравнивание между словами двух моделей
#[derive(Debug, Clone)]
pub struct WordAlignment {
    /// Индекс слова в primary (-1 если gap)
    pub primary_idx: i32,
    /// Индекс слова в secondary (-1 если gap)
    pub secondary_idx: i32,
    /// Оценка выравнивания
    pub score: i32,
    /// Слова семантически похожи
    pub is_similar: bool,
}

/// Гибридный транскрибер
pub struct HybridTranscriber {
    primary_engine: Arc<dyn TranscriptionEngine>,
    secondary_engine: Option<Arc<dyn TranscriptionEngine>>,
    config: HybridTranscriptionConfig,
}

impl HybridTranscriber {
    /// Создать новый гибридный транскрибер
    pub fn new(
        primary: Arc<dyn TranscriptionEngine>,
        secondary: Option<Arc<dyn TranscriptionEngine>>,
        config: HybridTranscriptionConfig,
    ) -> Self {
        Self {
            primary_engine: primary,
            secondary_engine: secondary,
            config,
        }
    }

    /// Выполнить гибридную транскрипцию
    #[allow(deprecated)]
    pub fn transcribe(&self, samples: &[f32]) -> Result<HybridTranscriptionResult> {
        match self.config.mode {
            HybridMode::Parallel => self.transcribe_parallel(samples),
            HybridMode::Confidence => self.transcribe_confidence_based(samples),
            // FullCompare deprecated: делегирует в transcribe_parallel
            HybridMode::FullCompare => self.transcribe_parallel(samples),
        }
    }

    /// Параллельная транскрипция обеими моделями
    fn transcribe_parallel(&self, samples: &[f32]) -> Result<HybridTranscriptionResult> {
        let secondary = match &self.secondary_engine {
            Some(engine) => engine,
            None => {
                // Нет вторичной модели - просто транскрибируем первичной
                let segments = self.primary_engine.transcribe_with_segments(samples)?;
                return Ok(HybridTranscriptionResult {
                    segments,
                    low_confidence_count: 0,
                    retranscribed_count: 0,
                    improvements: vec![],
                });
            }
        };

        tracing::info!(
            "[HybridTranscriber] Parallel transcription: primary='{}', secondary='{}'",
            self.primary_engine.name(),
            secondary.name()
        );

        // Запускаем обе модели (в текущем потоке, т.к. они уже в spawn_blocking)
        let primary_result = self.primary_engine.transcribe_with_segments(samples);
        let secondary_result = secondary.transcribe_with_segments(samples);

        // Обрабатываем результаты
        let primary_segments = match primary_result {
            Ok(segs) if !segs.is_empty() => segs,
            Ok(_) => {
                tracing::warn!("[HybridTranscriber] Primary returned empty");
                match secondary_result {
                    Ok(segs) if !segs.is_empty() => {
                        return Ok(HybridTranscriptionResult {
                            segments: segs,
                            low_confidence_count: 0,
                            retranscribed_count: 0,
                            improvements: vec![],
                        });
                    }
                    _ => {
                        return Ok(HybridTranscriptionResult {
                            segments: vec![],
                            low_confidence_count: 0,
                            retranscribed_count: 0,
                            improvements: vec![],
                        });
                    }
                }
            }
            Err(e) => {
                tracing::error!("[HybridTranscriber] Primary failed: {}", e);
                match secondary_result {
                    Ok(segs) => {
                        return Ok(HybridTranscriptionResult {
                            segments: segs,
                            low_confidence_count: 0,
                            retranscribed_count: 0,
                            improvements: vec![],
                        });
                    }
                    Err(e2) => {
                        anyhow::bail!("Both models failed: primary: {}, secondary: {}", e, e2);
                    }
                }
            }
        };

        let secondary_segments = match secondary_result {
            Ok(segs) => segs,
            Err(e) => {
                tracing::warn!("[HybridTranscriber] Secondary failed: {}, using primary", e);
                return Ok(HybridTranscriptionResult {
                    segments: primary_segments,
                    low_confidence_count: 0,
                    retranscribed_count: 0,
                    improvements: vec![],
                });
            }
        };

        if secondary_segments.is_empty() {
            return Ok(HybridTranscriptionResult {
                segments: primary_segments,
                low_confidence_count: 0,
                retranscribed_count: 0,
                improvements: vec![],
            });
        }

        // Сравниваем тексты
        let primary_text = segments_to_full_text(&primary_segments);
        let secondary_text = segments_to_full_text(&secondary_segments);

        tracing::debug!("[HybridTranscriber] Primary text: {:?}", primary_text);
        tracing::debug!("[HybridTranscriber] Secondary text: {:?}", secondary_text);

        // Если тексты идентичны - возвращаем первичный
        if primary_text == secondary_text {
            tracing::info!("[HybridTranscriber] Texts identical, using primary");
            return Ok(HybridTranscriptionResult {
                segments: primary_segments,
                low_confidence_count: 0,
                retranscribed_count: 0,
                improvements: vec![],
            });
        }

        // Объединяем на основе confidence
        let (merged_segments, improvements) =
            self.merge_by_confidence(&primary_segments, &secondary_segments);

        // Применяем hotwords если есть
        let final_segments = if !self.config.hotwords.is_empty() {
            self.apply_hotwords(&merged_segments, &primary_segments, &secondary_segments)
        } else {
            merged_segments
        };

        Ok(HybridTranscriptionResult {
            segments: final_segments,
            low_confidence_count: 0,
            retranscribed_count: improvements.len(),
            improvements,
        })
    }

    /// Объединение по confidence с Needleman-Wunsch alignment
    fn merge_by_confidence(
        &self,
        primary: &[TranscriptSegment],
        secondary: &[TranscriptSegment],
    ) -> (Vec<TranscriptSegment>, Vec<TranscriptionImprovement>) {
        let mut improvements = Vec::new();

        // Извлекаем слова
        let primary_words = extract_words_with_confidence(primary);
        let secondary_words = extract_words_with_confidence(secondary);

        if primary_words.is_empty() {
            return (secondary.to_vec(), improvements);
        }
        if secondary_words.is_empty() {
            return (primary.to_vec(), improvements);
        }

        // Выравниваем слова
        let alignment = align_words_needleman_wunsch(&primary_words, &secondary_words);

        tracing::debug!(
            "[HybridTranscriber] MergeByConfidence: {} primary words, {} secondary words, {} alignments",
            primary_words.len(),
            secondary_words.len(),
            alignment.len()
        );

        // Создаём карту замен
        let mut replacements: std::collections::HashMap<usize, TranscriptWord> =
            std::collections::HashMap::new();

        for align in &alignment {
            if align.primary_idx < 0 || align.secondary_idx < 0 {
                continue;
            }

            let pi = align.primary_idx as usize;
            let si = align.secondary_idx as usize;

            let pw = &primary_words[pi];
            let sw = &secondary_words[si];

            let pw_lower = pw.text.to_lowercase();

            // Проверяем <unk> токены
            let has_unk = pw_lower.contains("<unk>") || pw_lower.contains("[unk]");
            let sw_lower = sw.text.to_lowercase();
            let secondary_has_unk = sw_lower.contains("<unk>") || sw_lower.contains("[unk]");

            if has_unk && !secondary_has_unk && !sw.text.is_empty() {
                // Заменяем <unk> на слово от secondary
                replacements.insert(pi, sw.clone());
                tracing::debug!(
                    "[HybridTranscriber] <unk> replacement: '{}' -> '{}'",
                    pw.text,
                    sw.text
                );
                continue;
            }

            // Если слова похожи, используем voting
            if align.is_similar {
                if self.config.voting.enabled {
                    let vote_result = self.select_best_word_by_voting(pw, sw);
                    if vote_result.winner == "secondary" {
                        replacements.insert(pi, sw.clone());
                        tracing::debug!(
                            "[HybridTranscriber] Voting: '{}' -> '{}' - {}",
                            pw.text,
                            sw.text,
                            vote_result.reason
                        );
                    }
                } else {
                    // Простое сравнение confidence
                    if sw.confidence > pw.confidence && sw.confidence > 0.0 {
                        replacements.insert(pi, sw.clone());
                    }
                }
            }
        }

        if replacements.is_empty() {
            return (primary.to_vec(), improvements);
        }

        // Применяем замены к сегментам
        let mut result = Vec::with_capacity(primary.len());
        let mut global_word_idx = 0usize;

        for seg in primary {
            let mut new_seg = seg.clone();
            let mut new_words = Vec::with_capacity(seg.words.len());
            let mut new_text_parts = Vec::with_capacity(seg.words.len());

            for pw in &seg.words {
                let best_word = if let Some(replacement) = replacements.get(&global_word_idx) {
                    TranscriptWord {
                        start: pw.start,
                        end: pw.end,
                        text: replacement.text.clone(),
                        confidence: replacement.confidence,
                    }
                } else {
                    pw.clone()
                };

                new_text_parts.push(best_word.text.clone());
                new_words.push(best_word);
                global_word_idx += 1;
            }

            new_seg.words = new_words;
            new_seg.text = join_words(&new_text_parts);
            result.push(new_seg);
        }

        // Проверяем были ли улучшения
        let merged_text = segments_to_full_text(&result);
        let primary_text = segments_to_full_text(primary);

        if merged_text != primary_text {
            improvements.push(TranscriptionImprovement {
                start_ms: 0,
                end_ms: 0,
                original_text: primary_text,
                improved_text: merged_text,
                original_conf: 0.0,
                improved_conf: 0.0,
                source: "parallel_word_merge".to_string(),
            });
        }

        (result, improvements)
    }

    /// Voting система для выбора лучшего слова
    fn select_best_word_by_voting(
        &self,
        primary: &TranscriptWord,
        secondary: &TranscriptWord,
    ) -> VoteResult {
        let mut votes = VoteDetails::default();
        let voting_config = &self.config.voting;

        // Критерий 0: Проверка качества (артефакты, <unk>, мусорные слова)
        // Этот критерий имеет приоритет над остальными
        let secondary_quality = assess_word_quality(&secondary.text);
        let primary_quality = assess_word_quality(&primary.text);

        if secondary_quality.has_critical_issues && !primary_quality.has_critical_issues {
            // Secondary имеет критические проблемы - безусловно выбираем primary
            votes.quality_vote = "primary".to_string();
            votes.primary_votes += 2; // Даём двойной вес критическим проблемам
        } else if primary_quality.has_critical_issues && !secondary_quality.has_critical_issues {
            votes.quality_vote = "secondary".to_string();
            votes.secondary_votes += 2;
        } else if secondary_quality.penalty > primary_quality.penalty {
            votes.quality_vote = "primary".to_string();
            votes.primary_votes += 1;
        } else if primary_quality.penalty > secondary_quality.penalty {
            votes.quality_vote = "secondary".to_string();
            votes.secondary_votes += 1;
        } else {
            votes.quality_vote = "tie".to_string();
        }

        // Критерий A: Калиброванный confidence
        if voting_config.use_calibration {
            let primary_factor =
                get_calibration_factor(self.primary_engine.name(), &voting_config.calibrations);
            let secondary_factor = self
                .secondary_engine
                .as_ref()
                .map(|e| get_calibration_factor(e.name(), &voting_config.calibrations))
                .unwrap_or(1.0);

            let primary_calibrated = primary.confidence * primary_factor;
            let secondary_calibrated = secondary.confidence * secondary_factor;

            if primary_calibrated > secondary_calibrated + 0.01 {
                votes.calibration_vote = "primary".to_string();
                votes.primary_votes += 1;
            } else if secondary_calibrated > primary_calibrated + 0.01 {
                votes.calibration_vote = "secondary".to_string();
                votes.secondary_votes += 1;
            } else {
                votes.calibration_vote = "tie".to_string();
            }
        }

        // Критерий B: Латиница
        if voting_config.use_latin_detection {
            let primary_has_latin = contains_latin(&primary.text);
            let secondary_has_latin = contains_latin(&secondary.text);

            if secondary_has_latin && !primary_has_latin {
                votes.latin_vote = "secondary".to_string();
                votes.secondary_votes += 1;
            } else if primary_has_latin && !secondary_has_latin {
                votes.latin_vote = "primary".to_string();
                votes.primary_votes += 1;
            } else {
                votes.latin_vote = "abstain".to_string();
            }
        }

        // Критерий C: Hotwords
        if voting_config.use_hotwords && !self.config.hotwords.is_empty() {
            let (primary_matches, _) = matches_hotword(&primary.text, &self.config.hotwords);
            let (secondary_matches, _) = matches_hotword(&secondary.text, &self.config.hotwords);

            if secondary_matches && !primary_matches {
                votes.hotword_vote = "secondary".to_string();
                votes.secondary_votes += 1;
            } else if primary_matches && !secondary_matches {
                votes.hotword_vote = "primary".to_string();
                votes.primary_votes += 1;
            } else {
                votes.hotword_vote = "abstain".to_string();
            }
        }

        // Определяем победителя
        let (winner, reason) = if votes.secondary_votes > votes.primary_votes {
            (
                "secondary".to_string(),
                format!(
                    "Secondary wins {}:{} (qual={} cal={} lat={} hw={})",
                    votes.secondary_votes,
                    votes.primary_votes,
                    votes.quality_vote,
                    votes.calibration_vote,
                    votes.latin_vote,
                    votes.hotword_vote
                ),
            )
        } else {
            (
                "primary".to_string(),
                format!(
                    "Primary wins {}:{} (qual={} cal={} lat={} hw={})",
                    votes.primary_votes,
                    votes.secondary_votes,
                    votes.quality_vote,
                    votes.calibration_vote,
                    votes.latin_vote,
                    votes.hotword_vote
                ),
            )
        };

        VoteResult {
            primary_word: primary.clone(),
            secondary_word: secondary.clone(),
            winner,
            votes,
            reason,
        }
    }

    /// Применить hotwords для исправления слов
    fn apply_hotwords(
        &self,
        merged: &[TranscriptSegment],
        _primary: &[TranscriptSegment],
        _secondary: &[TranscriptSegment],
    ) -> Vec<TranscriptSegment> {
        if self.config.hotwords.is_empty() {
            return merged.to_vec();
        }

        // Собираем замены
        let mut replacements: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        for seg in merged {
            for word in &seg.words {
                let (matches, hotword) = matches_hotword(&word.text, &self.config.hotwords);
                if matches {
                    let word_lower = word.text.to_lowercase();
                    if word_lower != hotword.to_lowercase() {
                        replacements.insert(word_lower, hotword.clone());
                    }
                }
            }
        }

        if replacements.is_empty() {
            return merged.to_vec();
        }

        // Применяем замены
        let mut result = Vec::with_capacity(merged.len());
        for seg in merged {
            let mut new_seg = seg.clone();

            // Заменяем в тексте
            let mut new_text = seg.text.clone();
            for (from, to) in &replacements {
                new_text = replace_word_ignore_case(&new_text, from, to);
            }
            new_seg.text = new_text;

            // Заменяем в словах
            let new_words: Vec<TranscriptWord> = seg
                .words
                .iter()
                .map(|w| {
                    let word_lower = w.text.to_lowercase();
                    if let Some(replacement) = replacements.get(&word_lower) {
                        TranscriptWord {
                            text: replacement.clone(),
                            ..w.clone()
                        }
                    } else {
                        w.clone()
                    }
                })
                .collect();
            new_seg.words = new_words;

            result.push(new_seg);
        }

        result
    }

    /// Транскрипция на основе confidence (fallback mode)
    fn transcribe_confidence_based(&self, samples: &[f32]) -> Result<HybridTranscriptionResult> {
        // Упрощённая реализация - просто используем primary
        let segments = self.primary_engine.transcribe_with_segments(samples)?;
        Ok(HybridTranscriptionResult {
            segments,
            low_confidence_count: 0,
            retranscribed_count: 0,
            improvements: vec![],
        })
    }

    /// Асинхронная транскрипция с поддержкой LLM
    pub async fn transcribe_async(&self, samples: &[f32]) -> Result<HybridTranscriptionResult> {
        // Если LLM не включен - используем синхронную версию
        if !self.config.use_llm_for_merge {
            return self.transcribe(samples);
        }

        // LLM включен - сначала делаем обычное слияние, потом улучшаем через LLM
        self.transcribe_with_llm_enhancement(samples).await
    }

    /// Транскрипция с LLM-улучшением после стандартного слияния
    /// 
    /// 1. Сначала выполняем обычную транскрипцию (parallel или confidence)
    /// 2. Затем отправляем результат в LLM для улучшения
    async fn transcribe_with_llm_enhancement(&self, samples: &[f32]) -> Result<HybridTranscriptionResult> {
        // Шаг 1: Выполняем стандартное слияние
        let mut result = self.transcribe(samples)?;
        
        // Если нет сегментов - нечего улучшать
        if result.segments.is_empty() {
            return Ok(result);
        }
        
        // Проверяем настройки LLM
        if self.config.ollama_model.is_empty() {
            tracing::warn!("[HybridTranscriber] LLM enabled but no Ollama model specified, skipping enhancement");
            return Ok(result);
        }
        
        // Получаем текст для улучшения
        let merged_text = segments_to_full_text(&result.segments);
        
        if merged_text.trim().is_empty() {
            return Ok(result);
        }
        
        tracing::info!(
            "[HybridTranscriber] Enhancing with LLM: model={}, text_len={}",
            self.config.ollama_model,
            merged_text.len()
        );
        
        // Шаг 2: Вызываем LLM для улучшения
        let llm_selector = match crate::llm::LLMSelector::with_model_url(
            &self.config.ollama_model,
            &self.config.ollama_url,
        ) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("[HybridTranscriber] Failed to create LLM selector: {}", e);
                return Ok(result);
            }
        };
        
        // Вызываем LLM для улучшения текста
        let enhanced_text = match llm_selector.enhance_transcription(&merged_text).await {
            Ok(text) => text,
            Err(e) => {
                tracing::error!("[HybridTranscriber] LLM enhancement failed: {}", e);
                return Ok(result);
            }
        };
        
        // Проверяем, изменился ли текст
        if enhanced_text.trim() == merged_text.trim() {
            tracing::debug!("[HybridTranscriber] LLM returned same text, no enhancement");
            return Ok(result);
        }
        
        tracing::info!(
            "[HybridTranscriber] LLM enhanced: {} chars -> {} chars",
            merged_text.len(),
            enhanced_text.len()
        );
        
        // Обновляем сегменты с улучшенным текстом
        // Если один сегмент - просто заменяем текст
        // Если несколько - обновляем первый (простая стратегия)
        if result.segments.len() == 1 {
            result.segments[0].text = enhanced_text.clone();
        } else {
            // Для нескольких сегментов пытаемся сопоставить по словам
            // Пока простая стратегия - обновляем текст первого сегмента
            result.segments[0].text = enhanced_text.clone();
        }
        
        // Добавляем информацию об улучшении
        result.improvements.push(TranscriptionImprovement {
            start_ms: 0,
            end_ms: 0,
            original_text: merged_text,
            improved_text: enhanced_text,
            original_conf: 0.0,
            improved_conf: 0.0,
            source: "llm_enhancement".to_string(),
        });
        result.retranscribed_count = result.improvements.len();
        
        Ok(result)
    }

    /// Транскрипция с использованием LLM для выбора лучшего варианта (legacy)
    #[allow(dead_code)]
    async fn transcribe_with_llm(&self, samples: &[f32]) -> Result<HybridTranscriptionResult> {
        let secondary = match &self.secondary_engine {
            Some(engine) => engine,
            None => {
                // Нет вторичной модели
                let segments = self.primary_engine.transcribe_with_segments(samples)?;
                return Ok(HybridTranscriptionResult {
                    segments,
                    low_confidence_count: 0,
                    retranscribed_count: 0,
                    improvements: vec![],
                });
            }
        };

        // Транскрибируем обеими моделями
        let primary_result = self.primary_engine.transcribe_with_segments(samples);
        let secondary_result = secondary.transcribe_with_segments(samples);

        let primary_segments = match primary_result {
            Ok(segs) if !segs.is_empty() => segs,
            Ok(_) => {
                // Primary пустой, пробуем secondary
                match secondary_result {
                    Ok(segs) if !segs.is_empty() => {
                        return Ok(HybridTranscriptionResult {
                            segments: segs,
                            low_confidence_count: 0,
                            retranscribed_count: 0,
                            improvements: vec![],
                        });
                    }
                    _ => {
                        return Ok(HybridTranscriptionResult {
                            segments: vec![],
                            low_confidence_count: 0,
                            retranscribed_count: 0,
                            improvements: vec![],
                        });
                    }
                }
            }
            Err(e) => {
                tracing::error!("[HybridTranscriber] Primary failed: {}", e);
                match secondary_result {
                    Ok(segs) => {
                        return Ok(HybridTranscriptionResult {
                            segments: segs,
                            low_confidence_count: 0,
                            retranscribed_count: 0,
                            improvements: vec![],
                        });
                    }
                    Err(e2) => {
                        anyhow::bail!("Both models failed: primary: {}, secondary: {}", e, e2);
                    }
                }
            }
        };

        let secondary_segments = match secondary_result {
            Ok(segs) => segs,
            Err(e) => {
                tracing::warn!("[HybridTranscriber] Secondary failed: {}, using primary", e);
                return Ok(HybridTranscriptionResult {
                    segments: primary_segments,
                    low_confidence_count: 0,
                    retranscribed_count: 0,
                    improvements: vec![],
                });
            }
        };

        if secondary_segments.is_empty() {
            return Ok(HybridTranscriptionResult {
                segments: primary_segments,
                low_confidence_count: 0,
                retranscribed_count: 0,
                improvements: vec![],
            });
        }

        // Получаем тексты
        let primary_text = segments_to_full_text(&primary_segments);
        let secondary_text = segments_to_full_text(&secondary_segments);

        tracing::info!(
            "[HybridTranscriber] LLM mode: primary='{}' ({} chars), secondary='{}' ({} chars)",
            self.primary_engine.name(),
            primary_text.len(),
            secondary.name(),
            secondary_text.len()
        );

        // Если тексты идентичны - LLM не нужен
        if primary_text == secondary_text {
            tracing::info!("[HybridTranscriber] Texts identical, skipping LLM");
            return Ok(HybridTranscriptionResult {
                segments: primary_segments,
                low_confidence_count: 0,
                retranscribed_count: 0,
                improvements: vec![],
            });
        }

        // Вызываем LLM для выбора лучшего варианта
        if self.config.ollama_model.is_empty() {
            tracing::warn!("[HybridTranscriber] No Ollama model specified, using parallel merge");
            return self.transcribe_parallel(samples);
        }

        let llm_selector = match crate::llm::LLMSelector::with_model_url(
            &self.config.ollama_model,
            &self.config.ollama_url,
        ) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("[HybridTranscriber] Failed to create LLM selector: {}", e);
                return self.transcribe_parallel(samples);
            }
        };

        tracing::info!(
            "[HybridTranscriber] Calling LLM: model={}, url={}",
            self.config.ollama_model,
            self.config.ollama_url
        );

        // Вызываем LLM
        let selected_text = match llm_selector
            .select_best_transcription(&primary_text, &secondary_text, "")
            .await
        {
            Ok(text) => text,
            Err(e) => {
                tracing::error!("[HybridTranscriber] LLM selection failed: {}", e);
                // Fallback к parallel merge
                return self.transcribe_parallel(samples);
            }
        };

        // Определяем какой результат ближе к выбранному LLM
        let primary_sim = text_similarity_jaccard(&selected_text, &primary_text);
        let secondary_sim = text_similarity_jaccard(&selected_text, &secondary_text);

        tracing::info!(
            "[HybridTranscriber] LLM selected: primary_sim={:.2}, secondary_sim={:.2}",
            primary_sim,
            secondary_sim
        );

        let mut improvements = Vec::new();

        // Выбираем базовые сегменты и обновляем текст
        let final_segments = if secondary_sim > primary_sim {
            // LLM выбрал вариант ближе к secondary
            tracing::info!("[HybridTranscriber] Using secondary segments with LLM text");
            improvements.push(TranscriptionImprovement {
                start_ms: 0,
                end_ms: 0,
                original_text: primary_text.clone(),
                improved_text: selected_text.clone(),
                original_conf: 0.0,
                improved_conf: 0.0,
                source: "llm_full_compare".to_string(),
            });

            // Используем secondary сегменты, но с текстом от LLM
            let mut segs = secondary_segments;
            if segs.len() == 1 {
                segs[0].text = selected_text;
            }
            segs
        } else {
            // LLM выбрал вариант ближе к primary или смешанный
            if selected_text != primary_text {
                improvements.push(TranscriptionImprovement {
                    start_ms: 0,
                    end_ms: 0,
                    original_text: primary_text.clone(),
                    improved_text: selected_text.clone(),
                    original_conf: 0.0,
                    improved_conf: 0.0,
                    source: "llm_full_compare".to_string(),
                });
            }

            let mut segs = primary_segments;
            if segs.len() == 1 {
                segs[0].text = selected_text;
            }
            segs
        };

        Ok(HybridTranscriptionResult {
            segments: final_segments,
            low_confidence_count: 0,
            retranscribed_count: improvements.len(),
            improvements,
        })
    }
}

/// Jaccard similarity между текстами
fn text_similarity_jaccard(a: &str, b: &str) -> f64 {
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();
    let words_a: std::collections::HashSet<&str> = a_lower.split_whitespace().collect();
    let words_b: std::collections::HashSet<&str> = b_lower.split_whitespace().collect();

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

// ============================================================================
// Вспомогательные функции
// ============================================================================

/// Объединить текст из всех сегментов
fn segments_to_full_text(segments: &[TranscriptSegment]) -> String {
    segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Извлечь все слова из сегментов
fn extract_words_with_confidence(segments: &[TranscriptSegment]) -> Vec<TranscriptWord> {
    let mut words = Vec::new();
    for seg in segments {
        words.extend(seg.words.clone());
    }
    words
}

/// Выровнять слова алгоритмом Needleman-Wunsch
fn align_words_needleman_wunsch(
    primary: &[TranscriptWord],
    secondary: &[TranscriptWord],
) -> Vec<WordAlignment> {
    let n = primary.len();
    let m = secondary.len();

    if n == 0 || m == 0 {
        return vec![];
    }

    const MATCH_SCORE: i32 = 2;
    const SIMILAR_SCORE: i32 = 1;
    const MISMATCH_SCORE: i32 = -1;
    const GAP_PENALTY: i32 = -1;

    // Функция сравнения слов
    let compare_words = |w1: &TranscriptWord, w2: &TranscriptWord| -> (i32, bool) {
        let norm1 = normalize_word_for_comparison(&w1.text);
        let norm2 = normalize_word_for_comparison(&w2.text);

        if norm1 == norm2 {
            return (MATCH_SCORE, true);
        }
        if are_words_similar(&w1.text, &w2.text) {
            return (SIMILAR_SCORE, true);
        }
        (MISMATCH_SCORE, false)
    };

    // Создаём матрицу scoring
    let mut score = vec![vec![0i32; m + 1]; n + 1];

    // Инициализация
    for i in 0..=n {
        score[i][0] = i as i32 * GAP_PENALTY;
    }
    for j in 0..=m {
        score[0][j] = j as i32 * GAP_PENALTY;
    }

    // Заполняем матрицу
    for i in 1..=n {
        for j in 1..=m {
            let (match_val, _) = compare_words(&primary[i - 1], &secondary[j - 1]);

            let diag = score[i - 1][j - 1] + match_val;
            let up = score[i - 1][j] + GAP_PENALTY;
            let left = score[i][j - 1] + GAP_PENALTY;

            score[i][j] = diag.max(up).max(left);
        }
    }

    // Traceback
    let mut alignment = Vec::new();
    let mut i = n;
    let mut j = m;

    while i > 0 || j > 0 {
        if i > 0 && j > 0 {
            let (match_val, is_similar) = compare_words(&primary[i - 1], &secondary[j - 1]);
            if score[i][j] == score[i - 1][j - 1] + match_val {
                alignment.push(WordAlignment {
                    primary_idx: (i - 1) as i32,
                    secondary_idx: (j - 1) as i32,
                    score: match_val,
                    is_similar,
                });
                i -= 1;
                j -= 1;
                continue;
            }
        }

        if i > 0 && score[i][j] == score[i - 1][j] + GAP_PENALTY {
            alignment.push(WordAlignment {
                primary_idx: (i - 1) as i32,
                secondary_idx: -1,
                score: GAP_PENALTY,
                is_similar: false,
            });
            i -= 1;
        } else if j > 0 {
            alignment.push(WordAlignment {
                primary_idx: -1,
                secondary_idx: (j - 1) as i32,
                score: GAP_PENALTY,
                is_similar: false,
            });
            j -= 1;
        }
    }

    // Разворачиваем
    alignment.reverse();
    alignment
}

/// Нормализовать слово для сравнения
fn normalize_word_for_comparison(word: &str) -> String {
    word.trim()
        .to_lowercase()
        .trim_matches(|c: char| c.is_ascii_punctuation())
        .to_string()
}

/// Проверить похожесть слов
fn are_words_similar(word1: &str, word2: &str) -> bool {
    let norm1 = normalize_word_for_comparison(word1);
    let norm2 = normalize_word_for_comparison(word2);

    if norm1 == norm2 {
        return true;
    }

    if norm1.is_empty() || norm2.is_empty() {
        return false;
    }

    let len1 = norm1.chars().count();
    let len2 = norm2.chars().count();
    let max_len = len1.max(len2);
    let min_len = len1.min(len2);

    // Если длины сильно отличаются - не похожи
    if max_len > min_len * 2 {
        return false;
    }

    // Проверяем содержание
    if min_len >= 4 && (norm1.contains(&norm2) || norm2.contains(&norm1)) {
        return true;
    }

    // Расстояние Левенштейна
    let dist = levenshtein_distance(&norm1, &norm2);
    let max_dist = max_len * 30 / 100;
    let max_dist = max_dist.max(1);

    dist <= max_dist
}

/// Расстояние Левенштейна
fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    let r1: Vec<char> = s1.chars().collect();
    let r2: Vec<char> = s2.chars().collect();

    if r1.is_empty() {
        return r2.len();
    }
    if r2.is_empty() {
        return r1.len();
    }

    let mut matrix = vec![vec![0usize; r2.len() + 1]; r1.len() + 1];

    for (i, row) in matrix.iter_mut().enumerate() {
        row[0] = i;
    }
    for j in 0..=r2.len() {
        matrix[0][j] = j;
    }

    for i in 1..=r1.len() {
        for j in 1..=r2.len() {
            let cost = if r1[i - 1] == r2[j - 1] { 0 } else { 1 };
            matrix[i][j] = (matrix[i - 1][j] + 1)
                .min(matrix[i][j - 1] + 1)
                .min(matrix[i - 1][j - 1] + cost);
        }
    }

    matrix[r1.len()][r2.len()]
}

/// Проверить наличие латинских букв
fn contains_latin(word: &str) -> bool {
    word.chars().any(|c| c.is_ascii_alphabetic())
}

/// Получить коэффициент калибровки для модели
fn get_calibration_factor(model_name: &str, calibrations: &[ConfidenceCalibration]) -> f32 {
    for cal in calibrations {
        if let Ok(re) = regex::Regex::new(&cal.model_pattern) {
            if re.is_match(model_name) {
                return cal.scale_factor;
            }
        }
    }
    1.0
}

/// Проверить совпадение с hotword
fn matches_hotword(word: &str, hotwords: &[String]) -> (bool, String) {
    let word_norm = normalize_word_for_comparison(word);
    if word_norm.is_empty() || word_norm.chars().count() < 4 {
        return (false, String::new());
    }

    for hw in hotwords {
        let hw_norm = normalize_word_for_comparison(hw);
        if hw_norm.is_empty() || hw_norm.chars().count() < 4 {
            continue;
        }

        // Точное совпадение
        if word_norm == hw_norm {
            return (true, hw.clone());
        }

        // Fuzzy matching
        let word_len = word_norm.chars().count();
        let hw_len = hw_norm.chars().count();

        let len_diff = (hw_len as i32 - word_len as i32).unsigned_abs() as usize;
        if len_diff > hw_len * 30 / 100 {
            continue;
        }

        let dist = levenshtein_distance(&word_norm, &hw_norm);
        let max_dist = (hw_len * 15 / 100).max(1).min(2);

        if dist <= max_dist && dist > 0 {
            let max_len = word_len.max(hw_len);
            let similarity = 1.0 - (dist as f64 / max_len as f64);
            if similarity >= 0.75 {
                return (true, hw.clone());
            }
        }
    }

    (false, String::new())
}

/// Объединить слова в текст
fn join_words(words: &[String]) -> String {
    if words.is_empty() {
        return String::new();
    }

    let mut result = words[0].clone();
    for w in &words[1..] {
        if !w.is_empty()
            && (w.starts_with('.')
                || w.starts_with(',')
                || w.starts_with('!')
                || w.starts_with('?')
                || w.starts_with(':')
                || w.starts_with(';'))
        {
            result.push_str(w);
        } else {
            result.push(' ');
            result.push_str(w);
        }
    }
    result
}

/// Результат оценки качества слова
struct WordQualityAssessment {
    /// Есть критические проблемы (нужно дисквалифицировать это конкретное слово)
    has_critical_issues: bool,
    /// Штраф качества (0 = отлично, >0 = есть проблемы)
    penalty: i32,
}

/// Оценить качество слова на наличие артефактов
/// 
/// ВАЖНО: Эта функция оценивает только конкретное слово, а не всю транскрипцию.
/// Если слово содержит <unk>, это дисквалифицирует только это слово,
/// но не влияет на другие слова от той же модели.
fn assess_word_quality(word: &str) -> WordQualityAssessment {
    let mut penalty = 0i32;
    let mut has_critical_issues = false;
    let word_lower = word.to_lowercase();
    let word_clean = word_lower.trim();

    // Критические проблемы (дисквалификация конкретного слова)

    // 1. <unk> токены - явный признак неуверенности модели в этом слове
    if word_clean.contains("<unk>") || word_clean.contains("[unk]") {
        has_critical_issues = true;
        penalty += 100;
    }

    // 2. Пустое слово
    if word_clean.is_empty() {
        has_critical_issues = true;
        penalty += 100;
    }

    WordQualityAssessment {
        has_critical_issues,
        penalty,
    }
}

/// Заменить слово без учёта регистра
fn replace_word_ignore_case(text: &str, from: &str, to: &str) -> String {
    let text_lower = text.to_lowercase();
    let from_lower = from.to_lowercase();

    let mut result = text.to_string();
    let mut search_start = 0;

    while let Some(pos) = text_lower[search_start..].find(&from_lower) {
        let abs_pos = search_start + pos;

        // Проверяем границы слова
        let is_word_start = abs_pos == 0
            || !result
                .chars()
                .nth(abs_pos - 1)
                .map(|c| c.is_alphabetic())
                .unwrap_or(false);
        let end_pos = abs_pos + from.len();
        let is_word_end = end_pos >= result.len()
            || !result
                .chars()
                .nth(end_pos)
                .map(|c| c.is_alphabetic())
                .unwrap_or(false);

        if is_word_start && is_word_end {
            result = format!("{}{}{}", &result[..abs_pos], to, &result[end_pos..]);
            search_start = abs_pos + to.len();
        } else {
            search_start = abs_pos + 1;
        }

        if search_start >= result.len() {
            break;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_levenshtein_distance() {
        assert_eq!(levenshtein_distance("kitten", "sitting"), 3);
        assert_eq!(levenshtein_distance("hello", "hello"), 0);
        assert_eq!(levenshtein_distance("", "abc"), 3);
    }

    #[test]
    fn test_are_words_similar() {
        assert!(are_words_similar("hello", "Hello"));
        assert!(are_words_similar("hello", "helo")); // 1 edit
        assert!(!are_words_similar("hello", "world"));
    }

    #[test]
    fn test_contains_latin() {
        assert!(contains_latin("hello"));
        assert!(contains_latin("API"));
        assert!(!contains_latin("привет"));
    }

    #[test]
    fn test_word_quality_unk_tokens() {
        // <unk> дисквалифицирует только это конкретное слово
        let q = assess_word_quality("да<unk>т");
        assert!(q.has_critical_issues);
        assert!(q.penalty >= 100);

        let q = assess_word_quality("[unk]");
        assert!(q.has_critical_issues);
    }

    #[test]
    fn test_word_quality_normal_words() {
        // Обычные слова - без штрафов
        let q = assess_word_quality("калькулятор");
        assert!(!q.has_critical_issues);
        assert_eq!(q.penalty, 0);

        let q = assess_word_quality("дома");
        assert_eq!(q.penalty, 0);

        // Междометия - это валидные слова, без штрафов
        let q = assess_word_quality("Привет");
        assert!(!q.has_critical_issues);
        assert_eq!(q.penalty, 0);

        let q = assess_word_quality("Ммм");
        assert!(!q.has_critical_issues);
        assert_eq!(q.penalty, 0);

        let q = assess_word_quality("А?");
        assert!(!q.has_critical_issues);
        assert_eq!(q.penalty, 0);
    }

    #[test]
    fn test_word_quality_empty() {
        let q = assess_word_quality("");
        assert!(q.has_critical_issues);
    }
}
