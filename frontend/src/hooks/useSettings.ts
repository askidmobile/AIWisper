import { useState, useEffect, useCallback } from 'react';
import { HybridTranscriptionSettings } from '../types/models';

// Electron IPC
const electron = typeof window !== 'undefined' && (window as any).require ? (window as any).require('electron') : null;
const ipcRenderer = electron?.ipcRenderer;

export interface AppSettings {
    // Язык и модель
    language: 'ru' | 'en' | 'auto';
    modelId: string | null;
    
    // Аудио настройки
    micDevice: string;
    captureSystem: boolean;
    useVoiceIsolation: boolean;
    echoCancel: number;
    
    // VAD настройки
    vadMode: 'auto' | 'compression' | 'per-region' | 'off';
    vadMethod: 'auto' | 'energy' | 'silero';
    pauseThreshold: number;
    
    // Streaming настройки
    enableStreaming: boolean;
    streamingChunkSeconds: number;
    streamingConfirmationThreshold: number;
    
    // Ollama настройки
    ollamaModel: string;
    ollamaUrl: string;
    
    // Тема
    theme: 'light' | 'dark';
    
    // Диаризация
    diarizationEnabled: boolean;
    diarizationSegModelId: string;
    diarizationEmbModelId: string;
    diarizationProvider: string;
    
    // UI настройки
    showSessionStats: boolean;
    
    // Гибридная транскрипция
    hybridTranscription: HybridTranscriptionSettings;
}

const defaultSettings: AppSettings = {
    language: 'ru',
    modelId: 'ggml-large-v3-turbo',
    micDevice: '',
    captureSystem: true,
    useVoiceIsolation: false,
    echoCancel: 0.4,
    vadMode: 'auto',
    vadMethod: 'auto',
    pauseThreshold: 0.5,
    enableStreaming: false,
    streamingChunkSeconds: 15,
    streamingConfirmationThreshold: 0.85,
    ollamaModel: 'llama3.2',
    ollamaUrl: 'http://localhost:11434',
    theme: 'dark',
    diarizationEnabled: false,
    diarizationSegModelId: '',
    diarizationEmbModelId: '',
    diarizationProvider: 'auto',
    showSessionStats: true,
    hybridTranscription: {
        enabled: false,
        secondaryModelId: '',
        confidenceThreshold: 0.7,
        contextWords: 3,
        useLLMForMerge: true,
        mode: 'full_compare',
    },
};

export const useSettings = () => {
    const [settings, setSettings] = useState<AppSettings>(defaultSettings);
    const [isLoaded, setIsLoaded] = useState(false);

    // Загрузка настроек при старте
    useEffect(() => {
        const loadSettings = async () => {
            if (!ipcRenderer) {
                // Fallback для localStorage если нет Electron
                try {
                    const saved = localStorage.getItem('aiwisper_settings');
                    if (saved) {
                        const parsed = JSON.parse(saved);
                        setSettings(prev => ({ ...prev, ...parsed }));
                    }
                } catch (e) {
                    console.error('Failed to load settings from localStorage:', e);
                }
                setIsLoaded(true);
                return;
            }
            
            try {
                const loaded = await ipcRenderer.invoke('load-settings');
                if (loaded) {
                    setSettings(prev => ({ ...prev, ...loaded }));
                }
                setIsLoaded(true);
            } catch (err) {
                console.error('Failed to load settings:', err);
                setIsLoaded(true);
            }
        };
        loadSettings();
    }, []);

    // Сохранение настроек при изменении
    useEffect(() => {
        if (!isLoaded) return;
        
        const saveSettings = async () => {
            if (!ipcRenderer) {
                // Fallback для localStorage
                try {
                    localStorage.setItem('aiwisper_settings', JSON.stringify(settings));
                } catch (e) {
                    console.error('Failed to save settings to localStorage:', e);
                }
                return;
            }
            
            try {
                await ipcRenderer.invoke('save-settings', settings);
            } catch (err) {
                console.error('Failed to save settings:', err);
            }
        };
        saveSettings();
    }, [settings, isLoaded]);

    // Применяем тему к документу
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', settings.theme);
        document.body.setAttribute('data-theme', settings.theme);
    }, [settings.theme]);

    // Функция для обновления отдельных настроек
    const updateSetting = useCallback(<K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K]
    ) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    }, []);

    // Функция для обновления нескольких настроек сразу
    const updateSettings = useCallback((updates: Partial<AppSettings>) => {
        setSettings(prev => ({ ...prev, ...updates }));
    }, []);

    // Функция для сброса настроек
    const resetSettings = useCallback(() => {
        setSettings(defaultSettings);
    }, []);

    // Переключение темы
    const toggleTheme = useCallback(() => {
        setSettings(prev => ({
            ...prev,
            theme: prev.theme === 'dark' ? 'light' : 'dark'
        }));
    }, []);

    return {
        settings,
        isLoaded,
        updateSetting,
        updateSettings,
        resetSettings,
        toggleTheme,
        
        // Удобные геттеры для часто используемых настроек
        language: settings.language,
        setLanguage: (v: 'ru' | 'en' | 'auto') => updateSetting('language', v),
        
        theme: settings.theme,
        setTheme: (v: 'light' | 'dark') => updateSetting('theme', v),
        
        micDevice: settings.micDevice,
        setMicDevice: (v: string) => updateSetting('micDevice', v),
        
        captureSystem: settings.captureSystem,
        setCaptureSystem: (v: boolean) => updateSetting('captureSystem', v),
        
        useVoiceIsolation: settings.useVoiceIsolation,
        setUseVoiceIsolation: (v: boolean) => updateSetting('useVoiceIsolation', v),
        
        echoCancel: settings.echoCancel,
        setEchoCancel: (v: number) => updateSetting('echoCancel', v),
        
        pauseThreshold: settings.pauseThreshold,
        setPauseThreshold: (v: number) => updateSetting('pauseThreshold', v),
        
        enableStreaming: settings.enableStreaming,
        setEnableStreaming: (v: boolean) => updateSetting('enableStreaming', v),
        
        streamingChunkSeconds: settings.streamingChunkSeconds,
        setStreamingChunkSeconds: (v: number) => updateSetting('streamingChunkSeconds', v),
        
        streamingConfirmationThreshold: settings.streamingConfirmationThreshold,
        setStreamingConfirmationThreshold: (v: number) => updateSetting('streamingConfirmationThreshold', v),
        
        ollamaModel: settings.ollamaModel,
        setOllamaModel: (v: string) => updateSetting('ollamaModel', v),
        
        ollamaUrl: settings.ollamaUrl,
        setOllamaUrl: (v: string) => updateSetting('ollamaUrl', v),
        
        hybridTranscription: settings.hybridTranscription,
        setHybridTranscription: (v: HybridTranscriptionSettings) => updateSetting('hybridTranscription', v),
    };
};
