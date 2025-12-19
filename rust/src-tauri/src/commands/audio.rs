//! Audio-related Tauri commands

use crate::state::AppState;
use aiwisper_types::{AudioDevice, RecordingState};
use tauri::{AppHandle, Emitter, State};

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
pub async fn stop_recording(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<RecordingState, String> {
    tracing::info!("Stopping recording");

    tracing::info!("Calling state.stop_recording()...");
    let result = state.stop_recording().await.map_err(|e| e.to_string())?;
    tracing::info!("state.stop_recording() completed successfully");
    
    // Получаем ID последней сессии из результата (session_id хранится в state после stop)
    // Используем get_session для получения полной сессии
    let session_id = result.session_id.clone();
    
    // ✅ После остановки записи отправляем обновленный список сессий
    match state.list_sessions().await {
        Ok(sessions) => {
            tracing::info!("Emitting updated sessions list: {} sessions", sessions.len());
            // Проверяем что новая сессия есть в списке
            let has_new_session = sessions.iter().any(|s| s.id == session_id);
            tracing::info!("New session {} in list: {}", session_id, has_new_session);
            
            let _ = app_handle.emit(
                "sessions_list",
                serde_json::json!({ "sessions": sessions }),
            );
        }
        Err(e) => {
            tracing::error!("Failed to get sessions list after stop: {}", e);
        }
    }
    
    // ✅ Также отправляем ID завершённой сессии напрямую для автовыбора
    let _ = app_handle.emit(
        "recording_completed",
        serde_json::json!({ "sessionId": session_id }),
    );
    
    Ok(result)
}

/// Get list of available audio input devices
#[tauri::command]
pub async fn get_audio_devices(state: State<'_, AppState>) -> Result<Vec<AudioDevice>, String> {
    tracing::debug!("Getting audio devices");

    state.get_audio_devices().await.map_err(|e| e.to_string())
}

/// Force request microphone permission by opening a stream
#[tauri::command]
pub async fn request_microphone_access() -> Result<bool, String> {
    tracing::info!("Requesting microphone access via audio subsystem");
    
    // Run in blocking thread as cpal might block
    tauri::async_runtime::spawn_blocking(|| {
        aiwisper_audio::capture::request_microphone_access()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set mute state for a specific audio channel (mic or sys)
/// When muted, the channel will record silence instead of actual audio
#[tauri::command]
pub async fn set_channel_mute(
    state: State<'_, AppState>,
    channel: String,
    muted: bool,
) -> Result<(), String> {
    tracing::info!("Setting channel '{}' mute state to: {}", channel, muted);
    
    state
        .set_channel_mute(&channel, muted)
        .map_err(|e| e.to_string())
}

/// Get current mute state for a specific audio channel
#[tauri::command]
pub async fn get_channel_mute(
    state: State<'_, AppState>,
    channel: String,
) -> Result<bool, String> {
    state
        .get_channel_mute(&channel)
        .map_err(|e| e.to_string())
}
