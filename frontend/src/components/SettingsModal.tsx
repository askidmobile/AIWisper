import React from 'react';
import { ModelState, OllamaModel } from '../types/models';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    devices: { id: string; name: string; isInput: boolean }[];
    micDevice: string;
    setMicDevice: (id: string) => void;
    captureSystem: boolean;
    setCaptureSystem: (v: boolean) => void;
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
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    onClose,
    devices,
    micDevice,
    setMicDevice,
    captureSystem,
    setCaptureSystem,
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
}) => {
    if (!isOpen) return null;

    const activeModel = models.find((m) => m.id === activeModelId);
    const inputDevices = devices.filter((d) => d.isInput);

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
                    padding: '1.5rem',
                    width: '480px',
                    maxHeight: '85vh',
                    overflowY: 'auto',
                    boxShadow: 'var(--shadow-elevated)',
                    border: '1px solid var(--glass-border)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '1.5rem',
                        paddingBottom: '1rem',
                        borderBottom: '1px solid var(--glass-border-subtle)',
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

                {/* Footer */}
                <div style={{ textAlign: 'right', paddingTop: '0.5rem' }}>
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
