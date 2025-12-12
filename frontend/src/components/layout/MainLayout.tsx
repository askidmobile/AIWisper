import React, { useState, useEffect, useCallback } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { SettingsPanel } from '../modules/SettingsPanel';
import { TranscriptionView } from '../modules/TranscriptionView';
import { ConsoleFooter } from '../modules/ConsoleFooter';
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

interface MainLayoutProps {
    logs: string[];
    addLog: (msg: string) => void;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ logs, addLog }) => {
    const API_BASE = `http://localhost:${process.env.AIWISPER_HTTP_PORT || 18080}`;
    
    // Контексты
    const { startSession, stopSession, isRecording, selectedSession } = useSessionContext();
    const { activeModelId, models, fetchOllamaModels, downloadModel, cancelDownload, deleteModel, setActiveModel } = useModelContext();
    const { sendMessage, subscribe } = useWebSocketContext();

    // Хуки
    const { play, pause, playingUrl, seek, currentTime, duration, isPlaying } = useAudioPlayer();
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
        enableStreaming, setEnableStreaming,
        pauseThreshold, setPauseThreshold,
        streamingChunkSeconds, setStreamingChunkSeconds,
        streamingConfirmationThreshold, setStreamingConfirmationThreshold,
        hybridTranscription, setHybridTranscription,
    } = useSettings();

    // UI State
    const [showSettings, setShowSettings] = useState(false);
    const [showModelManager, setShowModelManager] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [modelLoading, setModelLoading] = useState(false);
    const [loadingModelName, setLoadingModelName] = useState('');

    // Devices
    const [inputDevices, setInputDevices] = useState<Array<{ id: string; name: string; isInput: boolean; isOutput: boolean }>>([]);

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
    }, [isRecording, stopSession, startSession, activeModelId, language, micDevice, captureSystem, useVoiceIsolation, echoCancel, pauseThreshold, hybridTranscription, addLog]);

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
        if (!selectedSession) {
            addLog('No session selected for retranscription');
            return;
        }

        const activeModel = models.find(m => m.id === activeModelId);
        const modelId = activeModel?.id || activeModelId;

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

        sendMessage({
            type: 'retranscribe_full',
            sessionId: selectedSession.id,
            model: modelId,
            language: language,
            diarizationEnabled: false
        });
        addLog(`Starting full retranscription with model: ${activeModel?.name || modelId}`);
    }, [selectedSession, models, activeModelId, language, sendMessage, addLog]);

    // Load Ollama models
    const loadOllama = useCallback(() => {
        fetchOllamaModels(settings.ollamaUrl);
    }, [fetchOllamaModels, settings.ollamaUrl]);

    const settingsLocked = isRecording;

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
            
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden', marginTop: isRecording ? '48px' : 0, transition: 'margin-top 0.2s ease' }}>
                <Sidebar onStartRecording={handleStartStop} />

                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <Header 
                        showSettings={showSettings} 
                        setShowSettings={setShowSettings}
                        onShowHelp={() => setShowHelp(true)}
                    />

                    {showSettings && (
                        <SettingsPanel
                            settingsLocked={settingsLocked}
                            micDevice={micDevice}
                            setMicDevice={setMicDevice}
                            inputDevices={inputDevices}
                            captureSystem={captureSystem}
                            setCaptureSystem={setCaptureSystem}
                            screenCaptureKitAvailable={true}
                            useVoiceIsolation={useVoiceIsolation}
                            setUseVoiceIsolation={setUseVoiceIsolation}
                            echoCancel={echoCancel}
                            setEchoCancel={setEchoCancel}
                            ollamaModel={ollamaModel}
                            setOllamaModel={setOllamaModel}
                            loadOllamaModels={loadOllama}
                            onShowModelManager={() => setShowModelManager(true)}
                            enableStreaming={enableStreaming}
                            setEnableStreaming={setEnableStreaming}
                            pauseThreshold={pauseThreshold}
                            setPauseThreshold={setPauseThreshold}
                            streamingChunkSeconds={streamingChunkSeconds}
                            setStreamingChunkSeconds={setStreamingChunkSeconds}
                            streamingConfirmationThreshold={streamingConfirmationThreshold}
                            setStreamingConfirmationThreshold={setStreamingConfirmationThreshold}
                            theme={theme}
                            setTheme={toggleTheme}
                            hybridTranscription={hybridTranscription}
                            setHybridTranscription={setHybridTranscription}
                        />
                    )}

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
                            sessionSpeakers={[]}
                            onRetranscribeAll={handleRetranscribeAll}
                        />
                    </ErrorBoundary>
                </div>
            </div>

            {/* Console Footer */}
            <ConsoleFooter logs={logs} />

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

            {/* Help Modal */}
            <HelpModal
                isOpen={showHelp}
                onClose={() => setShowHelp(false)}
                appVersion="1.39.0"
            />

            {/* Audio Meter Bar */}
            <AudioMeterBar />
        </div>
    );
};
