import React, { useState, useEffect, useCallback } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { SettingsPanel } from '../modules/SettingsPanel';
import { TranscriptionView } from '../modules/TranscriptionView';
import { ConsoleFooter } from '../modules/ConsoleFooter';
import { RecordingOverlay } from '../RecordingOverlay';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { useSessionContext } from '../../context/SessionContext';
import { useModelContext } from '../../context/ModelContext';
import { useWebSocketContext } from '../../context/WebSocketContext';
import ModelManager from '../ModelManager';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { AudioMeterBar } from '../common/AudioMeterBar';

interface MainLayoutProps {
    theme: 'light' | 'dark';
    toggleTheme: () => void;
    language: string;
    setLanguage: (lang: string) => void;
    logs: string[];
    addLog: (msg: string) => void;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
    language, logs, addLog
}) => {
    const API_BASE = `http://localhost:${process.env.AIWISPER_HTTP_PORT || 18080}`;
    const {
        startSession, stopSession, isRecording, selectedSession
    } = useSessionContext();
    const {
        activeModelId, models, fetchOllamaModels,
        downloadModel, cancelDownload, deleteModel, setActiveModel
    } = useModelContext();
    const { sendMessage, subscribe } = useWebSocketContext();

    // Audio Player
    const { play, playingUrl, seek, currentTime, duration } = useAudioPlayer();

    // Local Settings State
    const [showSettings, setShowSettings] = useState(false);
    const [micDevice, setMicDevice] = useState('default');
    const [captureSystem, setCaptureSystem] = useState(true); // Enable system capture by default
    const [useVoiceIsolation, setUseVoiceIsolation] = useState(false); // Default false for proper channel separation
    const [echoCancel, setEchoCancel] = useState(0.5);
    const [ollamaModel, setOllamaModel] = useState('');
    const [enableStreaming, setEnableStreaming] = useState(false); // Streaming transcription
    const [pauseThreshold, setPauseThreshold] = useState(0.5); // Pause threshold for segmentation (seconds)

    // Devices (fetched via navigator.mediaDevices usually, or Electron IPC)
    const [inputDevices, setInputDevices] = useState<any[]>([]);

    // Modal state
    const [showModelManager, setShowModelManager] = useState(false);

    // Model loading state
    const [modelLoading, setModelLoading] = useState(false);
    const [loadingModelName, setLoadingModelName] = useState('');

    // Initial Device Fetch & Load Settings
    useEffect(() => {
        const getDevices = async () => {
            try {
                const devs = await navigator.mediaDevices.enumerateDevices();
                const inputs = devs.filter(d => d.kind === 'audioinput').map(d => ({
                    id: d.deviceId, name: d.label || `Microphone ${d.deviceId}`, isInput: true
                }));
                setInputDevices(inputs);
            } catch (e) {
                console.error("Error fetching devices", e);
            }
        };
        getDevices();

        // Load settings
        try {
            const saved = localStorage.getItem('aiwisper_settings');
            if (saved) {
                const p = JSON.parse(saved);
                if (p.micDevice) setMicDevice(p.micDevice);
                if (p.captureSystem !== undefined) setCaptureSystem(p.captureSystem);
                if (p.useVoiceIsolation !== undefined) setUseVoiceIsolation(p.useVoiceIsolation);
                if (p.echoCancel !== undefined) setEchoCancel(p.echoCancel);
                if (p.ollamaModel) setOllamaModel(p.ollamaModel);
                if (p.enableStreaming !== undefined) setEnableStreaming(p.enableStreaming);
                if (p.pauseThreshold !== undefined) setPauseThreshold(p.pauseThreshold);
            }
        } catch (e) {
            console.error("Failed to load settings", e);
        }
    }, []);

    // Save settings on change
    useEffect(() => {
        const settings = {
            micDevice, captureSystem, useVoiceIsolation, echoCancel, ollamaModel, enableStreaming, pauseThreshold
        };
        localStorage.setItem('aiwisper_settings', JSON.stringify(settings));
    }, [micDevice, captureSystem, useVoiceIsolation, echoCancel, ollamaModel, enableStreaming, pauseThreshold]);

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

    // Start/Stop Handler
    const handleStartStop = async () => {
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
                    useNativeCapture: true // Use SCK by default on macOS 12+
                });
                addLog('Recording started');
            } catch (e: any) {
                addLog(`Error starting session: ${e.message}`);
            }
        }
    };

    // Playback Handlers
    const handlePlayChunk = (url: string) => {
        play(url);
    };

    const handlePlaySession = (sessionId: string) => {
        // Assuming backend serves full recording at specific URL
        // In App.tsx it was playFullRecording(id)
        // Usually: /api/sessions/{id}/audio
        const url = `${API_BASE}/api/sessions/${sessionId}/audio.mp3`;
        // Note: Backend needs to support this. App.tsx logic was slightly custom.
        // Let's assume standard URL or check App.tsx implementation.
        // App.tsx uses `playFullRecording` which likely constructs the URL.
        play(url);
    };

    // Retranscribe all chunks in session
    const handleRetranscribeAll = useCallback(() => {
        if (!selectedSession) {
            addLog('No session selected for retranscription');
            return;
        }

        // Get active model
        const activeModel = models.find(m => m.id === activeModelId);
        const modelId = activeModel?.id || activeModelId;

        // Check model status
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
            diarizationEnabled: false // Can be made configurable later
        });
        addLog(`Starting full retranscription with model: ${activeModel?.name || modelId}`);
    }, [selectedSession, models, activeModelId, language, sendMessage, addLog]);

    // Derived
    const settingsLocked = isRecording;

    // Load Ollama models on focus
    const loadOllama = () => fetchOllamaModels('http://localhost:11434');

    // Auto enable/disable streaming transcription based on recording state and settings
    useEffect(() => {
        if (isRecording && enableStreaming) {
            sendMessage({ type: 'enable_streaming' });
            addLog('Streaming transcription enabled');
        } else if (!isRecording) {
            sendMessage({ type: 'disable_streaming' });
        }
    }, [isRecording, enableStreaming, sendMessage, addLog]);

    return (
        <div className="app-frame" style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--app-bg)', color: 'var(--text-primary)' }}>
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
                        {/* Spinner */}
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
                        <div
                            style={{
                                fontSize: '1.1rem',
                                fontWeight: 600,
                                color: 'var(--text-primary)',
                                marginBottom: '0.5rem',
                            }}
                        >
                            Загрузка модели
                        </div>
                        <div
                            style={{
                                fontSize: '0.9rem',
                                color: 'var(--text-muted)',
                                marginBottom: '1rem',
                            }}
                        >
                            {loadingModelName}
                        </div>
                        <div
                            style={{
                                fontSize: '0.8rem',
                                color: 'var(--text-muted)',
                                opacity: 0.7,
                            }}
                        >
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

            {/* Recording Overlay - shows when recording */}
            <RecordingOverlay onStop={handleStartStop} />
            
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden', marginTop: isRecording ? '48px' : 0, transition: 'margin-top 0.2s ease' }}>
            <Sidebar
                onStartRecording={handleStartStop}
            />

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <Header
                    showSettings={showSettings}
                    setShowSettings={setShowSettings}
                />

                {showSettings && (
                    <SettingsPanel
                        settingsLocked={settingsLocked}
                        micDevice={micDevice} setMicDevice={setMicDevice}
                        inputDevices={inputDevices}
                        captureSystem={captureSystem} setCaptureSystem={setCaptureSystem}
                        screenCaptureKitAvailable={true} // Hardcoded for now or detect via IPC
                        useVoiceIsolation={useVoiceIsolation} setUseVoiceIsolation={setUseVoiceIsolation}
                        echoCancel={echoCancel} setEchoCancel={setEchoCancel}
                        ollamaModel={ollamaModel} setOllamaModel={setOllamaModel}
                        loadOllamaModels={loadOllama}
                        onShowModelManager={() => setShowModelManager(true)}
                        enableStreaming={enableStreaming}
                        setEnableStreaming={setEnableStreaming}
                        pauseThreshold={pauseThreshold}
                        setPauseThreshold={setPauseThreshold}
                    />
                )}

                <ErrorBoundary>
                    <TranscriptionView
                        onPlayChunk={handlePlayChunk}
                        playingUrl={playingUrl}
                        ollamaModel={ollamaModel}
                        // Player Props
                        isPlaying={!!playingUrl && playingUrl.includes('audio.mp3')} // Heuristic
                        onPlaySession={(id) => handlePlaySession(id)}
                        onPauseSession={() => playingUrl && play(playingUrl)}
                        currentTime={currentTime}
                        duration={duration}
                        onSeek={seek}
                        // Session speakers - пока пустой массив, т.к. MainLayout не использует WebSocket напрямую
                        sessionSpeakers={[]}
                        // Retranscribe all chunks
                        onRetranscribeAll={handleRetranscribeAll}
                    />
                </ErrorBoundary>
            </div>
            </div>

            {/* Console Footer - Full Width */}
            <ConsoleFooter logs={logs} />



            {/* Global Modal */}
            {showModelManager && (
                <ModelManager
                    models={models}
                    activeModelId={activeModelId}
                    onClose={() => setShowModelManager(false)}
                    // Pass other props required for ModelManager
                    // It uses sendMessage internally?
                    // Check ModelManager signature from App.tsx. It seemed to take props.
                    onDownload={(id) => downloadModel(id)}
                    onCancelDownload={(id) => cancelDownload(id)}
                    onDelete={(id) => deleteModel(id)}
                    onSetActive={(id) => setActiveModel(id)}
                />
            )}

            {/* Audio Meter Bar - Full Height Right Side */}
            <AudioMeterBar />
        </div>
    );
};
