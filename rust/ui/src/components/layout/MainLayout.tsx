import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { SettingsPage } from '../SettingsPage';
import { TranscriptionView } from '../modules/TranscriptionView';

import { RecordingOverlay } from '../RecordingOverlay';
import { HelpModal } from '../HelpModal';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { useSettingsContext } from '../../context/SettingsContext';
import { useKeyboardShortcuts, createAppShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useDragDrop, dropOverlayStyles } from '../../hooks/useDragDrop';
import { useExport } from '../../hooks/useExport';
import { usePermissions } from '../../hooks/usePermissions';
import { useSessionContext } from '../../context/SessionContext';
import { useModelContext } from '../../context/ModelContext';
import { useBackendContext } from '../../context/BackendContext';
import { useDiarizationContext } from '../../context/DiarizationContext';
import { useProvidersContext } from '../../context/ProvidersContext';
import ModelManager from '../ModelManager';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { AudioMeterBar } from '../common/AudioMeterBar';
import { AudioMeterSidebar } from '../AudioMeterSidebar';
import { SessionSpeaker, VoicePrint } from '../../types/voiceprint';
import { WaveformData } from '../../utils/waveform';

// Версия приложения
const APP_VERSION = '2.0.11';

interface MainLayoutProps {
    addLog: (msg: string) => void;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ addLog }) => {
    // API_BASE - в Tauri используем Tauri commands, в Electron - HTTP
    const API_BASE = `http://localhost:${(typeof process !== 'undefined' && process.env?.AIWISPER_HTTP_PORT) || 18080}`;
    
    // Контексты
    const { startSession, stopSession, isRecording, isStopping, isProcessingFinalChunks, selectedSession, micLevel, sysLevel, isFullTranscribing } = useSessionContext();
    const { activeModelId, models, fetchOllamaModels, downloadModel, cancelDownload, deleteModel, setActiveModel, ollamaModels, ollamaModelsLoading, ollamaError } = useModelContext();
    const { sendMessage, subscribe, isTauri } = useBackendContext();
    const { 
        status: diarizationStatus, 
        isLoading: diarizationLoading, 
        error: diarizationError,
        segmentationModels,
        embeddingModels,
        enableDiarization: contextEnableDiarization,
        disableDiarization: contextDisableDiarization,
    } = useDiarizationContext();

    // Хук провайдеров
    const { sttSettings } = useProvidersContext();

    // Хуки
    const { play, pause, playingUrl, seek, currentTime, duration, isPlaying, micLevel: playbackMicLevel, sysLevel: playbackSysLevel } = useAudioPlayer();
    const {
        settings,
        isLoaded: settingsLoaded,
        theme, setTheme,
        language, setLanguage,
        micDevice, setMicDevice,
        captureSystem, setCaptureSystem,
        useVoiceIsolation, setUseVoiceIsolation,
        echoCancel, setEchoCancel,
        ollamaModel, setOllamaModel,
        ollamaContextSize, setOllamaContextSize,
        enableStreaming,
        pauseThreshold,
        streamingChunkSeconds,
        streamingConfirmationThreshold,
        hybridTranscription, setHybridTranscription,
        ollamaUrl,
    } = useSettingsContext();
    
    // Streaming настройки используются в useEffect для WebSocket
    void enableStreaming;
    void pauseThreshold;
    void streamingChunkSeconds;
    void streamingConfirmationThreshold;
    
    // Permissions hook for macOS microphone access
    const { 
        requestMicrophonePermission,
        checkMicrophonePermission,
    } = usePermissions();

    // UI State
    const [showSettings, setShowSettings] = useState(false);
    const [showModelManager, setShowModelManager] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [modelLoading, setModelLoading] = useState(false);
    const [loadingModelName, setLoadingModelName] = useState('');

    // Devices
    const [inputDevices, setInputDevices] = useState<Array<{ id: string; name: string; isInput: boolean; isOutput: boolean }>>([]);

    // Session Speakers (для VoicePrint интеграции)
    const [sessionSpeakers, setSessionSpeakers] = useState<SessionSpeaker[]>([]);
    
    // Speaker sample playback
    const [playingSpeakerId, setPlayingSpeakerId] = useState<number | null>(null);
    const speakerAudioRef = useRef<HTMLAudioElement | null>(null);

    // Global Voiceprints (сохранённые голоса)
    const [voiceprints, setVoiceprints] = useState<VoicePrint[]>([]);
    const [voiceprintsLoading, setVoiceprintsLoading] = useState(false);

    // Diarization state - теперь берётся из DiarizationContext
    // Локальные состояния удалены, используем contextEnableDiarization/contextDisableDiarization

    // Waveform state
    const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
    const [waveformStatus, setWaveformStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [waveformError, setWaveformError] = useState<string | null>(null);
    const waveformSessionIdRef = useRef<string | null>(null);

    // VAD settings
    const [vadMode, setVADMode] = useState<'auto' | 'compression' | 'per-region' | 'off'>('auto');
    const [vadMethod, setVADMethod] = useState<'auto' | 'energy' | 'silero'>('auto');

    // Load waveform data when session changes
    useEffect(() => {
        const targetId = selectedSession?.id;
        if (!targetId) {
            waveformSessionIdRef.current = null;
            setWaveformData(null);
            setWaveformStatus('idle');
            setWaveformError(null);
            return;
        }

        // Skip if already loaded for this session
        if (waveformSessionIdRef.current === targetId && waveformData) return;

        let cancelled = false;
        setWaveformStatus('loading');
        setWaveformError(null);

        const loadWaveform = async () => {
            try {
                if (!isTauri) {
                    setWaveformStatus('error');
                    setWaveformError('Требуется Tauri backend');
                    return;
                }

                // В Tauri просим бэкенд вернуть waveform и mp3 одним запросом
                const res = await sendMessage({ type: 'get_waveform', sessionId: targetId });
                if (cancelled) return;

                if (res?.waveform) {
                    setWaveformData(res.waveform);
                    waveformSessionIdRef.current = targetId;
                    setWaveformStatus('ready');
                } else if (res?.error) {
                    throw new Error(res.error);
                } else {
                    throw new Error('waveform not available');
                }
            } catch (err) {
                if (cancelled) return;
                console.error('Failed to build waveform', err);
                setWaveformData(null);
                waveformSessionIdRef.current = null;
                setWaveformStatus('error');
                setWaveformError(err instanceof Error ? err.message : String(err));
            }
        };

        loadWaveform();

        return () => { cancelled = true; };
    }, [selectedSession?.id, isTauri, sendMessage]);

    // Fetch audio devices
    useEffect(() => {
        const getDevices = async () => {
            try {
                const devs = await navigator.mediaDevices.enumerateDevices();
                const inputs = devs.filter(d => d.kind === 'audioinput').map(d => ({
                    id: d.deviceId,
                    name: d.label || `Microphone ${d.deviceId}`,
                    isInput: true,
                    isOutput: false
                }));
                setInputDevices(inputs);
            } catch (e) {
                console.error("Error fetching devices", e);
            }
        };
        getDevices();
    }, []);

    // Subscribe to model loading events
    useEffect(() => {
        const unsubLoading = subscribe('model_loading', (msg: any) => {
            setModelLoading(true);
            setLoadingModelName(msg.modelName || msg.modelId || 'модель');
            addLog(`Загрузка модели: ${msg.modelName || msg.modelId}...`);
        });

        const unsubLoaded = subscribe('model_loaded', (msg: any) => {
            setModelLoading(false);
            setLoadingModelName('');
            addLog(`Модель загружена: ${msg.modelName || msg.modelId}`);
        });

        const unsubLoadError = subscribe('model_load_error', (msg: any) => {
            setModelLoading(false);
            setLoadingModelName('');
            addLog(`Ошибка загрузки модели: ${msg.error}`);
        });

        return () => {
            unsubLoading();
            unsubLoaded();
            unsubLoadError();
        };
    }, [subscribe, addLog]);

    // Subscribe to session speakers events
    useEffect(() => {
        const unsubSpeakers = subscribe('session_speakers', (msg: any) => {
            setSessionSpeakers(msg.speakers || []);
        });

        const unsubSpeakerRenamed = subscribe('speaker_renamed', (msg: any) => {
            setSessionSpeakers(prev => prev.map(s =>
                s.localId === msg.localId ? { ...s, displayName: msg.newName, isRecognized: msg.savedAsVoiceprint || s.isRecognized } : s
            ));
        });

        const unsubSpeakersMerged = subscribe('speakers_merged', (msg: any) => {
            console.log('[MainLayout] Speakers merged:', msg);
            // Запрашиваем обновлённый список спикеров после объединения
            if (msg.sessionId) {
                sendMessage({ type: 'get_session_speakers', sessionId: msg.sessionId });
            }
        });

        const unsubChunkTranscribed = subscribe('chunk_transcribed', (msg: any) => {
            // Запрашиваем обновлённый список спикеров после транскрипции
            if (msg.sessionId) {
                sendMessage({ type: 'get_session_speakers', sessionId: msg.sessionId });
            }
        });

        // Подписки на события диаризации теперь в DiarizationContext

        return () => {
            unsubSpeakers();
            unsubSpeakerRenamed();
            unsubSpeakersMerged();
            unsubChunkTranscribed();
        };
    }, [subscribe, sendMessage]);

    // Load session speakers when session changes
    useEffect(() => {
        if (selectedSession) {
            sendMessage({ type: 'get_session_speakers', sessionId: selectedSession.id });
        } else {
            setSessionSpeakers([]);
        }
    }, [selectedSession, sendMessage]);

    // Load voiceprints
    const refreshVoiceprints = useCallback(async () => {
        setVoiceprintsLoading(true);
        try {
            if (isTauri) {
                // Use IPC for Tauri
                const result = await sendMessage({ type: 'list_voiceprints' });
                if (result && result.voiceprints) {
                    setVoiceprints(result.voiceprints);
                }
            } else {
                // Use HTTP for Electron
                const res = await fetch(`${API_BASE}/api/voiceprints`);
                const data = await res.json();
                setVoiceprints(data.voiceprints || []);
            }
        } catch (error) {
            console.error('[refreshVoiceprints] Error:', error);
        } finally {
            setVoiceprintsLoading(false);
        }
    }, [API_BASE, isTauri, sendMessage]);

    // Load voiceprints on mount
    useEffect(() => {
        refreshVoiceprints();
    }, [refreshVoiceprints]);

    // Speaker rename handler
    const handleRenameSpeaker = useCallback((localId: number, newName: string, saveAsVoiceprint: boolean) => {
        if (!selectedSession) return;
        sendMessage({
            type: 'rename_session_speaker',
            sessionId: selectedSession.id,
            localSpeakerId: localId,
            speakerName: newName,
            saveAsVoiceprint
        });
        console.log(`[MainLayout] Renaming speaker ${localId} to "${newName}"${saveAsVoiceprint ? ' (saving voiceprint)' : ''}`);
    }, [selectedSession, sendMessage]);

    // Merge speakers handler
    const handleMergeSpeakers = useCallback((
        sourceSpeakerIds: number[],
        targetSpeakerId: number,
        newName: string,
        mergeEmbeddings: boolean,
        saveAsVoiceprint: boolean
    ) => {
        if (!selectedSession) return;
        sendMessage({
            type: 'merge_speakers',
            sessionId: selectedSession.id,
            sourceSpeakerIds,
            targetSpeakerId,
            speakerName: newName,
            mergeEmbeddings,
            saveAsVoiceprint
        });
        console.log(`[MainLayout] Merging speakers ${sourceSpeakerIds.join(', ')} into ${targetSpeakerId} as "${newName}"`);
    }, [selectedSession, sendMessage]);

    // Play speaker sample
    const handlePlaySpeakerSample = useCallback((localId: number) => {
        if (!selectedSession) return;
        
        // Останавливаем предыдущее воспроизведение
        if (speakerAudioRef.current) {
            speakerAudioRef.current.pause();
            speakerAudioRef.current = null;
        }
        
        const url = `${API_BASE}/api/speaker-sample/${selectedSession.id}/${localId}`;
        const audio = new Audio(url);
        speakerAudioRef.current = audio;
        setPlayingSpeakerId(localId);
        
        audio.onended = () => {
            setPlayingSpeakerId(null);
            speakerAudioRef.current = null;
        };
        audio.onerror = () => {
            setPlayingSpeakerId(null);
            speakerAudioRef.current = null;
        };
        
        audio.play().catch(() => {
            setPlayingSpeakerId(null);
            speakerAudioRef.current = null;
        });
    }, [selectedSession, API_BASE]);

    // Stop speaker sample
    const handleStopSpeakerSample = useCallback(() => {
        if (speakerAudioRef.current) {
            speakerAudioRef.current.pause();
            speakerAudioRef.current = null;
        }
        setPlayingSpeakerId(null);
    }, []);

    // Voiceprint handlers
    const handleRenameVoiceprint = useCallback(async (id: string, name: string) => {
        try {
            if (isTauri) {
                // Use IPC for Tauri
                await sendMessage({ type: 'rename_voiceprint', id, name });
            } else {
                // Use HTTP for Electron
                await fetch(`${API_BASE}/api/voiceprints/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
            }
            refreshVoiceprints();
        } catch (error) {
            console.error('[handleRenameVoiceprint] Error:', error);
        }
    }, [API_BASE, isTauri, sendMessage, refreshVoiceprints]);

    const handleDeleteVoiceprint = useCallback(async (id: string) => {
        try {
            if (isTauri) {
                // Use IPC for Tauri
                await sendMessage({ type: 'delete_voiceprint', id });
            } else {
                // Use HTTP for Electron
                await fetch(`${API_BASE}/api/voiceprints/${id}`, { method: 'DELETE' });
            }
            refreshVoiceprints();
        } catch (error) {
            console.error('[handleDeleteVoiceprint] Error:', error);
        }
    }, [API_BASE, isTauri, sendMessage, refreshVoiceprints]);

    // Diarization handlers
    // Обработчики диаризации - делегируют в DiarizationContext (который также сохраняет настройки)
    const handleEnableDiarization = useCallback((segModelId: string, embModelId: string, provider: string) => {
        contextEnableDiarization(segModelId, embModelId, provider);
    }, [contextEnableDiarization]);

    const handleDisableDiarization = useCallback(() => {
        contextDisableDiarization();
    }, [contextDisableDiarization]);

    // Auto enable/disable streaming transcription
    useEffect(() => {
        if (isRecording && enableStreaming) {
            sendMessage({ 
                type: 'enable_streaming',
                streamingChunkSeconds: streamingChunkSeconds,
                streamingConfirmationThreshold: streamingConfirmationThreshold
            });
            addLog(`Streaming transcription enabled (chunk=${streamingChunkSeconds}s, threshold=${Math.round(streamingConfirmationThreshold * 100)}%)`);
        } else if (!isRecording) {
            sendMessage({ type: 'disable_streaming' });
        }
    }, [isRecording, enableStreaming, streamingChunkSeconds, streamingConfirmationThreshold, sendMessage, addLog]);

    // Start/Stop Handler
    const handleStartStop = useCallback(async () => {
        // Block starting new recording during retranscription
        if (isFullTranscribing && !isRecording) {
            addLog('Cannot start recording during retranscription');
            return;
        }
        
        if (isRecording) {
            await stopSession();
            addLog('Recording stopped');
        } else {
            if (!activeModelId) {
                alert('Please select a model first');
                return;
            }
            
            // Check microphone permission before starting
            if (isTauri) {
                const hasMicPermission = await checkMicrophonePermission();
                if (!hasMicPermission) {
                    addLog('Requesting microphone permission...');
                    const granted = await requestMicrophonePermission();
                    if (!granted) {
                        addLog('Microphone permission denied. Please grant access in System Preferences > Privacy & Security > Microphone');
                        alert('Для записи необходим доступ к микрофону.\n\nОткройте Системные настройки > Конфиденциальность и безопасность > Микрофон и разрешите доступ для AIWisper.');
                        return;
                    }
                    addLog('Microphone permission granted');
                }
            }
            
            try {
                await startSession({
                    model: activeModelId,
                    language: language,
                    micDevice: micDevice,
                    captureSystem: captureSystem,
                    useVoiceIsolation: useVoiceIsolation,
                    echoCancel: echoCancel,
                    pauseThreshold: pauseThreshold,
                    useNativeCapture: true,
                    // Гибридная транскрипция
                    hybridEnabled: hybridTranscription.enabled,
                    hybridSecondaryModelId: hybridTranscription.secondaryModelId,
                    hybridConfidenceThreshold: hybridTranscription.confidenceThreshold,
                    hybridContextWords: hybridTranscription.contextWords,
                    hybridUseLLMForMerge: hybridTranscription.useLLMForMerge,
                    hybridMode: hybridTranscription.mode,
                });
                addLog('Recording started');
                if (hybridTranscription.enabled && hybridTranscription.secondaryModelId) {
                    addLog(`Hybrid transcription enabled: secondary model = ${hybridTranscription.secondaryModelId}`);
                }
            } catch (e: any) {
                addLog(`Error starting session: ${e.message}`);
            }
        }
    }, [isRecording, isFullTranscribing, stopSession, startSession, activeModelId, language, micDevice, captureSystem, useVoiceIsolation, echoCancel, pauseThreshold, hybridTranscription, addLog, isTauri, checkMicrophonePermission, requestMicrophonePermission]);

    // Playback Handlers
    const handlePlayChunk = useCallback((url: string) => {
        play(url);
    }, [play]);

    const handlePlaySession = useCallback(async (sessionId: string) => {
        if (isTauri) {
            // Use IPC for Tauri
            try {
                const audioDataUrl = await sendMessage({ type: 'get_full_audio', sessionId });
                if (audioDataUrl && typeof audioDataUrl === 'string') {
                    play(audioDataUrl);
                } else {
                    addLog('Failed to load session audio');
                }
            } catch (error) {
                console.error('[handlePlaySession] IPC error:', error);
                addLog('Error loading session audio');
            }
        } else {
            // Use HTTP for Electron
            const url = `${API_BASE}/api/sessions/${sessionId}/full.mp3`;
            play(url);
        }
    }, [API_BASE, play, isTauri, sendMessage, addLog]);

    // Retranscribe all chunks
    const handleRetranscribeAll = useCallback(() => {
        console.log('[handleRetranscribeAll] Called, selectedSession:', selectedSession?.id);
        
        // Block if already retranscribing or recording
        if (isFullTranscribing) {
            addLog('Retranscription already in progress');
            return;
        }
        
        if (isRecording) {
            addLog('Cannot retranscribe during recording');
            return;
        }
        
        if (!selectedSession) {
            addLog('No session selected for retranscription');
            return;
        }

        const activeModel = models.find(m => m.id === activeModelId);
        const modelId = activeModel?.id || activeModelId;
        const sttProvider = sttSettings.activeProvider || 'local';

        console.log('[handleRetranscribeAll] activeModel:', activeModel?.name, 'modelId:', modelId, 'sttProvider:', sttProvider);

        const isModelReady = activeModel?.status === 'downloaded' || activeModel?.status === 'active';
        if (!isModelReady && activeModelId && sttProvider === 'local') {
            addLog(`Model not downloaded (status: ${activeModel?.status}). Open model manager to download.`);
            setShowModelManager(true);
            return;
        }

        if (!modelId && sttProvider === 'local') {
            addLog('No model selected. Please select a model in settings.');
            setShowModelManager(true);
            return;
        }

        console.log('[handleRetranscribeAll] Sending retranscribe_full message');
        sendMessage({
            type: 'retranscribe_full',
            sessionId: selectedSession.id,
            model: modelId,
            language: language,
            sttProvider: sttProvider,  // STT provider: local, openai, deepgram, groq
            diarizationEnabled: false,
            // Добавляем настройки гибридной транскрипции
            hybridEnabled: hybridTranscription.enabled,
            hybridSecondaryModelId: hybridTranscription.secondaryModelId,
            hybridConfidenceThreshold: hybridTranscription.confidenceThreshold,
            hybridContextWords: hybridTranscription.contextWords,
            hybridUseLLMForMerge: hybridTranscription.useLLMForMerge,
            hybridMode: hybridTranscription.mode,
            hybridHotwords: hybridTranscription.hotwords,
            hybridOllamaModel: ollamaModel,
            hybridOllamaUrl: ollamaUrl,
        });
        addLog(`Starting full retranscription with ${sttProvider === 'local' ? 'model: ' + (activeModel?.name || modelId) : 'cloud: ' + sttProvider}, hybrid: ${hybridTranscription.enabled}`);
    }, [selectedSession, models, activeModelId, language, sendMessage, addLog, hybridTranscription, ollamaModel, ollamaUrl, isFullTranscribing, isRecording, sttSettings]);

    // Load Ollama models
    const loadOllama = useCallback(() => {
        fetchOllamaModels(settings.ollamaUrl);
    }, [fetchOllamaModels, settings.ollamaUrl]);

    // Export hook
    const { copyToClipboard, exportTXT } = useExport();

    // Keyboard shortcuts
    const handleTogglePlayPause = useCallback(() => {
        if (selectedSession && !isRecording) {
            if (isPlaying) {
                pause();
            } else {
                handlePlaySession(selectedSession.id);
            }
        }
    }, [selectedSession, isRecording, isPlaying, pause, handlePlaySession]);

    const handleSeekForward = useCallback(() => {
        if (!isRecording && duration > 0) {
            seek(Math.min(currentTime + 10, duration));
        }
    }, [isRecording, duration, currentTime, seek]);

    const handleSeekBackward = useCallback(() => {
        if (!isRecording) {
            seek(Math.max(currentTime - 10, 0));
        }
    }, [isRecording, currentTime, seek]);

    const handleCopyTranscription = useCallback(async () => {
        if (selectedSession) {
            const success = await copyToClipboard(selectedSession);
            if (success) {
                addLog('Транскрипция скопирована в буфер обмена');
            }
        }
    }, [selectedSession, copyToClipboard, addLog]);

    const handleExportTXT = useCallback(() => {
        if (selectedSession) {
            exportTXT(selectedSession);
            addLog('Экспорт в TXT завершён');
        }
    }, [selectedSession, exportTXT, addLog]);

    useKeyboardShortcuts({
        shortcuts: createAppShortcuts({
            onStartStop: handleStartStop,
            onPlayPause: handleTogglePlayPause,
            onSeekForward: handleSeekForward,
            onSeekBackward: handleSeekBackward,
            onToggleSettings: () => setShowSettings(prev => !prev),
            onCopyTranscription: handleCopyTranscription,
            onExportTXT: handleExportTXT,
            onShowHelp: () => setShowHelp(true),
            isRecording,
            isPlaying,
        }),
        enabled: !showHelp && !showModelManager, // Отключаем shortcuts когда открыты модальные окна
    });

    // Drag & Drop for file import
    const handleFileDrop = useCallback(async (file: File) => {
        try {
            if (isTauri) {
                // TODO: Implement file import via Tauri IPC
                addLog('Import not yet implemented in Tauri build');
                return;
            }
            
            // HTTP import for Electron
            const formData = new FormData();
            formData.append('audio', file);
            formData.append('model', activeModelId || '');
            formData.append('language', language);
            
            const response = await fetch(`${API_BASE}/api/import`, {
                method: 'POST',
                body: formData,
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || `HTTP ${response.status}`);
            }
            
            const result = await response.json();
            addLog(`Файл импортирован, сессия: ${result.sessionId || 'создана'}`);
            addLog('Транскрипция запущена в фоновом режиме');
        } catch (err: any) {
            addLog(`Ошибка импорта: ${err.message}`);
            throw err; // Re-throw для отображения ошибки в useDragDrop
        }
    }, [addLog, API_BASE, activeModelId, language, isTauri]);

    const { isDragging, isProcessing, dragHandlers } = useDragDrop({
        onFileDrop: handleFileDrop,
        enabled: !isRecording,
    });

    // Don't render until settings are loaded
    if (!settingsLoaded) {
        return (
            <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                height: '100vh',
                background: 'var(--app-bg)',
                color: 'var(--text-primary)'
            }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{
                        width: '40px',
                        height: '40px',
                        margin: '0 auto 1rem',
                        border: '3px solid var(--glass-border)',
                        borderTopColor: 'var(--primary)',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                    }} />
                    <div>Загрузка настроек...</div>
                </div>
            </div>
        );
    }

    return (
        <div 
            className="app-frame" 
            style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--app-bg)', color: 'var(--text-primary)' }}
            {...dragHandlers}
        >
            {/* Drag & Drop Overlay */}
            {isDragging && (
                <div style={dropOverlayStyles.container}>
                    <div style={dropOverlayStyles.content}>
                        <div style={dropOverlayStyles.icon}>📁</div>
                        <div style={dropOverlayStyles.title}>Перетащите аудиофайл сюда</div>
                        <div style={dropOverlayStyles.subtitle}>MP3, WAV, M4A, OGG, FLAC</div>
                    </div>
                </div>
            )}

            {/* Import Processing Overlay */}
            {isProcessing && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0, 0, 0, 0.6)',
                    backdropFilter: 'blur(8px)',
                    zIndex: 200,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}>
                    <div style={{
                        background: 'var(--surface-elevated)',
                        borderRadius: 'var(--radius-xl)',
                        padding: '2rem 3rem',
                        textAlign: 'center',
                        boxShadow: 'var(--shadow-lg)',
                        border: '1px solid var(--glass-border)',
                    }}>
                        <div style={{
                            width: '48px',
                            height: '48px',
                            margin: '0 auto 1.5rem',
                            border: '3px solid var(--glass-border)',
                            borderTopColor: 'var(--primary)',
                            borderRadius: '50%',
                            animation: 'spin 1s linear infinite',
                        }} />
                        <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            Импорт файла...
                        </div>
                    </div>
                </div>
            )}

            {/* Model Loading Overlay */}
            {modelLoading && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.6)',
                        backdropFilter: 'blur(8px)',
                        WebkitBackdropFilter: 'blur(8px)',
                        zIndex: 200,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <div
                        style={{
                            background: 'var(--surface-elevated)',
                            borderRadius: 'var(--radius-xl)',
                            padding: '2rem 3rem',
                            textAlign: 'center',
                            boxShadow: 'var(--shadow-lg)',
                            border: '1px solid var(--glass-border)',
                            maxWidth: '400px',
                        }}
                    >
                        <div
                            style={{
                                width: '48px',
                                height: '48px',
                                margin: '0 auto 1.5rem',
                                border: '3px solid var(--glass-border)',
                                borderTopColor: 'var(--primary)',
                                borderRadius: '50%',
                                animation: 'spin 1s linear infinite',
                            }}
                        />
                        <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                            Загрузка модели
                        </div>
                        <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                            {loadingModelName}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', opacity: 0.7 }}>
                            Первый запуск может занять до 30 секунд
                        </div>
                    </div>
                </div>
            )}

            {/* CSS for spinner animation */}
            <style>{`
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>

            {/* Recording Overlay */}
            <RecordingOverlay onStop={handleStartStop} />
            
            {/* Processing Final Chunk Overlay - показывается когда запись остановлена, но ещё идёт фоновая транскрипция */}
            {isStopping && isProcessingFinalChunks && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        zIndex: 100,
                        background: 'linear-gradient(180deg, rgba(245, 158, 11, 0.15) 0%, transparent 100%)',
                        backdropFilter: 'blur(8px)',
                        WebkitBackdropFilter: 'blur(8px)',
                        borderBottom: '1px solid rgba(245, 158, 11, 0.2)',
                        padding: '0.5rem 1.5rem',
                        paddingTop: '0.75rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '1rem',
                        WebkitAppRegion: 'drag',
                    } as React.CSSProperties}
                >
                    {/* Spinner */}
                    <div
                        style={{
                            width: '16px',
                            height: '16px',
                            border: '2px solid rgba(245, 158, 11, 0.3)',
                            borderTopColor: '#f59e0b',
                            borderRadius: '50%',
                            animation: 'spin 1s linear infinite',
                        }}
                    />
                    <span style={{ 
                        fontSize: '0.85rem', 
                        fontWeight: 600, 
                        color: '#f59e0b',
                        letterSpacing: '0.02em' 
                    }}>
                        Обрабатывается последний фрагмент...
                    </span>
                </div>
            )}
            
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden', marginTop: isRecording || (isStopping && isProcessingFinalChunks) ? '48px' : 0, transition: 'margin-top 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }}>
                <Sidebar onStartRecording={handleStartStop} />

                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <Header 
                        showSettings={showSettings} 
                        setShowSettings={setShowSettings}
                        onShowHelp={() => setShowHelp(true)}
                    />



                    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                        <ErrorBoundary>
                            <TranscriptionView
                                onPlayChunk={handlePlayChunk}
                                playingUrl={playingUrl}
                                ollamaModel={ollamaModel}
                                isPlaying={isPlaying}
                                isPlayingFullSession={playingUrl?.includes('/full.mp3') ?? false}
                                onPlaySession={handlePlaySession}
                                onPauseSession={pause}
                                currentTime={currentTime}
                                duration={duration}
                                onSeek={seek}
                                sessionSpeakers={sessionSpeakers}
                                onRetranscribeAll={handleRetranscribeAll}
                                onRenameSpeaker={handleRenameSpeaker}
                                onMergeSpeakers={handleMergeSpeakers}
                                onPlaySpeakerSample={handlePlaySpeakerSample}
                                onStopSpeakerSample={handleStopSpeakerSample}
                                playingSpeakerId={playingSpeakerId}
                                waveformData={waveformData}
                                waveformLoading={waveformStatus === 'loading'}
                                waveformError={waveformStatus === 'error' ? (waveformError || 'Не удалось загрузить аудио') : null}
                            />
                        </ErrorBoundary>

                        {/* VU Meters Sidebar - всегда рендерится, анимация внутри компонента */}
                        <AudioMeterSidebar
                            micLevel={isPlaying ? playbackMicLevel : micLevel}
                            sysLevel={isPlaying ? playbackSysLevel : sysLevel}
                            isActive={isRecording || isPlaying}
                        />
                    </div>
                </div>
            </div>

            {/* Model Manager Modal */}
            {showModelManager && (
                <ModelManager
                    models={models}
                    activeModelId={activeModelId}
                    onClose={() => setShowModelManager(false)}
                    onDownload={downloadModel}
                    onCancelDownload={cancelDownload}
                    onDelete={deleteModel}
                    onSetActive={setActiveModel}
                />
            )}

            {/* Settings Page (Full-screen) */}
            <SettingsPage
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                devices={inputDevices.map(d => ({ ...d, isInput: true }))}
                micDevice={micDevice}
                setMicDevice={setMicDevice}
                captureSystem={captureSystem}
                setCaptureSystem={setCaptureSystem}
                vadMode={vadMode}
                setVADMode={setVADMode}
                vadMethod={vadMethod}
                setVADMethod={setVADMethod}
                screenCaptureKitAvailable={true}
                useVoiceIsolation={useVoiceIsolation}
                setUseVoiceIsolation={setUseVoiceIsolation}
                echoCancel={echoCancel}
                setEchoCancel={setEchoCancel}
                language={language}
                setLanguage={setLanguage}
                theme={theme}
                setTheme={setTheme}
                ollamaModel={ollamaModel}
                setOllamaModel={setOllamaModel}
                ollamaContextSize={ollamaContextSize}
                setOllamaContextSize={setOllamaContextSize}
                ollamaModels={ollamaModels}
                ollamaModelsLoading={ollamaModelsLoading}
                ollamaError={ollamaError}
                loadOllamaModels={loadOllama}
                onShowModelManager={() => setShowModelManager(true)}
                activeModelId={activeModelId}
                models={models}
                // Diarization - состояние из DiarizationContext
                diarizationStatus={diarizationStatus}
                diarizationLoading={diarizationLoading}
                diarizationError={diarizationError}
                segmentationModels={segmentationModels}
                embeddingModels={embeddingModels}
                onEnableDiarization={handleEnableDiarization}
                onDisableDiarization={handleDisableDiarization}
                // Гибридная транскрипция
                hybridTranscription={hybridTranscription}
                onHybridTranscriptionChange={setHybridTranscription}
                // Voiceprints
                voiceprints={voiceprints}
                voiceprintsLoading={voiceprintsLoading}
                onRenameVoiceprint={handleRenameVoiceprint}
                onDeleteVoiceprint={handleDeleteVoiceprint}
                onRefreshVoiceprints={refreshVoiceprints}
                appVersion={APP_VERSION}
            />

            {/* Help Modal */}
            <HelpModal
                isOpen={showHelp}
                onClose={() => setShowHelp(false)}
                appVersion={APP_VERSION}
            />

            {/* Audio Meter Bar */}
            <AudioMeterBar />
        </div>
    );
};
