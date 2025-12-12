import React from 'react';
import { useModelContext } from '../../context/ModelContext';
import { HybridTranscriptionSettingsPanel } from './HybridTranscriptionSettings';
import { HybridTranscriptionSettings } from '../../types/models';

interface AudioDevice {
    id: string;
    name: string;
    isInput: boolean;
    isOutput: boolean;
}

interface SettingsPanelProps {
    settingsLocked: boolean;
    micDevice: string;
    setMicDevice: (v: string) => void;
    inputDevices: AudioDevice[];
    captureSystem: boolean;
    setCaptureSystem: (v: boolean) => void;
    screenCaptureKitAvailable: boolean;
    useVoiceIsolation: boolean;
    setUseVoiceIsolation: (v: boolean) => void;
    echoCancel: number;
    setEchoCancel: (v: number) => void;
    ollamaModel: string;
    setOllamaModel: (v: string) => void;
    loadOllamaModels: () => void;
    onShowModelManager: () => void;
    enableStreaming?: boolean;
    setEnableStreaming?: (v: boolean) => void;
    pauseThreshold?: number;
    setPauseThreshold?: (v: number) => void;
    streamingChunkSeconds?: number;
    setStreamingChunkSeconds?: (v: number) => void;
    streamingConfirmationThreshold?: number;
    setStreamingConfirmationThreshold?: (v: number) => void;
    theme?: 'light' | 'dark';
    setTheme?: (v: 'light' | 'dark') => void;
    // Гибридная транскрипция
    hybridTranscription?: HybridTranscriptionSettings;
    setHybridTranscription?: (v: HybridTranscriptionSettings) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
    settingsLocked,
    micDevice, setMicDevice, inputDevices,
    captureSystem, setCaptureSystem, screenCaptureKitAvailable,
    useVoiceIsolation, setUseVoiceIsolation,
    echoCancel, setEchoCancel,
    ollamaModel, setOllamaModel, loadOllamaModels,
    onShowModelManager,
    enableStreaming = false,
    setEnableStreaming,
    pauseThreshold = 0.5,
    setPauseThreshold,
    streamingChunkSeconds = 15,
    setStreamingChunkSeconds,
    streamingConfirmationThreshold = 0.85,
    setStreamingConfirmationThreshold,
    theme = 'dark',
    setTheme,
    hybridTranscription,
    setHybridTranscription
}) => {
    const { models, activeModelId, ollamaModels, ollamaError, ollamaModelsLoading } = useModelContext() as any;
    // Note: setShowModelManager is not in context yet. I need to add it or manage modal in parent.
    // For now, I'll assume parent handles modal or I add it to context.
    // Actually ModelContext has downloadModel etc. but UI state (show modal) is usually local or UI context.
    // I'll add onShowModelManager prop.

    return (
        <div
            data-surface
            data-elevated
            className="settings-panel"
            style={{ padding: '0.9rem 1.5rem', position: 'relative', borderBottom: '1px solid var(--border-strong)', overflow: 'hidden' }}
        >
            {settingsLocked && (
                <div className="settings-lock" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(0,0,0,0.55), rgba(0,0,0,0.35))', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', zIndex: 5, color: 'var(--text-primary)' }}>
                    <span style={{ fontSize: '1rem' }}>🔒</span>
                    <span style={{ fontWeight: 600 }}>Запись идёт — настройки временно заблокированы</span>
                </div>
            )}

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', opacity: settingsLocked ? 0.55 : 1, pointerEvents: settingsLocked ? 'none' : 'auto' }}>
                <div data-chip style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.75rem', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--surface-strong)' }}>
                    <span>🎤</span>
                    <select
                        value={micDevice}
                        disabled={settingsLocked}
                        onChange={e => setMicDevice(e.target.value)}
                        style={{ padding: '0.35rem 0.6rem', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '8px' }}
                    >
                        <option value="">Default</option>
                        {inputDevices.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                    </select>
                </div>

                <label data-chip style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', padding: '0.35rem 0.75rem', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--surface-strong)' }}>
                    <input type="checkbox" checked={captureSystem} disabled={settingsLocked} onChange={e => setCaptureSystem(e.target.checked)} />
                    <span>🔊 System Audio</span>
                    {captureSystem && screenCaptureKitAvailable && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--success)', backgroundColor: 'rgba(0,184,148,0.14)', padding: '2px 6px', borderRadius: '999px' }}>
                            Native
                        </span>
                    )}
                </label>

                {/* Voice Isolation */}
                {captureSystem && screenCaptureKitAvailable && (
                    <label data-chip style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', padding: '0.35rem 0.75rem', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--surface-strong)' }} title="ВАЖНО: Разделение микрофона и системного звука для раздельной транскрибации (Вы/Собеседник).">
                        <input type="checkbox" checked={useVoiceIsolation} disabled={settingsLocked} onChange={e => setUseVoiceIsolation(e.target.checked)} />
                        <span style={{ fontSize: '0.85rem' }}>Voice Isolation</span>
                        <span style={{ fontSize: '0.65rem', color: 'var(--primary)', backgroundColor: 'rgba(108,92,231,0.12)', padding: '2px 5px', borderRadius: '999px' }}>
                            macOS 15+
                        </span>
                    </label>
                )}

                {/* Предупреждение */}
                {captureSystem && !screenCaptureKitAvailable && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--warning-strong)', backgroundColor: 'rgba(253,203,110,0.15)', padding: '6px 10px', borderRadius: '10px', border: '1px solid rgba(253,203,110,0.35)' }}>
                        ⚠️ Voice Isolation недоступен — транскрипция будет в моно режиме
                    </div>
                )}

                {/* Выбор модели */}
                <button
                    onClick={onShowModelManager}
                    disabled={settingsLocked}
                    style={{ padding: '0.4rem 0.7rem', backgroundColor: 'var(--surface-strong)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '10px', cursor: settingsLocked ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                >
                    <span>🤖</span>
                    <span>{models.find((m: any) => m.id === activeModelId)?.name || 'Выбрать модель'}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>▼</span>
                </button>

                {/* Echo Cancel */}
                {captureSystem && !useVoiceIsolation && (
                    <div data-chip style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', padding: '0.35rem 0.75rem', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--surface-strong)' }}>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Echo:</span>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={echoCancel * 100}
                            disabled={settingsLocked}
                            onChange={e => setEchoCancel(Number(e.target.value) / 100)}
                            style={{ width: '90px', accentColor: 'var(--primary)' }}
                            title={`Эхоподавление: ${Math.round(echoCancel * 100)}%`}
                        />
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', minWidth: '32px' }}>
                            {Math.round(echoCancel * 100)}%
                        </span>
                    </div>
                )}

                {/* Pause Threshold - для сегментации транскрипции */}
                {setPauseThreshold && (
                    <div data-chip style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', padding: '0.35rem 0.75rem', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--surface-strong)' }} title="Порог паузы для разделения сегментов. Меньше = больше сегментов, больше = меньше сегментов.">
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>⏱️ Пауза:</span>
                        <input
                            type="range"
                            min="30"
                            max="200"
                            step="10"
                            value={pauseThreshold * 100}
                            disabled={settingsLocked}
                            onChange={e => setPauseThreshold(Number(e.target.value) / 100)}
                            style={{ width: '80px', accentColor: 'var(--primary)' }}
                        />
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', minWidth: '40px' }}>
                            {pauseThreshold.toFixed(1)}s
                        </span>
                    </div>
                )}

                {/* Streaming Transcription Toggle */}
                {setEnableStreaming && (
                    <label 
                        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}
                        title="Включить real-time транскрипцию во время записи (требует Parakeet TDT v3)"
                    >
                        <input 
                            type="checkbox" 
                            checked={enableStreaming} 
                            disabled={settingsLocked} 
                            onChange={e => setEnableStreaming?.(e.target.checked)} 
                        />
                        <span style={{ fontSize: '0.85rem' }}>Live Транскрипция</span>
                        <span style={{ fontSize: '0.65rem', color: 'var(--primary)', backgroundColor: 'rgba(108,92,231,0.12)', padding: '2px 5px', borderRadius: '999px' }}>
                            Beta
                        </span>
                    </label>
                )}

                {/* Streaming Settings (показываем только если streaming включен) */}
                {enableStreaming && setStreamingChunkSeconds && setStreamingConfirmationThreshold && (
                    <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', marginLeft: '1rem', paddingLeft: '1rem', borderLeft: '2px solid var(--primary-alpha)' }}>
                        {/* Chunk Seconds */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }} title="Размер чанка для обработки (меньше = быстрее, но менее точно)">
                                Чанк:
                            </span>
                            <input
                                type="range"
                                min="1"
                                max="30"
                                step="1"
                                value={streamingChunkSeconds}
                                disabled={settingsLocked}
                                onChange={e => setStreamingChunkSeconds(parseFloat(e.target.value))}
                                style={{ width: '80px', cursor: 'pointer' }}
                            />
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)', minWidth: '35px' }}>
                                {streamingChunkSeconds}s
                            </span>
                        </div>

                        {/* Confirmation Threshold */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }} title="Порог уверенности для подтверждения текста (выше = точнее, но медленнее)">
                                Порог:
                            </span>
                            <input
                                type="range"
                                min="0.5"
                                max="0.99"
                                step="0.01"
                                value={streamingConfirmationThreshold}
                                disabled={settingsLocked}
                                onChange={e => setStreamingConfirmationThreshold(parseFloat(e.target.value))}
                                style={{ width: '80px', cursor: 'pointer' }}
                            />
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)', minWidth: '40px' }}>
                                {Math.round(streamingConfirmationThreshold * 100)}%
                            </span>
                        </div>
                    </div>
                )}

                {/* Theme Toggle */}
                {setTheme && (
                    <button
                        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            padding: '0.35rem 0.75rem',
                            borderRadius: '12px',
                            border: '1px solid var(--border)',
                            background: 'var(--surface-strong)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                            fontSize: '0.85rem',
                            transition: 'all 0.2s ease'
                        }}
                        title={theme === 'dark' ? 'Переключить на светлую тему' : 'Переключить на тёмную тему'}
                    >
                        <span style={{ fontSize: '1rem' }}>{theme === 'dark' ? '☀️' : '🌙'}</span>
                        <span>{theme === 'dark' ? 'Светлая' : 'Тёмная'}</span>
                    </button>
                )}
            </div>

            {/* Ollama Settings */}
            <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px dashed var(--border)', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', opacity: settingsLocked ? 0.55 : 1, pointerEvents: settingsLocked ? 'none' : 'auto' }}>
                <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>📋 Summary (Ollama)</span>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Модель:</span>
                    <select
                        value={ollamaModel}
                        disabled={settingsLocked}
                        onChange={e => setOllamaModel(e.target.value)}
                        onFocus={loadOllamaModels}
                        style={{ padding: '0.35rem 0.6rem', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '8px', minWidth: '180px', fontSize: '0.9rem', cursor: 'pointer' }}
                    >
                        {ollamaModelsLoading ? (
                            <option value="">Загрузка...</option>
                        ) : ollamaModels.length === 0 ? (
                            <option value={ollamaModel}>{ollamaModel}</option>
                        ) : (
                            ollamaModels.map((m: any) => (
                                <option key={m.name} value={m.name}>
                                    {m.isCloud ? '☁️ ' : '💻 '} {m.name} {m.parameters ? ` (${m.parameters})` : ''}
                                </option>
                            ))
                        )}
                    </select>
                    <button
                        onClick={loadOllamaModels}
                        disabled={ollamaModelsLoading || settingsLocked}
                        style={{ padding: '0.35rem 0.55rem', backgroundColor: 'var(--surface-strong)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '8px', cursor: ollamaModelsLoading ? 'wait' : 'pointer', fontSize: '0.85rem' }}
                    >
                        {ollamaModelsLoading ? '⏳' : '🔄'}
                    </button>
                </div>

                {ollamaError && (
                    <span style={{ fontSize: '0.8rem', color: 'var(--danger)', backgroundColor: 'rgba(231, 76, 60, 0.14)', padding: '4px 8px', borderRadius: '8px', border: '1px solid rgba(231, 76, 60, 0.28)' }}>
                        ⚠️ {ollamaError}
                    </span>
                )}
            </div>

            {/* Hybrid Transcription Settings */}
            {hybridTranscription && setHybridTranscription && (
                <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px dashed var(--border)', opacity: settingsLocked ? 0.55 : 1, pointerEvents: settingsLocked ? 'none' : 'auto' }}>
                    <HybridTranscriptionSettingsPanel
                        settings={hybridTranscription}
                        onChange={setHybridTranscription}
                        availableModels={models}
                        currentModelId={activeModelId || ''}
                        disabled={settingsLocked}
                    />
                </div>
            )}
        </div>
    );
};
