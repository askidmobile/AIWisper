//! Settings-related Tauri commands

use crate::providers::{LLMProvidersSettings, STTProvidersSettings};
use crate::state::AppState;
use aiwisper_types::Settings;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

/// Get current application settings
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    tracing::debug!("Getting settings");

    state.get_settings().await.map_err(|e| e.to_string())
}

/// Update application settings
#[tauri::command]
pub async fn set_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    tracing::info!("Updating settings");

    state
        .set_settings(settings)
        .await
        .map_err(|e| e.to_string())
}

// ============================================================================
// UI Settings (full config.json structure for frontend)
// ============================================================================

/// Hybrid transcription settings from UI
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HybridTranscriptionSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub secondary_model_id: String,
    #[serde(default)]
    pub confidence_threshold: f64,
    #[serde(default)]
    pub context_words: u32,
    #[serde(default, alias = "useLLMForMerge")]
    pub use_llm_for_merge: bool,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub hotwords: Vec<String>,
}

/// Full UI settings structure (matches frontend AppSettings)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UISettings {
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub mic_device: String,
    #[serde(default = "default_true")]
    pub capture_system: bool,
    #[serde(default)]
    pub use_voice_isolation: bool,
    #[serde(default = "default_echo_cancel")]
    pub echo_cancel: f64,
    #[serde(default = "default_vad_mode")]
    pub vad_mode: String,
    #[serde(default = "default_vad_method")]
    pub vad_method: String,
    #[serde(default = "default_pause_threshold")]
    pub pause_threshold: f64,
    #[serde(default)]
    pub enable_streaming: bool,
    #[serde(default = "default_streaming_chunk_seconds")]
    pub streaming_chunk_seconds: u32,
    #[serde(default = "default_streaming_confirmation_threshold")]
    pub streaming_confirmation_threshold: f64,
    #[serde(default = "default_ollama_model")]
    pub ollama_model: String,
    #[serde(default = "default_ollama_url")]
    pub ollama_url: String,
    #[serde(default = "default_ollama_context_size")]
    pub ollama_context_size: u32,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub diarization_enabled: bool,
    #[serde(default)]
    pub diarization_seg_model_id: String,
    #[serde(default)]
    pub diarization_emb_model_id: String,
    #[serde(default = "default_diarization_provider")]
    pub diarization_provider: String,
    #[serde(default = "default_true")]
    pub show_session_stats: bool,
    #[serde(default)]
    pub hybrid_transcription: HybridTranscriptionSettings,
    /// STT providers settings (cloud and local)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_providers: Option<STTProvidersSettings>,
    /// LLM providers settings (Ollama, OpenAI, OpenRouter)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_providers: Option<LLMProvidersSettings>,
}

fn default_language() -> String { "ru".to_string() }
fn default_true() -> bool { true }
fn default_echo_cancel() -> f64 { 0.4 }
fn default_vad_mode() -> String { "auto".to_string() }
fn default_vad_method() -> String { "auto".to_string() }
fn default_pause_threshold() -> f64 { 0.5 }
fn default_streaming_chunk_seconds() -> u32 { 15 }
fn default_streaming_confirmation_threshold() -> f64 { 0.85 }
fn default_ollama_model() -> String { "llama3.2".to_string() }
fn default_ollama_url() -> String { "http://localhost:11434".to_string() }
fn default_ollama_context_size() -> u32 { 8 }
fn default_theme() -> String { "dark".to_string() }
fn default_diarization_provider() -> String { "auto".to_string() }

impl Default for UISettings {
    fn default() -> Self {
        Self {
            language: default_language(),
            model_id: None,
            mic_device: String::new(),
            capture_system: true,
            use_voice_isolation: false,
            echo_cancel: default_echo_cancel(),
            vad_mode: default_vad_mode(),
            vad_method: default_vad_method(),
            pause_threshold: default_pause_threshold(),
            enable_streaming: false,
            streaming_chunk_seconds: default_streaming_chunk_seconds(),
            streaming_confirmation_threshold: default_streaming_confirmation_threshold(),
            ollama_model: default_ollama_model(),
            ollama_url: default_ollama_url(),
            ollama_context_size: default_ollama_context_size(),
            theme: default_theme(),
            diarization_enabled: false,
            diarization_seg_model_id: String::new(),
            diarization_emb_model_id: String::new(),
            diarization_provider: default_diarization_provider(),
            show_session_stats: true,
            hybrid_transcription: HybridTranscriptionSettings::default(),
            stt_providers: None,
            llm_providers: None,
        }
    }
}

/// Config file structure for UI settings
#[derive(Debug, Serialize, Deserialize)]
struct UIConfigFile {
    settings: UISettings,
}

/// Get path to UI settings file
fn get_ui_settings_path() -> Option<PathBuf> {
    dirs::data_dir().map(|p| p.join("aiwisper").join("config.json"))
}

/// Load UI settings from config.json
#[tauri::command]
pub async fn load_ui_settings() -> Result<UISettings, String> {
    let path = get_ui_settings_path().ok_or("Failed to get settings path")?;
    
    if !path.exists() {
        tracing::info!("UI settings file not found, returning defaults");
        return Ok(UISettings::default());
    }
    
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read settings file: {}", e))?;
    
    let config: UIConfigFile = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings file: {}", e))?;
    
    tracing::info!("Loaded UI settings from {:?}, ollamaModel={}", path, config.settings.ollama_model);
    
    Ok(config.settings)
}

/// Save UI settings to config.json
#[tauri::command]
pub async fn save_ui_settings(settings: UISettings) -> Result<(), String> {
    let path = get_ui_settings_path().ok_or("Failed to get settings path")?;
    
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings directory: {}", e))?;
    }
    
    let config = UIConfigFile { settings };
    
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write settings file: {}", e))?;
    
    tracing::info!("Saved UI settings to {:?}", path);
    
    Ok(())
}
