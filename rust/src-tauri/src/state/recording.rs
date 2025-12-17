//! Recording session management
//!
//! Handles audio recording with:
//! - MP3 writing via FFmpeg
//! - ChunkBuffer for automatic segmentation
//! - Session and chunk metadata persistence
//! - Transcription of chunks during recording

use aiwisper_audio::{
    resample, AudioCapture, AudioChannel, ChunkBuffer, Mp3Writer, SystemAudioCapture,
    SystemCaptureConfig, SystemCaptureMethod, VadConfig,
};
use anyhow::Result;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use uuid::Uuid;

/// Sample rate for recording (matches Go backend)
const SAMPLE_RATE: u32 = 24000;
/// Sample rate for transcription
const TRANSCRIPTION_SAMPLE_RATE: u32 = 16000;

/// Configuration for transcription during recording
#[derive(Debug, Clone)]
pub struct TranscriptionConfig {
    /// Primary model ID (e.g., "ggml-large-v3-turbo")
    pub model_id: String,
    /// Language code (e.g., "ru", "en", "auto")
    pub language: String,
    /// Enable hybrid transcription
    pub hybrid_enabled: bool,
    /// Secondary model ID for hybrid mode
    pub hybrid_secondary_model_id: String,
    /// Hotwords for improved accuracy
    pub hotwords: Vec<String>,
}

impl Default for TranscriptionConfig {
    fn default() -> Self {
        Self {
            model_id: "ggml-large-v3-turbo".to_string(),
            language: "ru".to_string(),
            hybrid_enabled: false,
            hybrid_secondary_model_id: String::new(),
            hotwords: Vec::new(),
        }
    }
}

/// Recording session data
pub struct RecordingSession {
    pub id: String,
    pub data_dir: PathBuf,
    pub start_time: chrono::DateTime<chrono::Utc>,
    pub language: String,
    pub model_id: String,
    pub is_stereo: bool,
}

impl RecordingSession {
    /// Create a new recording session
    pub fn new(language: &str, model_id: &str, is_stereo: bool) -> Result<Self> {
        let id = Uuid::new_v4().to_string();
        let start_time = chrono::Utc::now();

        // Get sessions directory
        let sessions_dir = dirs::data_local_dir()
            .map(|p| p.join("aiwisper").join("sessions"))
            .ok_or_else(|| anyhow::anyhow!("Could not determine data directory"))?;

        let data_dir = sessions_dir.join(&id);

        // Create session directory and chunks subdirectory
        std::fs::create_dir_all(data_dir.join("chunks"))?;

        Ok(Self {
            id,
            data_dir,
            start_time,
            language: language.to_string(),
            model_id: model_id.to_string(),
            is_stereo: false,
        })
    }

    /// Get MP3 file path
    pub fn mp3_path(&self) -> PathBuf {
        self.data_dir.join("full.mp3")
    }

    /// Get meta.json path
    pub fn meta_path(&self) -> PathBuf {
        self.data_dir.join("meta.json")
    }

    /// Get chunk file path
    pub fn chunk_path(&self, index: usize) -> PathBuf {
        self.data_dir
            .join("chunks")
            .join(format!("chunk_{:04}.json", index))
    }

    /// Save session metadata
    pub fn save_meta(
        &self,
        end_time: Option<chrono::DateTime<chrono::Utc>>,
        duration_ms: u64,
        chunks_count: usize,
    ) -> Result<()> {
        let title = format!(
            "Запись {} · {} мин",
            self.start_time.format("%d.%m %H:%M"),
            duration_ms / 60000
        );

        let meta = serde_json::json!({
            "id": self.id,
            "startTime": self.start_time.to_rfc3339(),
            "endTime": end_time.map(|t| t.to_rfc3339()),
            "status": if end_time.is_some() { "completed" } else { "recording" },
            "language": self.language,
            "model": self.model_id,
            "title": title,
            "tags": [],
            "totalDuration": duration_ms,
            "chunksCount": chunks_count,
        });

        std::fs::write(self.meta_path(), serde_json::to_string_pretty(&meta)?)?;

        Ok(())
    }
}

/// Saved chunk metadata (for JSON)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMeta {
    pub id: String,
    pub index: i32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub status: String,
    #[serde(default)]
    pub transcription: String,
    #[serde(default)]
    pub mic_text: Option<String>,
    #[serde(default)]
    pub sys_text: Option<String>,
    #[serde(default)]
    pub dialogue: Vec<DialogueEntry>,
}

/// Dialogue entry for JSON
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DialogueEntry {
    pub start: i64,
    pub end: i64,
    pub text: String,
    #[serde(default)]
    pub speaker: String,
}

impl ChunkMeta {
    /// Create from ChunkEvent
    pub fn from_event(event: &aiwisper_audio::ChunkEvent, _session_id: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            index: event.index as i32,
            start_ms: event.start_ms,
            end_ms: event.end_ms,
            status: "pending".to_string(),
            transcription: String::new(),
            mic_text: None,
            sys_text: None,
            dialogue: Vec::new(),
        }
    }

    /// Save to file
    pub fn save(&self, path: &std::path::Path) -> Result<()> {
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

/// Handle to control active recording
pub struct RecordingHandle {
    /// Stop flag
    pub stop_flag: Arc<AtomicBool>,
    /// Join handle for recording thread
    pub join_handle: Option<std::thread::JoinHandle<RecordingResult>>,
    /// Session info
    pub session: RecordingSession,
}

/// Result of recording
pub struct RecordingResult {
    pub session_id: String,
    pub duration_ms: u64,
    pub sample_count: usize,
    pub chunks: Vec<ChunkMeta>,
}

impl RecordingHandle {
    /// Stop recording and get result
    pub fn stop(mut self) -> Result<RecordingResult> {
        // Signal stop
        self.stop_flag.store(true, Ordering::SeqCst);

        // Wait for thread
        let result = if let Some(handle) = self.join_handle.take() {
            handle
                .join()
                .map_err(|_| anyhow::anyhow!("Recording thread panicked"))?
        } else {
            return Err(anyhow::anyhow!("Recording already stopped"));
        };

        // Update session metadata with final state
        let end_time = chrono::Utc::now();
        self.session.save_meta(
            Some(end_time),
            result.duration_ms,
            result.chunks.len(),
        )?;

        Ok(result)
    }
}

/// Start recording session
///
/// Returns a handle to control the recording.
/// Recording runs in a separate thread due to cpal::Stream not being Send+Sync.
pub fn start_recording(
    device_id: Option<String>,
    language: &str,
    model_id: &str,
    capture_system: bool,
    transcription_config: TranscriptionConfig,
    app_handle: tauri::AppHandle,
) -> Result<RecordingHandle> {
    // Create session (фиксируем стерео-флаг из capture_system)
    let mut session = RecordingSession::new(language, model_id, capture_system)?;
    session.is_stereo = capture_system;
    let session_id = session.id.clone();
    let mp3_path = session.mp3_path();

    // Save initial meta
    session.save_meta(None, 0, 0)?;

    // Create stop flag
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();

    // Clone for thread
    let data_dir = session.data_dir.clone();

    // Spawn recording thread
    let join_handle = std::thread::spawn(move || {
        recording_thread(
            session_id,
            mp3_path,
            data_dir,
            device_id,
            capture_system,
            stop_flag_clone,
            app_handle,
            transcription_config,
        )
    });

    Ok(RecordingHandle {
        stop_flag,
        join_handle: Some(join_handle),
        session,
    })
}

/// Recording thread function
fn recording_thread(
    session_id: String,
    mp3_path: PathBuf,
    data_dir: PathBuf,
    device_id: Option<String>,
    capture_system: bool,
    stop_flag: Arc<AtomicBool>,
    app_handle: tauri::AppHandle,
    transcription_config: TranscriptionConfig,
) -> RecordingResult {
    use tauri::Emitter;

    // Create microphone capture
    let mut mic_capture = match AudioCapture::new(device_id.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Failed to create audio capture: {}", e);
            return RecordingResult {
                session_id,
                duration_ms: 0,
                sample_count: 0,
                chunks: Vec::new(),
            };
        }
    };

    // На macOS жёстко используем ScreenCaptureKit, чтобы не падать в VirtualLoopback
    let sys_config = if capture_system {
        SystemCaptureConfig {
            method: SystemCaptureMethod::ScreenCaptureKit,
            sample_rate: SAMPLE_RATE,
            capture_microphone: false,
        }
    } else {
        SystemCaptureConfig::default()
    };

    // Create system audio capture if requested
    let mut sys_capture: Option<Box<dyn SystemAudioCapture>> = if capture_system {
        match aiwisper_audio::create_system_capture(sys_config) {
            Ok(c) => {
                tracing::info!("System audio capture создан");
                Some(c)
            }
            Err(e) => {
                tracing::warn!("Failed to create system audio capture: {}", e);
                None
            }
        }
    } else {
        None
    };

    // MP3 channels: 1 for mic only, 2 for stereo (mic + sys)
    let channels = if sys_capture.is_some() { 2 } else { 1 };

    // Create MP3 writer
    let mut mp3_writer = match Mp3Writer::new(&mp3_path, SAMPLE_RATE, channels, "128k") {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("Failed to create MP3 writer: {}", e);
            return RecordingResult {
                session_id,
                duration_ms: 0,
                sample_count: 0,
                chunks: Vec::new(),
            };
        }
    };

    // Create chunk buffer with VAD config
    let vad_config = if capture_system {
        VadConfig::fixed_interval()
    } else {
        VadConfig::default()
    };
    let mut chunk_buffer = ChunkBuffer::new(vad_config, SAMPLE_RATE);

    // Start mic capture
    tracing::info!("Starting microphone capture...");
    if let Err(e) = mic_capture.start() {
        tracing::error!("Failed to start audio capture: {}", e);
        return RecordingResult {
            session_id,
            duration_ms: 0,
            sample_count: 0,
            chunks: Vec::new(),
        };
    }
    // Get mic sample rate for resampling
    let mic_sample_rate = mic_capture.sample_rate();
    let need_resample = mic_sample_rate != SAMPLE_RATE;

    tracing::info!(
        "Microphone capture started: rate={} Hz, target_rate={} Hz, need_resample={}",
        mic_sample_rate,
        SAMPLE_RATE,
        need_resample
    );

    // Start system capture
    if let Some(ref mut sys) = sys_capture {
        if let Err(e) = sys.start() {
            tracing::warn!("Failed to start system audio capture: {}", e);
            sys_capture = None;
        }
    }

    tracing::info!(
        "Recording started: session={}, capture_system={}",
        session_id,
        sys_capture.is_some()
    );

    // Emit session_started event with full session info
    let _ = app_handle.emit(
        "session-started",
        serde_json::json!({
            "sessionId": session_id.clone(),
            "session": {
                "id": session_id,
                "startTime": chrono::Utc::now().to_rfc3339(),
                "status": "recording",
                "chunks": [],
            }
        }),
    );

    let start_time = Instant::now();
    let mut chunks: Vec<ChunkMeta> = Vec::new();
    let mut last_mic_sample_count = 0usize;

    // Buffers for stereo recording (микрофон и система накапливаются до выравнивания)
    let mut sys_buffer: Vec<f32> = Vec::new();
    let mut mic_buffer: Vec<f32> = Vec::new();

    // For debug logging
    let mut loop_count: u64 = 0;

    // Main recording loop
    loop {
        // Check stop flag
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }

        // Sleep briefly
        std::thread::sleep(std::time::Duration::from_millis(50));

        // Get new mic samples (at mic_sample_rate)
        let all_mic_samples = mic_capture.get_samples();
        let new_mic_samples_raw = &all_mic_samples[last_mic_sample_count..];

        // Resample if needed
        let new_mic_samples: Vec<f32> = if need_resample && !new_mic_samples_raw.is_empty() {
            match resample(new_mic_samples_raw, mic_sample_rate, SAMPLE_RATE) {
                Ok(resampled) => resampled,
                Err(e) => {
                    tracing::warn!("Resample failed: {}, using raw samples", e);
                    new_mic_samples_raw.to_vec()
                }
            }
        } else {
            new_mic_samples_raw.to_vec()
        };

        // Log every 20 iterations (1 second)
        loop_count += 1;
        if loop_count % 20 == 0 {
            tracing::info!(
                "Recording loop #{}: total_samples={}, new_raw={}, new_resampled={}",
                loop_count,
                all_mic_samples.len(),
                new_mic_samples_raw.len(),
                new_mic_samples.len()
            );
        }

        // Collect system audio samples if available
        let mut sys_level: f32 = 0.0;
        if let Some(ref sys) = sys_capture {
            while let Ok(data) = sys.get_receiver().try_recv() {
                if data.channel == AudioChannel::System {
                    sys_buffer.extend_from_slice(&data.samples);
                    // Calculate RMS for sys level
                    if !data.samples.is_empty() {
                        let rms: f32 = (data.samples.iter().map(|s| s * s).sum::<f32>()
                            / data.samples.len() as f32)
                            .sqrt();
                        sys_level = (rms * 300.0).min(100.0);
                    }
                }
            }
        }

        // Накапливаем микрофонные семплы, выравниваем по системным
        if !new_mic_samples.is_empty() {
            mic_buffer.extend_from_slice(&new_mic_samples);
        }

        if sys_capture.is_some() {
            // Стерео режим: пишем и обрабатываем только выровненные пары mic/sys
            let min_len = mic_buffer.len().min(sys_buffer.len());
            if min_len > 0 {
                let mic_chunk = mic_buffer.drain(..min_len).collect::<Vec<_>>();
                let sys_chunk = sys_buffer.drain(..min_len).collect::<Vec<_>>();

                if let Err(e) = mp3_writer.write_stereo(&mic_chunk, &sys_chunk) {
                    tracing::error!("Failed to write stereo MP3: {}", e);
                }

                // Process through chunk buffer (стерео всегда при наличии capture_system)
                chunk_buffer.process_stereo(&mic_chunk, &sys_chunk);
            }
        } else if !new_mic_samples.is_empty() {
            // Моно режим: только микрофон
            if let Err(e) = mp3_writer.write(&new_mic_samples) {
                tracing::error!("Failed to write MP3: {}", e);
            }
            chunk_buffer.process(&new_mic_samples);
        }

        if !new_mic_samples.is_empty() {
            last_mic_sample_count = all_mic_samples.len();
        }

        // Check for completed chunks
        while let Some(event) = chunk_buffer.try_recv() {
            let mut chunk_meta = ChunkMeta::from_event(&event, &session_id);
            let chunk_path = data_dir
                .join("chunks")
                .join(format!("chunk_{:04}.json", event.index));

            tracing::info!(
                "Chunk created: {} ({}-{} ms)",
                event.index,
                event.start_ms,
                event.end_ms
            );

            // Emit chunk_created event (status: pending)
            let _ = app_handle.emit(
                "chunk_created",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunk": {
                        "id": chunk_meta.id,
                        "index": chunk_meta.index,
                        "startMs": chunk_meta.start_ms,
                        "endMs": chunk_meta.end_ms,
                        "status": "pending",
                    }
                }),
            );

            // Auto-transcribe chunk if model is available
            if chunk_buffer.has_separate_channels() {
                // Stereo mode: transcribe each channel separately
                let mic_samples = chunk_buffer.get_mic_samples_range(event.start_ms, event.end_ms);
                let sys_samples = chunk_buffer.get_sys_samples_range(event.start_ms, event.end_ms);
                
                if !mic_samples.is_empty() || !sys_samples.is_empty() {
                    chunk_meta = transcribe_chunk_stereo(
                        chunk_meta,
                        &mic_samples,
                        &sys_samples,
                        chunk_buffer.sample_rate(),
                        &transcription_config,
                        &session_id,
                        &app_handle,
                    );
                }
            } else {
                // Mono mode
                let chunk_samples = chunk_buffer.get_samples_range(event.start_ms, event.end_ms);
                if !chunk_samples.is_empty() {
                    chunk_meta = transcribe_chunk_samples(
                        chunk_meta,
                        &chunk_samples,
                        chunk_buffer.sample_rate(),
                        &transcription_config,
                        &session_id,
                        &app_handle,
                    );
                }
            }

            // Save chunk meta
            if let Err(e) = chunk_meta.save(&chunk_path) {
                tracing::error!("Failed to save chunk meta: {}", e);
            }

            chunks.push(chunk_meta);
        }

        // Emit audio level (always emit, even if no samples yet)
        let elapsed = start_time.elapsed().as_secs_f64();
        let recent_start = all_mic_samples.len().saturating_sub(800);
        let recent = &all_mic_samples[recent_start..];
        let mic_level = if !recent.is_empty() {
            let rms: f32 = (recent.iter().map(|s| s * s).sum::<f32>() / recent.len() as f32).sqrt();
            (rms * 300.0).min(100.0)
        } else {
            0.0
        };

        // Log first few emissions for debugging
        if loop_count <= 5 {
            tracing::info!(
                "Emitting audio-level: mic_level={:.1}, samples={}, elapsed={:.2}s",
                mic_level,
                all_mic_samples.len(),
                elapsed
            );
        }

        let _ = app_handle.emit(
            "audio-level",
            serde_json::json!({
                "micLevel": mic_level,
                "sysLevel": sys_level,
                "duration": elapsed,
            }),
        );
    }

    // Flush remaining audio as final chunk
    if let Some(event) = chunk_buffer.flush_all() {
        let mut chunk_meta = ChunkMeta::from_event(&event, &session_id);
        let chunk_path = data_dir
            .join("chunks")
            .join(format!("chunk_{:04}.json", event.index));

        // Auto-transcribe final chunk
        if chunk_buffer.has_separate_channels() {
            // Stereo mode: transcribe each channel separately
            let mic_samples = chunk_buffer.get_mic_samples_range(event.start_ms, event.end_ms);
            let sys_samples = chunk_buffer.get_sys_samples_range(event.start_ms, event.end_ms);
            
            if !mic_samples.is_empty() || !sys_samples.is_empty() {
                chunk_meta = transcribe_chunk_stereo(
                    chunk_meta,
                    &mic_samples,
                    &sys_samples,
                    chunk_buffer.sample_rate(),
                    &transcription_config,
                    &session_id,
                    &app_handle,
                );
            }
        } else {
            // Mono mode
            let chunk_samples = chunk_buffer.get_samples_range(event.start_ms, event.end_ms);
            if !chunk_samples.is_empty() {
                chunk_meta = transcribe_chunk_samples(
                    chunk_meta,
                    &chunk_samples,
                    chunk_buffer.sample_rate(),
                    &transcription_config,
                    &session_id,
                    &app_handle,
                );
            }
        }

        let _ = chunk_meta.save(&chunk_path);
        chunks.push(chunk_meta);
    }

    // Stop system audio capture first
    if let Some(ref mut sys) = sys_capture {
        let _ = sys.stop();
    }

    // Stop mic capture and close MP3
    let samples = mic_capture.stop();
    let sample_count = samples.len();
    let _ = mp3_writer.close();

    let duration_ms = mp3_writer.duration_ms();

    tracing::info!(
        "Recording stopped: session={}, {} samples, {} ms, {} chunks",
        session_id,
        sample_count,
        duration_ms,
        chunks.len()
    );

    // Emit session_stopped event
    let _ = app_handle.emit(
        "session-stopped",
        serde_json::json!({
            "sessionId": session_id,
        }),
    );

    RecordingResult {
        session_id,
        duration_ms,
        sample_count,
        chunks,
    }
}

/// Transcribe chunk samples and update ChunkMeta
/// This function resamples audio if needed and runs transcription
fn transcribe_chunk_samples(
    mut chunk_meta: ChunkMeta,
    samples: &[f32],
    source_sample_rate: u32,
    config: &TranscriptionConfig,
    session_id: &str,
    app_handle: &tauri::AppHandle,
) -> ChunkMeta {
    #[allow(unused_imports)]
    use tauri::Emitter;

    tracing::info!(
        "Transcribing chunk {}: {} samples @ {}Hz, model={}",
        chunk_meta.index,
        samples.len(),
        source_sample_rate,
        config.model_id
    );

    // Resample to 16kHz if needed
    let samples_16k = if source_sample_rate != TRANSCRIPTION_SAMPLE_RATE {
        resample_audio(samples, source_sample_rate, TRANSCRIPTION_SAMPLE_RATE)
    } else {
        samples.to_vec()
    };

    // Run transcription
    match transcribe_samples_sync(
        &samples_16k,
        &config.model_id,
        &config.language,
        config.hybrid_enabled,
        &config.hybrid_secondary_model_id,
        &config.hotwords,
    ) {
        Ok(segments) => {
            // Convert segments to dialogue
            let dialogue: Vec<DialogueEntry> = segments
                .into_iter()
                .map(|seg| DialogueEntry {
                    start: seg.start + chunk_meta.start_ms,
                    end: seg.end + chunk_meta.start_ms,
                    text: seg.text,
                    speaker: seg.speaker.unwrap_or_else(|| "mic".to_string()),
                })
                .collect();

            // Update chunk meta
            chunk_meta.transcription = dialogue
                .iter()
                .map(|d| d.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            chunk_meta.dialogue = dialogue.clone();
            chunk_meta.status = "completed".to_string();

            tracing::info!(
                "Chunk {} transcribed: {} segments, {} chars",
                chunk_meta.index,
                dialogue.len(),
                chunk_meta.transcription.len()
            );

            // Emit chunk_transcribed event
            let _ = app_handle.emit(
                "chunk_transcribed",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunk": {
                        "id": chunk_meta.id,
                        "index": chunk_meta.index,
                        "startMs": chunk_meta.start_ms,
                        "endMs": chunk_meta.end_ms,
                        "status": "completed",
                        "transcription": chunk_meta.transcription,
                        "dialogue": dialogue,
                    }
                }),
            );
        }
        Err(e) => {
            tracing::error!("Failed to transcribe chunk {}: {}", chunk_meta.index, e);
            chunk_meta.status = "error".to_string();

            // Emit chunk_error event
            let _ = app_handle.emit(
                "chunk_error",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunkId": chunk_meta.id,
                    "error": e.to_string(),
                }),
            );
        }
    }

    chunk_meta
}

/// Transcribe stereo chunk (separate mic and sys channels)
fn transcribe_chunk_stereo(
    mut chunk_meta: ChunkMeta,
    mic_samples: &[f32],
    sys_samples: &[f32],
    source_sample_rate: u32,
    config: &TranscriptionConfig,
    session_id: &str,
    app_handle: &tauri::AppHandle,
) -> ChunkMeta {
    #[allow(unused_imports)]
    use tauri::Emitter;

    tracing::info!(
        "Transcribing stereo chunk {}: mic={} sys={} samples @ {}Hz",
        chunk_meta.index,
        mic_samples.len(),
        sys_samples.len(),
        source_sample_rate
    );

    let mut all_dialogue: Vec<DialogueEntry> = Vec::new();

    // Transcribe mic channel
    if !mic_samples.is_empty() {
        let mic_16k = if source_sample_rate != TRANSCRIPTION_SAMPLE_RATE {
            resample_audio(mic_samples, source_sample_rate, TRANSCRIPTION_SAMPLE_RATE)
        } else {
            mic_samples.to_vec()
        };

        if let Ok(segments) = transcribe_samples_sync(
            &mic_16k,
            &config.model_id,
            &config.language,
            config.hybrid_enabled,
            &config.hybrid_secondary_model_id,
            &config.hotwords,
        ) {
            for seg in segments {
                all_dialogue.push(DialogueEntry {
                    start: seg.start + chunk_meta.start_ms,
                    end: seg.end + chunk_meta.start_ms,
                    text: seg.text,
                    speaker: "mic".to_string(),
                });
            }
        }
    }

    // Transcribe sys channel
    if !sys_samples.is_empty() {
        let sys_16k = if source_sample_rate != TRANSCRIPTION_SAMPLE_RATE {
            resample_audio(sys_samples, source_sample_rate, TRANSCRIPTION_SAMPLE_RATE)
        } else {
            sys_samples.to_vec()
        };

        if let Ok(segments) = transcribe_samples_sync(
            &sys_16k,
            &config.model_id,
            &config.language,
            config.hybrid_enabled,
            &config.hybrid_secondary_model_id,
            &config.hotwords,
        ) {
            for seg in segments {
                all_dialogue.push(DialogueEntry {
                    start: seg.start + chunk_meta.start_ms,
                    end: seg.end + chunk_meta.start_ms,
                    text: seg.text,
                    speaker: "sys".to_string(),
                });
            }
        }
    }

    // Sort by timestamp
    all_dialogue.sort_by_key(|d| d.start);

    // Update chunk meta
    chunk_meta.transcription = all_dialogue
        .iter()
        .map(|d| d.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    chunk_meta.dialogue = all_dialogue.clone();
    chunk_meta.status = "completed".to_string();

    tracing::info!(
        "Stereo chunk {} transcribed: {} segments total",
        chunk_meta.index,
        all_dialogue.len()
    );

    // Emit chunk_transcribed event
    let _ = app_handle.emit(
        "chunk_transcribed",
        serde_json::json!({
            "sessionId": session_id,
            "chunk": {
                "id": chunk_meta.id,
                "index": chunk_meta.index,
                "startMs": chunk_meta.start_ms,
                "endMs": chunk_meta.end_ms,
                "status": "completed",
                "transcription": chunk_meta.transcription,
                "dialogue": all_dialogue,
            }
        }),
    );

    chunk_meta
}

/// Resample audio to target sample rate using linear interpolation
fn resample_audio(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || samples.is_empty() {
        return samples.to_vec();
    }

    let ratio = target_rate as f64 / source_rate as f64;
    let new_len = (samples.len() as f64 * ratio) as usize;
    let mut resampled = vec![0.0f32; new_len];

    for (i, sample) in resampled.iter_mut().enumerate() {
        let src_idx = i as f64 / ratio;
        let src_idx_floor = src_idx.floor() as usize;
        let src_idx_ceil = (src_idx_floor + 1).min(samples.len() - 1);
        let frac = src_idx - src_idx_floor as f64;

        *sample = if src_idx_floor < samples.len() {
            samples[src_idx_floor] * (1.0 - frac as f32) + samples[src_idx_ceil] * frac as f32
        } else {
            0.0
        };
    }

    resampled
}

/// Synchronous transcription (called from recording thread)
fn transcribe_samples_sync(
    samples: &[f32],
    model_id: &str,
    language: &str,
    hybrid_enabled: bool,
    hybrid_secondary_model_id: &str,
    hotwords: &[String],
) -> Result<Vec<aiwisper_types::TranscriptSegment>> {
    use aiwisper_ml::{
        FluidASREngine, GigaAMEngine, HybridMode, HybridTranscriber, HybridTranscriptionConfig,
        TranscriptionEngine, VotingConfig, WhisperEngine,
    };
    use std::sync::Arc;

    // Get models directory
    let models_dir = dirs::data_local_dir()
        .map(|p| p.join("aiwisper").join("models"))
        .ok_or_else(|| anyhow::anyhow!("Models directory not found"))?;

    // Helper to create engine from model ID
    let create_engine = |mid: &str| -> Result<Arc<dyn TranscriptionEngine>> {
        let is_gigaam = mid.starts_with("gigaam");
        let is_whisper = mid.starts_with("ggml");
        let is_parakeet = mid.starts_with("parakeet") || mid.contains("fluid");

        if is_parakeet {
            // FluidASR (Parakeet TDT v3) - uses subprocess
            tracing::info!("Creating FluidASR engine for model: {}", mid);
            let mut engine = FluidASREngine::new()?;
            if !language.is_empty() && language != "auto" {
                engine.set_language(language)?;
            }
            Ok(Arc::new(engine))
        } else if is_gigaam {
            // Пробуем разные варианты имён модели
            let model_candidates: &[&str] = if mid.contains("e2e") {
                &["gigaam-v3-e2e-ctc.onnx", "v3_e2e_ctc.int8.onnx", "gigaam-v3-e2e-ctc.int8.onnx"]
            } else {
                &["gigaam-v3-ctc.onnx", "v3_ctc.int8.onnx", "gigaam-v3-ctc.int8.onnx"]
            };
            
            let model_path = model_candidates
                .iter()
                .map(|m| models_dir.join(m))
                .find(|p| p.exists())
                .ok_or_else(|| anyhow::anyhow!("GigaAM model not found. Tried: {:?}", model_candidates))?;
            
            // Пробуем разные варианты имён vocab файлов
            let vocab_candidates: &[&str] = if mid.contains("e2e") {
                &["gigaam-v3-e2e-ctc_vocab.txt", "v3_e2e_ctc_vocab.txt"]
            } else {
                &["gigaam-v3-ctc_vocab.txt", "v3_vocab.txt", "v3_ctc_vocab.txt"]
            };
            
            let vocab_path = vocab_candidates
                .iter()
                .map(|v| models_dir.join(v))
                .find(|p| p.exists())
                .ok_or_else(|| anyhow::anyhow!("GigaAM vocab not found. Tried: {:?}", vocab_candidates))?;

            let engine =
                GigaAMEngine::new(model_path.to_str().unwrap(), vocab_path.to_str().unwrap())?;
            Ok(Arc::new(engine))
        } else if is_whisper {
            let model_file = format!("{}.bin", mid);
            let model_path = models_dir.join(&model_file);

            if !model_path.exists() {
                return Err(anyhow::anyhow!("Whisper model not found: {}", model_file));
            }

            let mut engine = WhisperEngine::new(model_path.to_str().unwrap())?;
            if !language.is_empty() && language != "auto" {
                engine.set_language(language)?;
            }
            Ok(Arc::new(engine))
        } else {
            // Default to large-v3-turbo (fallback)
            tracing::warn!("Unknown model type '{}', falling back to Whisper large-v3-turbo", mid);
            let model_path = models_dir.join("ggml-large-v3-turbo.bin");
            if !model_path.exists() {
                return Err(anyhow::anyhow!("Default Whisper model not found"));
            }

            let mut engine = WhisperEngine::new(model_path.to_str().unwrap())?;
            if !language.is_empty() && language != "auto" {
                engine.set_language(language)?;
            }
            Ok(Arc::new(engine))
        }
    };

    // Create primary engine
    let primary_engine = create_engine(model_id)?;

    // If hybrid enabled, create secondary engine and use HybridTranscriber
    if hybrid_enabled && !hybrid_secondary_model_id.is_empty() {
        tracing::info!(
            "Using hybrid transcription: primary={}, secondary={}",
            model_id,
            hybrid_secondary_model_id
        );

        let secondary_engine = match create_engine(hybrid_secondary_model_id) {
            Ok(e) => Some(e),
            Err(e) => {
                tracing::warn!(
                    "Failed to create secondary engine: {}, using primary only",
                    e
                );
                None
            }
        };

        let config = HybridTranscriptionConfig {
            enabled: true,
            secondary_model_id: hybrid_secondary_model_id.to_string(),
            confidence_threshold: 0.5,
            mode: HybridMode::Parallel,
            hotwords: hotwords.to_vec(),
            voting: VotingConfig::default(),
            use_llm_for_merge: false, // Not used in recording mode
            ollama_model: String::new(),
            ollama_url: "http://localhost:11434".to_string(),
        };

        let transcriber = HybridTranscriber::new(primary_engine, secondary_engine, config);
        let result = transcriber.transcribe(samples)?;

        tracing::info!(
            "Hybrid transcription complete: {} segments, {} improvements",
            result.segments.len(),
            result.improvements.len()
        );

        Ok(result.segments)
    } else {
        // Single engine mode
        primary_engine.transcribe_with_segments(samples)
    }
}
