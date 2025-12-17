//! AIWisper Worker Process
//!
//! Isolated worker process for ML inference to prevent memory leaks
//! from affecting the main application.
//!
//! Communication is via JSON over stdin/stdout.

use aiwisper_types::{SpeakerSegment, WorkerCommand, WorkerResponse};
use anyhow::Result;
use std::io::{self, BufRead, Write};
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

fn run_worker() -> Result<()> {
    // TODO: Initialize ML engines here
    // let diarizer = init_diarizer()?;

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

                // TODO: Implement actual diarization
                // For now, return mock result
                let segments = vec![SpeakerSegment {
                    start: 0.0,
                    end: samples.len() as f32 / 16000.0,
                    speaker: 0,
                }];

                WorkerResponse::Diarization {
                    segments,
                    num_speakers: 1,
                }
            }

            WorkerCommand::Transcribe { samples, engine } => {
                tracing::debug!("Transcribing {} samples with {}", samples.len(), engine);

                // TODO: Implement actual transcription
                WorkerResponse::Error {
                    message: "Transcription not yet implemented in worker".to_string(),
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
