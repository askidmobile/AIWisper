//! Streaming MP3 writer using FFmpeg pipe
//!
//! Записывает аудио в MP3 файл через FFmpeg процесс.
//! Стриминговая запись - данные пишутся в stdin FFmpeg.
//!
//! # Сегментированная запись
//! `SegmentedMp3Writer` автоматически разбивает запись на сегменты
//! по 15 минут для предотвращения переполнения памяти при длительных
//! записях. При остановке сегменты склеиваются в один файл.

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

/// Сегментированный MP3 writer для длительных записей
///
/// Автоматически разбивает запись на сегменты по `segment_duration_secs` секунд.
/// При остановке склеивает все сегменты в один файл через FFmpeg concat.
///
/// # Преимущества:
/// - Ограниченное потребление памяти при любой длительности записи
/// - При crash сохраняются предыдущие сегменты
/// - Быстрая склейка без перекодирования (copy codec)
pub struct SegmentedMp3Writer {
    base_dir: PathBuf,
    sample_rate: u32,
    channels: u16,
    bitrate: String,

    /// Текущий активный writer
    current_writer: Option<Mp3Writer>,
    /// Индекс текущего сегмента (0, 1, 2, ...)
    current_segment: usize,
    /// Семплы записанные в текущий сегмент
    samples_in_segment: u64,

    /// Длительность сегмента в секундах (по умолчанию 900 = 15 минут)
    segment_duration_secs: u64,
    /// Список созданных файлов сегментов
    segment_files: Vec<PathBuf>,
    
    /// Общее количество записанных семплов (для duration_ms)
    total_samples_written: u64,
}

impl SegmentedMp3Writer {
    /// Создать сегментированный writer
    ///
    /// # Arguments
    /// * `base_dir` - Директория сессии (full_000.mp3 будет создан внутри)
    /// * `sample_rate` - Sample rate в Hz (обычно 24000)
    /// * `channels` - Количество каналов (1 - mono, 2 - stereo)
    /// * `bitrate` - Битрейт MP3 ("128k", "192k")
    /// * `segment_duration_secs` - Длительность одного сегмента в секундах
    pub fn new(
        base_dir: impl AsRef<Path>,
        sample_rate: u32,
        channels: u16,
        bitrate: &str,
        segment_duration_secs: u64,
    ) -> Result<Self> {
        let base_dir = base_dir.as_ref().to_path_buf();
        
        tracing::info!(
            "Creating SegmentedMp3Writer: dir={:?}, rate={}, channels={}, segment_duration={}s",
            base_dir,
            sample_rate,
            channels,
            segment_duration_secs
        );

        let mut writer = Self {
            base_dir,
            sample_rate,
            channels,
            bitrate: bitrate.to_string(),
            current_writer: None,
            current_segment: 0,
            samples_in_segment: 0,
            segment_duration_secs,
            segment_files: Vec::new(),
            total_samples_written: 0,
        };

        // Создаём первый сегмент
        writer.create_next_segment()?;

        Ok(writer)
    }

    /// Создать writer с длительностью сегмента 15 минут (900 секунд)
    pub fn new_default(
        base_dir: impl AsRef<Path>,
        sample_rate: u32,
        channels: u16,
        bitrate: &str,
    ) -> Result<Self> {
        Self::new(base_dir, sample_rate, channels, bitrate, 900)
    }

    /// Создать новый сегмент
    fn create_next_segment(&mut self) -> Result<()> {
        // Закрыть текущий сегмент если есть
        if let Some(mut writer) = self.current_writer.take() {
            writer.close()?;
        }

        // Имя файла: full_000.mp3, full_001.mp3, ...
        let segment_path = self.base_dir.join(format!("full_{:03}.mp3", self.current_segment));
        
        tracing::info!(
            "Creating segment {}: {:?}",
            self.current_segment,
            segment_path
        );

        let writer = Mp3Writer::new(&segment_path, self.sample_rate, self.channels, &self.bitrate)?;
        
        self.segment_files.push(segment_path);
        self.current_writer = Some(writer);
        self.samples_in_segment = 0;

        Ok(())
    }

    /// Проверить нужна ли ротация сегмента
    fn check_rotation(&mut self) -> Result<()> {
        let max_samples = self.segment_duration_secs * self.sample_rate as u64;
        
        if self.samples_in_segment >= max_samples {
            tracing::info!(
                "Segment {} reached {} samples, rotating to next segment",
                self.current_segment,
                self.samples_in_segment
            );
            
            self.current_segment += 1;
            self.create_next_segment()?;
        }

        Ok(())
    }

    /// Записать аудио семплы (float32)
    pub fn write(&mut self, samples: &[f32]) -> Result<()> {
        if samples.is_empty() {
            return Ok(());
        }

        // Проверяем нужна ли ротация
        self.check_rotation()?;

        // Пишем в текущий сегмент
        if let Some(ref mut writer) = self.current_writer {
            writer.write(samples)?;
            
            let samples_per_channel = samples.len() as u64 / self.channels as u64;
            self.samples_in_segment += samples_per_channel;
            self.total_samples_written += samples_per_channel;
        }

        Ok(())
    }

    /// Записать стерео семплы из раздельных каналов
    pub fn write_stereo(&mut self, mic_samples: &[f32], sys_samples: &[f32]) -> Result<()> {
        let min_len = mic_samples.len().min(sys_samples.len());
        if min_len == 0 {
            return Ok(());
        }

        // Проверяем нужна ли ротация
        self.check_rotation()?;

        // Пишем в текущий сегмент
        if let Some(ref mut writer) = self.current_writer {
            writer.write_stereo(mic_samples, sys_samples)?;
            
            self.samples_in_segment += min_len as u64;
            self.total_samples_written += min_len as u64;
        }

        Ok(())
    }

    /// Получить общую длительность в миллисекундах
    pub fn duration_ms(&self) -> u64 {
        self.total_samples_written * 1000 / self.sample_rate as u64
    }

    /// Получить количество созданных сегментов
    pub fn segment_count(&self) -> usize {
        self.segment_files.len()
    }

    /// Закрыть текущий сегмент
    pub fn close(&mut self) -> Result<()> {
        if let Some(mut writer) = self.current_writer.take() {
            writer.close()?;
        }

        tracing::info!(
            "SegmentedMp3Writer closed: {} segments, {} ms total",
            self.segment_files.len(),
            self.duration_ms()
        );

        Ok(())
    }

    /// Склеить все сегменты в один файл full.mp3
    ///
    /// Использует FFmpeg concat demuxer для быстрой склейки без перекодирования.
    /// После успешной склейки удаляет временные файлы сегментов.
    pub fn concatenate(&mut self) -> Result<PathBuf> {
        // Закрываем текущий сегмент
        self.close()?;

        let final_path = self.base_dir.join("full.mp3");

        if self.segment_files.is_empty() {
            return Err(anyhow::anyhow!("No segments to concatenate"));
        }

        // Один сегмент - просто переименовать
        if self.segment_files.len() == 1 {
            let first = &self.segment_files[0];
            std::fs::rename(first, &final_path)
                .with_context(|| format!("Failed to rename {:?} to {:?}", first, final_path))?;
            
            tracing::info!(
                "Single segment renamed to {:?}",
                final_path
            );
            
            self.segment_files.clear();
            return Ok(final_path);
        }

        // Несколько сегментов - используем FFmpeg concat
        tracing::info!(
            "Concatenating {} segments into {:?}",
            self.segment_files.len(),
            final_path
        );

        // Создаём concat list file
        let list_path = self.base_dir.join("concat_list.txt");
        let mut list_content = String::new();
        for segment in &self.segment_files {
            // FFmpeg требует относительные или абсолютные пути
            // Используем абсолютные для надёжности
            let abs_path = segment.canonicalize()
                .unwrap_or_else(|_| segment.clone());
            list_content.push_str(&format!("file '{}'\n", abs_path.display()));
        }
        std::fs::write(&list_path, &list_content)
            .context("Failed to write concat list")?;

        // Запускаем FFmpeg concat
        let ffmpeg = find_ffmpeg()?;
        
        let output = Command::new(&ffmpeg)
            .args([
                "-y",           // Overwrite output
                "-f", "concat", // Concat demuxer
                "-safe", "0",   // Allow absolute paths
                "-i",
            ])
            .arg(&list_path)
            .args([
                "-c", "copy",   // Copy без перекодирования (быстро!)
            ])
            .arg(&final_path)
            .output()
            .context("Failed to run FFmpeg concat")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::error!("FFmpeg concat failed: {}", stderr);
            return Err(anyhow::anyhow!("FFmpeg concat failed: {}", stderr));
        }

        tracing::info!(
            "Successfully concatenated {} segments into {:?}",
            self.segment_files.len(),
            final_path
        );

        // Удаляем временные файлы
        if let Err(e) = std::fs::remove_file(&list_path) {
            tracing::warn!("Failed to remove concat list: {}", e);
        }
        
        for segment in &self.segment_files {
            if let Err(e) = std::fs::remove_file(segment) {
                tracing::warn!("Failed to remove segment {:?}: {}", segment, e);
            }
        }
        
        self.segment_files.clear();

        Ok(final_path)
    }

    /// Получить путь к финальному файлу (full.mp3)
    pub fn final_path(&self) -> PathBuf {
        self.base_dir.join("full.mp3")
    }
}

impl Drop for SegmentedMp3Writer {
    fn drop(&mut self) {
        // Пытаемся закрыть текущий writer
        if let Some(mut writer) = self.current_writer.take() {
            let _ = writer.close();
        }
    }
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

    #[test]
    fn test_segmented_writer_creation() {
        let dir = tempdir().unwrap();
        let writer = SegmentedMp3Writer::new_default(
            dir.path(),
            24000,
            2,
            "128k"
        );
        // Может не работать без FFmpeg, но не должен паниковать
        if writer.is_ok() {
            assert_eq!(writer.unwrap().segment_count(), 1);
        }
    }
}
