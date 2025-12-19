//! AIWisper Library
//!
//! Core library for the AIWisper application.

use tauri::Manager;

pub mod audio;
pub mod commands;
pub mod ml;
pub mod providers;
pub mod state;
pub mod workers;

use state::AppState;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// Initialize and run the Tauri application
pub fn run() {
    // Set up file appender for logging
    let file_appender = tracing_appender::rolling::daily(
        dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")),
        "aiwisper.log",
    );
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    // Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,aiwisper=debug,aiwisper_audio=debug".into()),
        ))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stdout)
                .with_ansi(true)
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false)
        )
        .init();

    tracing::info!("Starting AIWisper application");
    tracing::info!("Logging initialized to file in home directory");
    tracing::info!("Logging initialized to file in home directory");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_macos_permissions::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // Audio
            commands::audio::start_recording,
            commands::audio::stop_recording,
            commands::audio::get_audio_devices,
            commands::audio::request_microphone_access,
            commands::audio::set_channel_mute,
            commands::audio::get_channel_mute,
            // Transcription
            commands::transcription::transcribe_file,
            commands::transcription::get_transcript_stream,
            commands::transcription::set_language,
            commands::transcription::set_hotwords,
            commands::transcription::get_waveform,
            commands::transcription::get_full_audio,
            commands::transcription::get_chunk_audio,
            commands::transcription::retranscribe_chunk,
            commands::transcription::retranscribe_full,
            commands::transcription::cancel_full_transcription,
            // Settings
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::settings::load_ui_settings,
            commands::settings::save_ui_settings,
            // Models
            commands::models::list_models,
            commands::models::download_model,
            commands::models::cancel_download,
            commands::models::delete_model,
            commands::models::set_active_model,
            commands::models::get_ollama_models,
            // Sessions
            commands::session::list_sessions,
            commands::session::get_session,
            commands::session::delete_session,
            commands::session::rename_session,
            commands::session::update_session_tags,
            commands::session::export_session,
            commands::session::get_session_speakers,
            commands::session::generate_summary,
            // Voiceprints
            commands::voiceprints::list_voiceprints,
            commands::voiceprints::create_voiceprint,
            commands::voiceprints::rename_voiceprint,
            commands::voiceprints::delete_voiceprint,
            commands::voiceprints::get_speaker_sample,
            // Diarization
            commands::diarization::enable_diarization,
            commands::diarization::disable_diarization,
            commands::diarization::get_diarization_status,
            // Providers
            commands::providers::get_stt_providers_settings,
            commands::providers::set_stt_providers_settings,
            commands::providers::get_llm_providers_settings,
            commands::providers::set_llm_providers_settings,
            commands::providers::set_provider_api_key,
            commands::providers::remove_provider_api_key,
            commands::providers::has_provider_api_key,
            commands::providers::test_provider_connection,
            commands::providers::get_providers_status,
            // Utility
            commands::open_data_folder,
        ])
        .setup(|app| {
            tracing::info!("Application setup complete");

            // Initialize ML engines in background
            let state = app.state::<AppState>();
            let state_clone = state.inner().clone();

            // Use tauri's async runtime instead of tokio::spawn directly
            tauri::async_runtime::spawn(async move {
                if let Err(e) = state_clone.initialize_engines().await {
                    tracing::error!("Failed to initialize ML engines: {}", e);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
