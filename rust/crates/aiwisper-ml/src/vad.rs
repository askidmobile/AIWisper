//! Voice Activity Detection using Silero VAD
//!
//! Silero VAD is a lightweight ONNX model for speech detection.
//! Reference: https://github.com/snakers4/silero-vad

use crate::traits::VadEngine;
use anyhow::{Context, Result};
use ort::session::{builder::GraphOptimizationLevel, Session};
use std::sync::Mutex;

/// Silero VAD configuration
#[derive(Debug, Clone)]
pub struct SileroVadConfig {
    /// Path to ONNX model
    pub model_path: String,
    /// Sample rate (8000 or 16000)
    pub sample_rate: u32,
    /// Speech probability threshold (0.0 - 1.0)
    pub threshold: f32,
    /// Minimum silence duration for segmentation (ms)
    pub min_silence_duration_ms: u32,
    /// Padding around speech (ms)
    pub speech_pad_ms: u32,
    /// Minimum speech duration (ms)
    pub min_speech_duration_ms: u32,
    /// Maximum region duration (ms), 0 = unlimited
    pub max_region_duration_ms: u32,
}

impl Default for SileroVadConfig {
    fn default() -> Self {
        Self {
            model_path: String::new(),
            sample_rate: 16000,
            threshold: 0.45,
            min_silence_duration_ms: 700,
            speech_pad_ms: 250,
            min_speech_duration_ms: 250,
            max_region_duration_ms: 25000,
        }
    }
}

/// Speech segment detected by VAD
#[derive(Debug, Clone)]
pub struct VadSegment {
    /// Start time in milliseconds
    pub start_ms: i64,
    /// End time in milliseconds
    pub end_ms: i64,
    /// Average speech probability
    pub avg_prob: f32,
}

/// Silero VAD engine
pub struct SileroVad {
    session: Mutex<Session>,
    config: SileroVadConfig,
    /// LSTM state (preserved between calls for streaming)
    state: Mutex<Vec<f32>>,
    /// Context - last N samples from previous chunk
    context: Mutex<Vec<f32>>,
}

impl SileroVad {
    /// Create new Silero VAD engine
    pub fn new(config: SileroVadConfig) -> Result<Self> {
        tracing::info!("Loading Silero VAD model from: {}", config.model_path);

        // Validate sample rate
        if config.sample_rate != 8000 && config.sample_rate != 16000 {
            anyhow::bail!(
                "Sample rate must be 8000 or 16000, got {}",
                config.sample_rate
            );
        }

        // Create ONNX session
        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(2)?
            .commit_from_file(&config.model_path)
            .context("Failed to load Silero VAD model")?;

        // Context size: 64 for 16kHz, 32 for 8kHz
        let context_size = if config.sample_rate == 16000 { 64 } else { 32 };

        // State size: [2, 1, 128] for h and c LSTM states
        let state_size = 2 * 1 * 128;

        tracing::info!(
            "Silero VAD initialized: sample_rate={}, threshold={:.2}",
            config.sample_rate,
            config.threshold
        );

        Ok(Self {
            session: Mutex::new(session),
            config,
            state: Mutex::new(vec![0.0; state_size]),
            context: Mutex::new(vec![0.0; context_size]),
        })
    }

    /// Reset LSTM state and context
    pub fn reset_state(&self) {
        let mut state = self.state.lock().unwrap();
        state.fill(0.0);

        let mut context = self.context.lock().unwrap();
        context.fill(0.0);
    }

    /// Process a single chunk and return speech probability
    /// Chunk size should be 512 for 16kHz or 256 for 8kHz
    pub fn process_chunk(&self, samples: &[f32]) -> Result<f32> {
        let context_size = if self.config.sample_rate == 16000 {
            64
        } else {
            32
        };

        let mut context = self.context.lock().unwrap();
        let mut state = self.state.lock().unwrap();

        // Create input buffer: context + samples
        let mut input_data = Vec::with_capacity(context_size + samples.len());
        input_data.extend_from_slice(&context);
        input_data.extend_from_slice(samples);

        // Update context for next call
        if samples.len() >= context_size {
            context.copy_from_slice(&samples[samples.len() - context_size..]);
        } else {
            context.rotate_left(samples.len());
            context[context_size - samples.len()..].copy_from_slice(samples);
        }

        // Create input tensors - ort 2.x uses tuple (shape, data) for Tensor::from_array
        let input_len = input_data.len();
        let input_tensor = ort::value::Tensor::from_array(([1_i64, input_len as i64], input_data))?;

        let state_tensor =
            ort::value::Tensor::from_array(([2_i64, 1_i64, 128_i64], state.clone()))?;

        let sr_tensor =
            ort::value::Tensor::from_array(([1_i64], vec![self.config.sample_rate as i64]))?;

        // Run inference - extract and copy data while holding lock, then release
        let (prob, new_state_vec) = {
            let mut session_guard = self.session.lock().unwrap();
            let outputs = session_guard.run(ort::inputs![
                "input" => input_tensor,
                "state" => state_tensor,
                "sr" => sr_tensor,
            ])?;

            // Get output probability - ort 2.x returns (&Shape, &[T])
            let (_, output_data) = outputs
                .get("output")
                .context("No output tensor")?
                .try_extract_tensor::<f32>()?;

            let prob = output_data[0];

            // Get new state - copy data before releasing lock
            let (_, new_state_data) = outputs
                .get("stateN")
                .context("No stateN tensor")?
                .try_extract_tensor::<f32>()?;

            let new_state_vec = new_state_data.to_vec();
            (prob, new_state_vec)
            // session_guard dropped here, lock released
        };

        // Update state
        state.copy_from_slice(&new_state_vec);

        Ok(prob)
    }

    /// Detect speech segments in audio
    pub fn detect_segments(&self, samples: &[f32]) -> Result<Vec<VadSegment>> {
        self.reset_state();

        // Chunk size: 512 for 16kHz, 256 for 8kHz
        let chunk_size = if self.config.sample_rate == 16000 {
            512
        } else {
            256
        };
        let samples_per_ms = self.config.sample_rate as f32 / 1000.0;
        let ms_per_chunk = chunk_size as f32 / samples_per_ms;

        let min_silence_chunks =
            (self.config.min_silence_duration_ms as f32 / ms_per_chunk).ceil() as usize;
        let speech_pad_chunks = (self.config.speech_pad_ms as f32 / ms_per_chunk).ceil() as usize;
        let min_speech_chunks =
            (self.config.min_speech_duration_ms as f32 / ms_per_chunk).ceil() as usize;
        let max_region_chunks = if self.config.max_region_duration_ms > 0 {
            (self.config.max_region_duration_ms as f32 / ms_per_chunk).ceil() as usize
        } else {
            usize::MAX
        };

        // Process all chunks
        let mut probs: Vec<f32> = Vec::new();

        for chunk in samples.chunks(chunk_size) {
            // Pad last chunk if needed
            let chunk_data = if chunk.len() < chunk_size {
                let mut padded = vec![0.0; chunk_size];
                padded[..chunk.len()].copy_from_slice(chunk);
                padded
            } else {
                chunk.to_vec()
            };

            let prob = self.process_chunk(&chunk_data)?;
            probs.push(prob);
        }

        // Find speech segments using threshold
        let mut segments: Vec<VadSegment> = Vec::new();
        let mut in_speech = false;
        let mut speech_start = 0;
        let mut silence_count = 0;
        let mut speech_probs: Vec<f32> = Vec::new();

        for (i, &prob) in probs.iter().enumerate() {
            let is_speech = prob >= self.config.threshold;

            if is_speech {
                if !in_speech {
                    // Start of speech
                    speech_start = i.saturating_sub(speech_pad_chunks);
                    in_speech = true;
                    speech_probs.clear();
                }
                speech_probs.push(prob);
                silence_count = 0;

                // Check max region duration
                let region_len = i - speech_start;
                if region_len >= max_region_chunks {
                    // Force split
                    let start_ms = (speech_start as f32 * ms_per_chunk) as i64;
                    let end_ms = ((i + speech_pad_chunks) as f32 * ms_per_chunk) as i64;
                    let avg_prob = speech_probs.iter().sum::<f32>() / speech_probs.len() as f32;

                    segments.push(VadSegment {
                        start_ms,
                        end_ms,
                        avg_prob,
                    });

                    in_speech = false;
                    speech_probs.clear();
                }
            } else if in_speech {
                silence_count += 1;

                if silence_count >= min_silence_chunks {
                    // End of speech
                    let speech_len = i - silence_count - speech_start;

                    if speech_len >= min_speech_chunks {
                        let start_ms = (speech_start as f32 * ms_per_chunk) as i64;
                        let end_ms =
                            ((i - silence_count + speech_pad_chunks) as f32 * ms_per_chunk) as i64;
                        let avg_prob = if speech_probs.is_empty() {
                            self.config.threshold
                        } else {
                            speech_probs.iter().sum::<f32>() / speech_probs.len() as f32
                        };

                        segments.push(VadSegment {
                            start_ms,
                            end_ms,
                            avg_prob,
                        });
                    }

                    in_speech = false;
                    speech_probs.clear();
                }
            }
        }

        // Handle trailing speech
        if in_speech {
            let speech_len = probs.len() - speech_start;
            if speech_len >= min_speech_chunks {
                let start_ms = (speech_start as f32 * ms_per_chunk) as i64;
                let end_ms = (probs.len() as f32 * ms_per_chunk) as i64;
                let avg_prob = if speech_probs.is_empty() {
                    self.config.threshold
                } else {
                    speech_probs.iter().sum::<f32>() / speech_probs.len() as f32
                };

                segments.push(VadSegment {
                    start_ms,
                    end_ms,
                    avg_prob,
                });
            }
        }

        // Merge close segments
        let merged = merge_close_segments(&segments, self.config.min_silence_duration_ms as i64);

        Ok(merged)
    }
}

impl VadEngine for SileroVad {
    fn is_speech(&self, samples: &[f32]) -> bool {
        // Process in chunks and return true if any chunk has speech
        let chunk_size = if self.config.sample_rate == 16000 {
            512
        } else {
            256
        };

        self.reset_state();

        for chunk in samples.chunks(chunk_size) {
            let chunk_data = if chunk.len() < chunk_size {
                let mut padded = vec![0.0; chunk_size];
                padded[..chunk.len()].copy_from_slice(chunk);
                padded
            } else {
                chunk.to_vec()
            };

            if let Ok(prob) = self.process_chunk(&chunk_data) {
                if prob >= self.config.threshold {
                    return true;
                }
            }
        }

        false
    }

    fn speech_probability(&self, samples: &[f32]) -> f32 {
        let chunk_size = if self.config.sample_rate == 16000 {
            512
        } else {
            256
        };

        self.reset_state();

        let mut total_prob = 0.0;
        let mut count = 0;

        for chunk in samples.chunks(chunk_size) {
            let chunk_data = if chunk.len() < chunk_size {
                let mut padded = vec![0.0; chunk_size];
                padded[..chunk.len()].copy_from_slice(chunk);
                padded
            } else {
                chunk.to_vec()
            };

            if let Ok(prob) = self.process_chunk(&chunk_data) {
                total_prob += prob;
                count += 1;
            }
        }

        if count > 0 {
            total_prob / count as f32
        } else {
            0.0
        }
    }

    fn reset(&mut self) {
        self.reset_state();
    }
}

/// Merge segments that are close together
fn merge_close_segments(segments: &[VadSegment], min_gap_ms: i64) -> Vec<VadSegment> {
    if segments.is_empty() {
        return vec![];
    }

    let mut merged: Vec<VadSegment> = Vec::new();
    let mut current = segments[0].clone();

    for seg in segments.iter().skip(1) {
        let gap = seg.start_ms - current.end_ms;

        if gap < min_gap_ms {
            // Merge segments
            current.end_ms = seg.end_ms;
            current.avg_prob = (current.avg_prob + seg.avg_prob) / 2.0;
        } else {
            merged.push(current);
            current = seg.clone();
        }
    }

    merged.push(current);
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_close_segments() {
        let segments = vec![
            VadSegment {
                start_ms: 0,
                end_ms: 100,
                avg_prob: 0.8,
            },
            VadSegment {
                start_ms: 150,
                end_ms: 300,
                avg_prob: 0.9,
            }, // gap 50ms
            VadSegment {
                start_ms: 500,
                end_ms: 700,
                avg_prob: 0.7,
            }, // gap 200ms
        ];

        let merged = merge_close_segments(&segments, 100);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].start_ms, 0);
        assert_eq!(merged[0].end_ms, 300);
        assert_eq!(merged[1].start_ms, 500);
    }
}
