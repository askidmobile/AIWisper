import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { SettingsModal } from '../SettingsModal';
import { TranscriptionView } from '../modules/TranscriptionView';

import { RecordingOverlay } from '../RecordingOverlay';
import { HelpModal } from '../HelpModal';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { useSettings } from '../../hooks/useSettings';
import { useKeyboardShortcuts, createAppShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useDragDrop, dropOverlayStyles } from '../../hooks/useDragDrop';
import { useExport } from '../../hooks/useExport';
import { useSessionContext } from '../../context/SessionContext';
import { useModelContext } from '../../context/ModelContext';
import { useWebSocketContext } from '../../context/WebSocketContext';
import ModelManager from '../ModelManager';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { AudioMeterBar } from '../common/AudioMeterBar';
import { AudioMeterSidebar } from '../AudioMeterSidebar';
import { SessionSpeaker, VoicePrint } from '../../types/voiceprint';
import { WaveformData, computeWaveform } from '../../utils/waveform';

// Версия приложения из package.json
const APP_VERSION = '1.41.19';

interface MainLayoutProps {
    addLog: (msg: string) => void;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ addLog }) => {
    const API_BASE = `http://localhost:${process.env.AIWISPER_HTTP_PORT || 18080}`;
    
    // Контексты
    const { startSession, stopSession, isRecording, selectedSession, micLevel, sysLevel, isFullTranscribing } = useSessionContext();
    const { activeModelId, models, fetchOllamaModels, downloadModel, cancelDownload, deleteModel, setActiveModel } = useModelContext();
    const { sendMessage, subscribe } = useWebSocketContext();

    // Хуки
    const { play, pause, playingUrl, seek, currentTime, duration, isPlaying, micLevel: playbackMicLevel, sysLevel: playbackSysLevel } = useAudioPlayer();
    const {
        settings,
        isLoaded: settingsLoaded,
        theme, toggleTheme,
        language,
        micDevice, setMicDevice,
        captureSystem, setCaptureSystem,
        useVoiceIsolation, setUseVoiceIsolation,
        echoCancel, setEchoCancel,
        ollamaModel, setOllamaModel,
        enableStreaming,
        pauseThreshold,
        streamingChunkSeconds,
        streamingConfirmationThreshold,
        hybridTranscription, setHybridTranscription,
        ollamaUrl,
    } = useSettings();
    
    // Streaming настройки используются в useEffect для WebSocket
    void enableStreaming;
    void pauseThreshold;
    void streamingChunkSeconds;
    void streamingConfirmationThreshold;

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

    // Diarization state
    const [diarizationEnabled, setDiarizationEnabled] = useState(false);
    const [diarizationProvider, setDiarizationProvider] = useState<string>('');
    const [diarizationLoading, setDiarizationLoading] = useState(false);
    const [diarizationError, setDiarizationError] = useState<string | null>(null);

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
                // 1. Try to load from cache first
                const cacheResp = await fetch(`${API_BASE}/api/waveform/${targetId}`);
                if (cacheResp.ok && cacheResp.status !== 204) {
                    const cachedWaveform = await cacheResp.json();
                    if (!cancelled && cachedWaveform) {
                        console.log('[Waveform] Loaded from cache');
                        setWaveformData(cachedWaveform);
                        waveformSessionIdRef.current = targetId;
                        setWaveformStatus('ready');
                        return;
                    }
                }

                // 2. No cache - compute from audio
                console.log('[Waveform] Computing from audio...');
                const url = `${API_BASE}/api/sessions/${targetId}/full.mp3`;
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const arr = await resp.arrayBuffer();
                if (cancelled) return;

                const ctx = new AudioContext();
                const decoded = await ctx.decodeAudioData(arr);
                if (cancelled) {
                    ctx.close();
                    return;
                }

                const waveform = computeWaveform(decoded);
                ctx.close();
                if (!cancelled) {
                    setWaveformData(waveform);
                    waveformSessionIdRef.current = targetId;
                    setWaveformStatus('ready');

                    // 3. Save to cache (async, don't block UI)
                    fetch(`${API_BASE}/api/waveform/${targetId}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(waveform),
                    }).then(() => {
                        console.log('[Waveform] Saved to cache');
                    }).catch(err => {
                        console.warn('[Waveform] Failed to save cache:', err);
                    });
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
    }, [selectedSession?.id, API_BASE]);

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

        const unsubChunkTranscribed = subscribe('chunk_transcribed', (msg: any) => {
            // Запрашиваем обновлённый список спикеров после транскрипции
            if (msg.sessionId) {
                sendMessage({ type: 'get_session_speakers', sessionId: msg.sessionId });
            }
        });

        const unsubDiarizationStatus = subscribe('diarization_status', (msg: any) => {
            setDiarizationEnabled(msg.diarizationEnabled || false);
            setDiarizationProvider(msg.diarizationProvider || '');
            setDiarizationLoading(false);
        });

        const unsubDiarizationEnabled = subscribe('diarization_enabled', (msg: any) => {
            setDiarizationEnabled(true);
            setDiarizationProvider(msg.diarizationProvider || '');
            setDiarizationLoading(false);
            setDiarizationError(null);
        });

        const unsubDiarizationDisabled = subscribe('diarization_disabled', () => {
            setDiarizationEnabled(false);
            setDiarizationProvider('');
            setDiarizationLoading(false);
        });

        const unsubDiarizationError = subscribe('diarization_error', (msg: any) => {
            setDiarizationError(msg.error);
            setDiarizationLoading(false);
        });

        return () => {
            unsubSpeakers();
            unsubSpeakerRenamed();
            unsubChunkTranscribed();
            unsubDiarizationStatus();
            unsubDiarizationEnabled();
            unsubDiarizationDisabled();
            unsubDiarizationError();
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
    const refreshVoiceprints = useCallback(() => {
        setVoiceprintsLoading(true);
        fetch(`${API_BASE}/api/voiceprints`)
            .then(res => res.json())
            .then(data => {
                setVoiceprints(data.voiceprints || []);
                setVoiceprintsLoading(false);
            })
            .catch(() => {
                setVoiceprintsLoading(false);
            });
    }, [API_BASE]);

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
    const handleRenameVoiceprint = useCallback((id: string, name: string) => {
        fetch(`${API_BASE}/api/voiceprints/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        }).then(() => refreshVoiceprints());
    }, [API_BASE, refreshVoiceprints]);

    const handleDeleteVoiceprint = useCallback((id: string) => {
        fetch(`${API_BASE}/api/voiceprints/${id}`, { method: 'DELETE' })
            .then(() => refreshVoiceprints());
    }, [API_BASE, refreshVoiceprints]);

    // Diarization handlers
    const handleEnableDiarization = useCallback((segModelId: string, embModelId: string, provider: string) => {
        setDiarizationLoading(true);
        setDiarizationError(null);
        
        // Для FluidAudio (coreml) не нужны пути к моделям - они скачиваются автоматически
        if (provider === 'coreml') {
            sendMessage({
                type: 'enable_diarization',
                segmentationModelPath: '',
                embeddingModelPath: '',
                diarizationProvider: 'coreml',
            });
            return;
        }
        
        // Для Sherpa-ONNX нужны пути к моделям
        const segModel = models.find(m => m.id === segModelId);
        const embModel = models.find(m => m.id === embModelId);
        
        if (!segModel?.path || !embModel?.path) {
            setDiarizationError('Модели диаризации не найдены');
            setDiarizationLoading(false);
            return;
        }
        
        sendMessage({
            type: 'enable_diarization',
            segmentationModelPath: segModel.path,
            embeddingModelPath: embModel.path,
            diarizationProvider: provider,
        });
    }, [sendMessage, models]);

    const handleDisableDiarization = useCallback(() => {
        setDiarizationLoading(true);
        sendMessage({ type: 'disable_diarization' });
    }, [sendMessage]);

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
    }, [isRecording, isFullTranscribing, stopSession, startSession, activeModelId, language, micDevice, captureSystem, useVoiceIsolation, echoCancel, pauseThreshold, hybridTranscription, addLog]);

    // Playback Handlers
    const handlePlayChunk = useCallback((url: string) => {
        play(url);
    }, [play]);

    const handlePlaySession = useCallback((sessionId: string) => {
        const url = `${API_BASE}/api/sessions/${sessionId}/full.mp3`;
        play(url);
    }, [API_BASE, play]);

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

        console.log('[handleRetranscribeAll] activeModel:', activeModel?.name, 'modelId:', modelId);

        const isModelReady = activeModel?.status === 'downloaded' || activeModel?.status === 'active';
        if (!isModelReady && activeModelId) {
            addLog(`Model not downloaded (status: ${activeModel?.status}). Open model manager to download.`);
            setShowModelManager(true);
            return;
        }

        if (!modelId) {
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
        addLog(`Starting full retranscription with model: ${activeModel?.name || modelId}, hybrid: ${hybridTranscription.enabled}`);
    }, [selectedSession, models, activeModelId, language, sendMessage, addLog, hybridTranscription, ollamaModel, ollamaUrl, isFullTranscribing, isRecording]);

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
        addLog(`Импорт файла: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
        
        try {
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
    }, [addLog, API_BASE, activeModelId, language]);

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
            
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden', marginTop: isRecording ? '48px' : 0, transition: 'margin-top 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }}>
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
                                onPlaySession={handlePlaySession}
                                onPauseSession={pause}
                                currentTime={currentTime}
                                duration={duration}
                                onSeek={seek}
                                sessionSpeakers={sessionSpeakers}
                                onRetranscribeAll={handleRetranscribeAll}
                                onRenameSpeaker={handleRenameSpeaker}
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

            {/* Settings Modal */}
            <SettingsModal
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
                setLanguage={() => {}} // TODO: добавить в useSettings
                theme={theme}
                setTheme={toggleTheme}
                ollamaModel={ollamaModel}
                setOllamaModel={setOllamaModel}
                ollamaModels={[]}
                ollamaModelsLoading={false}
                ollamaError={null}
                loadOllamaModels={loadOllama}
                onShowModelManager={() => setShowModelManager(true)}
                activeModelId={activeModelId}
                models={models}
                // Diarization
                diarizationStatus={{ enabled: diarizationEnabled, provider: diarizationProvider }}
                diarizationLoading={diarizationLoading}
                diarizationError={diarizationError}
                segmentationModels={models.filter(m => m.engine === 'diarization' && m.diarizationType === 'segmentation')}
                embeddingModels={models.filter(m => m.engine === 'diarization' && m.diarizationType === 'embedding')}
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
