import React, { useState, useEffect, useRef } from 'react';
import { ModelState, OllamaModel, DiarizationStatus, HybridTranscriptionSettings } from '../types/models';
import { VoicePrint } from '../types/voiceprint';
import { HybridTranscriptionSettingsPanel } from './modules/HybridTranscriptionSettings';
import { VoiceprintsSettings } from './modules/VoiceprintsSettings';
import { ProvidersSettings } from './modules/ProvidersSettings';
import { Switch, Slider } from './common';
import { useProvidersContext } from '../context/ProvidersContext';
import { STT_PROVIDERS, STTProviderId } from '../types/providers';

// Секции настроек
type SettingsSection = 'appearance' | 'audio' | 'providers' | 'models' | 'diarization' | 'voiceprints' | 'about';

interface SettingsPageProps {
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
    ollamaContextSize: number;
    setOllamaContextSize: (size: number) => void;
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
    // Voiceprints
    voiceprints?: VoicePrint[];
    voiceprintsLoading?: boolean;
    onRenameVoiceprint?: (id: string, name: string) => void;
    onDeleteVoiceprint?: (id: string) => void;
    onRefreshVoiceprints?: () => void;
    // Версия
    appVersion?: string;
}

// Иконки для меню
const MenuIcons = {
    appearance: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
    ),
    audio: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
        </svg>
    ),
    models: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
    ),
    diarization: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
    ),
    hybrid: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
    ),
    voiceprints: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" />
        </svg>
    ),
    about: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
    ),
    providers: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
        </svg>
    ),
};

const menuItems: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
    { id: 'appearance', label: 'Внешний вид', icon: MenuIcons.appearance },
    { id: 'audio', label: 'Аудио', icon: MenuIcons.audio },
    { id: 'providers', label: 'Провайдеры', icon: MenuIcons.providers },
    { id: 'models', label: 'Модели', icon: MenuIcons.models },
    { id: 'diarization', label: 'Диаризация', icon: MenuIcons.diarization },
    { id: 'voiceprints', label: 'Голоса', icon: MenuIcons.voiceprints },
    { id: 'about', label: 'О программе', icon: MenuIcons.about },
];

export const SettingsPage: React.FC<SettingsPageProps> = ({
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
    ollamaContextSize,
    setOllamaContextSize,
    ollamaModels,
    ollamaModelsLoading,
    ollamaError,
    loadOllamaModels,
    onShowModelManager,
    activeModelId,
    models,
    diarizationStatus,
    diarizationLoading,
    diarizationError,
    segmentationModels = [],
    embeddingModels = [],
    onEnableDiarization,
    onDisableDiarization,
    hybridTranscription,
    onHybridTranscriptionChange,
    voiceprints = [],
    voiceprintsLoading = false,
    onRenameVoiceprint,
    onDeleteVoiceprint,
    onRefreshVoiceprints,
    appVersion = '2.0.6',
}) => {
    const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');
    const [selectedSegModel, setSelectedSegModel] = useState(
        segmentationModels.find((m) => m.recommended)?.id || segmentationModels[0]?.id || ''
    );
    const [selectedEmbModel, setSelectedEmbModel] = useState(
        embeddingModels.find((m) => m.recommended)?.id || embeddingModels[0]?.id || ''
    );

    // Хук для управления провайдерами STT/LLM (из общего контекста)
    const {
        sttSettings,
        updateSttProvider,
    } = useProvidersContext();

    const ollamaLoadedRef = useRef(false);

    useEffect(() => {
        if (isOpen && !ollamaLoadedRef.current && ollamaModels.length === 0 && !ollamaModelsLoading) {
            ollamaLoadedRef.current = true;
            loadOllamaModels();
        }
        if (!isOpen) {
            ollamaLoadedRef.current = false;
        }
    }, [isOpen, ollamaModels.length, ollamaModelsLoading, loadOllamaModels]);

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

    // Закрытие по Escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const activeModel = models.find((m) => m.id === activeModelId);
    const inputDevices = devices.filter((d) => d.isInput);

    const selectStyle: React.CSSProperties = {
        width: '100%',
        padding: '0.6rem 2.25rem 0.6rem 0.75rem',
        background: 'var(--glass-bg)',
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 0.75rem center',
        backgroundSize: '12px',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-primary)',
        fontSize: '0.9rem',
        fontFamily: 'inherit',
        cursor: 'pointer',
        transition: 'border-color var(--duration-fast)',
        minHeight: '40px',
        lineHeight: '1.4',
        WebkitAppearance: 'none' as const,
        MozAppearance: 'none' as const,
        appearance: 'none' as const,
    };

    const labelStyle: React.CSSProperties = {
        fontSize: '0.8rem',
        color: 'var(--text-secondary)',
        marginBottom: '0.35rem',
        display: 'block',
    };

    const sectionTitleStyle: React.CSSProperties = {
        fontSize: '1.5rem',
        fontWeight: 600,
        marginBottom: '1.5rem',
        color: 'var(--text-primary)',
    };

    const cardStyle: React.CSSProperties = {
        background: 'var(--glass-bg)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--glass-border-subtle)',
        padding: '1.25rem',
        marginBottom: '1rem',
    };

    // Рендер секций
    const renderAppearanceSection = () => (
        <div>
            <h2 style={sectionTitleStyle}>Внешний вид</h2>
            
            <div style={cardStyle}>
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>Тема оформления</label>
                    <select value={theme} onChange={(e) => setTheme(e.target.value as any)} style={selectStyle}>
                        <option value="system">Системная</option>
                        <option value="dark">Тёмная</option>
                        <option value="light">Светлая</option>
                    </select>
                </div>
                
                <div>
                    <label style={labelStyle}>Язык распознавания</label>
                    <select value={language} onChange={(e) => setLanguage(e.target.value as any)} style={selectStyle}>
                        <option value="ru">Русский</option>
                        <option value="en">English</option>
                        <option value="auto">Авто</option>
                    </select>
                </div>
            </div>
        </div>
    );

    const renderAudioSection = () => (
        <div>
            <h2 style={sectionTitleStyle}>Аудио</h2>
            
            <div style={cardStyle}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)' }}>
                    Устройства ввода
                </h3>
                
                <div style={{ marginBottom: '1.25rem' }}>
                    <label style={labelStyle}>Микрофон</label>
                    <select value={micDevice} onChange={(e) => setMicDevice(e.target.value)} style={selectStyle}>
                        <option value="">По умолчанию</option>
                        {inputDevices.map((d) => (
                            <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                    </select>
                </div>
                
                <div style={{ marginBottom: '1rem' }}>
                    <Switch
                        checked={captureSystem}
                        onChange={setCaptureSystem}
                        label="Записывать системный звук"
                        description={screenCaptureKitAvailable ? 'ScreenCaptureKit' : undefined}
                    />
                </div>
                
                {captureSystem && screenCaptureKitAvailable && (
                    <div style={{ marginLeft: '56px' }}>
                        <Switch
                            checked={useVoiceIsolation}
                            onChange={setUseVoiceIsolation}
                            label="Voice Isolation"
                            description="macOS 15+ для выделения речи"
                            size="sm"
                        />
                    </div>
                )}
            </div>
            
            <div style={cardStyle}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)' }}>
                    Обработка речи (VAD)
                </h3>
                
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>Режим обработки пауз</label>
                    <select value={vadMode} onChange={(e) => setVADMode(e.target.value as any)} style={selectStyle}>
                        <option value="auto">Авто (рекомендуется)</option>
                        <option value="per-region">Per-region (лучше для GigaAM)</option>
                        <option value="compression">Compression (лучше для Whisper)</option>
                        <option value="off">Выключен (30с чанки)</option>
                    </select>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.5rem', lineHeight: '1.4' }}>
                        Per-region: каждый фрагмент речи отдельно. Compression: склеивание фрагментов.
                    </p>
                </div>
                
                <div style={{ marginBottom: '1.5rem' }}>
                    <label style={labelStyle}>Метод детекции речи</label>
                    <select value={vadMethod} onChange={(e) => setVADMethod(e.target.value as any)} style={selectStyle}>
                        <option value="auto">Авто</option>
                        <option value="energy">Energy (быстрый)</option>
                        <option value="silero">Silero VAD (точный)</option>
                    </select>
                </div>
                
                <Slider
                    value={echoCancel}
                    onChange={setEchoCancel}
                    min={0}
                    max={1}
                    step={0.05}
                    label="Эхоподавление"
                    description="Уменьшает обратную связь от динамиков"
                    valueFormat={(v) => `${Math.round(v * 100)}%`}
                />
            </div>
        </div>
    );

    const renderProvidersSection = () => (
        <div>
            <h2 style={sectionTitleStyle}>Провайдеры</h2>
            <div style={cardStyle}>
                <ProvidersSettings />
            </div>
        </div>
    );

    const renderModelsSection = () => {
        // Группировка моделей по движку
        const transcriptionModels = models.filter(
            (m) => m.engine === 'whisper' || m.engine === 'gigaam' || m.engine === 'fluid-asr'
        );
        const downloadedModels = transcriptionModels.filter(
            (m) => m.status === 'downloaded' || m.status === 'active'
        );
        
        const getModelStatusBadge = (model: ModelState) => {
            const isActive = model.id === activeModelId;
            if (isActive) {
                return { text: 'Активна', color: 'var(--success)', bg: 'rgba(52, 211, 153, 0.15)' };
            }
            if (model.status === 'downloading') {
                return { text: `${model.progress || 0}%`, color: 'var(--primary)', bg: 'rgba(124, 58, 237, 0.15)' };
            }
            if (model.status === 'downloaded') {
                return { text: 'Готова', color: 'var(--text-secondary)', bg: 'var(--glass-bg)' };
            }
            return null;
        };
        
        const formatSize = (bytes: number) => {
            if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
            if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
            return `${bytes} B`;
        };
        
        const getModelVisual = (model: ModelState) => {
            if (model.engine === 'whisper') return { bg: '#10b981', label: 'W' };
            if (model.engine === 'gigaam') return { bg: '#3b82f6', label: 'G' };
            return { bg: '#8b5cf6', label: 'P' }; // Parakeet / CoreML
        };

        const isLocalMode = sttSettings.activeProvider === 'local';
        const cloudProviders: STTProviderId[] = ['openai', 'deepgram', 'groq'];
        
        return (
            <div>
                <h2 style={sectionTitleStyle}>Модели</h2>
                
                {/* Provider Mode Toggle */}
                <div style={cardStyle}>
                    <label style={{ ...labelStyle, marginBottom: '0.75rem' }}>Режим транскрибации</label>
                    <div
                        style={{
                            display: 'flex',
                            gap: '0.5rem',
                            padding: '0.25rem',
                            background: 'var(--glass-bg-elevated)',
                            borderRadius: 'var(--radius-md)',
                        }}
                    >
                        <button
                            onClick={() => updateSttProvider('local')}
                            style={{
                                flex: 1,
                                padding: '0.65rem 1rem',
                                border: 'none',
                                borderRadius: 'var(--radius-sm)',
                                background: isLocalMode ? 'var(--primary)' : 'transparent',
                                color: isLocalMode ? 'white' : 'var(--text-muted)',
                                fontWeight: isLocalMode ? 600 : 400,
                                cursor: 'pointer',
                                transition: 'all var(--duration-fast)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '0.5rem',
                                fontSize: '0.9rem',
                            }}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                                <line x1="8" y1="21" x2="16" y2="21"/>
                                <line x1="12" y1="17" x2="12" y2="21"/>
                            </svg>
                            Локально
                        </button>
                        <button
                            onClick={() => {
                                // Переключаемся на первый доступный облачный провайдер
                                const firstCloud = cloudProviders.find(p => STT_PROVIDERS[p]?.isCloud);
                                if (firstCloud) {
                                    updateSttProvider(firstCloud);
                                }
                            }}
                            style={{
                                flex: 1,
                                padding: '0.65rem 1rem',
                                border: 'none',
                                borderRadius: 'var(--radius-sm)',
                                background: !isLocalMode ? 'var(--primary)' : 'transparent',
                                color: !isLocalMode ? 'white' : 'var(--text-muted)',
                                fontWeight: !isLocalMode ? 600 : 400,
                                cursor: 'pointer',
                                transition: 'all var(--duration-fast)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '0.5rem',
                                fontSize: '0.9rem',
                            }}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
                            </svg>
                            Облако
                        </button>
                    </div>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0, marginTop: '0.75rem' }}>
                        {isLocalMode 
                            ? 'Транскрибация выполняется на вашем устройстве — приватность и офлайн-работа'
                            : 'Облачные сервисы — быстрее и точнее, требуется API-ключ'}
                    </p>
                </div>

                {/* Cloud Provider Selection */}
                {!isLocalMode && (
                    <div style={cardStyle}>
                        <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)' }}>
                            Облачный провайдер
                        </h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {cloudProviders.map((providerId) => {
                                const meta = STT_PROVIDERS[providerId];
                                const isSelected = sttSettings.activeProvider === providerId;
                                const isConfigured = 
                                    providerId === 'openai' ? sttSettings.openai?.apiKeySet :
                                    providerId === 'deepgram' ? sttSettings.deepgram?.apiKeySet :
                                    providerId === 'groq' ? sttSettings.groq?.apiKeySet :
                                    false;
                                
                                return (
                                    <div
                                        key={providerId}
                                        onClick={() => updateSttProvider(providerId)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            padding: '0.85rem 1rem',
                                            background: isSelected ? 'rgba(124, 58, 237, 0.1)' : 'var(--glass-bg)',
                                            border: isSelected ? '1px solid var(--primary)' : '1px solid var(--glass-border-subtle)',
                                            borderRadius: 'var(--radius-md)',
                                            cursor: 'pointer',
                                            transition: 'all var(--duration-fast)',
                                        }}
                                    >
                                        {/* Radio indicator */}
                                        <div
                                            style={{
                                                width: '18px',
                                                height: '18px',
                                                borderRadius: '50%',
                                                border: `2px solid ${isSelected ? 'var(--primary)' : 'var(--text-muted)'}`,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                flexShrink: 0,
                                            }}
                                        >
                                            {isSelected && (
                                                <div style={{
                                                    width: '10px',
                                                    height: '10px',
                                                    borderRadius: '50%',
                                                    background: 'var(--primary)',
                                                }} />
                                            )}
                                        </div>
                                        
                                        {/* Info */}
                                        <div style={{ flex: 1 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{meta.name}</span>
                                                {isConfigured && (
                                                    <span style={{
                                                        fontSize: '0.7rem',
                                                        padding: '0.15rem 0.4rem',
                                                        background: 'rgba(52, 199, 89, 0.15)',
                                                        color: 'var(--success)',
                                                        borderRadius: '4px',
                                                        fontWeight: 500,
                                                    }}>
                                                        API ✓
                                                    </span>
                                                )}
                                            </div>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                                {meta.description}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        
                        {!sttSettings.openai?.apiKeySet && !sttSettings.deepgram?.apiKeySet && !sttSettings.groq?.apiKeySet && (
                            <div style={{
                                marginTop: '1rem',
                                padding: '0.75rem',
                                background: 'rgba(251, 191, 36, 0.1)',
                                borderRadius: 'var(--radius-sm)',
                                border: '1px solid rgba(251, 191, 36, 0.2)',
                            }}>
                                <p style={{ 
                                    fontSize: '0.85rem', 
                                    color: 'var(--warning, #f59e0b)', 
                                    margin: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <circle cx="12" cy="12" r="10"/>
                                        <line x1="12" y1="8" x2="12" y2="12"/>
                                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                                    </svg>
                                    Требуется API-ключ. Добавьте его в расширенных настройках провайдеров.
                                </p>
                            </div>
                        )}
                    </div>
                )}
                
                {/* Local Models - show only in local mode */}
                {isLocalMode && (
                    <div style={cardStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                            <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                                Загруженные модели
                            </h3>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                {downloadedModels.length} из {transcriptionModels.length}
                            </span>
                        </div>
                        
                        {downloadedModels.length === 0 ? (
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>
                                Нет загруженных моделей. Нажмите «Добавить модель» ниже.
                            </p>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {downloadedModels.map((model) => {
                                    const badge = getModelStatusBadge(model);
                                    const isActive = model.id === activeModelId;
                                    const visual = getModelVisual(model);
                                    return (
                                        <div
                                            key={model.id}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.75rem',
                                                padding: '0.75rem',
                                                background: isActive ? 'rgba(124, 58, 237, 0.08)' : 'var(--glass-bg)',
                                                borderRadius: 'var(--radius-sm)',
                                                border: isActive ? '1px solid var(--primary)' : '1px solid var(--glass-border-subtle)',
                                                cursor: 'pointer',
                                                transition: 'all 0.15s ease',
                                            }}
                                            onClick={() => !isActive && onShowModelManager()}
                                        >
                                            {/* Model Icon */}
                                            <div style={{
                                                width: '36px',
                                                height: '36px',
                                                borderRadius: 'var(--radius-xs)',
                                                background: visual.bg,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                color: 'white',
                                                fontSize: '0.7rem',
                                                fontWeight: 700,
                                                flexShrink: 0,
                                            }}>
                                                {visual.label}
                                            </div>
                                            
                                            {/* Model Info */}
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ 
                                                    fontWeight: 600, 
                                                    color: 'var(--text-primary)',
                                                    fontSize: '0.9rem',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                }}>
                                                    {model.name}
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                    {model.engine} · {model.sizeBytes ? formatSize(model.sizeBytes) : ''}
                                                </div>
                                            </div>
                                            
                                            {/* Status Badge */}
                                            {badge && (
                                                <div style={{
                                                    padding: '0.25rem 0.5rem',
                                                    borderRadius: 'var(--radius-xs)',
                                                    fontSize: '0.7rem',
                                                    fontWeight: 600,
                                                    color: badge.color,
                                                    background: badge.bg,
                                                }}>
                                                    {badge.text}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        
                        <button
                            onClick={onShowModelManager}
                            className="btn-capsule"
                            style={{ width: '100%', marginTop: '1rem' }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '0.5rem' }}>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            Добавить модель
                        </button>
                    </div>
                )}
                
                {/* Ollama Models */}
                <div style={cardStyle}>
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)' }}>
                        Ollama (для сводки)
                    </h3>
                    
                    <div style={{ marginBottom: '1rem' }}>
                        <label style={labelStyle}>Модель Ollama</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <select
                                value={ollamaModel}
                                onChange={(e) => setOllamaModel(e.target.value)}
                                style={{ ...selectStyle, flex: 1 }}
                                disabled={ollamaModelsLoading}
                            >
                                {ollamaModels.length === 0 && <option value="">Нет моделей</option>}
                                {ollamaModels.map((m) => (
                                    <option key={m.name} value={m.name}>{m.name}</option>
                                ))}
                            </select>
                            <button
                                onClick={loadOllamaModels}
                                className="btn-icon"
                                disabled={ollamaModelsLoading}
                                title="Обновить список"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M23 4v6h-6M1 20v-6h6" />
                                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                </svg>
                            </button>
                        </div>
                        {ollamaError && (
                            <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                                {ollamaError}
                            </p>
                        )}
                    </div>
                    
                    {/* Context Size */}
                    <div>
                        <label style={labelStyle}>Размер контекста</label>
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {[4, 8, 16, 32, 64, 128, 256].map((size) => (
                                <button
                                    key={size}
                                    onClick={() => setOllamaContextSize(size)}
                                    style={{
                                        padding: '0.4rem 0.75rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: ollamaContextSize === size 
                                            ? '1px solid var(--primary)' 
                                            : '1px solid var(--glass-border)',
                                        background: ollamaContextSize === size 
                                            ? 'var(--primary)' 
                                            : 'transparent',
                                        color: ollamaContextSize === size 
                                            ? 'white' 
                                            : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        fontSize: '0.85rem',
                                        fontWeight: 500,
                                        transition: 'all 0.2s ease',
                                    }}
                                >
                                    {size}k
                                </button>
                            ))}
                        </div>
                        <p style={{ 
                            fontSize: '0.75rem', 
                            color: 'var(--text-muted)', 
                            marginTop: '0.5rem' 
                        }}>
                            Больший контекст позволяет анализировать длинные записи, но требует больше памяти
                        </p>
                    </div>
                </div>

                {/* Hybrid settings moved from separate section */}
                <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        {MenuIcons.hybrid}
                        <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                            Гибридное распознавание
                        </h3>
                    </div>
                    {hybridTranscription && onHybridTranscriptionChange ? (
                        <HybridTranscriptionSettingsPanel
                            settings={hybridTranscription}
                            onChange={onHybridTranscriptionChange}
                            availableModels={models}
                            currentModelId={activeModelId || ''}
                        />
                    ) : (
                        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                            Настройки гибридной транскрипции недоступны
                        </p>
                    )}
                </div>
            </div>
        );
    };

    const renderDiarizationSection = () => {
        const handleDiarizationToggle = (enabled: boolean) => {
            if (enabled) {
                onEnableDiarization?.(selectedSegModel, selectedEmbModel, 'coreml');
            } else {
                onDisableDiarization?.();
            }
        };
        
        return (
            <div>
                <h2 style={sectionTitleStyle}>Диаризация спикеров</h2>
                
                <div style={cardStyle}>
                    {/* FluidAudio Switch */}
                    <div style={{ marginBottom: '1.25rem' }}>
                        <Switch
                            checked={diarizationStatus?.enabled ?? false}
                            onChange={handleDiarizationToggle}
                            disabled={diarizationLoading}
                            label="FluidAudio диаризация"
                            description={diarizationStatus?.enabled 
                                ? `Активна (${diarizationStatus.provider || 'CoreML'})`
                                : 'Автоматическое разделение речи по спикерам'}
                        />
                    </div>
                    
                    {diarizationLoading && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.75rem',
                            background: 'rgba(124, 58, 237, 0.1)',
                            borderRadius: 'var(--radius-sm)',
                            marginBottom: '1rem',
                        }}>
                            <div
                                style={{
                                    width: '16px',
                                    height: '16px',
                                    border: '2px solid var(--primary)',
                                    borderTopColor: 'transparent',
                                    borderRadius: '50%',
                                    animation: 'spin 1s linear infinite',
                                }}
                            />
                            <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                                {diarizationStatus?.enabled ? 'Отключение...' : 'Загрузка моделей...'}
                            </span>
                        </div>
                    )}
                    
                    {diarizationError && (
                        <div style={{
                            padding: '0.75rem',
                            background: 'rgba(239, 68, 68, 0.1)',
                            borderRadius: 'var(--radius-sm)',
                            marginBottom: '1rem',
                        }}>
                            <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: 0 }}>
                                {diarizationError}
                            </p>
                        </div>
                    )}
                    
                    {/* Info about FluidAudio */}
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: '1.5', margin: 0 }}>
                        Использует модели FluidAudio (CoreML) для сегментации речи и создания 
                        эмбеддингов голосов. Модели загружаются автоматически при первом включении.
                    </p>
                </div>
                
                {/* Advanced Settings (collapsed by default) */}
                {!diarizationStatus?.enabled && (segmentationModels.length > 0 || embeddingModels.length > 0) && (
                    <details style={{ marginTop: '-0.5rem' }}>
                        <summary style={{
                            cursor: 'pointer',
                            fontSize: '0.85rem',
                            color: 'var(--text-muted)',
                            padding: '0.5rem 0',
                            userSelect: 'none',
                        }}>
                            Расширенные настройки моделей
                        </summary>
                        <div style={{ ...cardStyle, marginTop: '0.5rem' }}>
                            {segmentationModels.length > 0 && (
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={labelStyle}>Модель сегментации</label>
                                    <select
                                        value={selectedSegModel}
                                        onChange={(e) => setSelectedSegModel(e.target.value)}
                                        style={selectStyle}
                                    >
                                        {segmentationModels.map((m) => (
                                            <option key={m.id} value={m.id}>
                                                {m.name} {m.recommended && '(рекомендуется)'}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            
                            {embeddingModels.length > 0 && (
                                <div>
                                    <label style={labelStyle}>Модель эмбеддингов</label>
                                    <select
                                        value={selectedEmbModel}
                                        onChange={(e) => setSelectedEmbModel(e.target.value)}
                                        style={selectStyle}
                                    >
                                        {embeddingModels.map((m) => (
                                            <option key={m.id} value={m.id}>
                                                {m.name} {m.recommended && '(рекомендуется)'}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                    </details>
                )}
            </div>
        );
    };


    const renderVoiceprintsSection = () => (
        <div>
            <h2 style={sectionTitleStyle}>Сохранённые голоса</h2>
            
            <VoiceprintsSettings
                voiceprints={voiceprints}
                isLoading={voiceprintsLoading}
                onRename={onRenameVoiceprint || (() => {})}
                onDelete={onDeleteVoiceprint || (() => {})}
                onRefresh={onRefreshVoiceprints || (() => {})}
            />
        </div>
    );

    const renderAboutSection = () => (
        <div>
            <h2 style={sectionTitleStyle}>О программе</h2>
            
            <div style={cardStyle}>
                <div style={{ textAlign: 'center', padding: '2rem 0' }}>
                    <div style={{
                        width: '80px',
                        height: '80px',
                        margin: '0 auto 1rem',
                        borderRadius: 'var(--radius-lg)',
                        background: 'linear-gradient(135deg, var(--primary), var(--accent))',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '2rem',
                        color: 'white',
                        fontWeight: 700,
                    }}>
                        AI
                    </div>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
                        AIWisper
                    </h3>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                        Версия {appVersion}
                    </p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: '1.5' }}>
                        AI-транскрипция речи в текст с поддержкой<br />
                        Whisper, GigaAM и диаризации спикеров
                    </p>
                </div>
                
                <div style={{ borderTop: '1px solid var(--glass-border-subtle)', paddingTop: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Платформа</span>
                        <span style={{ color: 'var(--text-primary)' }}>macOS (Tauri)</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Активная модель</span>
                        <span style={{ color: 'var(--text-primary)' }}>{activeModel?.name || 'Не выбрана'}</span>
                    </div>
                </div>
            </div>
            
            <div style={cardStyle}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
                    Горячие клавиши
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {[
                        { keys: '⌘ R', desc: 'Начать/остановить запись' },
                        { keys: '⌘ ,', desc: 'Открыть настройки' },
                        { keys: '⌘ E', desc: 'Экспорт' },
                        { keys: 'Space', desc: 'Воспроизведение/пауза' },
                        { keys: 'Esc', desc: 'Закрыть окно' },
                    ].map(({ keys, desc }) => (
                        <div key={keys} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{desc}</span>
                            <kbd style={{
                                padding: '0.25rem 0.5rem',
                                background: 'var(--glass-bg-elevated)',
                                borderRadius: 'var(--radius-xs)',
                                fontSize: '0.8rem',
                                fontFamily: 'monospace',
                                color: 'var(--text-primary)',
                            }}>
                                {keys}
                            </kbd>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );

    const renderContent = () => {
        switch (activeSection) {
            case 'appearance': return renderAppearanceSection();
            case 'audio': return renderAudioSection();
            case 'providers': return renderProvidersSection();
            case 'models': return renderModelsSection();
            case 'diarization': return renderDiarizationSection();
            case 'voiceprints': return renderVoiceprintsSection();
            case 'about': return renderAboutSection();
            default: return null;
        }
    };

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1000,
                display: 'flex',
                background: 'var(--bg)',
            }}
        >
            {/* Sidebar */}
            <div
                style={{
                    width: '240px',
                    flexShrink: 0,
                    background: 'var(--sidebar-bg)',
                    borderRight: '1px solid var(--glass-border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    backdropFilter: 'blur(var(--glass-blur))',
                    WebkitBackdropFilter: 'blur(var(--glass-blur))',
                }}
            >
                {/* Header */}
                <div
                    style={{
                        height: '52px',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0 1rem',
                        borderBottom: '1px solid var(--glass-border-subtle)',
                        WebkitAppRegion: 'drag',
                    } as React.CSSProperties}
                >
                    <button
                        onClick={onClose}
                        className="btn-icon"
                        style={{ 
                            width: '28px', 
                            height: '28px',
                            WebkitAppRegion: 'no-drag',
                        } as React.CSSProperties}
                        title="Назад (Esc)"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M19 12H5M12 19l-7-7 7-7" />
                        </svg>
                    </button>
                    <span style={{ marginLeft: '0.75rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Настройки
                    </span>
                </div>
                
                {/* Menu */}
                <nav style={{ flex: 1, padding: '0.5rem', overflowY: 'auto' }}>
                    {menuItems.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => setActiveSection(item.id)}
                            style={{
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.75rem',
                                padding: '0.6rem 0.75rem',
                                border: 'none',
                                borderRadius: 'var(--radius-sm)',
                                background: activeSection === item.id ? 'var(--glass-bg-active)' : 'transparent',
                                color: activeSection === item.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                                cursor: 'pointer',
                                textAlign: 'left',
                                fontSize: '0.9rem',
                                fontFamily: 'inherit',
                                transition: 'all var(--duration-fast)',
                            }}
                            onMouseEnter={(e) => {
                                if (activeSection !== item.id) {
                                    e.currentTarget.style.background = 'var(--glass-bg-hover)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                if (activeSection !== item.id) {
                                    e.currentTarget.style.background = 'transparent';
                                }
                            }}
                        >
                            {item.icon}
                            {item.label}
                        </button>
                    ))}
                </nav>
            </div>
            
            {/* Content */}
            <div
                style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}
            >
                {/* Draggable header area */}
                <div
                    style={{
                        height: '52px',
                        flexShrink: 0,
                        WebkitAppRegion: 'drag',
                    } as React.CSSProperties}
                />
                
                {/* Scrollable content */}
                <div
                    style={{
                        flex: 1,
                        overflowY: 'auto',
                        padding: '0 2rem 2rem',
                    }}
                >
                    <div style={{ maxWidth: '600px' }}>
                        {renderContent()}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SettingsPage;
