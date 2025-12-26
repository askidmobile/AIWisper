//! Audio capture using cpal
//!
//! # Sliding Window Buffer
//! Буфер ограничен `MAX_BUFFER_DURATION_SECS` секундами для предотвращения
//! бесконечного роста памяти при длительных записях.

use aiwisper_types::AudioDevice;
use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Максимальная длительность буфера в секундах (sliding window)
/// 30 секунд достаточно для:
/// - Расчёта уровня звука (последние ~30ms)
/// - Синхронизации между потоками
/// При sample_rate 48kHz: 48000 * 30 * 4 = ~5.5 МБ
const MAX_BUFFER_DURATION_SECS: u64 = 30;

/// Audio capture from input device
///
/// Использует sliding window buffer для ограничения потребления памяти.
/// Буфер хранит только последние `MAX_BUFFER_DURATION_SECS` секунд аудио.
pub struct AudioCapture {
    device: cpal::Device,
    config: cpal::StreamConfig,
    stream: Option<cpal::Stream>,
    buffer: Arc<Mutex<Vec<f32>>>,
    /// Максимальный размер буфера в семплах
    max_buffer_samples: usize,
    /// Общее количество семплов обработанных с начала записи
    /// (включая удалённые из буфера)
    total_samples_processed: Arc<AtomicU64>,
}

impl AudioCapture {
    /// Create new audio capture
    pub fn new(device_name: Option<&str>) -> Result<Self> {
        let host = cpal::default_host();
        
        // Log all available devices for debugging
        match host.input_devices() {
            Ok(devices) => {
                tracing::info!("Available audio input devices:");
                for d in devices {
                    if let Ok(n) = d.name() {
                        tracing::info!(" - {}", n);
                    }
                }
            }
            Err(e) => tracing::error!("Failed to enumerate input devices: {}", e),
        }

        let device = if let Some(name) = device_name {
            host.input_devices()?
                .find(|d| d.name().map(|n| n == name).unwrap_or(false))
                .context("Device not found")?
        } else {
            host.default_input_device()
                .context("No default input device")?
        };

        let config = device.default_input_config()?;

        let sample_rate = config.sample_rate().0;
        let max_buffer_samples = (sample_rate as u64 * MAX_BUFFER_DURATION_SECS) as usize;

        tracing::info!(
            "Audio capture: {} @ {}Hz, {} channels, max_buffer={}s ({} samples)",
            device.name().unwrap_or_default(),
            sample_rate,
            config.channels(),
            MAX_BUFFER_DURATION_SECS,
            max_buffer_samples
        );

        Ok(Self {
            device,
            config: config.into(),
            stream: None,
            buffer: Arc::new(Mutex::new(Vec::with_capacity(max_buffer_samples))),
            max_buffer_samples,
            total_samples_processed: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Start capturing audio
    pub fn start(&mut self) -> Result<()> {
        if self.stream.is_some() {
            return Ok(());
        }

        let buffer = self.buffer.clone();
        let channels = self.config.channels as usize;
        let sample_rate = self.config.sample_rate.0;
        let max_samples = self.max_buffer_samples;
        let total_processed = self.total_samples_processed.clone();

        tracing::info!(
            "Starting audio capture: {} channels, {} Hz, max_buffer={} samples",
            channels,
            sample_rate,
            max_samples
        );

        let callback_count = Arc::new(AtomicU64::new(0));
        let callback_count_clone = callback_count.clone();

        let stream = self.device.build_input_stream(
            &self.config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let count = callback_count_clone.fetch_add(1, Ordering::SeqCst);

                // Log first few callbacks
                if count < 5 {
                    tracing::info!("Audio callback #{}: {} samples", count, data.len());
                }

                // Convert to mono by averaging channels
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
                    .collect();

                if let Ok(mut buf) = buffer.lock() {
                    buf.extend_from_slice(&mono);
                    
                    // Sliding window: удаляем старые семплы если буфер переполнен
                    if buf.len() > max_samples {
                        let excess = buf.len() - max_samples;
                        buf.drain(0..excess);
                        
                        // Log редко (каждые ~100000 callbacks = ~30 сек при 3000 callbacks/sec)
                        if count % 100000 == 0 {
                            tracing::debug!(
                                "AudioCapture: sliding window trimmed {} samples, buffer_len={}",
                                excess,
                                buf.len()
                            );
                        }
                    }
                    
                    // Обновляем счётчик общего количества обработанных семплов
                    total_processed.fetch_add(mono.len() as u64, Ordering::Relaxed);
                }
            },
            |err| {
                tracing::error!("Audio capture error: {}", err);
            },
            None,
        )?;

        stream.play()?;
        self.stream = Some(stream);

        tracing::info!("Audio stream started successfully");

        Ok(())
    }

    /// Stop capturing and return samples
    pub fn stop(&mut self) -> Vec<f32> {
        self.stream = None;

        let mut buffer = self.buffer.lock().unwrap();
        std::mem::take(&mut *buffer)
    }

    /// Get current buffer without stopping
    pub fn get_samples(&self) -> Vec<f32> {
        self.buffer.lock().unwrap().clone()
    }

    /// Clear the buffer
    pub fn clear(&self) {
        self.buffer.lock().unwrap().clear();
    }

    /// Get sample rate
    pub fn sample_rate(&self) -> u32 {
        self.config.sample_rate.0
    }

    /// Получить общее количество обработанных семплов с начала записи
    ///
    /// Включает семплы которые уже были удалены из буфера (sliding window).
    /// Используется для отслеживания прогресса записи.
    pub fn total_samples_processed(&self) -> u64 {
        self.total_samples_processed.load(Ordering::Relaxed)
    }

    /// Получить текущий размер буфера в семплах
    pub fn buffer_len(&self) -> usize {
        self.buffer.lock().map(|b| b.len()).unwrap_or(0)
    }
}

/// List available input devices
pub fn list_input_devices() -> Result<Vec<AudioDevice>> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());

    let devices: Vec<AudioDevice> = host
        .input_devices()?
        .filter_map(|device| {
            let name = device.name().ok()?;
            let config = device.default_input_config().ok()?;

            Some(AudioDevice {
                id: name.clone(),
                name: name.clone(),
                is_default: default_name.as_ref() == Some(&name),
                channels: config.channels(),
                sample_rate: config.sample_rate().0,
            })
        })
        .collect();

    Ok(devices)
}

/// Force request microphone access by attempting to open a stream
pub fn request_microphone_access() -> Result<bool> {
    tracing::info!("Forcing microphone access request via cpal");
    
    let host = cpal::default_host();
    let device = host.default_input_device().context("No default input device")?;
    let config = device.default_input_config()?;
    
    // Try to build stream - this triggers the OS prompt
    let stream = device.build_input_stream(
        &config.into(),
        move |_data: &[f32], _: &cpal::InputCallbackInfo| {},
        move |err| { tracing::error!("Access check stream error: {}", err); },
        None
    );

    match stream {
        Ok(s) => {
            // If we got here, we might have access or the prompt is showing
            // Start playing briefly to ensure it's active
            if let Err(e) = s.play() {
                tracing::error!("Failed to play access check stream: {}", e);
                return Ok(false);
            }
            
            // Wait a tiny bit
            std::thread::sleep(std::time::Duration::from_millis(100));
            
            // Drop stream to close it
            drop(s);
            
            tracing::info!("Microphone access check stream created successfully");
            Ok(true)
        },
        Err(e) => {
            tracing::error!("Failed to create access check stream: {}", e);
            // This usually means access denied
            Ok(false)
        }
    }
}
