//! Streaming MP3 writer using FFmpeg pipe
//!
//! Записывает аудио в MP3 файл через FFmpeg процесс.
//! Стриминговая запись - данные пишутся в stdin FFmpeg.

use anyhow::{Context, Result};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

/// Streaming MP3 writer through FFmpeg pipe
pub struct Mp3Writer {
    cmd: Child,
    stdin: Option<std::process::ChildStdin>,
    file_path: PathBuf,
    sample_rate: u32,
    channels: u16,
    samples_written: AtomicU64,
}

impl Mp3Writer {
    /// Create new MP3 writer
    ///
    /// # Arguments
    /// * `file_path` - Output MP3 file path
    /// * `sample_rate` - Sample rate in Hz (typically 24000 for recording)
    /// * `channels` - Number of channels (1 for mono, 2 for stereo)
    /// * `bitrate` - MP3 bitrate (e.g., "128k", "192k")
    pub fn new(
        file_path: impl AsRef<Path>,
        sample_rate: u32,
        channels: u16,
        bitrate: &str,
    ) -> Result<Self> {
        let file_path = file_path.as_ref().to_path_buf();

        // Find FFmpeg
        let ffmpeg_path = find_ffmpeg()?;

        tracing::info!(
            "Creating MP3Writer: path={:?}, rate={}, channels={}, bitrate={}",
            file_path,
            sample_rate,
            channels,
            bitrate
        );

        // Start FFmpeg process
        let mut cmd = Command::new(&ffmpeg_path)
            .args([
                "-y", // Overwrite output
                "-f",
                "s16le", // Input format: signed 16-bit little-endian
                "-ar",
                &sample_rate.to_string(), // Sample rate
                "-ac",
                &channels.to_string(), // Channels
                "-i",
                "pipe:0", // Read from stdin
                "-c:a",
                "libmp3lame", // MP3 encoder
                "-b:a",
                bitrate, // Bitrate
                "-f",
                "mp3", // Output format
            ])
            .arg(&file_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("Failed to start FFmpeg: {}", ffmpeg_path.display()))?;

        let stdin = cmd.stdin.take().context("Failed to get FFmpeg stdin")?;

        Ok(Self {
            cmd,
            stdin: Some(stdin),
            file_path,
            sample_rate,
            channels,
            samples_written: AtomicU64::new(0),
        })
    }

    /// Write audio samples (float32)
    ///
    /// Samples are converted to int16 and written to FFmpeg stdin.
    /// For stereo, samples should be interleaved: [L0, R0, L1, R1, ...]
    pub fn write(&mut self, samples: &[f32]) -> Result<()> {
        if samples.is_empty() {
            return Ok(());
        }

        let stdin = self.stdin.as_mut().context("Writer already closed")?;

        // Convert float32 -> int16
        let mut buf = vec![0u8; samples.len() * 2];
        for (i, &sample) in samples.iter().enumerate() {
            // Clamp to [-1, 1] and convert to int16
            let clamped = sample.clamp(-1.0, 1.0);
            let int_sample = (clamped * 32767.0) as i16;
            buf[i * 2] = int_sample as u8;
            buf[i * 2 + 1] = (int_sample >> 8) as u8;
        }

        stdin
            .write_all(&buf)
            .context("Failed to write to FFmpeg stdin")?;

        // Count samples (per channel)
        let samples_per_channel = samples.len() as u64 / self.channels as u64;
        self.samples_written
            .fetch_add(samples_per_channel, Ordering::SeqCst);

        Ok(())
    }

    /// Write stereo samples from separate channels
    ///
    /// Interleaves mic and sys channels: [mic0, sys0, mic1, sys1, ...]
    pub fn write_stereo(&mut self, mic_samples: &[f32], sys_samples: &[f32]) -> Result<()> {
        let min_len = mic_samples.len().min(sys_samples.len());
        if min_len == 0 {
            return Ok(());
        }

        // Interleave channels
        let mut interleaved = vec![0.0f32; min_len * 2];
        for i in 0..min_len {
            interleaved[i * 2] = mic_samples[i]; // Left = mic
            interleaved[i * 2 + 1] = sys_samples[i]; // Right = sys
        }

        self.write(&interleaved)
    }

    /// Get number of samples written (per channel)
    pub fn samples_written(&self) -> u64 {
        self.samples_written.load(Ordering::SeqCst)
    }

    /// Get duration in milliseconds
    pub fn duration_ms(&self) -> u64 {
        let samples = self.samples_written();
        samples * 1000 / self.sample_rate as u64
    }

    /// Get output file path
    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    /// Close the writer and finalize MP3 file
    pub fn close(&mut self) -> Result<()> {
        // Close stdin to signal EOF to FFmpeg
        if let Some(stdin) = self.stdin.take() {
            drop(stdin);
        }

        // Wait for FFmpeg to finish
        let status = self.cmd.wait().context("Failed to wait for FFmpeg")?;

        if !status.success() {
            anyhow::bail!("FFmpeg exited with error: {:?}", status);
        }

        tracing::info!(
            "MP3Writer closed: {:?}, {} samples written, {} ms",
            self.file_path,
            self.samples_written.load(Ordering::SeqCst),
            self.duration_ms()
        );

        Ok(())
    }
}

impl Drop for Mp3Writer {
    fn drop(&mut self) {
        // Try to kill FFmpeg if still running
        let _ = self.cmd.kill();
    }
}

/// Find FFmpeg binary
///
/// Search order:
/// 1. App bundle Resources directory (macOS) - Tauri bundled resources
/// 2. Next to executable
/// 3. Current working directory
/// 4. System PATH
fn find_ffmpeg() -> Result<PathBuf> {
    let mut search_paths = Vec::new();

    // Get executable directory
    if let Ok(exe_path) = std::env::current_exe() {
        let exe_dir = exe_path.parent().unwrap_or(Path::new("."));

        // macOS app bundle: Contents/MacOS/../Resources/resources/ffmpeg (Tauri bundled)
        search_paths.push(exe_dir.join("../Resources/resources/ffmpeg"));
        
        // Also check Contents/MacOS/../Resources/ffmpeg (legacy path)
        search_paths.push(exe_dir.join("../Resources/ffmpeg"));

        // Next to executable
        search_paths.push(exe_dir.join("ffmpeg"));
    }

    // Current working directory
    if let Ok(cwd) = std::env::current_dir() {
        search_paths.push(cwd.join("ffmpeg"));
        search_paths.push(cwd.join("vendor/ffmpeg/ffmpeg"));
        // Also check src-tauri resources for dev mode
        search_paths.push(cwd.join("src-tauri/resources/ffmpeg"));
    }

    // Log all search paths for debugging
    tracing::debug!("FFmpeg search paths: {:?}", search_paths);

    // Check all paths
    for path in &search_paths {
        if path.exists() {
            tracing::info!("Found FFmpeg: {:?}", path);
            return Ok(path.clone());
        }
    }

    // System PATH
    if let Ok(path) = which::which("ffmpeg") {
        tracing::info!("Using system FFmpeg: {:?}", path);
        return Ok(path);
    }

    // Fallback: try "ffmpeg" and hope it works
    tracing::warn!("FFmpeg not found in bundle or PATH, trying 'ffmpeg' command");
    Ok(PathBuf::from("ffmpeg"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_find_ffmpeg() {
        // Should not panic
        let _ = find_ffmpeg();
    }
}
