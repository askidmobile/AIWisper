//! AIWisper Worker Process
//!
//! Isolated worker process for ML inference to prevent memory leaks
//! from affecting the main application.
//!
//! Communication is via JSON over stdin/stdout.

use aiwisper_ml::{get_or_create_engine_cached, FluidDiarizationEngine};
use aiwisper_types::{WorkerCommand, WorkerResponse};
use anyhow::Result;
use std::io::{self, BufRead, Write};
use std::sync::OnceLock;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
    // Initialize tracing to stderr (stdout is for IPC)
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".into()),
        ))
        .with(tracing_subscriber::fmt::layer().with_writer(io::stderr))
        .init();

    tracing::info!("AIWisper worker starting");

    if let Err(e) = run_worker() {
        tracing::error!("Worker error: {}", e);
        std::process::exit(1);
    }
}

fn get_diarizer() -> Result<&'static FluidDiarizationEngine> {
    static DIARIZER: OnceLock<FluidDiarizationEngine> = OnceLock::new();
    DIARIZER.get_or_try_init(|| FluidDiarizationEngine::with_defaults())
}

fn run_worker() -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    tracing::info!("Worker ready, listening for commands");

    for line in stdin.lock().lines() {
        let line = line?;

        if line.is_empty() {
            continue;
        }

        let command: WorkerCommand = match serde_json::from_str(&line) {
            Ok(cmd) => cmd,
            Err(e) => {
                let response = WorkerResponse::Error {
                    message: format!("Invalid command: {}", e),
                };
                writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
                stdout.flush()?;
                continue;
            }
        };

        let response = match command {
            WorkerCommand::Diarize { samples } => {
                tracing::debug!("Diarizing {} samples", samples.len());

                match get_diarizer().and_then(|engine| engine.diarize_with_embeddings(&samples)) {
                    Ok(result) => WorkerResponse::Diarization {
                        segments: result.segments,
                        num_speakers: result.num_speakers,
                    },
                    Err(e) => WorkerResponse::Error {
                        message: format!("Diarization failed: {}", e),
                    },
                }
            }

            WorkerCommand::Transcribe { samples, engine } => {
                tracing::debug!("Transcribing {} samples with {}", samples.len(), engine);

                match get_or_create_engine_cached(&engine, "auto")
                    .and_then(|engine| engine.transcribe(&samples))
                {
                    Ok(result) => WorkerResponse::Transcription(result),
                    Err(e) => WorkerResponse::Error {
                        message: format!("Transcription failed: {}", e),
                    },
                }
            }

            WorkerCommand::Shutdown => {
                tracing::info!("Shutdown command received");
                let response = WorkerResponse::Ok;
                writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
                stdout.flush()?;
                break;
            }
        };

        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }

    tracing::info!("Worker shutting down");
    Ok(())
}
