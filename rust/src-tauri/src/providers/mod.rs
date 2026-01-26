//! Providers module
//!
//! Contains cloud and local providers for Speech-to-Text (STT) and LLM services.

pub mod keystore;
pub mod llm;
pub mod registry;
pub mod stt;
pub mod traits;
pub mod types;

pub use keystore::KeyStore;
pub use registry::ProviderRegistry;
pub use traits::{GenerationOptions, GenerationResult, LLMProvider, STTProvider, TranscriptionOptions, TranscriptionResult, TranscriptionSegment};
pub use types::*;
