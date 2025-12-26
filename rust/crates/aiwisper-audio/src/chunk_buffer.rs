//! Chunk buffer with VAD for automatic audio segmentation
//!
//! Накапливает аудио и нарезает на chunk'и:
//! - В режиме VAD: ищет паузы в речи (1+ сек тишины)
//! - В режиме Off: фиксированные интервалы (30 сек)
//!
//! Основан на Go реализации из backend/session/chunk_buffer.go

use std::sync::mpsc;
use std::time::{Duration, Instant};

/// VAD режим определения пауз
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VadMode {
    /// Автоматическое определение пауз (по RMS)
    #[default]
    Auto,
    /// Фиксированные интервалы (для системного звука)
    Off,
}

/// Конфигурация VAD
#[derive(Debug, Clone)]
pub struct VadConfig {
    /// Режим VAD
    pub mode: VadMode,
    /// Задержка перед началом нарезки (первые N сек не режем)
    pub chunking_start_delay: Duration,
    /// Минимальная длина chunk'а
    pub min_chunk_duration: Duration,
    /// Максимальная длина chunk'а (принудительный разрез)
    pub max_chunk_duration: Duration,
    /// Длительность тишины для разреза
    pub silence_duration: Duration,
    /// Порог тишины (RMS ниже этого = тишина)
    pub silence_threshold: f32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            mode: VadMode::Auto,
            chunking_start_delay: Duration::from_secs(60), // 60 сек перед началом нарезки
            min_chunk_duration: Duration::from_secs(30),   // минимум 30 сек
            max_chunk_duration: Duration::from_secs(300),  // максимум 5 мин
            silence_duration: Duration::from_secs(1),      // 1 сек тишины
            silence_threshold: 0.02,                       // RMS порог
        }
    }
}

impl VadConfig {
    /// Конфигурация для фиксированных интервалов (системный звук)
    pub fn fixed_interval() -> Self {
        Self {
            mode: VadMode::Off,
            chunking_start_delay: Duration::from_secs(5), // ✅ Было 60, стало 5
            min_chunk_duration: Duration::from_secs(10),   // ✅ Было 30, стало 10
            max_chunk_duration: Duration::from_secs(15),   // ✅ Было 30, стало 15
            silence_duration: Duration::from_secs(1),
            silence_threshold: 0.02,
        }
    }
}

/// Событие готовности chunk'а
#[derive(Debug, Clone)]
pub struct ChunkEvent {
    /// Начало chunk'а в миллисекундах (от начала записи)
    pub start_ms: i64,
    /// Конец chunk'а в миллисекундах
    pub end_ms: i64,
    /// Длительность
    pub duration: Duration,
    /// Индекс chunk'а
    pub index: usize,
}

/// Буфер для VAD и нарезки на chunk'и
pub struct ChunkBuffer {
    config: VadConfig,
    sample_rate: u32,

    /// Накопленные семплы (микс для моно или mic для стерео)
    accumulated: Vec<f32>,

    /// Раздельные каналы (если есть)
    mic_accumulated: Vec<f32>,
    sys_accumulated: Vec<f32>,
    has_separate_channels: bool,

    /// Счётчики
    total_samples: i64,
    emitted_samples: i64,
    chunk_count: usize,

    /// Время начала записи
    start_time: Instant,

    /// Можно ли начинать нарезку
    chunking_enabled: bool,

    /// Канал для отправки событий
    output_tx: mpsc::Sender<ChunkEvent>,
    output_rx: mpsc::Receiver<ChunkEvent>,
}

impl ChunkBuffer {
    /// Создать новый буфер
    pub fn new(config: VadConfig, sample_rate: u32) -> Self {
        let (tx, rx) = mpsc::channel();

        // Буфер на 10 минут
        let capacity = sample_rate as usize * 600;

        Self {
            config,
            sample_rate,
            accumulated: Vec::with_capacity(capacity),
            mic_accumulated: Vec::with_capacity(capacity),
            sys_accumulated: Vec::with_capacity(capacity),
            has_separate_channels: false,
            total_samples: 0,
            emitted_samples: 0,
            chunk_count: 0,
            start_time: Instant::now(),
            chunking_enabled: false,
            output_tx: tx,
            output_rx: rx,
        }
    }

    /// Обработать моно семплы
    pub fn process(&mut self, samples: &[f32]) {
        self.accumulated.extend_from_slice(samples);
        self.total_samples += samples.len() as i64;

        // Проверяем задержку начала нарезки
        if !self.chunking_enabled {
            if self.start_time.elapsed() >= self.config.chunking_start_delay {
                self.chunking_enabled = true;
                tracing::info!(
                    "ChunkBuffer: Chunking enabled after {:?}",
                    self.start_time.elapsed()
                );
            } else {
                return;
            }
        }

        self.try_emit_chunk();
    }

    /// Обработать стерео семплы (раздельные каналы)
    pub fn process_stereo(&mut self, mic_samples: &[f32], sys_samples: &[f32]) {
        let min_len = mic_samples.len().min(sys_samples.len());
        if min_len == 0 {
            return;
        }

        self.has_separate_channels = true;

        // Накапливаем раздельные каналы
        self.mic_accumulated
            .extend_from_slice(&mic_samples[..min_len]);
        self.sys_accumulated
            .extend_from_slice(&sys_samples[..min_len]);

        // Создаём микс для VAD
        let mut mix = vec![0.0f32; min_len];
        for i in 0..min_len {
            mix[i] = (mic_samples[i] + sys_samples[i]) / 2.0;
        }

        self.process(&mix);
    }

    /// Попытка выпустить chunk
    fn try_emit_chunk(&mut self) {
        let min_chunk_samples =
            (self.config.min_chunk_duration.as_secs_f64() * self.sample_rate as f64) as i64;
        let max_chunk_samples =
            (self.config.max_chunk_duration.as_secs_f64() * self.sample_rate as f64) as i64;
        let fixed_chunk_samples = min_chunk_samples; // Для VadMode::Off

        let available_samples = self.accumulated.len() as i64 - self.emitted_samples;

        // Определяем точку разреза
        let split_point: i64;

        match self.config.mode {
            VadMode::Off => {
                // Фиксированные интервалы
                if available_samples < fixed_chunk_samples {
                    return;
                }
                split_point = self.emitted_samples + fixed_chunk_samples;
            }
            VadMode::Auto => {
                // VAD режим: ищем паузу после минимальной длины
                let search_start = self.emitted_samples + min_chunk_samples;
                let search_end =
                    (self.accumulated.len() as i64).min(self.emitted_samples + max_chunk_samples);

                if search_start >= search_end {
                    return;
                }

                if let Some(gap) = self.find_silence_gap(search_start, search_end) {
                    split_point = gap;
                } else if available_samples >= max_chunk_samples {
                    // Принудительный разрез при достижении максимума
                    split_point = self.emitted_samples + max_chunk_samples;
                    tracing::warn!(
                        "ChunkBuffer: Forced split at max duration ({}s)",
                        self.config.max_chunk_duration.as_secs()
                    );
                } else {
                    // Паузы нет, ждём ещё
                    return;
                }
            }
        }

        // Вычисляем таймстемпы
        let start_ms = self.emitted_samples * 1000 / self.sample_rate as i64;
        let end_ms = split_point * 1000 / self.sample_rate as i64;
        let duration = Duration::from_millis((end_ms - start_ms) as u64);

        let event = ChunkEvent {
            start_ms,
            end_ms,
            duration,
            index: self.chunk_count,
        };

        tracing::info!(
            "ChunkBuffer: Emitting chunk {} ({} - {} ms, {:?})",
            self.chunk_count,
            start_ms,
            end_ms,
            duration
        );

        self.chunk_count += 1;
        self.emitted_samples = split_point;

        // Отправляем событие
        let _ = self.output_tx.send(event);
    }

    /// Найти паузу (тишину) в указанном диапазоне
    fn find_silence_gap(&self, start_pos: i64, end_pos: i64) -> Option<i64> {
        let silence_samples =
            (self.config.silence_duration.as_secs_f64() * self.sample_rate as f64) as i64;
        let window_size = (self.sample_rate / 10) as i64; // 100ms окно

        let mut consecutive_silent = 0i64;
        let mut silence_start = -1i64;

        let mut pos = start_pos;
        while pos < end_pos - window_size {
            let end = (pos + window_size).min(self.accumulated.len() as i64);
            let window = &self.accumulated[pos as usize..end as usize];

            let rms = calculate_rms(window);

            if rms < self.config.silence_threshold {
                if consecutive_silent == 0 {
                    silence_start = pos;
                }
                consecutive_silent += window_size;

                // Нашли паузу нужной длительности
                if consecutive_silent >= silence_samples {
                    // Возвращаем середину паузы
                    return Some(silence_start + consecutive_silent / 2);
                }
            } else {
                consecutive_silent = 0;
                silence_start = -1;
            }

            pos += window_size;
        }

        None
    }

    /// Получить канал для получения событий
    pub fn events(&self) -> &mpsc::Receiver<ChunkEvent> {
        &self.output_rx
    }

    /// Попробовать получить событие (non-blocking)
    pub fn try_recv(&self) -> Option<ChunkEvent> {
        self.output_rx.try_recv().ok()
    }

    /// Flush все оставшиеся данные как один chunk
    pub fn flush_all(&mut self) -> Option<ChunkEvent> {
        let available = self.accumulated.len() as i64 - self.emitted_samples;

        // Минимум 1 секунда для flush
        let min_flush_samples = self.sample_rate as i64;

        if available < min_flush_samples {
            return None;
        }

        let start_ms = self.emitted_samples * 1000 / self.sample_rate as i64;
        let end_ms = self.accumulated.len() as i64 * 1000 / self.sample_rate as i64;
        let duration = Duration::from_millis((end_ms - start_ms) as u64);

        let event = ChunkEvent {
            start_ms,
            end_ms,
            duration,
            index: self.chunk_count,
        };

        tracing::info!(
            "ChunkBuffer: Flushing final chunk {} ({} - {} ms, {:?})",
            self.chunk_count,
            start_ms,
            end_ms,
            duration
        );

        self.chunk_count += 1;
        self.emitted_samples = self.accumulated.len() as i64;

        Some(event)
    }

    /// Получить количество выпущенных chunk'ов
    pub fn chunk_count(&self) -> usize {
        self.chunk_count
    }

    /// Получить аудио семплы для указанного диапазона времени
    /// Возвращает семплы из accumulated буфера
    pub fn get_samples_range(&self, start_ms: i64, end_ms: i64) -> Vec<f32> {
        let start_sample = (start_ms * self.sample_rate as i64 / 1000) as usize;
        let end_sample = (end_ms * self.sample_rate as i64 / 1000) as usize;

        let start = start_sample.min(self.accumulated.len());
        let end = end_sample.min(self.accumulated.len());

        if start >= end {
            return Vec::new();
        }

        self.accumulated[start..end].to_vec()
    }

    /// Получить все накопленные семплы (для финальной транскрипции)
    pub fn get_all_samples(&self) -> &[f32] {
        &self.accumulated
    }

    /// Получить sample rate
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Получить общую длительность в миллисекундах
    pub fn total_duration_ms(&self) -> i64 {
        self.total_samples * 1000 / self.sample_rate as i64
    }

    /// Проверить, есть ли раздельные каналы (стерео режим)
    pub fn has_separate_channels(&self) -> bool {
        self.has_separate_channels
    }

    /// Получить mic samples для указанного диапазона (только для стерео режима)
    pub fn get_mic_samples_range(&self, start_ms: i64, end_ms: i64) -> Vec<f32> {
        if !self.has_separate_channels {
            return Vec::new();
        }

        let start_sample = (start_ms * self.sample_rate as i64 / 1000) as usize;
        let end_sample = (end_ms * self.sample_rate as i64 / 1000) as usize;

        let start = start_sample.min(self.mic_accumulated.len());
        let end = end_sample.min(self.mic_accumulated.len());

        if start >= end {
            return Vec::new();
        }

        self.mic_accumulated[start..end].to_vec()
    }

    /// Получить sys samples для указанного диапазона (только для стерео режима)
    pub fn get_sys_samples_range(&self, start_ms: i64, end_ms: i64) -> Vec<f32> {
        if !self.has_separate_channels {
            return Vec::new();
        }

        let start_sample = (start_ms * self.sample_rate as i64 / 1000) as usize;
        let end_sample = (end_ms * self.sample_rate as i64 / 1000) as usize;

        let start = start_sample.min(self.sys_accumulated.len());
        let end = end_sample.min(self.sys_accumulated.len());

        if start >= end {
            return Vec::new();
        }

        self.sys_accumulated[start..end].to_vec()
    }

    /// Сбросить буфер
    pub fn clear(&mut self) {
        self.accumulated.clear();
        self.mic_accumulated.clear();
        self.sys_accumulated.clear();
        self.total_samples = 0;
        self.emitted_samples = 0;
        self.chunk_count = 0;
        self.chunking_enabled = false;
        self.start_time = Instant::now();
    }

    /// Удалить обработанные семплы до указанной позиции
    ///
    /// Вызывается после успешной транскрипции чанка для освобождения памяти.
    /// Это критически важно для длительных записей, чтобы буферы не росли бесконечно.
    ///
    /// # Arguments
    /// * `up_to_ms` - Временная метка в миллисекундах до которой удалить семплы
    ///
    /// # Note
    /// После вызова все временные метки в буфере остаются корректными,
    /// так как мы обновляем внутренние счётчики.
    pub fn drain_processed_samples(&mut self, up_to_ms: i64) {
        // Конвертируем миллисекунды в количество семплов
        let drain_samples = (up_to_ms * self.sample_rate as i64 / 1000) as usize;

        // Проверяем что есть что удалять
        if drain_samples == 0 {
            return;
        }

        // Удаляем из основного буфера
        let actual_drain = drain_samples.min(self.accumulated.len());
        if actual_drain > 0 {
            self.accumulated.drain(0..actual_drain);
        }

        // Удаляем из раздельных каналов если есть
        if self.has_separate_channels {
            let mic_drain = drain_samples.min(self.mic_accumulated.len());
            if mic_drain > 0 {
                self.mic_accumulated.drain(0..mic_drain);
            }

            let sys_drain = drain_samples.min(self.sys_accumulated.len());
            if sys_drain > 0 {
                self.sys_accumulated.drain(0..sys_drain);
            }
        }

        // Корректируем счётчики
        // emitted_samples - это позиция в ОРИГИНАЛЬНОМ буфере откуда мы уже выпустили чанки
        // После drain нужно сдвинуть на количество удалённых семплов
        let drain_i64 = actual_drain as i64;
        self.emitted_samples = (self.emitted_samples - drain_i64).max(0);
        self.total_samples = (self.total_samples - drain_i64).max(0);

        tracing::info!(
            "ChunkBuffer: drained {} samples (up to {} ms), remaining accumulated={}, mic={}, sys={}",
            actual_drain,
            up_to_ms,
            self.accumulated.len(),
            self.mic_accumulated.len(),
            self.sys_accumulated.len()
        );
    }

    /// Получить текущий размер буферов в байтах (для мониторинга памяти)
    pub fn memory_usage_bytes(&self) -> usize {
        let f32_size = std::mem::size_of::<f32>();
        (self.accumulated.capacity() + 
         self.mic_accumulated.capacity() + 
         self.sys_accumulated.capacity()) * f32_size
    }
}

/// Вычислить RMS (Root Mean Square) для определения громкости
fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    (sum_squares / samples.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_rms() {
        let silence = vec![0.0f32; 100];
        assert!(calculate_rms(&silence) < 0.001);

        let loud = vec![0.5f32; 100];
        assert!(calculate_rms(&loud) > 0.4);
    }

    #[test]
    fn test_chunk_buffer_basic() {
        let config = VadConfig {
            chunking_start_delay: Duration::from_millis(0), // No delay for test
            min_chunk_duration: Duration::from_secs(1),
            max_chunk_duration: Duration::from_secs(2),
            ..Default::default()
        };

        let mut buffer = ChunkBuffer::new(config, 16000);

        // Feed 3 seconds of silence
        let silence = vec![0.01f32; 16000 * 3];
        buffer.process(&silence);

        // Should have emitted at least one chunk
        assert!(buffer.chunk_count() >= 1);
    }
}
