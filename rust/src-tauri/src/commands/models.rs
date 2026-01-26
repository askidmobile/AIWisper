//! Model management Tauri commands

use crate::state::AppState;
use aiwisper_types::ModelInfo;
use tauri::Emitter;
use tauri::{AppHandle, State};

/// List available ML models
#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    tracing::info!("list_models command called");

    let models = state.list_models().await.map_err(|e| e.to_string())?;

    // Log downloaded models
    let downloaded: Vec<_> = models
        .iter()
        .filter(|m| m.status == "downloaded")
        .map(|m| &m.id)
        .collect();
    tracing::info!(
        "Returning {} models, {} downloaded: {:?}",
        models.len(),
        downloaded.len(),
        downloaded
    );

    Ok(models)
}

/// Download a model by ID
#[tauri::command]
pub async fn download_model(state: State<'_, AppState>, model_id: String) -> Result<(), String> {
    tracing::info!("Downloading model: {}", model_id);

    state
        .download_model(&model_id)
        .await
        .map_err(|e| e.to_string())
}

/// Cancel model download
#[tauri::command]
pub async fn cancel_download(state: State<'_, AppState>, model_id: String) -> Result<(), String> {
    tracing::info!("Cancel model download: {}", model_id);
    state
        .cancel_download(&model_id)
        .await
        .map_err(|e| e.to_string())
}

/// Delete model
#[tauri::command]
pub async fn delete_model(state: State<'_, AppState>, model_id: String) -> Result<(), String> {
    tracing::info!("Delete model: {}", model_id);
    state
        .delete_model(&model_id)
        .await
        .map_err(|e| e.to_string())
}

/// Set active model
#[tauri::command]
pub async fn set_active_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model_id: String,
) -> Result<(), String> {
    tracing::info!("Set active model: {}", model_id);
    state
        .set_active_model(&model_id)
        .await
        .map_err(|e| e.to_string())?;

    // Emit event to notify frontend
    let _ = app.emit(
        "active-model-changed",
        serde_json::json!({
            "modelId": model_id
        }),
    );

    Ok(())
}

/// Get Ollama models
#[tauri::command]
pub async fn get_ollama_models(
    state: State<'_, AppState>,
    url: String,
) -> Result<Vec<ModelInfo>, String> {
    tracing::info!("Get Ollama models from {}", url);
    state
        .get_ollama_models(&url)
        .await
        .map_err(|e| e.to_string())
}
