//! Provider-related Tauri commands
//!
//! Commands for managing STT and LLM providers, API keys, and connection testing.

use crate::commands::settings::{load_ui_settings, save_ui_settings};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::providers::{
    ConnectionTestResult, LLMProviderId, LLMProvidersSettings, ProviderStatus, STTProviderId,
    STTProvidersSettings,
};

// ============================================================================
// Request/Response Types
// ============================================================================

/// Request to set an API key
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetApiKeyRequest {
    /// Provider type: "stt" or "llm"
    pub provider_type: String,
    /// Provider ID
    pub provider_id: String,
    /// API key value
    pub api_key: String,
}

/// Request to remove an API key
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveApiKeyRequest {
    /// Provider type: "stt" or "llm"
    pub provider_type: String,
    /// Provider ID
    pub provider_id: String,
}

/// Request to test provider connection
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionRequest {
    /// Provider type: "stt" or "llm"
    pub provider_type: String,
    /// Provider ID
    pub provider_id: String,
}

/// Combined provider status response
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersStatusResponse {
    pub stt: Vec<ProviderStatus>,
    pub llm: Vec<ProviderStatus>,
}

// ============================================================================
// STT Provider Commands
// ============================================================================

/// Get STT providers settings
#[tauri::command]
pub async fn get_stt_providers_settings(
    state: State<'_, AppState>,
) -> Result<STTProvidersSettings, String> {
    tracing::info!("Getting STT providers settings");

    // Try to load from UI settings first
    match load_ui_settings().await {
        Ok(mut ui_settings) => {
            if let Some(stt_settings) = ui_settings.stt_providers {
                tracing::info!("Loaded STT settings from UI settings: {:?}", stt_settings.active_provider);
                return Ok(stt_settings);
            } else {
                tracing::info!("No STT settings found in UI settings, initializing with defaults");
                // Initialize with defaults and save
                let registry = state.provider_registry();
                let defaults = registry.get_stt_settings().await;
                ui_settings.stt_providers = Some(defaults.clone());
                if let Err(e) = save_ui_settings(ui_settings).await {
                    tracing::warn!("Failed to save default STT settings: {}", e);
                }
                return Ok(defaults);
            }
        }
        Err(e) => {
            tracing::warn!("Failed to load UI settings for STT providers: {}", e);
        }
    }

    // Fallback to registry defaults
    let registry = state.provider_registry();
    let defaults = registry.get_stt_settings().await;
    tracing::info!("Using STT settings defaults: {:?}", defaults.active_provider);
    Ok(defaults)
}

/// Set STT providers settings
#[tauri::command]
pub async fn set_stt_providers_settings(
    state: State<'_, AppState>,
    settings: STTProvidersSettings,
) -> Result<(), String> {
    tracing::info!(
        "Setting STT providers settings, active: {:?}",
        settings.active_provider
    );

    // Save to UI settings
    let mut ui_settings = load_ui_settings().await.unwrap_or_default();
    ui_settings.stt_providers = Some(settings.clone());
    save_ui_settings(ui_settings).await?;

    // Also update registry for runtime
    let registry = state.provider_registry();
    registry.set_stt_settings(settings).await;
    Ok(())
}

// ============================================================================
// LLM Provider Commands
// ============================================================================

/// Get LLM providers settings
#[tauri::command]
pub async fn get_llm_providers_settings(
    state: State<'_, AppState>,
) -> Result<LLMProvidersSettings, String> {
    tracing::info!("Getting LLM providers settings");

    // Try to load from UI settings first
    match load_ui_settings().await {
        Ok(mut ui_settings) => {
            if let Some(llm_settings) = ui_settings.llm_providers {
                tracing::info!("Loaded LLM settings from UI settings: {:?}", llm_settings.active_provider);
                return Ok(llm_settings);
            } else {
                tracing::info!("No LLM settings found in UI settings, initializing with defaults");
                // Initialize with defaults and save
                let registry = state.provider_registry();
                let defaults = registry.get_llm_settings().await;
                ui_settings.llm_providers = Some(defaults.clone());
                if let Err(e) = save_ui_settings(ui_settings).await {
                    tracing::warn!("Failed to save default LLM settings: {}", e);
                }
                return Ok(defaults);
            }
        }
        Err(e) => {
            tracing::warn!("Failed to load UI settings for LLM providers: {}", e);
        }
    }

    // Fallback to registry defaults
    let registry = state.provider_registry();
    let defaults = registry.get_llm_settings().await;
    tracing::info!("Using LLM settings defaults: {:?}", defaults.active_provider);
    Ok(defaults)
}

/// Set LLM providers settings
#[tauri::command]
pub async fn set_llm_providers_settings(
    state: State<'_, AppState>,
    settings: LLMProvidersSettings,
) -> Result<(), String> {
    tracing::info!(
        "Setting LLM providers settings, active: {:?}",
        settings.active_provider
    );

    // Save to UI settings
    let mut ui_settings = load_ui_settings().await.unwrap_or_default();
    ui_settings.llm_providers = Some(settings.clone());
    save_ui_settings(ui_settings).await?;

    // Also update registry for runtime
    let registry = state.provider_registry();
    registry.set_llm_settings(settings).await;
    Ok(())
}

// ============================================================================
// API Key Management
// ============================================================================

/// Set an API key for a provider
#[tauri::command]
pub async fn set_provider_api_key(
    state: State<'_, AppState>,
    request: SetApiKeyRequest,
) -> Result<(), String> {
    tracing::info!(
        "Setting API key for {} provider: {}",
        request.provider_type,
        request.provider_id
    );

    let registry = state.provider_registry();
    let keystore = registry.keystore();

    match request.provider_type.as_str() {
        "stt" => {
            let provider_id = parse_stt_provider_id(&request.provider_id)?;
            tracing::info!("Storing STT API key for provider: {:?}, key length: {}", provider_id, request.api_key.len());
            
            match keystore.store_stt_api_key(provider_id.clone(), &request.api_key).await {
                Ok(_) => {
                    tracing::info!("Successfully stored STT API key for {:?}", provider_id);
                }
                Err(e) => {
                    tracing::error!("Failed to store STT API key for {:?}: {}", provider_id, e);
                    return Err(e);
                }
            }
            
            // Reload the provider with the new API key
            tracing::info!("Reloading STT API keys...");
            registry.load_stt_api_keys().await;
            tracing::info!("STT API keys reloaded");
            Ok(())
        }
        "llm" => {
            let provider_id = parse_llm_provider_id(&request.provider_id)?;
            tracing::info!("Storing LLM API key for provider: {:?}, key length: {}", provider_id, request.api_key.len());
            
            match keystore.store_llm_api_key(provider_id.clone(), &request.api_key).await {
                Ok(_) => {
                    tracing::info!("Successfully stored LLM API key for {:?}", provider_id);
                }
                Err(e) => {
                    tracing::error!("Failed to store LLM API key for {:?}: {}", provider_id, e);
                    return Err(e);
                }
            }
            
            // Reload the provider with the new API key
            tracing::info!("Reloading LLM API keys...");
            registry.load_llm_api_keys().await;
            tracing::info!("LLM API keys reloaded");
            Ok(())
        }
        _ => Err(format!("Unknown provider type: {}", request.provider_type)),
    }
}

/// Remove an API key for a provider
#[tauri::command]
pub async fn remove_provider_api_key(
    state: State<'_, AppState>,
    request: RemoveApiKeyRequest,
) -> Result<(), String> {
    tracing::info!(
        "Removing API key for {} provider: {}",
        request.provider_type,
        request.provider_id
    );

    let registry = state.provider_registry();
    let keystore = registry.keystore();

    match request.provider_type.as_str() {
        "stt" => {
            let provider_id = parse_stt_provider_id(&request.provider_id)?;
            keystore.delete_stt_api_key(provider_id).await
        }
        "llm" => {
            let provider_id = parse_llm_provider_id(&request.provider_id)?;
            keystore.delete_llm_api_key(provider_id).await
        }
        _ => Err(format!("Unknown provider type: {}", request.provider_type)),
    }
}

/// Check if an API key is set for a provider
#[tauri::command]
pub async fn has_provider_api_key(
    state: State<'_, AppState>,
    provider_type: String,
    provider_id: String,
) -> Result<bool, String> {
    let registry = state.provider_registry();
    let keystore = registry.keystore();

    match provider_type.as_str() {
        "stt" => {
            let id = parse_stt_provider_id(&provider_id)?;
            Ok(keystore.has_stt_api_key(id).await)
        }
        "llm" => {
            let id = parse_llm_provider_id(&provider_id)?;
            Ok(keystore.has_llm_api_key(id).await)
        }
        _ => Err(format!("Unknown provider type: {}", provider_type)),
    }
}

// ============================================================================
// Connection Testing
// ============================================================================

/// Test connection to a provider
#[tauri::command]
pub async fn test_provider_connection(
    state: State<'_, AppState>,
    request: TestConnectionRequest,
) -> Result<ConnectionTestResult, String> {
    tracing::info!(
        "Testing connection to {} provider: {}",
        request.provider_type,
        request.provider_id
    );

    let registry = state.provider_registry();

    match request.provider_type.as_str() {
        "stt" => {
            let provider_id = parse_stt_provider_id(&request.provider_id)?;
            Ok(registry.test_stt_connection(provider_id).await)
        }
        "llm" => {
            let provider_id = parse_llm_provider_id(&request.provider_id)?;
            Ok(registry.test_llm_connection(provider_id).await)
        }
        _ => Err(format!("Unknown provider type: {}", request.provider_type)),
    }
}

/// Get status of all providers
#[tauri::command]
pub async fn get_providers_status(
    state: State<'_, AppState>,
) -> Result<ProvidersStatusResponse, String> {
    tracing::debug!("Getting all providers status");

    let registry = state.provider_registry();

    let stt = registry.get_stt_providers_status().await;
    let llm = registry.get_llm_providers_status().await;

    Ok(ProvidersStatusResponse { stt, llm })
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Parse STT provider ID from string
fn parse_stt_provider_id(id: &str) -> Result<STTProviderId, String> {
    match id.to_lowercase().as_str() {
        "local" => Ok(STTProviderId::Local),
        "openai" => Ok(STTProviderId::OpenAI),
        "deepgram" => Ok(STTProviderId::Deepgram),
        "assemblyai" => Ok(STTProviderId::AssemblyAI),
        "groq" => Ok(STTProviderId::Groq),
        _ => Err(format!("Unknown STT provider ID: {}", id)),
    }
}

/// Parse LLM provider ID from string
fn parse_llm_provider_id(id: &str) -> Result<LLMProviderId, String> {
    match id.to_lowercase().as_str() {
        "ollama" => Ok(LLMProviderId::Ollama),
        "openai" => Ok(LLMProviderId::OpenAI),
        "openrouter" => Ok(LLMProviderId::OpenRouter),
        _ => Err(format!("Unknown LLM provider ID: {}", id)),
    }
}
