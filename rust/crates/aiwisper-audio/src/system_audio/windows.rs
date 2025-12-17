//! Windows system audio capture implementation
//!
//! Uses WASAPI Loopback Capture for system audio.
//! No additional software required - built into Windows Vista+.

use super::{
    AudioChannel, ChannelData, SystemAudioCapture, SystemCaptureConfig, SystemCaptureMethod,
};
use anyhow::{Context, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

/// Windows system audio capture using WASAPI Loopback
pub struct WindowsSystemCapture {
    config: SystemCaptureConfig,
    capture_thread: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
    receiver: Receiver<ChannelData>,
    sender: Sender<ChannelData>,
}

impl WindowsSystemCapture {
    /// Create new Windows system capture
    pub fn new(config: SystemCaptureConfig) -> Result<Self> {
        let (sender, receiver) = mpsc::channel();

        Ok(Self {
            config,
            capture_thread: None,
            running: Arc::new(AtomicBool::new(false)),
            receiver,
            sender,
        })
    }
}

impl SystemAudioCapture for WindowsSystemCapture {
    fn start(&mut self) -> Result<()> {
        if self.running.load(Ordering::SeqCst) {
            anyhow::bail!("Capture already running");
        }

        #[cfg(target_os = "windows")]
        {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

            let host =
                cpal::host_from_id(cpal::HostId::Wasapi).context("Failed to get WASAPI host")?;

            // Get default output device for loopback
            let device = host
                .default_output_device()
                .context("No default output device")?;

            tracing::info!(
                "WASAPI loopback device: {}",
                device.name().unwrap_or_default()
            );

            // Get supported config
            let config = device
                .default_output_config()
                .context("Failed to get output config")?;

            let sample_rate = config.sample_rate().0;
            let channels = config.channels() as usize;
            let target_rate = self.config.sample_rate;

            tracing::info!("WASAPI config: {}Hz, {} channels", sample_rate, channels);

            self.running.store(true, Ordering::SeqCst);
            let running = self.running.clone();
            let sender = self.sender.clone();

            // Build loopback stream
            // Note: WASAPI loopback requires special handling
            let stream_config = cpal::StreamConfig {
                channels: config.channels(),
                sample_rate: config.sample_rate(),
                buffer_size: cpal::BufferSize::Default,
            };

            let capture_thread = thread::spawn(move || {
                // WASAPI loopback implementation
                // This is a simplified version - full implementation would use
                // windows-rs or wasapi crate for proper loopback capture

                let stream_result = device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if !running.load(Ordering::SeqCst) {
                            return;
                        }

                        // Convert to mono
                        let mono: Vec<f32> = data
                            .chunks(channels)
                            .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
                            .collect();

                        // Resample if needed (simple linear interpolation)
                        let samples = if sample_rate != target_rate {
                            resample(&mono, sample_rate, target_rate)
                        } else {
                            mono
                        };

                        let _ = sender.send(ChannelData {
                            channel: AudioChannel::System,
                            samples,
                        });
                    },
                    |err| {
                        tracing::error!("WASAPI stream error: {}", err);
                    },
                    None,
                );

                match stream_result {
                    Ok(stream) => {
                        if let Err(e) = stream.play() {
                            tracing::error!("Failed to start WASAPI stream: {}", e);
                            return;
                        }

                        // Keep thread alive while running
                        while running.load(Ordering::SeqCst) {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to build WASAPI stream: {}", e);
                    }
                }
            });

            self.capture_thread = Some(capture_thread);
        }

        #[cfg(not(target_os = "windows"))]
        {
            anyhow::bail!("WASAPI capture only available on Windows");
        }

        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        if !self.running.load(Ordering::SeqCst) {
            return Ok(());
        }

        tracing::info!("Stopping WASAPI capture...");
        self.running.store(false, Ordering::SeqCst);

        if let Some(thread) = self.capture_thread.take() {
            let _ = thread.join();
        }

        tracing::info!("WASAPI capture stopped");
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn get_receiver(&self) -> &Receiver<ChannelData> {
        &self.receiver
    }
}

impl Drop for WindowsSystemCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Check if WASAPI loopback is available
pub fn is_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        use cpal::traits::HostTrait;

        cpal::host_from_id(cpal::HostId::Wasapi)
            .map(|host| host.default_output_device().is_some())
            .unwrap_or(false)
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Simple linear interpolation resampling
fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }

    let ratio = from_rate as f64 / to_rate as f64;
    let new_len = (samples.len() as f64 / ratio) as usize;
    let mut result = Vec::with_capacity(new_len);

    for i in 0..new_len {
        let src_pos = i as f64 * ratio;
        let src_idx = src_pos as usize;
        let frac = (src_pos - src_idx as f64) as f32;

        let sample = if src_idx + 1 < samples.len() {
            samples[src_idx] * (1.0 - frac) + samples[src_idx + 1] * frac
        } else if src_idx < samples.len() {
            samples[src_idx]
        } else {
            0.0
        };

        result.push(sample);
    }

    result
}
