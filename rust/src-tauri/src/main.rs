//! AIWisper - AI-powered speech transcription application
//!
//! Main entry point for the Tauri application.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use aiwisper_lib::run;

fn main() {
    run();
}
