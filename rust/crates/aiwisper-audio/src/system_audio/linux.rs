//! Linux system audio capture implementation
//!
//! Supports two audio systems:
//! - **PipeWire** (modern, default on Fedora/Ubuntu 22.04+)
//! - **PulseAudio** (legacy, widely supported)
//!
//! Uses monitor sources for system audio capture.

use super::{
    AudioChannel, ChannelData, SystemAudioCapture, SystemCaptureConfig, SystemCaptureMethod,
};
use anyhow::{Context, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

/// Linux system audio capture using PipeWire or PulseAudio
pub struct LinuxSystemCapture {
    config: SystemCaptureConfig,
    capture_thread: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
    receiver: Receiver<ChannelData>,
    sender: Sender<ChannelData>,
}

impl LinuxSystemCapture {
    /// Create new Linux system capture
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

impl SystemAudioCapture for LinuxSystemCapture {
    fn start(&mut self) -> Result<()> {
        if self.running.load(Ordering::SeqCst) {
            anyhow::bail!("Capture already running");
        }

        #[cfg(target_os = "linux")]
        {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

            let host = cpal::default_host();

            // Find monitor device for system audio capture
            // PulseAudio/PipeWire expose monitor sources for output devices
            let device = find_monitor_device(&host)
                .or_else(|| host.default_input_device())
                .context("No monitor or input device found")?;

            let device_name = device.name().unwrap_or_default();
            tracing::info!("Linux audio device: {}", device_name);

            let config = device
                .default_input_config()
                .context("Failed to get input config")?;

            let sample_rate = config.sample_rate().0;
            let channels = config.channels() as usize;
            let target_rate = self.config.sample_rate;

            tracing::info!(
                "Linux audio config: {}Hz, {} channels",
                sample_rate,
                channels
            );

            self.running.store(true, Ordering::SeqCst);
            let running = self.running.clone();
            let sender = self.sender.clone();

            let stream_config = cpal::StreamConfig {
                channels: config.channels(),
                sample_rate: config.sample_rate(),
                buffer_size: cpal::BufferSize::Default,
            };

            let capture_thread = thread::spawn(move || {
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

                        // Resample if needed
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
                        tracing::error!("Linux audio stream error: {}", err);
                    },
                    None,
                );

                match stream_result {
                    Ok(stream) => {
                        if let Err(e) = stream.play() {
                            tracing::error!("Failed to start Linux audio stream: {}", e);
                            return;
                        }

                        // Keep thread alive while running
                        while running.load(Ordering::SeqCst) {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to build Linux audio stream: {}", e);
                    }
                }
            });

            self.capture_thread = Some(capture_thread);
        }

        #[cfg(not(target_os = "linux"))]
        {
            anyhow::bail!("Linux audio capture only available on Linux");
        }

        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        if !self.running.load(Ordering::SeqCst) {
            return Ok(());
        }

        tracing::info!("Stopping Linux audio capture...");
        self.running.store(false, Ordering::SeqCst);

        if let Some(thread) = self.capture_thread.take() {
            let _ = thread.join();
        }

        tracing::info!("Linux audio capture stopped");
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn get_receiver(&self) -> &Receiver<ChannelData> {
        &self.receiver
    }
}

impl Drop for LinuxSystemCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Find monitor device for system audio capture
#[cfg(target_os = "linux")]
fn find_monitor_device(host: &cpal::Host) -> Option<cpal::Device> {
    use cpal::traits::HostTrait;

    host.input_devices().ok()?.find(|device| {
        device
            .name()
            .map(|name| {
                // PulseAudio/PipeWire monitor sources contain ".monitor" suffix
                name.contains(".monitor") || name.contains("Monitor")
            })
            .unwrap_or(false)
    })
}

/// Check if system audio capture is available on Linux
pub fn is_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        use cpal::traits::HostTrait;

        let host = cpal::default_host();

        // Check for monitor device or any input device
        find_monitor_device(&host).is_some() || host.default_input_device().is_some()
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Get the best available capture method for Linux
pub fn get_best_method() -> Option<SystemCaptureMethod> {
    // Check if PipeWire is running
    if is_pipewire_running() {
        return Some(SystemCaptureMethod::PipeWire);
    }

    // Fallback to PulseAudio
    if is_pulseaudio_running() {
        return Some(SystemCaptureMethod::PulseAudio);
    }

    None
}

/// Check if PipeWire is running
fn is_pipewire_running() -> bool {
    std::process::Command::new("pgrep")
        .arg("-x")
        .arg("pipewire")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if PulseAudio is running
fn is_pulseaudio_running() -> bool {
    std::process::Command::new("pgrep")
        .arg("-x")
        .arg("pulseaudio")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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
