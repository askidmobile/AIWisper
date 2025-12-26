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
//! - **MP3 decoding** via symphonia
//! - **Chunk buffer** with VAD for automatic segmentation

pub mod capture;
pub mod chunk_buffer;
pub mod file_io;
pub mod mp3_decoder;
pub mod mp3_writer;
pub mod resampling;
pub mod system_audio;

pub use capture::list_input_devices;
pub use capture::AudioCapture;
pub use chunk_buffer::{ChunkBuffer, ChunkEvent, VadConfig, VadMode};
pub use mp3_decoder::{Mp3Decoder, StereoSegment, WaveformData, ASR_SAMPLE_RATE};
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

/// Calculate RMS (Root Mean Square) of audio samples
/// Returns 0.0 for empty input
pub fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    (sum_squares / samples.len() as f32).sqrt()
}

/// Check if audio channel contains only silence (very low RMS)
/// 
/// # Arguments
/// * `samples` - Audio samples to check
/// * `threshold` - RMS threshold below which audio is considered silent (default: 0.005 ≈ -46dB)
/// 
/// # Returns
/// `true` if the channel should be skipped from transcription
pub fn is_silent(samples: &[f32], threshold: Option<f32>) -> bool {
    const DEFAULT_SILENCE_THRESHOLD: f32 = 0.005; // ~-46dB
    
    if samples.is_empty() {
        return true;
    }
    
    let rms = calculate_rms(samples);
    rms < threshold.unwrap_or(DEFAULT_SILENCE_THRESHOLD)
}

/// Check if two audio channels are similar (duplicated mono)
/// 
/// Used to detect when stereo recording contains identical left/right channels,
/// which means it's actually mono audio that should be transcribed once.
/// 
/// # Arguments
/// * `left` - Left channel samples
/// * `right` - Right channel samples
/// 
/// # Returns
/// `true` if channels are more than 95% similar (duplicated mono)
pub fn are_channels_similar(left: &[f32], right: &[f32]) -> bool {
    if left.len() != right.len() || left.is_empty() {
        return false;
    }
    
    // Sample every Nth sample for efficiency (check ~1000 samples max)
    let step = (left.len() / 1000).max(1);
    let mut similar_count = 0;
    let mut total_count = 0;
    
    for i in (0..left.len()).step_by(step) {
        let diff = (left[i] - right[i]).abs();
        if diff < 0.01 {
            similar_count += 1;
        }
        total_count += 1;
    }
    
    // If more than 95% of samples are similar, channels are duplicated
    total_count > 0 && similar_count as f32 / total_count as f32 > 0.95
}
