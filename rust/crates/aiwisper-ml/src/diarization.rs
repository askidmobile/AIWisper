//! FluidAudio diarization engine
//!
//! This module provides speaker diarization using the FluidAudio Swift/CoreML binary.
//! The binary is called as a subprocess for stability (each call = new process, no memory leaks).

use aiwisper_types::SpeakerSegment;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

/// Diarization configuration
#[derive(Debug, Clone)]
pub struct FluidDiarizationConfig {
    /// Path to diarization-fluid binary (optional, auto-detected if not set)
    pub binary_path: Option<String>,
    /// Clustering threshold (0.0-1.0), default: 0.70
    pub clustering_threshold: f64,
    /// Minimum segment duration in seconds, default: 0.2
    pub min_segment_duration: f64,
    /// Maximum VBx iterations, default: 30
    pub vbx_max_iterations: i32,
    /// Minimum gap duration in seconds, default: 0.15
    pub min_gap_duration: f64,
    /// Enable debug output
    pub debug: bool,
}

impl Default for FluidDiarizationConfig {
    fn default() -> Self {
        Self {
            binary_path: None,
            clustering_threshold: 0.70,
            min_segment_duration: 0.2,
            vbx_max_iterations: 30,
            min_gap_duration: 0.15,
            debug: false,
        }
    }
}

/// Speaker embedding from diarization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerEmbedding {
    /// Speaker ID (0, 1, 2...)
    pub speaker: i32,
    /// 256-dimensional embedding vector
    pub embedding: Vec<f32>,
    /// Total speech duration for this speaker (seconds)
    pub duration: f64,
}

/// Full diarization result with embeddings
#[derive(Debug, Clone)]
pub struct DiarizationResult {
    /// Speaker segments
    pub segments: Vec<SpeakerSegment>,
    /// Number of detected speakers
    pub num_speakers: i32,
    /// Speaker embeddings (for cross-session matching)
    pub speaker_embeddings: Vec<SpeakerEmbedding>,
}

/// JSON output from diarization-fluid binary
#[derive(Debug, Deserialize)]
struct FluidDiarizationOutput {
    segments: Vec<FluidSegment>,
    num_speakers: i32,
    speaker_embeddings: Option<Vec<FluidSpeakerEmbedding>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FluidSegment {
    speaker: i32,
    start: f64,
    end: f64,
}

#[derive(Debug, Deserialize)]
struct FluidSpeakerEmbedding {
    speaker: i32,
    embedding: Vec<f32>,
    duration: f64,
}

/// FluidAudio-based speaker diarization engine
pub struct FluidDiarizationEngine {
    binary_path: PathBuf,
    config: FluidDiarizationConfig,
    last_num_speakers: Mutex<usize>,
}

impl FluidDiarizationEngine {
    /// Create a new FluidDiarizationEngine
    pub fn new(config: FluidDiarizationConfig) -> Result<Self> {
        let binary_path = if let Some(ref path) = config.binary_path {
            PathBuf::from(path)
        } else {
            Self::find_binary()?
        };

        if !binary_path.exists() {
            anyhow::bail!(
                "diarization-fluid binary not found at {:?}. Build it with: cd backend/audio/diarization && swift build -c release",
                binary_path
            );
        }

        tracing::info!(
            "FluidDiarizationEngine: using binary at {:?} (threshold={:.2}, minSeg={:.2}, vbxIter={})",
            binary_path,
            config.clustering_threshold,
            config.min_segment_duration,
            config.vbx_max_iterations
        );

        Ok(Self {
            binary_path,
            config,
            last_num_speakers: Mutex::new(0),
        })
    }

    /// Create with default configuration
    pub fn with_defaults() -> Result<Self> {
        Self::new(FluidDiarizationConfig::default())
    }

    /// Find the diarization-fluid binary in common locations
    fn find_binary() -> Result<PathBuf> {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()));

        let candidates = vec![
            // Next to executable (packaged app)
            exe_dir.as_ref().map(|d| d.join("diarization-fluid")),
            // In Resources for macOS app bundle
            exe_dir.as_ref().map(|d| d.join("../Resources/diarization-fluid")),
            // Tauri resources
            exe_dir.as_ref().map(|d| d.join("resources/diarization-fluid")),
            // Development paths
            Some(PathBuf::from("rust/src-tauri/resources/diarization-fluid")),
            Some(PathBuf::from("backend/audio/diarization/.build/release/diarization-fluid")),
            Some(PathBuf::from("/Users/askid/Projects/AIWisper/rust/src-tauri/resources/diarization-fluid")),
            Some(PathBuf::from("/Users/askid/Projects/AIWisper/backend/audio/diarization/.build/release/diarization-fluid")),
        ];

        for candidate in candidates.into_iter().flatten() {
            if candidate.exists() {
                tracing::debug!("Found diarization-fluid at {:?}", candidate);
                return Ok(candidate);
            }
        }

        anyhow::bail!("diarization-fluid binary not found in any known location")
    }

    /// Diarize audio samples
    ///
    /// # Arguments
    /// * `samples` - Audio samples in float32 format, 16kHz, mono
    ///
    /// # Returns
    /// Vector of speaker segments with timestamps and speaker IDs
    pub fn diarize(&self, samples: &[f32]) -> Result<Vec<SpeakerSegment>> {
        let result = self.diarize_with_embeddings(samples)?;
        Ok(result.segments)
    }

    /// Diarize audio samples and return full result with embeddings
    ///
    /// # Arguments
    /// * `samples` - Audio samples in float32 format, 16kHz, mono
    ///
    /// # Returns
    /// Full diarization result including speaker embeddings
    pub fn diarize_with_embeddings(&self, samples: &[f32]) -> Result<DiarizationResult> {
        if samples.is_empty() {
            return Ok(DiarizationResult {
                segments: vec![],
                num_speakers: 0,
                speaker_embeddings: vec![],
            });
        }

        let start_time = std::time::Instant::now();

        // Build command arguments
        let mut args = vec!["--samples".to_string()];
        args.push("--clustering-threshold".to_string());
        args.push(format!("{:.2}", self.config.clustering_threshold));
        args.push("--min-segment-duration".to_string());
        args.push(format!("{:.2}", self.config.min_segment_duration));
        args.push("--vbx-max-iterations".to_string());
        args.push(format!("{}", self.config.vbx_max_iterations));
        args.push("--min-gap-duration".to_string());
        args.push(format!("{:.2}", self.config.min_gap_duration));
        if self.config.debug {
            args.push("--debug".to_string());
        }

        // Start subprocess
        let mut child = Command::new(&self.binary_path)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to start diarization-fluid process")?;

        // Write samples to stdin as binary float32
        {
            let stdin = child.stdin.as_mut().context("Failed to get stdin")?;
            let bytes: Vec<u8> = samples
                .iter()
                .flat_map(|&s| s.to_le_bytes())
                .collect();
            stdin.write_all(&bytes).context("Failed to write samples")?;
        }

        // Wait for process and collect output
        let output = child.wait_with_output().context("Failed to wait for diarization-fluid")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::error!("diarization-fluid failed: {}", stderr);
            anyhow::bail!("diarization-fluid failed: {}", stderr);
        }

        // Parse JSON output
        let stdout = String::from_utf8_lossy(&output.stdout);
        let result: FluidDiarizationOutput = serde_json::from_str(&stdout)
            .context(format!("Failed to parse diarization result: {}", stdout))?;

        if let Some(error) = result.error {
            anyhow::bail!("Diarization error: {}", error);
        }

        // Convert segments
        let segments: Vec<SpeakerSegment> = result
            .segments
            .iter()
            .map(|seg| SpeakerSegment {
                start: seg.start as f32,
                end: seg.end as f32,
                speaker: seg.speaker,
            })
            .collect();

        // Convert embeddings
        let speaker_embeddings: Vec<SpeakerEmbedding> = result
            .speaker_embeddings
            .unwrap_or_default()
            .iter()
            .map(|emb| SpeakerEmbedding {
                speaker: emb.speaker,
                embedding: emb.embedding.clone(),
                duration: emb.duration,
            })
            .collect();

        // Update last speaker count
        *self.last_num_speakers.lock().unwrap() = result.num_speakers as usize;

        let elapsed = start_time.elapsed();
        let audio_duration = samples.len() as f64 / 16000.0;
        tracing::info!(
            "FluidDiarization: processed {:.1}s audio in {:.2}s, found {} segments from {} speakers (embeddings: {})",
            audio_duration,
            elapsed.as_secs_f64(),
            segments.len(),
            result.num_speakers,
            speaker_embeddings.len()
        );

        Ok(DiarizationResult {
            segments,
            num_speakers: result.num_speakers,
            speaker_embeddings,
        })
    }

    /// Get number of speakers from last diarization
    pub fn num_speakers(&self) -> usize {
        *self.last_num_speakers.lock().unwrap()
    }

    /// Check if the engine is available (binary exists)
    pub fn is_available() -> bool {
        Self::find_binary().is_ok()
    }
}

impl super::traits::DiarizationEngine for FluidDiarizationEngine {
    fn name(&self) -> &str {
        "FluidAudio"
    }

    fn diarize(&self, samples: &[f32]) -> Result<Vec<SpeakerSegment>> {
        FluidDiarizationEngine::diarize(self, samples)
    }

    fn num_speakers(&self) -> usize {
        FluidDiarizationEngine::num_speakers(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_binary() {
        // This test will only pass if diarization-fluid is built
        if FluidDiarizationEngine::is_available() {
            let engine = FluidDiarizationEngine::with_defaults();
            assert!(engine.is_ok());
        }
    }

    #[test]
    fn test_default_config() {
        let config = FluidDiarizationConfig::default();
        assert_eq!(config.clustering_threshold, 0.70);
        assert_eq!(config.min_segment_duration, 0.2);
        assert_eq!(config.vbx_max_iterations, 30);
    }
}
