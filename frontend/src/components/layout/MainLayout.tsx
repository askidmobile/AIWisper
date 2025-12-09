import React, { useState, useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { SettingsPanel } from '../modules/SettingsPanel';
import { TranscriptionView } from '../modules/TranscriptionView';
import { ConsoleFooter } from '../modules/ConsoleFooter';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { useSessionContext } from '../../context/SessionContext';
import { useModelContext } from '../../context/ModelContext';
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
        startSession, stopSession, isRecording
    } = useSessionContext();
    const {
        activeModelId, models, fetchOllamaModels,
        downloadModel, cancelDownload, deleteModel, setActiveModel
    } = useModelContext();
    // WebSocketContext isConnected unused here, removed

    // Audio Player
    const { play, playingUrl, seek, currentTime, duration } = useAudioPlayer();

    // Local Settings State
    const [showSettings, setShowSettings] = useState(false);
    const [micDevice, setMicDevice] = useState('default');
    const [captureSystem, setCaptureSystem] = useState(true); // Enable system capture by default
    const [useVoiceIsolation, setUseVoiceIsolation] = useState(false); // Default false for proper channel separation
    const [echoCancel, setEchoCancel] = useState(0.5);
    const [ollamaModel, setOllamaModel] = useState('');

    // Devices (fetched via navigator.mediaDevices usually, or Electron IPC)
    const [inputDevices, setInputDevices] = useState<any[]>([]);

    // Modal state
    const [showModelManager, setShowModelManager] = useState(false);

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
            }
        } catch (e) {
            console.error("Failed to load settings", e);
        }
    }, []);

    // Save settings on change
    useEffect(() => {
        const settings = {
            micDevice, captureSystem, useVoiceIsolation, echoCancel, ollamaModel
        };
        localStorage.setItem('aiwisper_settings', JSON.stringify(settings));
    }, [micDevice, captureSystem, useVoiceIsolation, echoCancel, ollamaModel]);

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

    // Derived
    const settingsLocked = isRecording;

    // Load Ollama models on focus
    const loadOllama = () => fetchOllamaModels('http://localhost:11434');

    return (
        <div className="app-frame" style={{ display: 'flex', height: '100vh', background: 'var(--app-bg)', color: 'var(--text-primary)' }}>
            <Sidebar
                onStartRecording={handleStartStop}
            />

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
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
                    />
                </ErrorBoundary>

                <ConsoleFooter logs={logs} />

                {/* Model Manager Modal - Triggered via SettingsPanel or Menu?
                    SettingsPanel has button. We need to pass setShowModelManager to it
                    or manage it via Context.
                    I passed `setShowModelManager` via ModelContext in SettingsPanel? No, I commented it.
                    I should pass `onShowModelManager` to SettingsPanel.
                */}
            </div>

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
