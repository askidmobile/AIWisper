//! MP3 audio decoder using symphonia
//!
//! Provides unified interface for decoding MP3 files with various output modes:
//! - Mono mix for ASR (resampled to 16kHz)
//! - Stereo channels for ASR (resampled to 16kHz)
//! - Raw stereo for playback (original sample rate)
//! - Full file waveform for visualization

use anyhow::{Context, Result};
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Target sample rate for ASR (Whisper, GigaAM, etc.)
pub const ASR_SAMPLE_RATE: u32 = 16000;

/// Result of stereo audio extraction
#[derive(Debug, Clone)]
pub struct StereoSegment {
    /// Left channel samples (typically microphone)
    pub left: Vec<f32>,
    /// Right channel samples (typically system audio)
    pub right: Vec<f32>,
    /// Sample rate of the audio
    pub sample_rate: u32,
}

/// Result of waveform extraction for visualization
#[derive(Debug, Clone)]
pub struct WaveformData {
    /// Per-channel samples
    pub channels: Vec<Vec<f32>>,
    /// Sample rate of the audio
    pub sample_rate: u32,
    /// Number of channels
    pub channel_count: usize,
}

/// MP3 audio decoder
pub struct Mp3Decoder;

impl Mp3Decoder {
    /// Create decoder state from a file path
    fn open_file(path: &Path) -> Result<DecoderState> {
        let file = std::fs::File::open(path)
            .with_context(|| format!("Failed to open audio file: {:?}", path))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions::default();
        let decoder_opts = DecoderOptions::default();

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &metadata_opts)
            .context("Failed to probe audio format")?;

        let format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| anyhow::anyhow!("No audio track found"))?;

        let track_id = track.id;
        let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
        let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &decoder_opts)
            .context("Failed to create audio decoder")?;

        Ok(DecoderState {
            format,
            decoder,
            track_id,
            sample_rate,
            channels,
        })
    }

    /// Decode audio segment as mono mix (for ASR)
    /// 
    /// Extracts audio from start_ms to end_ms, mixes channels to mono,
    /// and resamples to 16kHz for speech recognition.
    pub fn decode_segment_mono(path: &Path, start_ms: i64, end_ms: i64) -> Result<Vec<f32>> {
        let mut state = Self::open_file(path)?;
        
        let start_sample = (start_ms as f64 * state.sample_rate as f64 / 1000.0) as usize;
        let end_sample = (end_ms as f64 * state.sample_rate as f64 / 1000.0) as usize;

        let mut all_samples: Vec<f32> = Vec::new();
        let mut current_sample = 0usize;

        loop {
            let packet = match state.format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break
                }
                Err(_) => break,
            };

            if packet.track_id() != state.track_id {
                continue;
            }

            let decoded = match state.decoder.decode(&packet) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let spec = *decoded.spec();
            let duration = decoded.capacity() as u64;

            let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
            sample_buf.copy_interleaved_ref(decoded);
            let samples = sample_buf.samples();

            let frame_samples = samples.len() / state.channels;

            for i in 0..frame_samples {
                let sample_idx = current_sample + i;

                if sample_idx >= start_sample && sample_idx < end_sample {
                    // Mix channels to mono (average)
                    let mut sum = 0.0;
                    for ch in 0..state.channels {
                        sum += samples[i * state.channels + ch];
                    }
                    all_samples.push(sum / state.channels as f32);
                }
            }

            current_sample += frame_samples;

            if current_sample >= end_sample {
                break;
            }
        }

        // Resample to 16kHz if needed
        if state.sample_rate != ASR_SAMPLE_RATE {
            Ok(resample_for_asr(&all_samples, state.sample_rate, ASR_SAMPLE_RATE))
        } else {
            Ok(all_samples)
        }
    }

    /// Decode audio segment as stereo channels (for ASR)
    /// 
    /// Extracts audio from start_ms to end_ms, separates left/right channels,
    /// and resamples to 16kHz for speech recognition.
    /// Left channel is typically microphone, right is system audio.
    pub fn decode_segment_stereo(path: &Path, start_ms: i64, end_ms: i64) -> Result<(Vec<f32>, Vec<f32>)> {
        let mut state = Self::open_file(path)?;
        
        let start_sample = (start_ms as f64 * state.sample_rate as f64 / 1000.0) as usize;
        let end_sample = (end_ms as f64 * state.sample_rate as f64 / 1000.0) as usize;

        let mut left_samples: Vec<f32> = Vec::new();
        let mut right_samples: Vec<f32> = Vec::new();
        let mut current_sample = 0usize;

        loop {
            let packet = match state.format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break
                }
                Err(_) => break,
            };

            if packet.track_id() != state.track_id {
                continue;
            }

            let decoded = match state.decoder.decode(&packet) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let spec = *decoded.spec();
            let duration = decoded.capacity() as u64;

            let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
            sample_buf.copy_interleaved_ref(decoded);
            let samples = sample_buf.samples();

            let frame_samples = samples.len() / state.channels;

            for i in 0..frame_samples {
                let sample_idx = current_sample + i;

                if sample_idx >= start_sample && sample_idx < end_sample {
                    if state.channels >= 2 {
                        left_samples.push(samples[i * state.channels]);
                        right_samples.push(samples[i * state.channels + 1]);
                    } else {
                        // Mono: duplicate to both channels
                        left_samples.push(samples[i * state.channels]);
                        right_samples.push(samples[i * state.channels]);
                    }
                }
            }

            current_sample += frame_samples;

            if current_sample >= end_sample {
                break;
            }
        }

        // Resample to 16kHz if needed
        if state.sample_rate != ASR_SAMPLE_RATE {
            Ok((
                resample_for_asr(&left_samples, state.sample_rate, ASR_SAMPLE_RATE),
                resample_for_asr(&right_samples, state.sample_rate, ASR_SAMPLE_RATE),
            ))
        } else {
            Ok((left_samples, right_samples))
        }
    }

    /// Decode audio segment for playback (raw stereo, original sample rate)
    /// 
    /// Extracts audio from start_ms to end_ms without resampling.
    /// Returns (left, right, sample_rate).
    pub fn decode_segment_for_playback(path: &Path, start_ms: i64, end_ms: i64) -> Result<StereoSegment> {
        let mut state = Self::open_file(path)?;
        
        let start_sample = (start_ms as f64 * state.sample_rate as f64 / 1000.0) as usize;
        let end_sample = (end_ms as f64 * state.sample_rate as f64 / 1000.0) as usize;

        let mut left_samples: Vec<f32> = Vec::new();
        let mut right_samples: Vec<f32> = Vec::new();
        let mut current_sample = 0usize;

        loop {
            let packet = match state.format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break
                }
                Err(_) => break,
            };

            if packet.track_id() != state.track_id {
                continue;
            }

            let decoded = match state.decoder.decode(&packet) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let spec = *decoded.spec();
            let duration = decoded.capacity() as u64;

            let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
            sample_buf.copy_interleaved_ref(decoded);
            let samples = sample_buf.samples();

            let frame_samples = samples.len() / state.channels;

            for i in 0..frame_samples {
                let sample_idx = current_sample + i;

                if sample_idx >= start_sample && sample_idx < end_sample {
                    if state.channels >= 2 {
                        left_samples.push(samples[i * state.channels]);
                        right_samples.push(samples[i * state.channels + 1]);
                    } else {
                        left_samples.push(samples[i * state.channels]);
                        right_samples.push(samples[i * state.channels]);
                    }
                }
            }

            current_sample += frame_samples;

            if current_sample >= end_sample {
                break;
            }
        }

        Ok(StereoSegment {
            left: left_samples,
            right: right_samples,
            sample_rate: state.sample_rate,
        })
    }

    /// Decode full file for waveform visualization
    /// 
    /// Returns all samples organized by channel for waveform display.
    pub fn decode_waveform(path: &Path) -> Result<WaveformData> {
        let mut state = Self::open_file(path)?;
        
        let mut channels: Vec<Vec<f32>> = vec![Vec::new(); state.channels];

        loop {
            let packet = match state.format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break
                }
                Err(e) => return Err(e.into()),
            };

            if packet.track_id() != state.track_id {
                continue;
            }

            let decoded = state.decoder.decode(&packet)?;
            let spec = *decoded.spec();
            let duration = decoded.capacity() as u64;

            let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
            sample_buf.copy_interleaved_ref(decoded);
            let samples = sample_buf.samples();

            // De-interleave samples into channels
            for (i, sample) in samples.iter().enumerate() {
                let ch = i % state.channels;
                channels[ch].push(*sample);
            }
        }

        if channels.is_empty() || channels[0].is_empty() {
            return Err(anyhow::anyhow!("No audio samples found"));
        }

        Ok(WaveformData {
            channels,
            sample_rate: state.sample_rate,
            channel_count: state.channels,
        })
    }
}

/// Internal decoder state
struct DecoderState {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    sample_rate: u32,
    channels: usize,
}

/// Resample audio using rubato (high quality) with fallback to original samples on error
fn resample_for_asr(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if samples.is_empty() || source_rate == target_rate {
        return samples.to_vec();
    }
    
    crate::resampling::resample(samples, source_rate, target_rate)
        .unwrap_or_else(|_| samples.to_vec())
}
