/**
 * Type-safe Tauri API
 * 
 * This module provides typed wrappers around Tauri's invoke() and listen() functions.
 * Types are kept in sync with Rust types in aiwisper-types crate.
 * 
 * Usage:
 *   import { commands, events } from '@/lib/tauri';
 *   
 *   // Commands (request-response)
 *   const sessions = await commands.listSessions();
 *   await commands.startRecording({ captureSystem: true });
 *   
 *   // Events (streaming)
 *   const unlisten = await events.onChunkTranscribed((payload) => {
 *     console.log('Chunk transcribed:', payload.chunk);
 *   });
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// Re-export types from session.ts and models.ts
import type { Session, SessionInfo, Chunk, WaveformData } from '../types/session';
import type { ModelState, AppSettings, OllamaModel } from '../types/models';

// ============================================================================
// Event Payload Types
// ============================================================================

export interface SessionStartedEvent {
    sessionId: string;
    session: Session;
}

export interface SessionStoppedEvent {
    sessionId: string;
    session?: Session;
}

export interface ChunkCreatedEvent {
    sessionId: string;
    chunk: Chunk;
}

export interface ChunkTranscribedEvent {
    sessionId: string;
    chunk: Chunk;
}

export interface ChunkTranscribingEvent {
    sessionId: string;
    chunkId: string;
    chunkIndex: number;
}

export interface AudioLevelEvent {
    micLevel: number;
    sysLevel: number;
    duration: number;
    micMuted: boolean;
    sysMuted: boolean;
}

export interface ModelDownloadProgressEvent {
    modelId: string;
    progress: number;
    downloadedBytes: number;
    totalBytes: number;
}

export interface FullTranscriptionProgressEvent {
    sessionId: string;
    current: number;
    total: number;
    chunkId: string;
}

export interface SummaryCompletedEvent {
    sessionId: string;
    summary: string;
}

export interface SessionSpeaker {
    id: string;
    displayName: string;
    isMic: boolean;
    isRecognized: boolean;
    voiceprintId?: string;
    entryCount: number;
    totalDurationMs: number;
}

export interface VoicePrint {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    sampleCount: number;
}

export interface VoicePrintMatchResult {
    voiceprintId: string;
    voiceprintName: string;
    similarity: number;
    confidence: 'high' | 'medium' | 'low' | 'none';
}

export interface RecordingResult {
    sessionId: string;
    durationMs: number;
    sampleCount: number;
    chunksCount: number;
}

export interface DiarizationStatus {
    enabled: boolean;
    provider: string;
}

export interface AudioDevice {
    id: string;
    name: string;
    isDefault: boolean;
    channels: number;
    sampleRate: number;
}

// ============================================================================
// Typed Commands
// ============================================================================

export const commands = {
    // ===== Recording =====
    startRecording: (args: {
        deviceId?: string;
        captureSystem: boolean;
        language?: string;
    }) => invoke<void>('start_recording', args),

    stopRecording: () => invoke<RecordingResult>('stop_recording'),

    // ===== Sessions =====
    listSessions: () => invoke<SessionInfo[]>('list_sessions'),

    getSession: (sessionId: string) => invoke<Session>('get_session', { sessionId }),

    deleteSession: (sessionId: string) => invoke<void>('delete_session', { sessionId }),

    renameSession: (sessionId: string, newTitle: string) =>
        invoke<void>('rename_session', { sessionId, newTitle }),

    updateSessionTags: (sessionId: string, tags: string[]) =>
        invoke<void>('update_session_tags', { sessionId, tags }),

    exportSession: (sessionId: string, format: string, path: string) =>
        invoke<void>('export_session', { sessionId, format, path }),

    searchSessions: (query: string) =>
        invoke<SessionInfo[]>('search_sessions', { query }),

    // ===== Speakers =====
    getSessionSpeakers: (sessionId: string) =>
        invoke<SessionSpeaker[]>('get_session_speakers', { sessionId }),

    renameSessionSpeaker: (sessionId: string, speakerId: string, newName: string) =>
        invoke<void>('rename_session_speaker', { sessionId, speakerId, newName }),

    mergeSessionSpeakers: (sessionId: string, sourceSpeakerId: string, targetSpeakerId: string) =>
        invoke<void>('merge_session_speakers', { sessionId, sourceSpeakerId, targetSpeakerId }),

    // ===== VoicePrints =====
    listVoiceprints: () => invoke<{ voiceprints: VoicePrint[] }>('list_voiceprints'),

    createVoiceprint: (name: string, embedding: number[], source: string) =>
        invoke<VoicePrint>('create_voiceprint', { name, embedding, source }),

    renameVoiceprint: (id: string, name: string) =>
        invoke<void>('rename_voiceprint', { id, name }),

    deleteVoiceprint: (id: string) =>
        invoke<void>('delete_voiceprint', { id }),

    getSpeakerSample: (sessionId: string, speakerId: string) =>
        invoke<{ audio: string }>('get_speaker_sample', { sessionId, speakerId }),

    matchVoiceprint: (embedding: number[]) =>
        invoke<VoicePrintMatchResult | null>('match_voiceprint', { embedding }),

    matchVoiceprintWithUpdate: (embedding: number[]) =>
        invoke<VoicePrintMatchResult | null>('match_voiceprint_with_update', { embedding }),

    // ===== Transcription =====
    getWaveform: (sessionId: string) =>
        invoke<WaveformData>('get_waveform', { sessionId }),

    getChunkAudio: (sessionId: string, chunkIndex: number) =>
        invoke<{ audio: string }>('get_chunk_audio', { sessionId, chunkIndex }),

    getFullAudio: (sessionId: string) =>
        invoke<{ audio: string }>('get_full_audio', { sessionId }),

    retranscribeChunk: (args: {
        sessionId: string;
        chunkId: string;
        model?: string;
        language?: string;
        sttProvider?: string;
        hybridEnabled?: boolean;
        hybridSecondaryModelId?: string;
        hybridUseLlmForMerge?: boolean;
        hybridMode?: string;
        ollamaModel?: string;
        ollamaUrl?: string;
    }) => invoke<Chunk>('retranscribe_chunk', args),

    retranscribeFull: (args: {
        sessionId: string;
        model?: string;
        language?: string;
        sttProvider?: string;
        hybridEnabled?: boolean;
        hybridSecondaryModelId?: string;
        hybridUseLlmForMerge?: boolean;
        hybridMode?: string;
        ollamaModel?: string;
        ollamaUrl?: string;
    }) => invoke<void>('retranscribe_full', args),

    cancelFullTranscription: () => invoke<void>('cancel_full_transcription'),

    setLanguage: (language: string) => invoke<void>('set_language', { language }),

    setHotwords: (hotwords: string[]) => invoke<void>('set_hotwords', { hotwords }),

    // ===== Import =====
    importAudio: (path: string, language?: string) =>
        invoke<Session>('import_audio', { path, language }),

    // ===== Diarization =====
    enableDiarization: (args: {
        segmentationModelPath?: string;
        embeddingModelPath?: string;
        provider?: string;
    }) => invoke<void>('enable_diarization', args),

    disableDiarization: () => invoke<void>('disable_diarization'),

    getDiarizationStatus: () => invoke<DiarizationStatus>('get_diarization_status'),

    // ===== Models =====
    listModels: () => invoke<ModelState[]>('list_models'),

    downloadModel: (modelId: string) => invoke<void>('download_model', { modelId }),

    cancelDownload: (modelId: string) => invoke<void>('cancel_download', { modelId }),

    deleteModel: (modelId: string) => invoke<void>('delete_model', { modelId }),

    setActiveModel: (modelId: string) => invoke<void>('set_active_model', { modelId }),

    getOllamaModels: (url?: string) =>
        invoke<OllamaModel[]>('get_ollama_models', { url: url || 'http://localhost:11434' }),

    // ===== Summary =====
    generateSummary: (args: {
        sessionId: string;
        ollamaModel?: string;
        ollamaUrl?: string;
        ollamaContextSize?: number;
    }) => invoke<string>('generate_summary', args),

    // ===== Settings =====
    getSettings: () => invoke<AppSettings>('get_settings'),

    setSettings: (settings: Partial<AppSettings>) =>
        invoke<void>('set_settings', { settings }),

    // ===== Audio Devices =====
    getAudioDevices: () => invoke<AudioDevice[]>('get_audio_devices'),

    setChannelMute: (channel: 'mic' | 'sys', muted: boolean) =>
        invoke<void>('set_channel_mute', { channel, muted }),

    // ===== System =====
    openDataFolder: () => invoke<void>('open_data_folder'),
};

// ============================================================================
// Typed Events
// ============================================================================

export const events = {
    // ===== Session Events =====
    onSessionStarted: (handler: (payload: SessionStartedEvent) => void): Promise<UnlistenFn> =>
        listen<SessionStartedEvent>('session_started', (e) => handler(e.payload)),

    onSessionStopped: (handler: (payload: SessionStoppedEvent) => void): Promise<UnlistenFn> =>
        listen<SessionStoppedEvent>('session_stopped', (e) => handler(e.payload)),

    onSessionFinalizing: (handler: (payload: { sessionId: string; stage: string; message: string }) => void): Promise<UnlistenFn> =>
        listen('session_finalizing', (e) => handler(e.payload as { sessionId: string; stage: string; message: string })),

    // ===== Chunk Events =====
    onChunkCreated: (handler: (payload: ChunkCreatedEvent) => void): Promise<UnlistenFn> =>
        listen<ChunkCreatedEvent>('chunk_created', (e) => handler(e.payload)),

    onChunkTranscribed: (handler: (payload: ChunkTranscribedEvent) => void): Promise<UnlistenFn> =>
        listen<ChunkTranscribedEvent>('chunk_transcribed', (e) => handler(e.payload)),

    onChunkTranscribing: (handler: (payload: ChunkTranscribingEvent) => void): Promise<UnlistenFn> =>
        listen<ChunkTranscribingEvent>('chunk_transcribing', (e) => handler(e.payload)),

    // ===== Audio Events =====
    onAudioLevel: (handler: (payload: AudioLevelEvent) => void): Promise<UnlistenFn> =>
        listen<AudioLevelEvent>('audio_level', (e) => handler(e.payload)),

    // ===== Model Events =====
    onModelDownloadProgress: (handler: (payload: ModelDownloadProgressEvent) => void): Promise<UnlistenFn> =>
        listen<ModelDownloadProgressEvent>('model_download_progress', (e) => handler(e.payload)),

    // ===== Retranscription Events =====
    onFullTranscriptionStarted: (handler: (payload: { sessionId: string }) => void): Promise<UnlistenFn> =>
        listen('full_transcription_started', (e) => handler(e.payload as { sessionId: string })),

    onFullTranscriptionProgress: (handler: (payload: FullTranscriptionProgressEvent) => void): Promise<UnlistenFn> =>
        listen<FullTranscriptionProgressEvent>('full_transcription_progress', (e) => handler(e.payload)),

    onFullTranscriptionCompleted: (handler: (payload: { sessionId: string }) => void): Promise<UnlistenFn> =>
        listen('full_transcription_completed', (e) => handler(e.payload as { sessionId: string })),

    onFullTranscriptionCancelled: (handler: (payload: { sessionId: string }) => void): Promise<UnlistenFn> =>
        listen('full_transcription_cancelled', (e) => handler(e.payload as { sessionId: string })),

    onFullTranscriptionError: (handler: (payload: { sessionId: string; error: string }) => void): Promise<UnlistenFn> =>
        listen('full_transcription_error', (e) => handler(e.payload as { sessionId: string; error: string })),

    // ===== Summary Events =====
    onSummaryStarted: (handler: (payload: { sessionId: string }) => void): Promise<UnlistenFn> =>
        listen('summary_started', (e) => handler(e.payload as { sessionId: string })),

    onSummaryCompleted: (handler: (payload: SummaryCompletedEvent) => void): Promise<UnlistenFn> =>
        listen<SummaryCompletedEvent>('summary_completed', (e) => handler(e.payload)),

    onSummaryError: (handler: (payload: { sessionId: string; error: string }) => void): Promise<UnlistenFn> =>
        listen('summary_error', (e) => handler(e.payload as { sessionId: string; error: string })),

    // ===== Error Events =====
    onError: (handler: (payload: { message: string }) => void): Promise<UnlistenFn> =>
        listen('error', (e) => handler(e.payload as { message: string })),
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if running in Tauri environment
 */
export const isTauri = (): boolean => '__TAURI__' in window;

/**
 * Subscribe to multiple events at once
 * Returns a cleanup function that unsubscribes from all events
 */
export async function subscribeAll(handlers: {
    onSessionStarted?: (payload: SessionStartedEvent) => void;
    onSessionStopped?: (payload: SessionStoppedEvent) => void;
    onChunkCreated?: (payload: ChunkCreatedEvent) => void;
    onChunkTranscribed?: (payload: ChunkTranscribedEvent) => void;
    onAudioLevel?: (payload: AudioLevelEvent) => void;
    onError?: (payload: { message: string }) => void;
}): Promise<() => void> {
    const unlisteners: UnlistenFn[] = [];

    if (handlers.onSessionStarted) {
        unlisteners.push(await events.onSessionStarted(handlers.onSessionStarted));
    }
    if (handlers.onSessionStopped) {
        unlisteners.push(await events.onSessionStopped(handlers.onSessionStopped));
    }
    if (handlers.onChunkCreated) {
        unlisteners.push(await events.onChunkCreated(handlers.onChunkCreated));
    }
    if (handlers.onChunkTranscribed) {
        unlisteners.push(await events.onChunkTranscribed(handlers.onChunkTranscribed));
    }
    if (handlers.onAudioLevel) {
        unlisteners.push(await events.onAudioLevel(handlers.onAudioLevel));
    }
    if (handlers.onError) {
        unlisteners.push(await events.onError(handlers.onError));
    }

    return () => {
        unlisteners.forEach(unlisten => unlisten());
    };
}

// ============================================================================
// Legacy exports for backward compatibility
// ============================================================================

// Re-export individual functions for code that uses old API
export const startRecording = commands.startRecording;
export const stopRecording = commands.stopRecording;
export const getAudioDevices = commands.getAudioDevices;
export const listModels = commands.listModels;
export const downloadModel = commands.downloadModel;
export const deleteModel = commands.deleteModel;
export const getSettings = commands.getSettings;
export const setSettings = commands.setSettings;
export const setLanguage = commands.setLanguage;
export const setHotwords = commands.setHotwords;
