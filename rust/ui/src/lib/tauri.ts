/**
 * Tauri API bindings for AIWisper
 * 
 * This module provides a unified interface for communicating with the Rust backend.
 * It replaces the gRPC/WebSocket communication used in the Electron version.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, emit, UnlistenFn } from '@tauri-apps/api/event';

// ============================================================================
// Types (matching Rust aiwisper-types)
// ============================================================================

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  processing_time_ms: number;
  rtf: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
  words: TranscriptWord[];
  confidence: number;
}

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
  channels: number;
  sample_rate: number;
}

export interface RecordingState {
  duration_ms: number;
  sample_count: number;
}

export interface Settings {
  language: string;
  hotwords: string[];
  enable_diarization: boolean;
  transcription_engine: string;
  whisper_model: string;
  enable_vad: boolean;
  audio_device_id: string | null;
  echo_cancellation: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  model_type: string;
  size_bytes: number;
  is_downloaded: boolean;
  languages: string[];
  description: string;
}

// ============================================================================
// Audio Commands
// ============================================================================

/**
 * Start audio recording from the specified device
 */
export async function startRecording(deviceId?: string, captureSystem?: boolean): Promise<void> {
  return invoke('start_recording', { deviceId, captureSystem });
}

/**
 * Stop audio recording and return the recording state
 */
export async function stopRecording(): Promise<RecordingState> {
  return invoke('stop_recording');
}

/**
 * Get list of available audio input devices
 */
export async function getAudioDevices(): Promise<AudioDevice[]> {
  return invoke('get_audio_devices');
}

// ============================================================================
// Transcription Commands
// ============================================================================

/**
 * Transcribe an audio file
 */
export async function transcribeFile(path: string): Promise<TranscriptionResult> {
  return invoke('transcribe_file', { path });
}

/**
 * Start streaming transcription - subscribes to transcript-segment events
 */
export async function getTranscriptStream(): Promise<void> {
  return invoke('get_transcript_stream');
}

/**
 * Set transcription language
 */
export async function setLanguage(language: string): Promise<void> {
  return invoke('set_language', { language });
}

/**
 * Set hotwords for improved recognition
 */
export async function setHotwords(hotwords: string[]): Promise<void> {
  return invoke('set_hotwords', { hotwords });
}

// ============================================================================
// Settings Commands
// ============================================================================

/**
 * Get current application settings
 */
export async function getSettings(): Promise<Settings> {
  return invoke('get_settings');
}

/**
 * Update application settings
 */
export async function setSettings(settings: Settings): Promise<void> {
  return invoke('set_settings', { settings });
}

// ============================================================================
// Model Commands
// ============================================================================

/**
 * List available models
 */
export async function listModels(): Promise<ModelInfo[]> {
  return invoke('list_models');
}

/**
 * Download a model by ID
 */
export async function downloadModel(modelId: string): Promise<void> {
  return invoke('download_model', { modelId });
}

/**
 * Delete a downloaded model
 */
export async function deleteModel(modelId: string): Promise<void> {
  return invoke('delete_model', { modelId });
}

// ============================================================================
// Event Listeners
// ============================================================================

/**
 * Listen for transcript segment events
 */
export function onTranscriptSegment(
  callback: (segment: TranscriptSegment) => void
): Promise<UnlistenFn> {
  return listen<TranscriptSegment>('transcript-segment', (event) => {
    callback(event.payload);
  });
}

/**
 * Listen for recording state updates
 */
export function onRecordingState(
  callback: (state: RecordingState) => void
): Promise<UnlistenFn> {
  return listen<RecordingState>('recording-state', (event) => {
    callback(event.payload);
  });
}

/**
 * Listen for audio level updates (for VU meter)
 */
export function onAudioLevel(
  callback: (level: number) => void
): Promise<UnlistenFn> {
  return listen<number>('audio-level', (event) => {
    callback(event.payload);
  });
}

/**
 * Listen for model download progress
 */
export function onModelDownloadProgress(
  callback: (progress: { modelId: string; progress: number }) => void
): Promise<UnlistenFn> {
  return listen('model-download-progress', (event) => {
    callback(event.payload as { modelId: string; progress: number });
  });
}

/**
 * Listen for errors from the backend
 */
export function onError(
  callback: (error: { message: string; code?: string }) => void
): Promise<UnlistenFn> {
  return listen('error', (event) => {
    callback(event.payload as { message: string; code?: string });
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if running in Tauri environment
 */
export function isTauri(): boolean {
  return '__TAURI__' in window;
}

/**
 * Emit an event to the backend
 */
export async function emitEvent(event: string, payload?: unknown): Promise<void> {
  return emit(event, payload);
}
