//! System diagnostic commands
//!
//! Provides information about GPU/accelerator status and system capabilities.

use serde::{Deserialize, Serialize};

/// GPU/Accelerator status information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuStatus {
    /// Operating system
    pub platform: String,
    /// CPU architecture
    pub arch: String,
    /// Whether running on Apple Silicon
    pub is_apple_silicon: bool,
    /// Metal availability (macOS GPU)
    pub metal_available: bool,
    /// CoreML availability (macOS ML accelerator)
    pub coreml_available: bool,
    /// CUDA availability (NVIDIA GPU)
    pub cuda_available: bool,
    /// Whisper GPU status
    pub whisper_gpu_enabled: bool,
    /// GigaAM CoreML status
    pub gigaam_coreml_enabled: bool,
    /// VAD CoreML status  
    pub vad_coreml_enabled: bool,
    /// Recommendation message
    pub recommendation: String,
}

/// Get GPU/accelerator status
#[tauri::command]
pub async fn get_gpu_status() -> Result<GpuStatus, String> {
    let platform = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    
    let is_apple_silicon = cfg!(target_os = "macos") && cfg!(target_arch = "aarch64");
    
    // Check Metal availability (macOS GPU)
    let metal_available = is_apple_silicon && check_metal_available();
    
    // Check CoreML availability
    let coreml_available = is_apple_silicon;
    
    // Check CUDA availability
    let cuda_available = check_cuda_available();
    
    // Determine recommendation
    let recommendation = if is_apple_silicon {
        if metal_available && coreml_available {
            "Optimal: Apple Silicon detected. Metal (Whisper) and CoreML (ONNX models) acceleration available.".to_string()
        } else if metal_available {
            "Good: Metal GPU acceleration available for Whisper.".to_string()
        } else {
            "Warning: Apple Silicon detected but Metal not available. Check ggml-metal.metal file.".to_string()
        }
    } else if cuda_available {
        "Good: NVIDIA CUDA GPU detected.".to_string()
    } else {
        "Info: Running on CPU. For best performance, use Apple Silicon Mac or NVIDIA GPU.".to_string()
    };
    
    Ok(GpuStatus {
        platform,
        arch,
        is_apple_silicon,
        metal_available,
        coreml_available,
        cuda_available,
        whisper_gpu_enabled: metal_available, // Whisper uses Metal on Apple Silicon
        gigaam_coreml_enabled: coreml_available, // GigaAM uses CoreML (except INT8)
        vad_coreml_enabled: coreml_available, // VAD uses CoreML
        recommendation,
    })
}

/// Check if Metal shader is available
fn check_metal_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        // Check in common locations
        let locations = [
            // In app resources
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("resources").join("ggml-metal.metal"))),
            // In current directory
            Some(std::path::PathBuf::from("ggml-metal.metal")),
            // In app bundle
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("ggml-metal.metal"))),
        ];
        
        for loc in locations.into_iter().flatten() {
            if loc.exists() {
                return true;
            }
        }
        
        // On Apple Silicon, Metal is generally available even if shader not found
        // whisper-rs will handle this internally
        cfg!(target_arch = "aarch64")
    }
    
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Check if CUDA is available
fn check_cuda_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        // Check for NVIDIA device
        if std::path::Path::new("/dev/nvidia0").exists() {
            return true;
        }
        
        // Check environment variables
        if let Ok(devices) = std::env::var("NVIDIA_VISIBLE_DEVICES") {
            if !devices.is_empty() && devices.to_lowercase() != "none" {
                return true;
            }
        }
        
        if let Ok(devices) = std::env::var("CUDA_VISIBLE_DEVICES") {
            if !devices.is_empty() && devices.to_lowercase() != "none" {
                return true;
            }
        }
        
        false
    }
    
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Log GPU status at application startup
pub fn log_gpu_status() {
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let is_apple_silicon = cfg!(target_os = "macos") && cfg!(target_arch = "aarch64");
    
    tracing::info!("=== GPU/Accelerator Status ===");
    tracing::info!("Platform: {} ({})", platform, arch);
    
    if is_apple_silicon {
        tracing::info!("Apple Silicon: YES");
        tracing::info!("Metal GPU: available (Whisper acceleration)");
        tracing::info!("CoreML: available (ONNX model acceleration)");
        tracing::info!("Note: INT8 models use CPU (faster than CoreML for quantized)");
    } else if check_cuda_available() {
        tracing::info!("NVIDIA CUDA: available");
    } else {
        tracing::info!("Acceleration: CPU only");
    }
    
    tracing::info!("==============================");
}
