/**
 * TauriContext - Provides Tauri IPC communication layer
 * 
 * This context replaces WebSocketContext when running in Tauri.
 * It provides the same interface (sendMessage, subscribe) but uses
 * Tauri's invoke and event system instead of WebSocket/gRPC.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { BackendContext, BackendContextType } from './BackendContext';

// Check if running in Tauri
const isTauri = () => '__TAURI__' in window;

type MessageHandler = (data: any) => void;

/**
 * Maps WebSocket message types to Tauri commands and events
 */
const MESSAGE_TO_COMMAND: Record<string, string> = {
    // Recording
    'start_session': 'start_recording',
    'stop_session': 'stop_recording',
    // Sessions
    'get_sessions': 'list_sessions',
    'get_session': 'get_session',
    'get_session_speakers': 'get_session_speakers',
    'delete_session': 'delete_session',
    'rename_session': 'rename_session',
    'update_session_title': 'rename_session',  // alias for SessionControls
    'update_session_tags': 'update_session_tags',
    'add_session_tag': 'update_session_tags',      // Handled via update_session_tags
    'remove_session_tag': 'update_session_tags',   // Handled via update_session_tags
    'export_session': 'export_session',
    // Models
    'get_models': 'list_models',
    'download_model': 'download_model',
    'cancel_download': 'cancel_download',
    'delete_model': 'delete_model',
    'set_active_model': 'set_active_model',
    'get_ollama_models': 'get_ollama_models',
    // Transcription
    'set_language': 'set_language',
    'set_hotwords': 'set_hotwords',
    'transcribe_file': 'transcribe_file',
    'get_waveform': 'get_waveform',
    'get_chunk_audio': 'get_chunk_audio',
    'get_full_audio': 'get_full_audio',
    'retranscribe_chunk': 'retranscribe_chunk',
    'retranscribe_full': 'retranscribe_full',
    // Settings
    'get_settings': 'get_settings',
    'set_settings': 'set_settings',
    // Audio
    'get_audio_devices': 'get_audio_devices',
    'set_channel_mute': 'set_channel_mute',
    // Voiceprints
    'list_voiceprints': 'list_voiceprints',
    'create_voiceprint': 'create_voiceprint',
    'rename_voiceprint': 'rename_voiceprint',
    'delete_voiceprint': 'delete_voiceprint',
    'get_speaker_sample': 'get_speaker_sample',
    // Diarization
    'enable_diarization': 'enable_diarization',
    'disable_diarization': 'disable_diarization',
    'get_diarization_status': 'get_diarization_status',
    // Summary
    'generate_summary': 'generate_summary',
    // Cancel
    'cancel_full_transcription': 'cancel_full_transcription',
};

/**
 * Maps Tauri events to WebSocket message types
 */
const EVENT_TO_MESSAGE: Record<string, string> = {
    'transcript-segment': 'chunk_transcribed',
    'recording-state': 'audio_level',
    'audio-level': 'audio_level',
    'audio_level': 'audio_level',
    'session-started': 'session_started',
    'session-stopped': 'session_stopped',
    'session_started': 'session_started',
    'session_stopped': 'session_stopped',

    // ✅ События списка/завершения записи в Tauri
    // (backend эмитит их напрямую, без invoke)
    'sessions_list': 'sessions_list',
    'recording_completed': 'recording_completed',

    'model-download-progress': 'model_download_progress',
    'model-loading': 'model_loading',
    'model-loaded': 'model_loaded',
    'model-load-error': 'model_load_error',
    'active-model-changed': 'active_model_changed',
    'error': 'error',
    // Chunk events
    'chunk_created': 'chunk_created',
    'chunk_transcribed': 'chunk_transcribed',
    'chunk_transcribing': 'chunk_transcribing',
    // Retranscription events
    'full_transcription_started': 'full_transcription_started',
    'full_transcription_progress': 'full_transcription_progress',
    'full_transcription_completed': 'full_transcription_completed',
    'full_transcription_cancelled': 'full_transcription_cancelled',
    'full_transcription_error': 'full_transcription_error',
    // Summary events
    'summary_started': 'summary_started',
    'summary_completed': 'summary_completed',
    'summary_error': 'summary_error',
};

export const TauriProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [isConnected, setIsConnected] = useState(false);
    const handlersRef = useRef<Map<string, Set<MessageHandler>>>(new Map());
    const unlistenersRef = useRef<UnlistenFn[]>([]);

    // Subscribe to a message type
    const subscribe = useCallback((type: string, handler: MessageHandler) => {
        if (!handlersRef.current.has(type)) {
            handlersRef.current.set(type, new Set());
        }
        handlersRef.current.get(type)?.add(handler);

        return () => {
            handlersRef.current.get(type)?.delete(handler);
        };
    }, []);

    // Notify handlers of a message
    const notify = useCallback((type: string, data: any) => {
        const handlers = handlersRef.current.get(type);
        // Skip logging for high-frequency events
        if (type !== 'audio_level') {
            console.log(`[Tauri] notify: type="${type}", handlers count:`, handlers?.size || 0);
        }
        if (handlers) {
            handlers.forEach(handler => handler(data));
        } else if (type !== 'audio_level' && type !== 'error') {
            console.warn(`[Tauri] No handlers registered for event type: ${type}`);
        }
    }, []);

    // Send a message (invoke Tauri command)
    const sendMessage = useCallback(async (msg: any) => {
        if (!isTauri()) {
            console.warn('[Tauri] Not running in Tauri, message dropped:', msg);
            return;
        }

        const msgType = msg.type;

        // Стриминговые сообщения пока не поддержаны в Tauri – просто игнорируем без предупреждений
        if (msgType === 'disable_streaming') {
            return;
        }

        const command = MESSAGE_TO_COMMAND[msgType];

        if (!command) {
            console.warn('[Tauri] Unknown message type:', msgType);
            return;
        }

        try {
            // Map WebSocket message format to Tauri command args
            let args: Record<string, any> = {};
            
            switch (msgType) {
                case 'start_session':
                    args = {
                        deviceId: msg.deviceId || null,
                        captureSystem: msg.captureSystem ?? false,
                        language: msg.language || null,
                    };
                    break;
                case 'get_session':
                case 'delete_session':
                case 'get_session_speakers':
                    args = { sessionId: msg.sessionId };
                    break;
                case 'rename_session':
                case 'update_session_title':
                    args = { sessionId: msg.sessionId, newTitle: msg.title || msg.newTitle || msg.data };
                    break;
                case 'update_session_tags':
                    args = { sessionId: msg.sessionId, tags: msg.tags || [] };
                    break;
                case 'export_session':
                    args = { sessionId: msg.sessionId, format: msg.format, path: msg.path };
                    break;
                case 'set_language':
                    args = { language: msg.language };
                    break;
                case 'set_hotwords':
                    args = { hotwords: msg.hotwords || [] };
                    break;
                case 'download_model':
                case 'cancel_download':
                case 'delete_model':
                case 'set_active_model':
                    args = { modelId: msg.modelId };
                    break;
                case 'get_ollama_models':
                    args = { url: msg.url || 'http://localhost:11434' };
                    break;
                case 'set_settings':
                    args = { settings: msg.settings };
                    break;
                case 'transcribe_file':
                    args = { path: msg.path };
                    break;
                case 'get_waveform':
                    args = { sessionId: msg.sessionId };
                    break;
                case 'get_chunk_audio':
                    args = { sessionId: msg.sessionId, chunkIndex: msg.chunkIndex };
                    break;
                case 'get_full_audio':
                    args = { sessionId: msg.sessionId };
                    break;
                case 'rename_voiceprint':
                    args = { id: msg.id, name: msg.name };
                    break;
                case 'delete_voiceprint':
                    args = { id: msg.id };
                    break;
                case 'create_voiceprint':
                    args = { name: msg.name, embedding: msg.embedding, source: msg.source };
                    break;
                case 'get_speaker_sample':
                    args = { sessionId: msg.sessionId, speakerId: msg.speakerId };
                    break;
                case 'enable_diarization':
                    args = { 
                        segmentationModelPath: msg.segmentationModelPath || '',
                        embeddingModelPath: msg.embeddingModelPath || '',
                        provider: msg.diarizationProvider || 'coreml'
                    };
                    break;
                case 'disable_diarization':
                    args = {};
                    break;
                case 'get_diarization_status':
                    args = {};
                    break;
                case 'retranscribe_chunk':
                    args = { 
                        sessionId: msg.sessionId, 
                        chunkId: msg.data,  // chunk ID comes in 'data' field
                        model: msg.model || '', 
                        language: msg.language || '',
                        sttProvider: msg.sttProvider || 'local',  // STT provider: local, openai, deepgram, groq
                        hybridEnabled: msg.hybridEnabled || null,
                        hybridSecondaryModelId: msg.hybridSecondaryModelId || null,
                        hybridUseLlmForMerge: msg.hybridUseLLMForMerge || false,
                        hybridMode: msg.hybridMode || 'parallel',
                        ollamaModel: msg.hybridOllamaModel || '',
                        ollamaUrl: msg.hybridOllamaUrl || 'http://localhost:11434',
                    };
                    break;
                case 'retranscribe_full':
                    args = { 
                        sessionId: msg.sessionId, 
                        model: msg.model || '', 
                        language: msg.language || '',
                        sttProvider: msg.sttProvider || 'local',  // STT provider: local, openai, deepgram, groq
                        hybridEnabled: msg.hybridEnabled || false,
                        hybridSecondaryModelId: msg.hybridSecondaryModelId || '',
                        hybridUseLlmForMerge: msg.hybridUseLLMForMerge || false,
                        hybridMode: msg.hybridMode || 'parallel',
                        ollamaModel: msg.hybridOllamaModel || '',
                        ollamaUrl: msg.hybridOllamaUrl || 'http://localhost:11434',
                    };
                    break;
                case 'generate_summary':
                    args = {
                        sessionId: msg.sessionId,
                        ollamaModel: msg.ollamaModel || 'llama3.2',
                        ollamaUrl: msg.ollamaUrl || 'http://localhost:11434',
                        ollamaContextSize: msg.ollamaContextSize || 8,
                    };
                    break;
                case 'set_channel_mute':
                    args = {
                        channel: msg.channel, // 'mic' or 'sys'
                        muted: msg.muted,
                    };
                    break;
            }

            console.log(`[Tauri] Invoking command: ${command}`, args);
            const result = await invoke(command, args);
            console.log(`[Tauri] Command ${command} returned:`, typeof result, Array.isArray(result) ? `array of ${result.length}` : result);

            // Map result back to WebSocket response format
            switch (msgType) {
                case 'start_session':
                    // Session started event is emitted from backend via Tauri events
                    // Don't notify here - wait for the event
                    break;
                case 'stop_session':
                    // Session stopped event is emitted from backend via Tauri events
                    // Don't notify here - wait for the event
                    break;
                case 'get_sessions':
                    notify('sessions_list', { sessions: result });
                    break;
                case 'get_session':
                    notify('session_details', { session: result });
                    break;
                case 'get_session_speakers':
                    notify('session_speakers', { speakers: result });
                    break;
                case 'rename_session':
                case 'update_session_title':
                    // Notify UI to update session title
                    notify('session_title_updated', { sessionId: msg.sessionId, title: args.newTitle });
                    break;
                case 'update_session_tags':
                case 'add_session_tag':
                case 'remove_session_tag':
                    // Notify UI to update session tags
                    notify('session_tags_updated', { sessionId: msg.sessionId, tags: args.tags });
                    break;
                case 'get_models':
                    console.log('[Tauri] get_models result:', result);
                    console.log('[Tauri] First model status:', Array.isArray(result) && result.length > 0 ? result[0].status : 'N/A');
                    notify('models_list', { models: result });
                    return { models: result };
                case 'get_ollama_models':
                    // Return Ollama models directly
                    return result;
                case 'get_settings':
                    notify('settings', { settings: result });
                    return result;
                case 'get_waveform':
                    console.log('[Tauri] get_waveform result:', result);
                    console.log('[Tauri] waveform has peaks?', (result as any)?.peaks ? `yes, ${(result as any).peaks.length} channels` : 'no');
                    // Return wrapped in waveform object for consistency
                    return { waveform: result };
                case 'get_chunk_audio':
                case 'get_full_audio':
                case 'get_speaker_sample':
                    // Return result directly for audio/data
                    return result;
                case 'list_voiceprints':
                    console.log('[Tauri] list_voiceprints result:', result);
                    // Backend already returns { voiceprints: [...] }, return as-is
                    return result;
                case 'enable_diarization':
                    notify('diarization_enabled', { diarizationProvider: (result as any)?.provider || 'coreml' });
                    break;
                case 'disable_diarization':
                    notify('diarization_disabled', {});
                    break;
                case 'get_diarization_status':
                    // Map Rust struct fields (enabled, provider) to expected WebSocket format
                    const statusResult = result as { enabled?: boolean; provider?: string } | null;
                    notify('diarization_status', { 
                        diarizationEnabled: statusResult?.enabled || false,
                        diarizationProvider: statusResult?.provider || ''
                    });
                    break;
                case 'retranscribe_chunk':
                    // Result contains the updated chunk
                    notify('chunk_transcribed', result);
                    break;
                case 'retranscribe_full':
                    // Progress events are emitted via Tauri events, not return value
                    // Result is empty on success
                    break;
                case 'generate_summary':
                    // Command returns summary, but it may be truncated by Tauri IPC
                    // So we fetch the session to get the full summary from disk
                    console.log(`[Tauri] generate_summary returned: ${typeof result === 'string' ? (result as string).length : 0} chars`);
                    // Fetch session to get full summary (saved to meta.json)
                    try {
                        const session = await invoke('get_session', { sessionId: msg.sessionId });
                        if (session && (session as any).summary) {
                            console.log(`[Tauri] Fetched session with summary: ${(session as any).summary.length} chars`);
                            notify('summary_completed', { 
                                sessionId: msg.sessionId, 
                                summary: (session as any).summary 
                            });
                        } else {
                            // Fallback to command result if session fetch fails
                            notify('summary_completed', { 
                                sessionId: msg.sessionId, 
                                summary: result || '' 
                            });
                        }
                    } catch (e) {
                        console.error('[Tauri] Failed to fetch session after summary:', e);
                        notify('summary_completed', { 
                            sessionId: msg.sessionId, 
                            summary: result || '' 
                        });
                    }
                    break;
            }
        } catch (error) {
            console.error(`[Tauri] Command ${command} failed:`, error);
            notify('error', { message: String(error) });
        }
    }, [notify]);

        // Setup Tauri event listeners
    useEffect(() => {
        if (!isTauri()) {
            console.log('[Tauri] Not running in Tauri environment');
            return;
        }

        console.log('[Tauri] Setting up event listeners');
        setIsConnected(true);

        let cancelled = false;

        // Listen to all Tauri events and forward to handlers
        const setupListeners = async () => {
            // На всякий случай чистим старые unlisten (React 18 StrictMode может вызывать эффект дважды в dev)
            unlistenersRef.current.forEach(unlisten => unlisten());
            unlistenersRef.current = [];

            console.log('[Tauri] Setting up listeners for events:', Object.keys(EVENT_TO_MESSAGE));
            for (const [tauriEvent, wsType] of Object.entries(EVENT_TO_MESSAGE)) {
                const unlisten = await listen(tauriEvent, (event) => {
                    // Skip logging for high-frequency events
                    if (tauriEvent !== 'audio_level' && tauriEvent !== 'audio-level') {
                        console.log(`[Tauri] ✅ Event received: ${tauriEvent} -> ${wsType}`, event.payload);
                    }

                    // Унифицируем payload для sessions_list
                    // Backend может эмитить либо {sessions: [...]}, либо голый массив
                    if (wsType === 'sessions_list' && Array.isArray(event.payload)) {
                        notify(wsType, { sessions: event.payload });
                        return;
                    }

                    notify(wsType, event.payload);
                });

                // Если эффект уже размонтирован (StrictMode), сразу снимаем подписку
                if (cancelled) {
                    unlisten();
                    continue;
                }

                unlistenersRef.current.push(unlisten);
            }

            if (!cancelled) {
                console.log('[Tauri] All listeners set up, total:', unlistenersRef.current.length);
            }

            // Also listen for generic events
            const unlistenGeneric = await listen('message', (event) => {
                const payload = event.payload as any;
                if (payload?.type) {
                    notify(payload.type, payload);
                }
            });

            if (cancelled) {
                unlistenGeneric();
                return;
            }

            unlistenersRef.current.push(unlistenGeneric);
        };

        setupListeners();

        return () => {
            cancelled = true;
            // Cleanup listeners
            unlistenersRef.current.forEach(unlisten => unlisten());
            unlistenersRef.current = [];
        };
    }, [notify]);

    const contextValue: BackendContextType = {
        isConnected,
        isTauri: true,
        sendMessage,
        subscribe,
    };

    return (
        <BackendContext.Provider value={contextValue}>
            {children}
        </BackendContext.Provider>
    );
};

/**
 * Hook to get TauriContext specifically
 * Prefer useBackendContext for cross-environment compatibility
 */
export const useTauriContext = () => {
    const context = React.useContext(BackendContext);
    if (!context) {
        throw new Error('useTauriContext must be used within a TauriProvider');
    }
    return context;
};

export default TauriProvider;
