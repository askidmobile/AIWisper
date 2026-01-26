//! System audio capture module
//!
//! Provides cross-platform system audio capture functionality.
//!
//! # Platform support
//! - **macOS**: Core Audio Process Tap (14.2+) or ScreenCaptureKit (13+)
//! - **Windows**: WASAPI Loopback Capture
//! - **Linux**: PipeWire or PulseAudio monitor source

use anyhow::Result;
use std::sync::mpsc;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

/// Audio channel identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioChannel {
    /// Microphone input
    Microphone,
    /// System audio output (loopback)
    System,
}

/// Audio data with channel information
#[derive(Debug, Clone)]
pub struct ChannelData {
    /// Source channel
    pub channel: AudioChannel,
    /// Audio samples (mono, float32)
    pub samples: Vec<f32>,
}

/// System audio capture method (macOS specific)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SystemCaptureMethod {
    /// Core Audio Process Tap (macOS 14.2+)
    /// Best option: no Screen Recording permission required
    #[default]
    CoreAudioTap,
    /// ScreenCaptureKit (macOS 13+)
    /// Requires Screen Recording permission
    ScreenCaptureKit,
    /// Virtual loopback device (BlackHole, etc.)
    /// Legacy method, requires additional software
    VirtualLoopback,
    /// WASAPI Loopback (Windows)
    WasapiLoopback,
    /// PipeWire monitor (Linux)
    PipeWire,
    /// PulseAudio monitor (Linux)
    PulseAudio,
}

/// Configuration for system audio capture
#[derive(Debug, Clone)]
pub struct SystemCaptureConfig {
    /// Capture method to use
    pub method: SystemCaptureMethod,
    /// Target sample rate (default: 24000 Hz)
    pub sample_rate: u32,
    /// Whether to capture microphone as well (macOS 15+ with Voice Isolation)
    pub capture_microphone: bool,
}

impl Default for SystemCaptureConfig {
    fn default() -> Self {
        Self {
            method: SystemCaptureMethod::default(),
            sample_rate: 24000,
            capture_microphone: false,
        }
    }
}

/// System audio capture trait
pub trait SystemAudioCapture: Send {
    /// Start capturing system audio
    fn start(&mut self) -> Result<()>;

    /// Stop capturing
    fn stop(&mut self) -> Result<()>;

    /// Check if capture is running
    fn is_running(&self) -> bool;

    /// Get receiver for audio data
    fn get_receiver(&self) -> &mpsc::Receiver<ChannelData>;
}

/// Check if system audio capture is available on this platform
pub fn is_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::is_available()
    }

    #[cfg(target_os = "windows")]
    {
        windows::is_available()
    }

    #[cfg(target_os = "linux")]
    {
        linux::is_available()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        false
    }
}

/// Get the best available capture method for current platform
pub fn get_best_method() -> Option<SystemCaptureMethod> {
    #[cfg(target_os = "macos")]
    {
        macos::get_best_method()
    }

    #[cfg(target_os = "windows")]
    {
        Some(SystemCaptureMethod::WasapiLoopback)
    }

    #[cfg(target_os = "linux")]
    {
        linux::get_best_method()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

/// Create a system audio capture instance
pub fn create_capture(config: SystemCaptureConfig) -> Result<Box<dyn SystemAudioCapture>> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(macos::MacOSSystemCapture::new(config)?))
    }

    #[cfg(target_os = "windows")]
    {
        Ok(Box::new(windows::WindowsSystemCapture::new(config)?))
    }

    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(linux::LinuxSystemCapture::new(config)?))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        anyhow::bail!("System audio capture not supported on this platform")
    }
}
