//! ML inference crate for AIWisper
//!
//! Provides transcription, diarization, VAD, voiceprint matching, and dialogue merge.

pub mod dialogue_merge;
pub mod diarization;
pub mod engine_manager;
pub mod fluidasr;
pub mod gigaam;
pub mod hybrid;
pub mod llm;
pub mod traits;
pub mod vad;
pub mod voiceprint;
pub mod whisper;

pub use diarization::{
    DiarizationResult, FluidDiarizationConfig, FluidDiarizationEngine, SpeakerEmbedding,
};
pub use engine_manager::{
    clear_engine_cache, get_engine_cache_info, get_or_create_engine_cached,
    get_recommended_model_for_language, EngineManager, EngineType,
};
pub use fluidasr::{FluidASREngine, FluidModelVersion};
pub use gigaam::GigaAMEngine;
pub use hybrid::{
    ConfidenceCalibration, HybridMode, HybridTranscriber, HybridTranscriptionConfig,
    HybridTranscriptionResult, TranscriptionImprovement, VotingConfig,
};
pub use llm::{LLMConfig, LLMSelector};
pub use traits::{DiarizationEngine, TranscriptionEngine, VadEngine};
pub use vad::{SileroVad, SileroVadConfig, VadSegment};
pub use voiceprint::{
    cosine_distance, cosine_similarity, MatchConfidence, MatchResult, VoicePrint,
    VoicePrintMatcher, THRESHOLD_HIGH, THRESHOLD_LOW, THRESHOLD_MEDIUM, THRESHOLD_MIN,
};
pub use whisper::WhisperEngine;

// Dialogue merge
pub use dialogue_merge::{is_mic_speaker, merge_words_to_dialogue};
