//! Audio capture using cpal

use aiwisper_types::AudioDevice;
use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};

/// Audio capture from input device
pub struct AudioCapture {
    device: cpal::Device,
    config: cpal::StreamConfig,
    stream: Option<cpal::Stream>,
    buffer: Arc<Mutex<Vec<f32>>>,
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

        tracing::info!(
            "Audio capture: {} @ {}Hz, {} channels",
            device.name().unwrap_or_default(),
            config.sample_rate().0,
            config.channels()
        );

        Ok(Self {
            device,
            config: config.into(),
            stream: None,
            buffer: Arc::new(Mutex::new(Vec::new())),
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

        tracing::info!(
            "Starting audio capture: {} channels, {} Hz",
            channels,
            sample_rate
        );

        let callback_count = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let callback_count_clone = callback_count.clone();

        let stream = self.device.build_input_stream(
            &self.config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let count = callback_count_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

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
