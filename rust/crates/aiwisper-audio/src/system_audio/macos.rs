//! macOS system audio capture implementation
//!
//! Uses external Swift binaries for system audio capture:
//! - `coreaudio-tap` - Core Audio Process Tap (macOS 14.2+)
//! - `screencapture-audio` - ScreenCaptureKit (macOS 13+)
//!
//! Binary protocol (Swift -> Rust):
//! ```text
//! [marker 1 byte][size 4 bytes little-endian][float32 samples]
//! Markers: 'M' (0x4D) = microphone, 'S' (0x53) = system audio
//! ```

use super::{
    AudioChannel, ChannelData, SystemAudioCapture, SystemCaptureConfig, SystemCaptureMethod,
};
use anyhow::{Context, Result};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

/// Protocol markers
const MARKER_MICROPHONE: u8 = b'M'; // 0x4D
const MARKER_SYSTEM: u8 = b'S'; // 0x53

/// macOS system audio capture using Swift binaries
pub struct MacOSSystemCapture {
    config: SystemCaptureConfig,
    process: Option<Child>,
    reader_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
    receiver: Receiver<ChannelData>,
    sender: Sender<ChannelData>,
}

impl MacOSSystemCapture {
    /// Create new macOS system capture
    pub fn new(config: SystemCaptureConfig) -> Result<Self> {
        let (sender, receiver) = mpsc::channel();

        Ok(Self {
            config,
            process: None,
            reader_thread: None,
            stderr_thread: None,
            running: Arc::new(AtomicBool::new(false)),
            receiver,
            sender,
        })
    }

    /// Get path to the capture binary
    fn get_binary_path(&self) -> Result<PathBuf> {
        let binary_name = match self.config.method {
            SystemCaptureMethod::CoreAudioTap => "coreaudio-tap",
            SystemCaptureMethod::ScreenCaptureKit => "screencapture-audio",
            _ => anyhow::bail!("Unsupported method for macOS: {:?}", self.config.method),
        };

        // Check multiple possible paths
        // Базовый путь для сборки (корень репозитория находится на три уровня выше manifest_dir)
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir.join("../../..");

        let paths = [
            // Next to the executable
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join(binary_name))),
            // In Tauri resources
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("../Resources").join(binary_name))),
            // Development paths - Swift .build/release
            Some(PathBuf::from(format!(
                "backend/audio/{}/.build/release/{}",
                if binary_name == "coreaudio-tap" {
                    "coreaudio"
                } else {
                    "screencapture"
                },
                binary_name
            ))),
            // Development paths - Swift .build/arm64-apple-macosx/release (default on Apple Silicon)
            Some(PathBuf::from(format!(
                "backend/audio/{}/.build/arm64-apple-macosx/release/{}",
                if binary_name == "coreaudio-tap" {
                    "coreaudio"
                } else {
                    "screencapture"
                },
                binary_name
            ))),
            // Development paths anchored at repo root (more robust for `cargo tauri dev`)
            Some(repo_root.join(format!(
                "backend/audio/{}/.build/release/{}",
                if binary_name == "coreaudio-tap" {
                    "coreaudio"
                } else {
                    "screencapture"
                },
                binary_name
            ))),
            Some(repo_root.join(format!(
                "backend/audio/{}/.build/arm64-apple-macosx/release/{}",
                if binary_name == "coreaudio-tap" {
                    "coreaudio"
                } else {
                    "screencapture"
                },
                binary_name
            ))),
        ];

        for path in paths.into_iter().flatten() {
            if path.exists() {
                return Ok(path);
            }
        }

        anyhow::bail!(
            "{} binary not found. Build it with: cd backend/audio/{} && swift build -c release",
            binary_name,
            if binary_name == "coreaudio-tap" {
                "coreaudio"
            } else {
                "screencapture"
            }
        )
    }

    /// Get capture mode argument for screencapture-audio
    fn get_capture_mode(&self) -> &str {
        if self.config.capture_microphone {
            "both"
        } else {
            "system"
        }
    }
}

impl SystemAudioCapture for MacOSSystemCapture {
    fn start(&mut self) -> Result<()> {
        if self.running.load(Ordering::SeqCst) {
            anyhow::bail!("Capture already running");
        }

        let binary_path = self.get_binary_path()?;
        tracing::info!("Starting system audio capture: {:?}", binary_path);

        // Build command
        let mut cmd = Command::new(&binary_path);

        // Add mode argument for screencapture-audio
        if self.config.method == SystemCaptureMethod::ScreenCaptureKit {
            cmd.arg(self.get_capture_mode());
        }

        // Configure process
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        // Start process
        let mut process = cmd.spawn().context("Failed to start capture binary")?;

        let stdout = process.stdout.take().context("Failed to get stdout")?;
        let stderr = process.stderr.take().context("Failed to get stderr")?;

        self.running.store(true, Ordering::SeqCst);

        // Spawn stderr reader thread (for logs)
        let running = self.running.clone();
        let stderr_thread = thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(line) = line {
                    if line.starts_with("READY") {
                        tracing::info!("System audio capture ready: {}", line);
                    } else if line.starts_with("ERROR:") {
                        tracing::error!("System audio: {}", line);
                    } else {
                        tracing::debug!("System audio: {}", line);
                    }
                }
            }
        });

        // Spawn stdout reader thread (for audio data)
        let running = self.running.clone();
        let sender = self.sender.clone();
        let reader_thread = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut header = [0u8; 5]; // 1 byte marker + 4 bytes size

            while running.load(Ordering::SeqCst) {
                // Read header
                if reader.read_exact(&mut header).is_err() {
                    break;
                }

                let marker = header[0];
                let sample_count = u32::from_le_bytes([header[1], header[2], header[3], header[4]]);

                if sample_count == 0 || sample_count > 1_000_000 {
                    tracing::warn!("Invalid sample count: {}", sample_count);
                    continue;
                }

                // Read audio data
                let data_size = sample_count as usize * 4;
                let mut data = vec![0u8; data_size];
                if reader.read_exact(&mut data).is_err() {
                    break;
                }

                // Convert bytes to f32 samples
                let samples: Vec<f32> = data
                    .chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect();

                // Determine channel from marker
                let channel = match marker {
                    MARKER_MICROPHONE => AudioChannel::Microphone,
                    MARKER_SYSTEM => AudioChannel::System,
                    _ => {
                        tracing::warn!("Unknown channel marker: 0x{:02X}", marker);
                        continue;
                    }
                };

                // Send to channel
                if sender.send(ChannelData { channel, samples }).is_err() {
                    break;
                }
            }

            tracing::debug!("Audio reader thread finished");
        });

        self.process = Some(process);
        self.reader_thread = Some(reader_thread);
        self.stderr_thread = Some(stderr_thread);

        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        if !self.running.load(Ordering::SeqCst) {
            return Ok(());
        }

        tracing::info!("Stopping system audio capture...");
        self.running.store(false, Ordering::SeqCst);

        // Send SIGINT for graceful shutdown
        if let Some(ref mut process) = self.process {
            #[cfg(unix)]
            {
                use nix::sys::signal::{kill, Signal};
                use nix::unistd::Pid;

                if let Some(pid) = process.id().try_into().ok() {
                    let _ = kill(Pid::from_raw(pid), Signal::SIGINT);
                }
            }

            // Wait with timeout
            let start = std::time::Instant::now();
            loop {
                match process.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if start.elapsed() > std::time::Duration::from_secs(5) {
                            tracing::warn!("Force killing capture process...");
                            let _ = process.kill();
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(_) => break,
                }
            }
        }

        // Wait for threads
        if let Some(thread) = self.reader_thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.stderr_thread.take() {
            let _ = thread.join();
        }

        self.process = None;

        // Short delay for macOS to release audio resources
        std::thread::sleep(std::time::Duration::from_millis(200));

        tracing::info!("System audio capture stopped");
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn get_receiver(&self) -> &Receiver<ChannelData> {
        &self.receiver
    }
}

impl Drop for MacOSSystemCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Check if system audio capture is available on macOS
pub fn is_available() -> bool {
    // Check for screencapture-audio binary
    let paths = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("screencapture-audio"))),
        std::env::current_exe().ok().and_then(|p| {
            p.parent()
                .map(|p| p.join("../Resources/screencapture-audio"))
        }),
        Some(PathBuf::from(
            "backend/audio/screencapture/.build/release/screencapture-audio",
        )),
    ];

    paths.into_iter().flatten().any(|p| p.exists())
}

/// Get the best available capture method for macOS
pub fn get_best_method() -> Option<SystemCaptureMethod> {
    // Check macOS version
    let version = get_macos_version();

    if let Some((major, minor)) = version {
        // macOS 14.2+ - Core Audio Process Tap (best, no permission required)
        if major > 14 || (major == 14 && minor >= 2) {
            if coreaudio_tap_available() {
                return Some(SystemCaptureMethod::CoreAudioTap);
            }
        }

        // macOS 13+ - ScreenCaptureKit
        if major >= 13 {
            if screencapture_available() {
                return Some(SystemCaptureMethod::ScreenCaptureKit);
            }
        }
    }

    // Fallback to virtual loopback if available
    Some(SystemCaptureMethod::VirtualLoopback)
}

/// Get macOS version (major, minor)
fn get_macos_version() -> Option<(u32, u32)> {
    let output = Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;

    let version = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = version.trim().split('.').collect();

    let major = parts.first()?.parse().ok()?;
    let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);

    Some((major, minor))
}

/// Check if coreaudio-tap binary is available
fn coreaudio_tap_available() -> bool {
    let paths = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("coreaudio-tap"))),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("../Resources/coreaudio-tap"))),
        Some(PathBuf::from(
            "backend/audio/coreaudio/.build/release/coreaudio-tap",
        )),
    ];

    paths.into_iter().flatten().any(|p| p.exists())
}

/// Check if screencapture-audio binary is available
fn screencapture_available() -> bool {
    let paths = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("screencapture-audio"))),
        std::env::current_exe().ok().and_then(|p| {
            p.parent()
                .map(|p| p.join("../Resources/screencapture-audio"))
        }),
        Some(PathBuf::from(
            "backend/audio/screencapture/.build/release/screencapture-audio",
        )),
    ];

    paths.into_iter().flatten().any(|p| p.exists())
}

/// Check if Voice Isolation is available (macOS 15+)
#[allow(dead_code)]
pub fn voice_isolation_available() -> bool {
    if let Some((major, _)) = get_macos_version() {
        major >= 15
    } else {
        false
    }
}
