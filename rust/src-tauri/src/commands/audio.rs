//! Audio-related Tauri commands

use crate::state::AppState;
use aiwisper_types::{AudioDevice, RecordingState};
use tauri::{AppHandle, State};

/// Start audio recording from the specified device
#[tauri::command]
pub async fn start_recording(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    device_id: Option<String>,
    capture_system: Option<bool>,
    language: Option<String>,
) -> Result<(), String> {
    let capture_system = capture_system.unwrap_or(false);
    tracing::info!(
        "Starting recording, device: {:?}, capture_system: {}, language: {:?}",
        device_id,
        capture_system,
        language
    );

    state
        .start_recording(device_id, capture_system, language, app_handle)
        .await
        .map_err(|e| e.to_string())
}

/// Stop audio recording and return the recorded samples
#[tauri::command]
pub async fn stop_recording(state: State<'_, AppState>) -> Result<RecordingState, String> {
    tracing::info!("Stopping recording");

    state.stop_recording().await.map_err(|e| e.to_string())
}

/// Get list of available audio input devices
#[tauri::command]
pub async fn get_audio_devices(state: State<'_, AppState>) -> Result<Vec<AudioDevice>, String> {
    tracing::debug!("Getting audio devices");

    state.get_audio_devices().await.map_err(|e| e.to_string())
}
