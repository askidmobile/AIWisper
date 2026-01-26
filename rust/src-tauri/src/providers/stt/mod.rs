//! Speech-to-Text providers
//!
//! Contains implementations for various STT providers:
//! - Local: Whisper/GigaAM/Parakeet via local ML engines
//! - OpenAI: Whisper API
//! - Deepgram: Nova-2 API
//! - AssemblyAI: Universal API
//! - Groq: Fast Whisper inference

pub mod local;
pub mod openai;
pub mod deepgram;
pub mod groq;
// Future: pub mod assemblyai;

pub use local::LocalSTTProvider;
pub use openai::OpenAISTTProvider;
pub use deepgram::DeepgramSTTProvider;
pub use groq::GroqSTTProvider;

use super::types::STTProviderId;

/// Get human-readable name for an STT provider
pub fn provider_name(id: &STTProviderId) -> &'static str {
    match id {
        STTProviderId::Local => "Local (Whisper/GigaAM)",
        STTProviderId::OpenAI => "OpenAI Whisper",
        STTProviderId::Deepgram => "Deepgram Nova-2",
        STTProviderId::AssemblyAI => "AssemblyAI",
        STTProviderId::Groq => "Groq Whisper",
    }
}

/// Check if provider is a cloud service
pub fn is_cloud_provider(id: &STTProviderId) -> bool {
    match id {
        STTProviderId::Local => false,
        STTProviderId::OpenAI => true,
        STTProviderId::Deepgram => true,
        STTProviderId::AssemblyAI => true,
        STTProviderId::Groq => true,
    }
}

/// Get pricing info (cost per minute in USD)
pub fn pricing_per_minute(id: &STTProviderId) -> Option<f64> {
    match id {
        STTProviderId::Local => None, // Free (local)
        STTProviderId::OpenAI => Some(0.006),
        STTProviderId::Deepgram => Some(0.0043),
        STTProviderId::AssemblyAI => Some(0.00025), // Per second = $0.015/min
        STTProviderId::Groq => Some(0.0001), // Very low, has free tier
    }
}
