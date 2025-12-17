//! GigaAM transcription engine using ONNX Runtime
//!
//! GigaAM is a Russian-optimized ASR model from Sber AI.
//! Supports CoreML acceleration on macOS Apple Silicon.
//! Reference: https://github.com/salute-developers/GigaAM

use crate::traits::TranscriptionEngine;
use aiwisper_types::{TranscriptSegment, TranscriptWord, TranscriptionResult};
use anyhow::{Context, Result};
use ort::execution_providers::CoreMLExecutionProvider;
use ort::session::{builder::GraphOptimizationLevel, Session};
use std::sync::Mutex;
use std::time::Instant;

/// GigaAM constants
const SAMPLE_RATE: u32 = 16000;
const N_MELS: usize = 64;
const HOP_LENGTH: usize = 160; // 10ms at 16kHz
const WIN_LENGTH_V2: usize = 400; // 25ms for v2 models
const WIN_LENGTH_V3: usize = 320; // 20ms for v3 models
const N_FFT_V2: usize = 400;
const N_FFT_V3: usize = 320;

/// GigaAM model type
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GigaAMModelType {
    /// Character-level CTC (34 tokens)
    Ctc,
    /// End-to-end BPE (257 tokens, with punctuation)
    E2e,
}

/// GigaAM transcription engine with CoreML support
pub struct GigaAMEngine {
    session: Mutex<Session>,
    vocab: Vec<String>,
    blank_id: usize,
    space_id: Option<usize>,
    model_type: GigaAMModelType,
    mel_processor: MelProcessor,
    language: String,
    use_coreml: bool,
}

impl TranscriptionEngine for GigaAMEngine {
    fn name(&self) -> &str {
        "gigaam"
    }

    fn transcribe(&self, samples: &[f32]) -> Result<TranscriptionResult> {
        let segments = self.transcribe_with_segments(samples)?;

        let text = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        Ok(TranscriptionResult {
            text,
            segments,
            language: Some(self.language.clone()),
            processing_time_ms: 0,
            rtf: 0.0,
        })
    }

    fn transcribe_with_segments(&self, samples: &[f32]) -> Result<Vec<TranscriptSegment>> {
        let start = Instant::now();

        // Minimum audio length check (0.1 seconds)
        if samples.len() < SAMPLE_RATE as usize / 10 {
            return Ok(vec![]);
        }

        // Compute mel spectrogram
        let (mel_spec, num_frames) = self.compute_mel_spectrogram(samples);

        // Prepare input tensors
        // Flatten mel-spectrogram for tensor [batch, n_mels, time]
        let mut flat_mel = vec![0.0f32; N_MELS * num_frames];
        for i in 0..N_MELS {
            for j in 0..num_frames {
                flat_mel[i * num_frames + j] = mel_spec[j][i];
            }
        }

        // Run inference - ort 2.x uses tuple (shape, data) for Tensor::from_array
        let input_tensor =
            ort::value::Tensor::from_array(([1_i64, N_MELS as i64, num_frames as i64], flat_mel))?;

        let length_tensor = ort::value::Tensor::from_array(([1_i64], vec![num_frames as i64]))?;

        // Run inference - extract and copy data while holding lock, then release
        // GigaAM CTC models use "features"/"feature_lengths" as input names
        // GigaAM RNNT models use "audio_signal"/"length" as input names
        
        // Debug: log mel spectrogram stats
        tracing::debug!(
            "GigaAM: mel_spec shape={}x{}, mel_min={:.3}, mel_max={:.3}",
            num_frames,
            N_MELS,
            mel_spec.iter().flat_map(|f| f.iter()).cloned().fold(f32::INFINITY, f32::min),
            mel_spec.iter().flat_map(|f| f.iter()).cloned().fold(f32::NEG_INFINITY, f32::max)
        );
        
        let logits = {
            let mut session_guard = self.session.lock().unwrap();
            
            // Try CTC input names first (most common for e2e-ctc models)
            let outputs = session_guard.run(ort::inputs![
                "features" => input_tensor,
                "feature_lengths" => length_tensor,
            ])?;

            // Get output tensor - try "log_probs" first (CTC), then "logprobs", then "output"
            let output = outputs
                .get("log_probs")
                .or_else(|| outputs.get("logprobs"))
                .or_else(|| outputs.get("output"))
                .context("No output tensor found")?;

            // Extract tensor data - ort 2.x returns (&Shape, &[T])
            let (output_shape, output_data) = output.try_extract_tensor::<f32>()?;
            
            tracing::debug!(
                "GigaAM: output shape={:?}, data_len={}",
                output_shape,
                output_data.len()
            );

            // Convert to 2D [time, vocab] - copy data before releasing lock
            let time_steps = output_shape[1] as usize;
            let vocab_size = output_shape[2] as usize;
            
            tracing::debug!(
                "GigaAM: time_steps={}, vocab_size={}, expected_vocab={}",
                time_steps,
                vocab_size,
                self.vocab.len()
            );
            
            // Debug: check first frame values
            if !output_data.is_empty() {
                let first_frame = &output_data[0..vocab_size.min(output_data.len())];
                let max_val = first_frame.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                let min_val = first_frame.iter().cloned().fold(f32::INFINITY, f32::min);
                let has_nan = first_frame.iter().any(|v| v.is_nan());
                let all_zero = first_frame.iter().all(|v| *v == 0.0);
                
                tracing::debug!(
                    "GigaAM: first_frame min={:.4}, max={:.4}, has_nan={}, all_zero={}",
                    min_val,
                    max_val,
                    has_nan,
                    all_zero
                );
                
                // Also check what token index would win for first frame
                let (argmax_idx, argmax_val) = first_frame
                    .iter()
                    .enumerate()
                    .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
                    .unwrap_or((0, &0.0));
                tracing::debug!(
                    "GigaAM: first_frame argmax: idx={}, val={:.4}, is_blank={}",
                    argmax_idx,
                    argmax_val,
                    argmax_idx == self.blank_id
                );
            }

            let mut logits: Vec<Vec<f32>> = Vec::with_capacity(time_steps);
            for t in 0..time_steps {
                let start_idx = t * vocab_size;
                let end_idx = start_idx + vocab_size;
                logits.push(output_data[start_idx..end_idx].to_vec());
            }
            logits
            // session_guard dropped here, lock released
        };

        // Decode based on model type
        let audio_duration = samples.len() as f64 / SAMPLE_RATE as f64;
        
        // Debug: log logits statistics
        if !logits.is_empty() {
            let first_frame = &logits[0];
            let (max_idx, max_val) = first_frame
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
                .unwrap_or((0, &0.0));
            
            // Count blank predictions across all frames
            let mut blank_count = 0;
            let mut non_blank_count = 0;
            for frame in &logits {
                let (idx, _) = frame
                    .iter()
                    .enumerate()
                    .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
                    .unwrap_or((0, &0.0));
                if idx == self.blank_id {
                    blank_count += 1;
                } else {
                    non_blank_count += 1;
                }
            }
            
            tracing::debug!(
                "GigaAM decode: {} frames, vocab_size={}, blank_id={}, first_frame_max_idx={}, max_val={:.3}, blank_frames={}, non_blank_frames={}",
                logits.len(),
                first_frame.len(),
                self.blank_id,
                max_idx,
                max_val,
                blank_count,
                non_blank_count
            );
        }
        
        let segments = match self.model_type {
            GigaAMModelType::E2e => self.decode_e2e_with_timestamps(&logits, audio_duration),
            GigaAMModelType::Ctc => self.decode_ctc_with_timestamps(&logits, audio_duration),
        };

        let elapsed = start.elapsed();
        let rtf = audio_duration / elapsed.as_secs_f64();

        tracing::debug!(
            "GigaAM: transcribed {:.1}s audio in {:.2}s (RTFx: {:.1}), {} segments",
            audio_duration,
            elapsed.as_secs_f64(),
            rtf,
            segments.len()
        );

        Ok(segments)
    }

    fn supported_languages(&self) -> &[&str] {
        // GigaAM is optimized for Russian only
        &["ru"]
    }

    fn set_language(&mut self, language: &str) -> Result<()> {
        if language != "ru" && language != "auto" {
            tracing::warn!(
                "GigaAM only supports Russian, ignoring language: {}",
                language
            );
        }
        self.language = "ru".to_string();
        Ok(())
    }

    fn set_hotwords(&mut self, _hotwords: &[String]) -> Result<()> {
        // GigaAM doesn't support hotwords at model level
        // They are applied as post-processing in hybrid transcription
        Ok(())
    }
}

impl GigaAMEngine {
    /// Create new GigaAM engine with model and vocab paths
    /// Automatically enables CoreML on Apple Silicon
    pub fn new(model_path: &str, vocab_path: &str) -> Result<Self> {
        Self::new_with_options(model_path, vocab_path, true)
    }

    /// Create GigaAM engine with explicit CoreML option
    pub fn new_with_options(model_path: &str, vocab_path: &str, use_coreml: bool) -> Result<Self> {
        tracing::info!("Loading GigaAM model from: {}", model_path);

        // Detect model version and type from filename
        let model_path_lower = model_path.to_lowercase();
        let is_v3 = model_path_lower.contains("v3");
        let is_e2e = model_path_lower.contains("e2e");

        let model_type = if is_e2e {
            tracing::info!("GigaAM: detected E2E model (BPE tokenization)");
            GigaAMModelType::E2e
        } else {
            tracing::info!("GigaAM: detected CTC model (character-level)");
            GigaAMModelType::Ctc
        };

        // Configure mel spectrogram parameters based on model version
        let (win_length, n_fft, center) = if is_v3 {
            tracing::info!(
                "GigaAM: v3 model, win_length={}, n_fft={}",
                WIN_LENGTH_V3,
                N_FFT_V3
            );
            (WIN_LENGTH_V3, N_FFT_V3, false)
        } else {
            tracing::info!(
                "GigaAM: v2/v1 model, win_length={}, n_fft={}",
                WIN_LENGTH_V2,
                N_FFT_V2
            );
            (WIN_LENGTH_V2, N_FFT_V2, true)
        };

        let mel_processor = MelProcessor::new(MelConfig {
            sample_rate: SAMPLE_RATE,
            n_mels: N_MELS,
            hop_length: HOP_LENGTH,
            win_length,
            n_fft,
            center,
        });

        // Load vocabulary
        let (vocab, blank_id, space_id) = load_vocab(vocab_path)?;
        tracing::info!(
            "GigaAM: vocab={} tokens, blank_id={}, space_id={:?}",
            vocab.len(),
            blank_id,
            space_id
        );

        // Detect if we're on Apple Silicon for CoreML support
        let is_apple_silicon = cfg!(target_os = "macos") && cfg!(target_arch = "aarch64");
        let enable_coreml = use_coreml && is_apple_silicon;

        // Create ONNX session with CoreML if available
        let session = if enable_coreml {
            tracing::info!("GigaAM: Attempting CoreML acceleration (Apple Silicon)");

            // Try to create session with CoreML
            match Session::builder()?
                .with_execution_providers([CoreMLExecutionProvider::default()
                    .with_subgraphs(true) // Enable subgraph partitioning
                    .build()])?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .with_intra_threads(4)?
                .commit_from_file(model_path)
            {
                Ok(session) => {
                    tracing::info!("GigaAM: CoreML acceleration enabled");
                    session
                }
                Err(e) => {
                    tracing::warn!("GigaAM: CoreML failed ({}), falling back to CPU", e);
                    Session::builder()?
                        .with_optimization_level(GraphOptimizationLevel::Level3)?
                        .with_intra_threads(4)?
                        .commit_from_file(model_path)
                        .context("Failed to load GigaAM ONNX model")?
                }
            }
        } else {
            tracing::info!("GigaAM: Using CPU inference");
            Session::builder()?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .with_intra_threads(4)?
                .commit_from_file(model_path)
                .context("Failed to load GigaAM ONNX model")?
        };

        tracing::info!("GigaAM model loaded successfully");

        Ok(Self {
            session: Mutex::new(session),
            vocab,
            blank_id,
            space_id,
            model_type,
            mel_processor,
            language: "ru".to_string(),
            use_coreml: enable_coreml,
        })
    }

    /// Check if CoreML acceleration is enabled
    pub fn is_coreml_enabled(&self) -> bool {
        self.use_coreml
    }

    /// Compute log-mel spectrogram
    fn compute_mel_spectrogram(&self, samples: &[f32]) -> (Vec<Vec<f32>>, usize) {
        self.mel_processor.compute(samples)
    }

    /// Decode CTC output with timestamps
    fn decode_ctc_with_timestamps(
        &self,
        logits: &[Vec<f32>],
        audio_duration: f64,
    ) -> Vec<TranscriptSegment> {
        if logits.is_empty() {
            return vec![];
        }

        // GigaAM uses subsampling factor 4, each frame ~40ms
        let frame_ms = audio_duration * 1000.0 / logits.len() as f64;

        let mut words: Vec<TranscriptWord> = vec![];
        let mut current_word = String::new();
        let mut word_start: Option<i64> = None;
        let mut last_confidence: f32 = 0.9;
        let mut prev_token = self.blank_id;

        for (t, frame) in logits.iter().enumerate() {
            // Find token with maximum probability
            let (max_idx, _max_val) = frame
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
                .unwrap_or((0, &0.0));

            let frame_time = (t as f64 * frame_ms) as i64;
            let current_confidence = softmax_max(frame);

            // CTC rule: skip blank and repeated tokens
            if max_idx != self.blank_id && max_idx != prev_token {
                if max_idx < self.vocab.len() {
                    let token = &self.vocab[max_idx];
                    last_confidence = current_confidence;

                    // ▁ = space = start of new word
                    if self.space_id == Some(max_idx) {
                        // Save previous word if exists
                        if !current_word.is_empty() {
                            if let Some(start) = word_start {
                                words.push(TranscriptWord {
                                    start,
                                    end: frame_time,
                                    text: current_word.clone(),
                                    confidence: last_confidence,
                                });
                            }
                            current_word.clear();
                        }
                        word_start = Some(frame_time);
                    } else {
                        // Regular character - add to current word
                        if word_start.is_none() {
                            word_start = Some(frame_time);
                        }
                        current_word.push_str(token);
                    }
                }
            }
            prev_token = max_idx;
        }

        // Add last word
        if !current_word.is_empty() {
            if let Some(start) = word_start {
                words.push(TranscriptWord {
                    start,
                    end: (audio_duration * 1000.0) as i64,
                    text: current_word,
                    confidence: last_confidence,
                });
            }
        }

        // Form segment from all words
        if words.is_empty() {
            return vec![];
        }

        let full_text = words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        vec![TranscriptSegment {
            start: words.first().map(|w| w.start).unwrap_or(0),
            end: words.last().map(|w| w.end).unwrap_or(0),
            text: full_text,
            speaker: None,
            words,
            confidence: 0.9,
        }]
    }

    /// Decode E2E (BPE) output with timestamps
    fn decode_e2e_with_timestamps(
        &self,
        logits: &[Vec<f32>],
        audio_duration: f64,
    ) -> Vec<TranscriptSegment> {
        if logits.is_empty() {
            return vec![];
        }

        let frame_ms = audio_duration * 1000.0 / logits.len() as f64;

        let mut words: Vec<TranscriptWord> = vec![];
        let mut current_tokens: Vec<BpeTokenInfo> = vec![];
        let mut prev_token = self.blank_id;
        
        // Debug: collect first few non-blank tokens
        let mut debug_tokens: Vec<(usize, String, f32)> = vec![];
        let mut total_non_blank = 0;

        for (t, frame) in logits.iter().enumerate() {
            let (max_idx, max_val) = frame
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
                .unwrap_or((0, &0.0));

            let frame_time = (t as f64 * frame_ms) as i64;
            let current_confidence = softmax_max(frame);
            
            // Debug: log some non-blank tokens
            if max_idx != self.blank_id {
                total_non_blank += 1;
                if debug_tokens.len() < 10 {
                    let token_str = if max_idx < self.vocab.len() {
                        self.vocab[max_idx].clone()
                    } else {
                        format!("[OOV:{}]", max_idx)
                    };
                    debug_tokens.push((max_idx, token_str, *max_val));
                }
            }

            if max_idx != self.blank_id && max_idx != prev_token {
                if max_idx < self.vocab.len() {
                    let mut token = self.vocab[max_idx].clone();

                    // Skip <unk>
                    if token != "<unk>" {
                        // ▁ means start of new word
                        if token.starts_with('▁') {
                            // Save previous word
                            if !current_tokens.is_empty() {
                                if let Some(word) = merge_tokens_to_word(&current_tokens) {
                                    words.push(word);
                                }
                                current_tokens.clear();
                            }
                            // Remove ▁ prefix
                            token = token.trim_start_matches('▁').to_string();
                        }

                        if !token.is_empty() {
                            current_tokens.push(BpeTokenInfo {
                                text: token,
                                start_time: frame_time,
                                end_time: frame_time,
                                confidence: current_confidence,
                            });
                        }
                    }
                }
            }
            prev_token = max_idx;
        }
        
        // Debug output
        if !debug_tokens.is_empty() {
            tracing::debug!(
                "GigaAM E2E decode: total_non_blank={}, first tokens: {:?}",
                total_non_blank,
                debug_tokens
            );
        } else {
            tracing::warn!(
                "GigaAM E2E decode: ALL frames are blank_id={}, vocab_size={}",
                self.blank_id,
                self.vocab.len()
            );
        }

        // Add last word
        if !current_tokens.is_empty() {
            if let Some(word) = merge_tokens_to_word(&current_tokens) {
                words.push(word);
            }
        }

        if words.is_empty() {
            return vec![];
        }

        let full_text = words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        vec![TranscriptSegment {
            start: words.first().map(|w| w.start).unwrap_or(0),
            end: words.last().map(|w| w.end).unwrap_or(0),
            text: full_text,
            speaker: None,
            words,
            confidence: 0.9,
        }]
    }
}

// ============================================================================
// Helper structures and functions
// ============================================================================

/// BPE token info for E2E decoding
struct BpeTokenInfo {
    text: String,
    start_time: i64,
    end_time: i64,
    confidence: f32,
}

/// Merge BPE tokens into a word
fn merge_tokens_to_word(tokens: &[BpeTokenInfo]) -> Option<TranscriptWord> {
    if tokens.is_empty() {
        return None;
    }

    let text: String = tokens.iter().map(|t| t.text.as_str()).collect();
    let total_confidence: f32 = tokens.iter().map(|t| t.confidence).sum();
    let avg_confidence = total_confidence / tokens.len() as f32;

    let start = tokens.first().map(|t| t.start_time).unwrap_or(0);
    let end = tokens.last().map(|t| t.end_time).unwrap_or(0);

    Some(TranscriptWord {
        start,
        end,
        text,
        confidence: avg_confidence,
    })
}

/// Compute softmax max probability
fn softmax_max(logits: &[f32]) -> f32 {
    let max_val = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);

    let mut sum = 0.0f32;
    let mut max_prob = 0.0f32;

    for &v in logits {
        let exp = (v - max_val).exp();
        sum += exp;
        if exp > max_prob {
            max_prob = exp;
        }
    }

    max_prob / sum
}

/// Load vocabulary from file
fn load_vocab(path: &str) -> Result<(Vec<String>, usize, Option<usize>)> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read vocab file: {}", path))?;

    let mut vocab = Vec::new();
    let mut blank_id = None;
    let mut space_id = None;

    for line in content.lines() {
        // Format: "token index" or "token\tindex"
        let parts: Vec<&str> = line.rsplitn(2, |c| c == ' ' || c == '\t').collect();

        let token = if parts.len() == 2 {
            parts[1].to_string()
        } else if parts.len() == 1 {
            parts[0].to_string()
        } else {
            continue;
        };

        let idx = vocab.len();

        // Find blank token
        if token == "<blk>" || token == "<blank>" || token == "[blank]" {
            blank_id = Some(idx);
        }

        // Find space token (space " " or ▁)
        if token == " " || token == "▁" {
            space_id = Some(idx);
        }

        vocab.push(token);
    }

    // If blank not found, assume last token
    let blank_id = blank_id.unwrap_or(vocab.len().saturating_sub(1));

    Ok((vocab, blank_id, space_id))
}

// ============================================================================
// Mel Spectrogram Processing
// ============================================================================

/// Mel spectrogram configuration
pub struct MelConfig {
    pub sample_rate: u32,
    pub n_mels: usize,
    pub hop_length: usize,
    pub win_length: usize,
    pub n_fft: usize,
    pub center: bool,
}

/// Mel spectrogram processor
pub struct MelProcessor {
    config: MelConfig,
    mel_filterbank: Vec<Vec<f32>>,
    window: Vec<f32>,
}

impl MelProcessor {
    /// Create new mel processor
    pub fn new(config: MelConfig) -> Self {
        // Create Hann window (symmetric, matches torch.hann_window with periodic=False)
        // Note: GigaAM uses symmetric window (n-1 in denominator)
        let window: Vec<f32> = (0..config.win_length)
            .map(|i| {
                let n = (config.win_length - 1) as f32;
                0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n).cos())
            })
            .collect();

        // Create mel filterbank
        let mel_filterbank = create_mel_filterbank(config.sample_rate, config.n_fft, config.n_mels);

        Self {
            config,
            mel_filterbank,
            window,
        }
    }

    /// Compute log-mel spectrogram
    pub fn compute(&self, samples: &[f32]) -> (Vec<Vec<f32>>, usize) {
        let n_fft = self.config.n_fft;
        let hop_length = self.config.hop_length;
        let win_length = self.config.win_length;

        // Pad signal if center=true
        let padded: Vec<f32> = if self.config.center {
            let pad_size = n_fft / 2;
            let mut p = vec![0.0; pad_size];
            p.extend_from_slice(samples);
            p.extend(vec![0.0; pad_size]);
            p
        } else {
            samples.to_vec()
        };

        // Calculate number of frames
        let num_frames = (padded.len() - win_length) / hop_length + 1;

        // Compute STFT and mel spectrogram
        let mut mel_spec: Vec<Vec<f32>> = Vec::with_capacity(num_frames);

        for frame_idx in 0..num_frames {
            let start = frame_idx * hop_length;
            let end = start + win_length;

            if end > padded.len() {
                break;
            }

            // Apply window and compute FFT
            let mut windowed: Vec<f32> = padded[start..end]
                .iter()
                .zip(self.window.iter())
                .map(|(s, w)| s * w)
                .collect();

            // Zero-pad to n_fft
            windowed.resize(n_fft, 0.0);

            // Compute power spectrum using real FFT
            let power_spec = compute_power_spectrum(&windowed);

            // Apply mel filterbank
            let mut mel_frame = vec![0.0f32; self.config.n_mels];
            for (m, filter) in self.mel_filterbank.iter().enumerate() {
                let mut sum = 0.0;
                for (f, &weight) in filter.iter().enumerate() {
                    if f < power_spec.len() {
                        sum += power_spec[f] * weight;
                    }
                }
                // Log mel with floor to avoid log(0)
                mel_frame[m] = (sum.max(1e-10)).ln();
            }

            mel_spec.push(mel_frame);
        }

        let num_frames = mel_spec.len();
        (mel_spec, num_frames)
    }
}

/// Compute power spectrum from windowed samples
fn compute_power_spectrum(samples: &[f32]) -> Vec<f32> {
    let n = samples.len();
    let n_fft = n / 2 + 1;

    // Simple DFT implementation (for correctness)
    // In production, use rustfft for performance
    let mut power = vec![0.0f32; n_fft];

    for k in 0..n_fft {
        let mut real = 0.0f32;
        let mut imag = 0.0f32;

        for (t, &sample) in samples.iter().enumerate() {
            let angle = -2.0 * std::f32::consts::PI * (k * t) as f32 / n as f32;
            real += sample * angle.cos();
            imag += sample * angle.sin();
        }

        power[k] = real * real + imag * imag;
    }

    power
}

/// Create mel filterbank (compatible with torchaudio/librosa)
/// Uses Hz-based interpolation (not bin indices) for better accuracy
fn create_mel_filterbank(sample_rate: u32, n_fft: usize, n_mels: usize) -> Vec<Vec<f32>> {
    let num_bins = n_fft / 2 + 1;
    let fmax = sample_rate as f32 / 2.0;

    // Convert Hz to Mel (HTK formula)
    let hz_to_mel = |hz: f32| -> f32 { 2595.0 * (1.0 + hz / 700.0).log10() };
    let mel_to_hz = |mel: f32| -> f32 { 700.0 * (10.0_f32.powf(mel / 2595.0) - 1.0) };

    // Frequencies for each FFT bin
    let all_freqs: Vec<f32> = (0..num_bins)
        .map(|i| i as f32 * fmax / (num_bins - 1) as f32)
        .collect();

    // Mel points (n_mels + 2 points: left edge, centers, right edge)
    let mel_min = hz_to_mel(0.0);
    let mel_max = hz_to_mel(fmax);
    let f_pts: Vec<f32> = (0..=n_mels + 1)
        .map(|i| {
            let mel = mel_min + i as f32 * (mel_max - mel_min) / (n_mels + 1) as f32;
            mel_to_hz(mel)
        })
        .collect();

    // Differences between adjacent points (for normalization)
    let f_diff: Vec<f32> = (0..n_mels + 1)
        .map(|i| f_pts[i + 1] - f_pts[i])
        .collect();

    // Create triangular filters (as in torchaudio)
    let mut filterbank = vec![vec![0.0f32; num_bins]; n_mels];

    for m in 0..n_mels {
        for (k, &freq) in all_freqs.iter().enumerate() {
            // Lower slope: (freq - f_pts[m]) / (f_pts[m+1] - f_pts[m])
            // Upper slope: (f_pts[m+2] - freq) / (f_pts[m+2] - f_pts[m+1])
            let lower = (freq - f_pts[m]) / f_diff[m];
            let upper = (f_pts[m + 2] - freq) / f_diff[m + 1];

            // Take minimum and clamp to [0, inf)
            let val = lower.min(upper).max(0.0);
            filterbank[m][k] = val;
        }
    }

    filterbank
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_softmax_max() {
        let logits = vec![1.0, 2.0, 3.0, 0.5];
        let prob = softmax_max(&logits);
        assert!(prob > 0.0 && prob <= 1.0);
    }

    #[test]
    fn test_mel_filterbank() {
        let filterbank = create_mel_filterbank(16000, 400, 64);
        assert_eq!(filterbank.len(), 64);
        assert_eq!(filterbank[0].len(), 201); // n_fft/2 + 1
    }
}
