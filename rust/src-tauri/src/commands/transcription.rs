//! Transcription-related Tauri commands

use crate::state::AppState;
use aiwisper_types::TranscriptionResult;
use tauri::{Emitter, State, Window};

/// Transcribe an audio file
#[tauri::command]
pub async fn transcribe_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<TranscriptionResult, String> {
    tracing::info!("Transcribing file: {}", path);

    state
        .transcribe_file(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Get waveform for session (stub)
#[tauri::command]
pub async fn get_waveform(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    tracing::debug!("Get waveform for session: {}", session_id);
    state
        .get_waveform(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Start streaming transcription - emits events to the window
#[tauri::command]
pub async fn get_transcript_stream(
    state: State<'_, AppState>,
    window: Window,
) -> Result<(), String> {
    tracing::info!("Starting transcript stream");

    // Subscribe to transcript events and forward to window
    let mut rx = state.subscribe_transcripts();

    tokio::spawn(async move {
        while let Ok(segment) = rx.recv().await {
            if let Err(e) = window.emit("transcript-segment", &segment) {
                tracing::error!("Failed to emit transcript segment: {}", e);
                break;
            }
        }
    });

    Ok(())
}

/// Set transcription language
#[tauri::command]
pub async fn set_language(state: State<'_, AppState>, language: String) -> Result<(), String> {
    tracing::info!("Setting language to: {}", language);

    state
        .set_language(&language)
        .await
        .map_err(|e| e.to_string())
}

/// Set hotwords for improved recognition
#[tauri::command]
pub async fn set_hotwords(state: State<'_, AppState>, hotwords: Vec<String>) -> Result<(), String> {
    tracing::info!("Setting {} hotwords", hotwords.len());

    state
        .set_hotwords(hotwords)
        .await
        .map_err(|e| e.to_string())
}

/// Get full audio for a session as base64-encoded WAV data URL
#[tauri::command]
pub async fn get_full_audio(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    tracing::debug!("Get full audio for session: {}", session_id);
    state
        .get_full_audio(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Get chunk audio as base64-encoded WAV data URL
#[tauri::command]
pub async fn get_chunk_audio(
    state: State<'_, AppState>,
    session_id: String,
    chunk_index: usize,
) -> Result<String, String> {
    tracing::debug!(
        "Get chunk audio for session: {}, chunk: {}",
        session_id,
        chunk_index
    );
    state
        .get_chunk_audio(&session_id, chunk_index)
        .await
        .map_err(|e| e.to_string())
}

/// Retranscribe a single chunk
#[tauri::command]
pub async fn retranscribe_chunk(
    state: State<'_, AppState>,
    window: Window,
    session_id: String,
    chunk_id: String,
    model: String,
    language: String,
    stt_provider: Option<String>,
    hybrid_enabled: Option<bool>,
    hybrid_secondary_model_id: Option<String>,
    hybrid_use_llm_for_merge: Option<bool>,
    hybrid_mode: Option<String>,
    ollama_model: Option<String>,
    ollama_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let stt_provider = stt_provider.unwrap_or_else(|| "local".to_string());
    let hybrid_enabled = hybrid_enabled.unwrap_or(false);
    let hybrid_secondary = hybrid_secondary_model_id.unwrap_or_default();
    let use_llm = hybrid_use_llm_for_merge.unwrap_or(false);
    let mode = hybrid_mode.unwrap_or_else(|| "parallel".to_string());
    let ollama_model = ollama_model.unwrap_or_default();
    let ollama_url = ollama_url.unwrap_or_else(|| "http://localhost:11434".to_string());

    tracing::info!(
        "Retranscribe chunk: session={}, chunk={}, model={}, lang={}, stt_provider={}, hybrid={}, use_llm={}, mode={}, ollama_model={}",
        session_id,
        chunk_id,
        model,
        language,
        stt_provider,
        hybrid_enabled,
        use_llm,
        mode,
        ollama_model
    );

    state
        .retranscribe_chunk(
            &session_id,
            &chunk_id,
            &model,
            &language,
            &stt_provider,
            hybrid_enabled,
            &hybrid_secondary,
            use_llm,
            &mode,
            &ollama_model,
            &ollama_url,
            &window,
        )
        .await
        .map_err(|e| e.to_string())
}

/// Retranscribe entire session (all chunks)
#[tauri::command]
pub async fn retranscribe_full(
    state: State<'_, AppState>,
    window: Window,
    session_id: String,
    model: String,
    language: String,
    stt_provider: Option<String>,
    hybrid_enabled: bool,
    hybrid_secondary_model_id: String,
    hybrid_use_llm_for_merge: Option<bool>,
    hybrid_mode: Option<String>,
    ollama_model: Option<String>,
    ollama_url: Option<String>,
) -> Result<(), String> {
    let stt_provider = stt_provider.unwrap_or_else(|| "local".to_string());
    let use_llm = hybrid_use_llm_for_merge.unwrap_or(false);
    let mode = hybrid_mode.unwrap_or_else(|| "parallel".to_string());
    let ollama_model = ollama_model.unwrap_or_default();
    let ollama_url = ollama_url.unwrap_or_else(|| "http://localhost:11434".to_string());

    tracing::info!(
        "Retranscribe full session: {}, model={}, lang={}, stt_provider={}, hybrid={}, use_llm={}, mode={}, ollama_model={}",
        session_id,
        model,
        language,
        stt_provider,
        hybrid_enabled,
        use_llm,
        mode,
        ollama_model
    );

    state
        .retranscribe_full(
            &session_id,
            &model,
            &language,
            &stt_provider,
            hybrid_enabled,
            &hybrid_secondary_model_id,
            use_llm,
            &mode,
            &ollama_model,
            &ollama_url,
            &window,
        )
        .await
        .map_err(|e| e.to_string())
}

/// Cancel ongoing full retranscription
#[tauri::command]
pub async fn cancel_full_transcription(
    state: State<'_, AppState>,
    window: Window,
) -> Result<(), String> {
    tracing::info!("Cancel full transcription requested");
    
    state
        .cancel_full_transcription(&window)
        .await
        .map_err(|e| e.to_string())
}
