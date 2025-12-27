//! Voiceprint-related Tauri commands

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoicePrint {
    pub id: String,
    pub name: String,
    pub embedding: Vec<f32>,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: String,
    pub seen_count: i32,
    pub sample_path: Option<String>,
    pub source: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct VoicePrintsResponse {
    pub voiceprints: Vec<VoicePrint>,
}

/// List all voiceprints
#[tauri::command]
pub async fn list_voiceprints(state: State<'_, AppState>) -> Result<VoicePrintsResponse, String> {
    tracing::debug!("Listing voiceprints");

    let voiceprints = state.list_voiceprints().await.map_err(|e| e.to_string())?;

    Ok(VoicePrintsResponse { voiceprints })
}

/// Create a new voiceprint
#[tauri::command]
pub async fn create_voiceprint(
    state: State<'_, AppState>,
    name: String,
    embedding: Vec<f32>,
    source: Option<String>,
) -> Result<VoicePrint, String> {
    tracing::info!("Creating voiceprint: {}", name);

    state
        .create_voiceprint(&name, embedding, source)
        .await
        .map_err(|e| e.to_string())
}

/// Rename a voiceprint
#[tauri::command]
pub async fn rename_voiceprint(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    tracing::info!("Renaming voiceprint {} to {}", id, name);

    state
        .rename_voiceprint(&id, &name)
        .await
        .map_err(|e| e.to_string())
}

/// Delete a voiceprint
#[tauri::command]
pub async fn delete_voiceprint(state: State<'_, AppState>, id: String) -> Result<(), String> {
    tracing::info!("Deleting voiceprint: {}", id);

    state
        .delete_voiceprint(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Get audio sample for a speaker (returns base64 WAV data URL)
#[tauri::command]
pub async fn get_speaker_sample(
    state: State<'_, AppState>,
    session_id: String,
    speaker_id: i32,
) -> Result<String, String> {
    tracing::debug!(
        "Getting speaker sample for session: {}, speaker: {}",
        session_id,
        speaker_id
    );

    state
        .get_speaker_sample(&session_id, speaker_id)
        .await
        .map_err(|e| e.to_string())
}

/// Match result from voiceprint matching
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResultResponse {
    pub voiceprint_id: String,
    pub voiceprint_name: String,
    pub similarity: f32,
    pub confidence: String,
}

/// Match an embedding against known voiceprints
#[tauri::command]
pub async fn match_voiceprint(
    state: State<'_, AppState>,
    embedding: Vec<f32>,
) -> Result<Option<MatchResultResponse>, String> {
    tracing::debug!("Matching voiceprint with {} dimensional embedding", embedding.len());

    let result = state.find_voiceprint_match(&embedding);
    
    Ok(result.map(|m| MatchResultResponse {
        voiceprint_id: m.voiceprint.id,
        voiceprint_name: m.voiceprint.name,
        similarity: m.similarity,
        confidence: m.confidence.to_string(),
    }))
}

/// Match an embedding and auto-update on high confidence
#[tauri::command]
pub async fn match_voiceprint_with_update(
    state: State<'_, AppState>,
    embedding: Vec<f32>,
) -> Result<Option<MatchResultResponse>, String> {
    tracing::debug!("Matching voiceprint with auto-update, {} dimensions", embedding.len());

    let result = state.match_voiceprint_with_update(&embedding);
    
    Ok(result.map(|m| MatchResultResponse {
        voiceprint_id: m.voiceprint.id,
        voiceprint_name: m.voiceprint.name,
        similarity: m.similarity,
        confidence: m.confidence.to_string(),
    }))
}
