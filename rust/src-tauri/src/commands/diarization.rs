//! Diarization-related Tauri commands

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationStatus {
    pub enabled: bool,
    pub provider: String,
}

/// Enable diarization
#[tauri::command]
pub async fn enable_diarization(
    state: State<'_, AppState>,
    segmentation_model_path: String,
    embedding_model_path: String,
    provider: String,
) -> Result<DiarizationStatus, String> {
    tracing::info!(
        "Enabling diarization: provider={}, seg={}, emb={}",
        provider,
        segmentation_model_path,
        embedding_model_path
    );

    state
        .enable_diarization(&segmentation_model_path, &embedding_model_path, &provider)
        .await
        .map_err(|e| e.to_string())
}

/// Disable diarization
#[tauri::command]
pub async fn disable_diarization(state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("Disabling diarization");

    state.disable_diarization().await.map_err(|e| e.to_string())
}

/// Get diarization status
#[tauri::command]
pub async fn get_diarization_status(
    state: State<'_, AppState>,
) -> Result<DiarizationStatus, String> {
    tracing::debug!("Getting diarization status");

    state
        .get_diarization_status()
        .await
        .map_err(|e| e.to_string())
}
