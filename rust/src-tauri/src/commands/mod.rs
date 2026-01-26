//! Tauri commands module
//!
//! Contains all IPC commands exposed to the frontend.

pub mod audio;
pub mod diarization;
pub mod models;
pub mod providers;
pub mod session;
pub mod settings;
pub mod system;
pub mod transcription;
pub mod voiceprints;

/// Open the data folder in Finder
#[tauri::command]
pub async fn open_data_folder() -> Result<(), String> {
    // Get the app data directory (legacy path for compatibility with Go backend)
    let data_dir = dirs::data_local_dir()
        .map(|p| p.join("aiwisper"))
        .ok_or_else(|| "Could not determine data directory".to_string())?;

    // Create if not exists
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data directory: {}", e))?;
    }

    // Open in Finder using 'open' command on macOS
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&data_dir)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&data_dir)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&data_dir)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    Ok(())
}
