//! Worker process management
//!
//! Provides process isolation for ML inference to prevent memory leaks
//! from affecting the main application.

use anyhow::Result;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

/// Worker process manager for isolated ML inference
pub struct WorkerManager {
    /// Path to worker binary
    worker_path: String,
    /// Current worker process handle
    worker: Option<Child>,
    /// Memory threshold for restart (bytes)
    #[allow(dead_code)]
    memory_threshold: usize,
    /// Number of requests since last restart
    request_count: usize,
    /// Max requests before forced restart
    max_requests: usize,
}

impl WorkerManager {
    /// Create a new worker manager
    pub fn new(worker_path: &str) -> Self {
        Self {
            worker_path: worker_path.to_string(),
            worker: None,
            memory_threshold: 500 * 1024 * 1024, // 500MB
            request_count: 0,
            max_requests: 100, // Restart after 100 requests as a safety measure
        }
    }

    /// Start the worker process
    pub fn start(&mut self) -> Result<()> {
        if self.worker.is_some() {
            return Ok(());
        }

        tracing::info!("Starting worker process: {}", self.worker_path);

        let child = Command::new(&self.worker_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        self.worker = Some(child);
        self.request_count = 0;

        Ok(())
    }

    /// Stop the worker process
    pub fn stop(&mut self) -> Result<()> {
        if let Some(mut child) = self.worker.take() {
            tracing::info!("Stopping worker process");
            child.kill()?;
            child.wait()?;
        }
        Ok(())
    }

    /// Restart the worker process
    pub fn restart(&mut self) -> Result<()> {
        tracing::info!(
            "Restarting worker process (request_count={}, memory isolation)",
            self.request_count
        );
        self.stop()?;
        self.start()
    }

    /// Check if worker needs restart (memory or request count)
    pub fn needs_restart(&self) -> bool {
        self.request_count >= self.max_requests
        // TODO: Check actual memory usage of worker process
    }

    /// Send a command to the worker and get response
    pub fn send_command<T, R>(&mut self, command: &T) -> Result<R>
    where
        T: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        // Auto-restart if needed
        if self.needs_restart() {
            self.restart()?;
        }

        // Ensure worker is running
        if self.worker.is_none() {
            self.start()?;
        }

        let child = self.worker.as_mut().unwrap();

        // Send command
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Worker stdin not available"))?;

        let cmd_json = serde_json::to_string(command)?;
        writeln!(stdin, "{}", cmd_json)?;
        stdin.flush()?;

        // Read response
        let stdout = child
            .stdout
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Worker stdout not available"))?;

        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line)?;

        self.request_count += 1;

        let response: R = serde_json::from_str(&line)?;
        Ok(response)
    }
}

impl Drop for WorkerManager {
    fn drop(&mut self) {
        if let Err(e) = self.stop() {
            tracing::error!("Error stopping worker: {}", e);
        }
    }
}
