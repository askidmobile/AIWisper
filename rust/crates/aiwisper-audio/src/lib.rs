//! Audio processing crate for AIWisper
//!
//! Provides audio capture, resampling, and file I/O functionality.
//!
//! # Features
//! - **Microphone capture** via cpal (cross-platform)
//! - **System audio capture** via platform-specific APIs:
//!   - macOS: Core Audio Process Tap (14.2+) or ScreenCaptureKit (13+)
//!   - Windows: WASAPI Loopback Capture
//!   - Linux: PipeWire or PulseAudio monitor sources
//! - **MP3 recording** via FFmpeg pipe
//! - **Chunk buffer** with VAD for automatic segmentation

pub mod capture;
pub mod chunk_buffer;
pub mod file_io;
pub mod mp3_writer;
pub mod resampling;
pub mod system_audio;

pub use capture::list_input_devices;
pub use capture::AudioCapture;
pub use chunk_buffer::{ChunkBuffer, ChunkEvent, VadConfig, VadMode};
pub use mp3_writer::{Mp3Writer, SegmentedMp3Writer};
pub use system_audio::{
    create_capture as create_system_capture, get_best_method as get_best_system_capture_method,
    is_available as is_system_capture_available, AudioChannel, ChannelData, SystemAudioCapture,
    SystemCaptureConfig, SystemCaptureMethod,
};

/// Load audio from a file and return samples at 16kHz mono
pub fn load_audio_file(path: &str) -> anyhow::Result<Vec<f32>> {
    file_io::load_audio_file(path)
}

/// Convert f32 samples to WAV bytes
pub fn samples_to_wav_bytes(samples: &[f32], sample_rate: u32) -> anyhow::Result<Vec<u8>> {
    file_io::samples_to_wav_bytes(samples, sample_rate)
}

/// Resample audio to 16kHz
pub fn resample_to_16khz(samples: &[f32], source_rate: u32) -> anyhow::Result<Vec<f32>> {
    resampling::resample(samples, source_rate, 16000)
}

/// Resample audio to target rate
pub fn resample(samples: &[f32], source_rate: u32, target_rate: u32) -> anyhow::Result<Vec<f32>> {
    resampling::resample(samples, source_rate, target_rate)
}
