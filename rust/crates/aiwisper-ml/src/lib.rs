//! ML inference crate for AIWisper
//!
//! Provides transcription, diarization, and VAD engines.

pub mod engine_manager;
pub mod fluidasr;
pub mod gigaam;
pub mod hybrid;
pub mod llm;
pub mod traits;
pub mod vad;
pub mod whisper;

pub use engine_manager::{get_recommended_model_for_language, EngineManager, EngineType};
pub use fluidasr::{FluidASREngine, FluidModelVersion};
pub use gigaam::GigaAMEngine;
pub use hybrid::{
    ConfidenceCalibration, HybridMode, HybridTranscriber, HybridTranscriptionConfig,
    HybridTranscriptionResult, TranscriptionImprovement, VotingConfig,
};
pub use llm::{LLMConfig, LLMSelector};
pub use traits::{DiarizationEngine, TranscriptionEngine, VadEngine};
pub use vad::{SileroVad, SileroVadConfig, VadSegment};
pub use whisper::WhisperEngine;
