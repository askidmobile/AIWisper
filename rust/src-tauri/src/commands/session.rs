//! Session management Tauri commands

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

/// Session information for listing (matches frontend SessionInfo interface)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    #[serde(rename = "startTime")]
    pub start_time: String,
    pub status: String,
    #[serde(rename = "totalDuration")]
    pub total_duration: u64,
    #[serde(rename = "chunksCount")]
    pub chunks_count: usize,
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Full session with chunks (matches frontend Session interface)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    #[serde(rename = "startTime")]
    pub start_time: String,
    #[serde(rename = "endTime")]
    pub end_time: Option<String>,
    pub status: String,
    pub chunks: Vec<SessionChunk>,
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    #[serde(rename = "totalDuration")]
    pub total_duration: u64,
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub summary: Option<String>,
    pub language: Option<String>,
    pub model: Option<String>,
}

/// Session chunk (audio segment with transcription) - matches frontend Chunk interface
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChunk {
    pub id: String,
    pub index: i32,
    #[serde(rename = "startMs")]
    pub start_ms: i64,
    #[serde(rename = "endMs")]
    pub end_ms: i64,
    pub duration: i64,
    pub transcription: String,
    #[serde(rename = "micText")]
    pub mic_text: Option<String>,
    #[serde(rename = "sysText")]
    pub sys_text: Option<String>,
    pub dialogue: Vec<DialogueSegment>,
    #[serde(rename = "isStereo")]
    pub is_stereo: bool,
    pub status: String,
    pub speaker: Option<String>,
}

/// Dialogue segment for transcript
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogueSegment {
    pub start: i64,
    pub end: i64,
    pub text: String,
    pub speaker: Option<String>,
}

/// List all sessions
#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    tracing::debug!("Listing sessions");

    state.list_sessions().await.map_err(|e| e.to_string())
}

/// Get a specific session by ID
#[tauri::command]
pub async fn get_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Session, String> {
    tracing::debug!("Getting session: {}", session_id);

    state
        .get_session(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Delete a session
#[tauri::command]
pub async fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    tracing::info!("Deleting session: {}", session_id);

    state
        .delete_session(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Rename a session
#[tauri::command]
pub async fn rename_session(
    state: State<'_, AppState>,
    session_id: String,
    new_title: String,
) -> Result<(), String> {
    tracing::info!("Renaming session {} to: {}", session_id, new_title);

    state
        .rename_session(&session_id, &new_title)
        .await
        .map_err(|e| e.to_string())
}

/// Update session tags
#[tauri::command]
pub async fn update_session_tags(
    state: State<'_, AppState>,
    session_id: String,
    tags: Vec<String>,
) -> Result<(), String> {
    tracing::info!("Updating tags for session {}: {:?}", session_id, tags);

    state
        .update_session_tags(&session_id, tags)
        .await
        .map_err(|e| e.to_string())
}

/// Export session to file
#[tauri::command]
pub async fn export_session(
    state: State<'_, AppState>,
    session_id: String,
    format: String,
    path: String,
) -> Result<(), String> {
    tracing::info!("Exporting session {} as {} to {}", session_id, format, path);

    state
        .export_session(&session_id, &format, &path)
        .await
        .map_err(|e| e.to_string())
}

/// Session speaker info (matches frontend SessionSpeaker interface)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpeaker {
    pub local_id: i32,
    pub global_id: Option<String>,
    pub display_name: String,
    pub is_recognized: bool,
    pub is_mic: bool,
    pub segment_count: usize,
    pub total_duration: f64,
    pub has_sample: bool,
}

/// Get speakers from a session (extracted from dialogue segments)
#[tauri::command]
pub async fn get_session_speakers(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<SessionSpeaker>, String> {
    tracing::debug!("Getting speakers for session: {}", session_id);

    state
        .get_session_speakers(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Generate summary for a session using Ollama
/// Returns the generated summary text directly from the command
#[tauri::command]
pub async fn generate_summary(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    ollama_model: String,
    ollama_url: String,
    ollama_context_size: Option<u32>,
) -> Result<String, String> {
    let context_size = ollama_context_size.unwrap_or(8); // default 8k
    tracing::info!(
        "Generating summary for session {} with model {} (context: {}k)",
        session_id,
        ollama_model,
        context_size
    );

    // Emit started event
    let _ = app.emit(
        "summary_started",
        serde_json::json!({ "sessionId": session_id }),
    );

    // Get session to extract transcription text
    let session = state
        .get_session(&session_id)
        .await
        .map_err(|e| e.to_string())?;

    // Build transcript text from dialogue or transcription field
    let mut transcript_text = String::new();
    tracing::info!(
        "Building transcript from {} chunks for session {}",
        session.chunks.len(),
        session_id
    );
    
    for chunk in &session.chunks {
        tracing::debug!(
            "Chunk {}: dialogue={}, transcription={}, mic_text={:?}, sys_text={:?}",
            chunk.id,
            chunk.dialogue.len(),
            chunk.transcription.len(),
            chunk.mic_text.as_ref().map(|s| s.len()),
            chunk.sys_text.as_ref().map(|s| s.len())
        );
        
        // First try to use dialogue entries
        if !chunk.dialogue.is_empty() {
            for segment in &chunk.dialogue {
                let speaker = segment.speaker.as_deref().unwrap_or("Unknown");
                transcript_text.push_str(&format!("{}: {}\n", speaker, segment.text));
            }
        } else if !chunk.transcription.is_empty() {
            // Fallback to transcription field
            transcript_text.push_str(&chunk.transcription);
            transcript_text.push('\n');
        } else if let Some(mic) = &chunk.mic_text {
            // Fallback to mic_text
            if !mic.is_empty() {
                transcript_text.push_str(&format!("Mic: {}\n", mic));
            }
        }
        // Also add sys_text if available
        if let Some(sys) = &chunk.sys_text {
            if !sys.is_empty() && chunk.dialogue.is_empty() {
                transcript_text.push_str(&format!("System: {}\n", sys));
            }
        }
    }

    tracing::info!(
        "Built transcript text with {} chars for session {}",
        transcript_text.len(),
        session_id
    );

    if transcript_text.is_empty() {
        let err = "No transcription available for summary generation";
        let _ = app.emit(
            "summary_error",
            serde_json::json!({
                "sessionId": session_id,
                "error": err
            }),
        );
        return Err(err.to_string());
    }

    // Generate summary with Ollama
    match generate_summary_with_ollama(&transcript_text, &ollama_model, &ollama_url, context_size)
        .await
    {
        Ok(summary) => {
            tracing::info!(
                "Generated summary for session {}: {} chars, preview: {}...",
                session_id,
                summary.len(),
                summary.chars().take(100).collect::<String>()
            );
            
            // Save summary to session
            if let Err(e) = state.set_session_summary(&session_id, &summary).await {
                tracing::error!("Failed to save summary: {}", e);
            }

            // Emit completed event (for UI spinner/status updates)
            let _ = app.emit(
                "summary_completed",
                serde_json::json!({
                    "sessionId": session_id.clone()
                }),
            );
            
            // Return summary directly from command (more reliable than event payload)
            tracing::info!("Returning summary from command: {} chars", summary.len());
            Ok(summary)
        }
        Err(e) => {
            let err_msg = e.to_string();
            let _ = app.emit(
                "summary_error",
                serde_json::json!({
                    "sessionId": session_id,
                    "error": err_msg
                }),
            );
            Err(err_msg)
        }
    }
}

/// Call Ollama API to generate summary
async fn generate_summary_with_ollama(
    transcript: &str,
    model: &str,
    base_url: &str,
    context_size_k: u32,
) -> Result<String, anyhow::Error> {
    let client = reqwest::Client::new();

    // Check if Ollama is running
    let check_url = format!("{}/api/tags", base_url);
    if client.get(&check_url).send().await.is_err() {
        anyhow::bail!("Ollama is not running at {}", base_url);
    }

    let prompt = format!(
        r#"Проанализируй следующую транскрипцию разговора и создай структурированное резюме на русском языке.

Транскрипция:
{}

Создай резюме в следующем формате:

## Тема разговора
[Одно предложение о главной теме]

## Ключевые моменты
- [Пункт 1]
- [Пункт 2]
- [Пункт 3]

## Решения и выводы
- [Что было решено или согласовано]

## Следующие шаги
- [Если упоминались какие-то действия]

Будь кратким и конкретным. Используй только информацию из транскрипции."#,
        transcript
    );

    // Convert context size from k to actual tokens (e.g., 8 -> 8192)
    let num_ctx = context_size_k * 1024;

    let request_body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "options": {
            "temperature": 0.3,
            "num_predict": 4096,  // Allow longer summaries
            "num_ctx": num_ctx
        }
    });

    let response = client
        .post(format!("{}/api/generate", base_url))
        .json(&request_body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        anyhow::bail!("Ollama API error: {} - {}", status, error_text);
    }

    let json: serde_json::Value = response.json().await?;
    tracing::debug!("Ollama response JSON keys: {:?}", json.as_object().map(|o| o.keys().collect::<Vec<_>>()));
    
    // Try "response" first, then "thinking" for thinking models like kimi-k2-thinking
    let response_text = json["response"].as_str().unwrap_or("");
    let thinking_text = json["thinking"].as_str().unwrap_or("");
    
    tracing::info!(
        "Ollama response fields: response={} chars, thinking={} chars",
        response_text.len(),
        thinking_text.len()
    );
    
    // Log first 200 chars of each for debugging
    if !response_text.is_empty() {
        tracing::debug!("response preview: {}", response_text.chars().take(200).collect::<String>());
    }
    if !thinking_text.is_empty() {
        tracing::debug!("thinking preview: {}", thinking_text.chars().take(500).collect::<String>());
    }
    
    // Use response if available, otherwise use thinking
    // For thinking models, the actual answer is in "response", thinking is the reasoning
    // But some models like kimi-k2-thinking put everything in thinking and leave response empty
    let summary = if !response_text.is_empty() {
        response_text.to_string()
    } else if !thinking_text.is_empty() {
        // For thinking models, just use the whole thinking text
        // It usually contains useful analysis even if not perfectly formatted
        thinking_text.to_string()
    } else {
        "Не удалось получить ответ от модели".to_string()
    };
    
    tracing::info!("Ollama returned summary: {} chars, preview: {}...", 
        summary.len(),
        summary.chars().take(100).collect::<String>()
    );

    Ok(summary)
}
