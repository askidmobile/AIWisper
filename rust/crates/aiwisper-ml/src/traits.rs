//! ML engine traits

use aiwisper_types::{SpeakerSegment, TranscriptSegment, TranscriptionResult};
use anyhow::Result;

/// Trait for transcription engines
pub trait TranscriptionEngine: Send + Sync {
    /// Engine name
    fn name(&self) -> &str;

    /// Transcribe audio samples and return result
    fn transcribe(&self, samples: &[f32]) -> Result<TranscriptionResult>;

    /// Transcribe audio samples and return segments with timestamps
    fn transcribe_with_segments(&self, samples: &[f32]) -> Result<Vec<TranscriptSegment>>;

    /// Supported languages
    fn supported_languages(&self) -> &[&str];

    /// Set transcription language
    fn set_language(&mut self, language: &str) -> Result<()>;

    /// Set hotwords for improved recognition
    fn set_hotwords(&mut self, hotwords: &[String]) -> Result<()>;
}

/// Trait for diarization engines
pub trait DiarizationEngine: Send + Sync {
    /// Engine name
    fn name(&self) -> &str;

    /// Diarize audio samples and return speaker segments
    fn diarize(&self, samples: &[f32]) -> Result<Vec<SpeakerSegment>>;

    /// Get number of detected speakers from last diarization
    fn num_speakers(&self) -> usize;
}

/// Trait for Voice Activity Detection
pub trait VadEngine: Send + Sync {
    /// Check if audio contains speech
    fn is_speech(&self, samples: &[f32]) -> bool;

    /// Get speech probability (0.0 - 1.0)
    fn speech_probability(&self, samples: &[f32]) -> f32;

    /// Reset internal state
    fn reset(&mut self);
}
