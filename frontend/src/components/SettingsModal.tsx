import React, { useState, useEffect } from 'react';
import { ModelState, OllamaModel, DiarizationStatus, HybridTranscriptionSettings } from '../types/models';
import { VoicePrint } from '../types/voiceprint';
import { HybridTranscriptionSettingsPanel } from './modules/HybridTranscriptionSettings';
import { VoiceprintsSettings } from './modules/VoiceprintsSettings';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    devices: { id: string; name: string; isInput: boolean }[];
    micDevice: string;
    setMicDevice: (id: string) => void;
    captureSystem: boolean;
    setCaptureSystem: (v: boolean) => void;
    vadMode: 'auto' | 'compression' | 'per-region' | 'off';
    setVADMode: (v: 'auto' | 'compression' | 'per-region' | 'off') => void;
    vadMethod: 'auto' | 'energy' | 'silero';
    setVADMethod: (v: 'auto' | 'energy' | 'silero') => void;
    screenCaptureKitAvailable: boolean;
    useVoiceIsolation: boolean;
    setUseVoiceIsolation: (v: boolean) => void;
    echoCancel: number;
    setEchoCancel: (v: number) => void;
    language: 'ru' | 'en' | 'auto';
    setLanguage: (l: 'ru' | 'en' | 'auto') => void;
    theme: 'light' | 'dark' | 'system';
    setTheme: (t: 'light' | 'dark' | 'system') => void;
    ollamaModel: string;
    setOllamaModel: (m: string) => void;
    ollamaModels: OllamaModel[];
    ollamaModelsLoading: boolean;
    ollamaError: string | null;
    loadOllamaModels: () => void;
    onShowModelManager: () => void;
    activeModelId: string | null;
    models: ModelState[];
    // Диаризация
    diarizationStatus?: DiarizationStatus;
    diarizationLoading?: boolean;
    diarizationError?: string | null;
    segmentationModels?: ModelState[];
    embeddingModels?: ModelState[];
    onEnableDiarization?: (segModelId: string, embModelId: string, provider: string) => void;
    onDisableDiarization?: () => void;
    // Гибридная транскрипция
    hybridTranscription?: HybridTranscriptionSettings;
    onHybridTranscriptionChange?: (settings: HybridTranscriptionSettings) => void;
    // Voiceprints (сохранённые голоса)
    voiceprints?: VoicePrint[];
    voiceprintsLoading?: boolean;
    onRenameVoiceprint?: (id: string, name: string) => void;
    onDeleteVoiceprint?: (id: string) => void;
    onRefreshVoiceprints?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    onClose,
    devices,
    micDevice,
    setMicDevice,
    captureSystem,
    setCaptureSystem,
    vadMode,
    setVADMode,
    vadMethod,
    setVADMethod,
    screenCaptureKitAvailable,
    useVoiceIsolation,
    setUseVoiceIsolation,
    echoCancel,
    setEchoCancel,
    language,
    setLanguage,
    theme,
    setTheme,
    ollamaModel,
    setOllamaModel,
    ollamaModels,
    ollamaModelsLoading,
    ollamaError,
    loadOllamaModels,
    onShowModelManager,
    activeModelId,
    models,
    // Диаризация
    diarizationStatus,
    diarizationLoading,
    diarizationError,
    segmentationModels = [],
    embeddingModels = [],
    onEnableDiarization,
    onDisableDiarization,
    // Гибридная транскрипция
    hybridTranscription,
    onHybridTranscriptionChange,
    // Voiceprints
    voiceprints = [],
    voiceprintsLoading = false,
    onRenameVoiceprint,
    onDeleteVoiceprint,
    onRefreshVoiceprints,
}) => {
    // Локальное состояние для выбора моделей диаризации
    const [selectedSegModel, setSelectedSegModel] = useState(
        segmentationModels.find((m) => m.recommended)?.id || segmentationModels[0]?.id || ''
    );
    const [selectedEmbModel, setSelectedEmbModel] = useState(
        embeddingModels.find((m) => m.recommended)?.id || embeddingModels[0]?.id || ''
    );
    // FluidAudio всегда использует coreml - переменная provider больше не нужна

    // Обновляем выбор при изменении списка моделей
    useEffect(() => {
        if (!selectedSegModel && segmentationModels.length > 0) {
            setSelectedSegModel(
                segmentationModels.find((m) => m.recommended)?.id || segmentationModels[0].id
            );
        }
        if (!selectedEmbModel && embeddingModels.length > 0) {
            setSelectedEmbModel(
                embeddingModels.find((m) => m.recommended)?.id || embeddingModels[0].id
            );
        }
    }, [segmentationModels, embeddingModels, selectedSegModel, selectedEmbModel]);

    if (!isOpen) return null;

    const activeModel = models.find((m) => m.id === activeModelId);
    const inputDevices = devices.filter((d) => d.isInput);

    // FluidAudio скачивает модели автоматически - проверка готовности не нужна

    const sectionStyle: React.CSSProperties = {
        marginBottom: '1.5rem',
        padding: '1rem',
        background: 'var(--glass-bg)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--glass-border-subtle)',
    };

    const labelStyle: React.CSSProperties = {
        fontSize: '0.75rem',
        fontWeight: 'var(--font-weight-semibold)',
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        marginBottom: '0.75rem',
        display: 'block',
    };

    const selectStyle: React.CSSProperties = {
        width: '100%',
        padding: '0.6rem 0.75rem',
        background: 'var(--glass-bg)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-primary)',
        fontSize: '0.9rem',
        cursor: 'pointer',
        transition: 'border-color var(--duration-fast)',
    };

    return (
        <div
            className="animate-scale-in"
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.5)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
            }}
            onClick={onClose}
        >
            <div
                style={{
                    background: 'var(--glass-bg-elevated)',
                    backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    WebkitBackdropFilter:
                        'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    borderRadius: 'var(--radius-xl)',
                    width: '480px',
                    maxHeight: '85vh',
                    boxShadow: 'var(--shadow-elevated)',
                    border: '1px solid var(--glass-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header - Fixed */}
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '1.5rem',
                        paddingBottom: '1rem',
                        borderBottom: '1px solid var(--glass-border-subtle)',
                        flexShrink: 0,
                    }}
                >
                    <h2
                        style={{
                            margin: 0,
                            fontSize: '1.2rem',
                            fontWeight: 'var(--font-weight-bold)',
                        }}
                    >
                        Настройки
                    </h2>
                    <button
                        className="btn-icon"
                        onClick={onClose}
                        style={{ width: '32px', height: '32px' }}
                    >
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* Scrollable Content */}
                <div
                    style={{
                        flex: 1,
                        overflowY: 'auto',
                        padding: '0 1.5rem',
                        paddingBottom: '1rem',
                    }}
                >
                {/* Appearance Section */}
                <div style={sectionStyle}>
                    <span style={labelStyle}>Внешний вид</span>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                        <div>
                            <label
                                style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--text-secondary)',
                                    marginBottom: '0.35rem',
                                    display: 'block',
                                }}
                            >
                                Тема
                            </label>
                            <select
                                value={theme}
                                onChange={(e) => setTheme(e.target.value as any)}
                                style={selectStyle}
                            >
                                <option value="system">Системная</option>
                                <option value="dark">Тёмная</option>
                                <option value="light">Светлая</option>
                            </select>
                        </div>
                        <div>
                            <label
                                style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--text-secondary)',
                                    marginBottom: '0.35rem',
                                    display: 'block',
                                }}
                            >
                                Язык распознавания
                            </label>
                            <select
                                value={language}
                                onChange={(e) => setLanguage(e.target.value as any)}
                                style={selectStyle}
                            >
                                <option value="ru">Русский</option>
                                <option value="en">English</option>
                                <option value="auto">Авто</option>
                            </select>
                        </div>
                    </div>
                </div>

                {/* Audio Section */}
                <div style={sectionStyle}>
                    <span style={labelStyle}>Аудио</span>

                    <div style={{ marginBottom: '0.75rem' }}>
                        <label
                            style={{
                                fontSize: '0.8rem',
                                color: 'var(--text-secondary)',
                                marginBottom: '0.35rem',
                                display: 'block',
                            }}
                        >
                            Микрофон
                        </label>
                        <select
                            value={micDevice}
                            onChange={(e) => setMicDevice(e.target.value)}
                            style={selectStyle}
                        >
                            <option value="">По умолчанию</option>
                            {inputDevices.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Checkboxes */}
                    <div
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.6rem',
                            marginTop: '1rem',
                        }}
                    >
                        <label
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.6rem',
                                fontSize: '0.85rem',
                                color: 'var(--text-primary)',
                                cursor: 'pointer',
                            }}
                        >
                            <input
                                type="checkbox"
                                checked={captureSystem}
                                onChange={(e) => setCaptureSystem(e.target.checked)}
                                style={{
                                    width: '18px',
                                    height: '18px',
                                    accentColor: 'var(--primary)',
                                }}
                            />
                            <span>
                                Записывать системный звук
                                {screenCaptureKitAvailable && (
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                        {' '}
                                        (ScreenCaptureKit)
                                    </span>
                                )}
                            </span>
                        </label>

                        {captureSystem && screenCaptureKitAvailable && (
                            <label
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.6rem',
                                    fontSize: '0.85rem',
                                    color: 'var(--text-primary)',
                                    cursor: 'pointer',
                                    paddingLeft: '1.5rem',
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={useVoiceIsolation}
                                    onChange={(e) => setUseVoiceIsolation(e.target.checked)}
                                    style={{
                                        width: '18px',
                                        height: '18px',
                                        accentColor: 'var(--primary)',
                                    }}
                                />
                                <span>
                                    Voice Isolation
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                        {' '}
                                        (macOS 15+)
                                    </span>
                                </span>
                            </label>
                        )}

                        <div style={{ marginTop: '0.75rem' }}>
                            <label
                                style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--text-secondary)',
                                    marginBottom: '0.35rem',
                                    display: 'block',
                                }}
                            >
                                Режим VAD (обработка пауз)
                            </label>
                            <select
                                value={vadMode}
                                onChange={(e) => setVADMode(e.target.value as any)}
                                style={selectStyle}
                            >
                                <option value="auto">Авто (рекомендуется)</option>
                                <option value="per-region">Per-region (лучше для GigaAM)</option>
                                <option value="compression">Compression (лучше для Whisper)</option>
                                <option value="off">Выключен (30с чанки)</option>
                            </select>
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', lineHeight: '1.3', marginTop: '4px', display: 'block' }}>
                                Per-region: каждый фрагмент речи отдельно. Compression: склеивание фрагментов.
                            </span>
                        </div>

                        <div style={{ marginTop: '0.75rem' }}>
                            <label
                                style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--text-secondary)',
                                    marginBottom: '0.35rem',
                                    display: 'block',
                                }}
                            >
                                Метод детекции речи
                            </label>
                            <select
                                value={vadMethod}
                                onChange={(e) => setVADMethod(e.target.value as any)}
                                style={selectStyle}
                            >
                                <option value="auto">Авто (Silero если доступен)</option>
                                <option value="silero">Silero VAD (точный, ~2MB модель)</option>
                                <option value="energy">Energy-based (быстрый)</option>
                            </select>
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', lineHeight: '1.3', marginTop: '4px', display: 'block' }}>
                                Silero VAD: нейросетевой детектор, точнее в шумных условиях.
                            </span>
                        </div>
                    </div>

                    {/* Echo Cancellation Slider */}
                    {captureSystem && !useVoiceIsolation && (
                        <div style={{ marginTop: '1rem' }}>
                            <div
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    marginBottom: '0.35rem',
                                }}
                            >
                                <label
                                    style={{
                                        fontSize: '0.8rem',
                                        color: 'var(--text-secondary)',
                                    }}
                                >
                                    Эхоподавление
                                </label>
                                <span
                                    style={{
                                        fontSize: '0.8rem',
                                        color: 'var(--text-muted)',
                                        fontFamily: 'SF Mono, monospace',
                                    }}
                                >
                                    {Math.round(echoCancel * 100)}%
                                </span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.1"
                                value={echoCancel}
                                onChange={(e) => setEchoCancel(parseFloat(e.target.value))}
                                style={{
                                    width: '100%',
                                    accentColor: 'var(--primary)',
                                }}
                            />
                        </div>
                    )}
                </div>

                {/* Models Section */}
                <div style={sectionStyle}>
                    <span style={labelStyle}>Модели</span>

                    {/* Whisper Model */}
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'flex-end',
                            gap: '0.75rem',
                            marginBottom: '1rem',
                        }}
                    >
                        <div style={{ flex: 1 }}>
                            <label
                                style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--text-secondary)',
                                    marginBottom: '0.35rem',
                                    display: 'block',
                                }}
                            >
                                Whisper модель
                            </label>
                            <div
                                style={{
                                    padding: '0.6rem 0.75rem',
                                    background: 'var(--glass-bg)',
                                    border: '1px solid var(--glass-border)',
                                    borderRadius: 'var(--radius-sm)',
                                    fontSize: '0.9rem',
                                    color: 'var(--text-primary)',
                                }}
                            >
                                {activeModel?.name || 'Не выбрана'}
                            </div>
                        </div>
                        <button
                            className="btn-capsule btn-capsule-primary"
                            onClick={onShowModelManager}
                            style={{ padding: '0.6rem 1rem' }}
                        >
                            Управление
                        </button>
                    </div>

                    {/* Ollama Model */}
                    <div>
                        <label
                            style={{
                                fontSize: '0.8rem',
                                color: 'var(--text-secondary)',
                                marginBottom: '0.35rem',
                                display: 'block',
                            }}
                        >
                            Ollama модель (для Сводки)
                        </label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <select
                                value={ollamaModel}
                                onChange={(e) => setOllamaModel(e.target.value)}
                                style={{ ...selectStyle, flex: 1 }}
                            >
                                {ollamaModels.length === 0 && (
                                    <option value={ollamaModel}>{ollamaModel}</option>
                                )}
                                {ollamaModels.map((m) => (
                                    <option key={m.name} value={m.name}>
                                        {m.name}
                                    </option>
                                ))}
                            </select>
                            <button
                                className="btn-icon"
                                onClick={loadOllamaModels}
                                disabled={ollamaModelsLoading}
                                style={{
                                    width: '40px',
                                    height: '40px',
                                    opacity: ollamaModelsLoading ? 0.5 : 1,
                                }}
                            >
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    style={{
                                        animation: ollamaModelsLoading
                                            ? 'spin 1s linear infinite'
                                            : 'none',
                                    }}
                                >
                                    <path d="M23 4v6h-6" />
                                    <path d="M1 20v-6h6" />
                                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                </svg>
                            </button>
                        </div>
                        {ollamaError && (
                            <div
                                style={{
                                    fontSize: '0.75rem',
                                    color: 'var(--danger)',
                                    marginTop: '0.35rem',
                                }}
                            >
                                {ollamaError}
                            </div>
                        )}
                    </div>
                </div>

                {/* Diarization Section */}
                {(segmentationModels.length > 0 || embeddingModels.length > 0) && (
                    <div style={sectionStyle}>
                        <span style={labelStyle}>Диаризация спикеров</span>

                        {/* Status indicator */}
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                marginBottom: '1rem',
                                padding: '0.6rem 0.85rem',
                                background: diarizationStatus?.enabled
                                    ? 'rgba(52, 199, 89, 0.1)'
                                    : 'var(--glass-bg)',
                                borderRadius: 'var(--radius-md)',
                                border: `1px solid ${diarizationStatus?.enabled ? 'rgba(52, 199, 89, 0.3)' : 'var(--glass-border)'}`,
                            }}
                        >
                            <div
                                style={{
                                    width: '8px',
                                    height: '8px',
                                    borderRadius: '50%',
                                    background: diarizationStatus?.enabled ? '#34c759' : 'var(--text-muted)',
                                    boxShadow: diarizationStatus?.enabled ? '0 0 8px rgba(52, 199, 89, 0.5)' : 'none',
                                }}
                            />
                            <span style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                                {diarizationStatus?.enabled ? 'FluidAudio активен' : 'Выключена'}
                            </span>
                            {diarizationStatus?.enabled && (
                                <span
                                    style={{
                                        fontSize: '0.75rem',
                                        color: 'var(--success)',
                                        marginLeft: 'auto',
                                        padding: '0.15rem 0.5rem',
                                        background: 'rgba(52, 199, 89, 0.15)',
                                        borderRadius: 'var(--radius-sm)',
                                    }}
                                >
                                    CoreML
                                </span>
                            )}
                        </div>

                        {/* FluidAudio info - всегда показываем информацию о движке */}
                        <div
                            style={{
                                fontSize: '0.85rem',
                                color: 'var(--text-secondary)',
                                marginBottom: '1rem',
                                padding: '1rem',
                                background: 'var(--glass-bg)',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--glass-border)',
                            }}
                        >
                            <div style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                gap: '0.5rem',
                                marginBottom: '0.75rem', 
                                fontWeight: 600, 
                                color: 'var(--text-primary)',
                                fontSize: '0.95rem',
                            }}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                                    <line x1="12" y1="19" x2="12" y2="22"/>
                                </svg>
                                FluidAudio
                            </div>
                            <div style={{ lineHeight: 1.5 }}>
                                Нативный движок диаризации на Apple Neural Engine (CoreML).
                                Быстрое распознавание говорящих без внешних зависимостей.
                            </div>
                            <div style={{ 
                                marginTop: '0.75rem',
                                padding: '0.5rem 0.75rem',
                                background: 'rgba(52, 199, 89, 0.1)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: '0.8rem',
                                color: 'var(--success)',
                            }}>
                                Модели скачиваются автоматически при первом включении
                            </div>
                        </div>

                        {/* Error message */}
                        {diarizationError && (
                            <div
                                style={{
                                    fontSize: '0.75rem',
                                    color: 'var(--danger)',
                                    marginBottom: '0.75rem',
                                }}
                            >
                                {diarizationError}
                            </div>
                        )}

                        {/* Action button */}
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            {!diarizationStatus?.enabled ? (
                                <button
                                    className="btn-capsule btn-capsule-primary"
                                    onClick={() => {
                                        // FluidAudio использует coreml провайдер, модели скачиваются автоматически
                                        if (onEnableDiarization) {
                                            onEnableDiarization(selectedSegModel || '', selectedEmbModel || '', 'coreml');
                                        }
                                    }}
                                    disabled={diarizationLoading}
                                    style={{
                                        padding: '0.5rem 1.25rem',
                                        opacity: diarizationLoading ? 0.5 : 1,
                                    }}
                                >
                                    {diarizationLoading ? 'Включение...' : 'Включить FluidAudio'}
                                </button>
                            ) : (
                                <button
                                    className="btn-capsule"
                                    onClick={onDisableDiarization}
                                    disabled={diarizationLoading}
                                    style={{
                                        padding: '0.5rem 1.25rem',
                                        background: 'var(--glass-bg)',
                                        border: '1px solid var(--glass-border)',
                                    }}
                                >
                                    {diarizationLoading ? 'Отключение...' : 'Отключить'}
                                </button>
                            )}
                        </div>

                        <div
                            style={{
                                fontSize: '0.75rem',
                                color: 'var(--text-muted)',
                                marginTop: '0.75rem',
                            }}
                        >
                            Диаризация определяет кто говорит в mono-записи. При записи mic+sys спикеры определяются автоматически.
                        </div>
                    </div>
                )}

                {/* Hybrid Transcription Section */}
                {hybridTranscription && onHybridTranscriptionChange && (
                    <div style={sectionStyle}>
                        <span style={labelStyle}>Улучшенное распознавание</span>
                        <HybridTranscriptionSettingsPanel
                            settings={hybridTranscription}
                            onChange={onHybridTranscriptionChange}
                            availableModels={models.filter(m => m.status === 'downloaded' && (m.engine === 'whisper' || m.engine === 'gigaam' || m.engine === 'fluid-asr'))}
                            currentModelId={activeModelId || ''}
                            disabled={false}
                        />
                    </div>
                )}

                {/* Voiceprints Section */}
                {onRenameVoiceprint && onDeleteVoiceprint && onRefreshVoiceprints && (
                    <div style={sectionStyle}>
                        <span style={labelStyle}>Сохранённые голоса</span>
                        <VoiceprintsSettings
                            voiceprints={voiceprints}
                            onRename={onRenameVoiceprint}
                            onDelete={onDeleteVoiceprint}
                            onRefresh={onRefreshVoiceprints}
                            isLoading={voiceprintsLoading}
                        />
                    </div>
                )}

                </div>

                {/* Footer - Fixed */}
                <div style={{ 
                    textAlign: 'right', 
                    padding: '1rem 1.5rem',
                    borderTop: '1px solid var(--glass-border-subtle)',
                    flexShrink: 0,
                }}>
                    <button
                        className="btn-capsule btn-capsule-primary"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1.5rem' }}
                    >
                        Готово
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SettingsModal;
