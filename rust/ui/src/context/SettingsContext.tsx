import React, { createContext, useContext } from 'react';
import { useSettings, AppSettings } from '../hooks/useSettings';
import { HybridTranscriptionSettings, VADMode, VADMethod } from '../types/models';

interface SettingsContextType {
    settings: AppSettings;
    isLoaded: boolean;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    updateSettings: (updates: Partial<AppSettings>) => void;
    resetSettings: () => void;
    toggleTheme: () => void;
    
    // Удобные геттеры/сеттеры
    language: 'ru' | 'en' | 'auto';
    setLanguage: (v: 'ru' | 'en' | 'auto') => void;
    
    theme: 'light' | 'dark' | 'system';
    setTheme: (v: 'light' | 'dark' | 'system') => void;
    
    micDevice: string;
    setMicDevice: (v: string) => void;
    
    captureSystem: boolean;
    setCaptureSystem: (v: boolean) => void;
    
    useVoiceIsolation: boolean;
    setUseVoiceIsolation: (v: boolean) => void;
    
    echoCancel: number;
    setEchoCancel: (v: number) => void;
    
    // VAD настройки
    vadMode: VADMode;
    setVADMode: (v: VADMode) => void;
    
    vadMethod: VADMethod;
    setVADMethod: (v: VADMethod) => void;
    
    pauseThreshold: number;
    setPauseThreshold: (v: number) => void;
    
    enableStreaming: boolean;
    setEnableStreaming: (v: boolean) => void;
    
    streamingChunkSeconds: number;
    setStreamingChunkSeconds: (v: number) => void;
    
    streamingConfirmationThreshold: number;
    setStreamingConfirmationThreshold: (v: number) => void;
    
    ollamaModel: string;
    setOllamaModel: (v: string) => void;
    
    ollamaUrl: string;
    setOllamaUrl: (v: string) => void;
    
    ollamaContextSize: number;
    setOllamaContextSize: (v: number) => void;
    
    hybridTranscription: HybridTranscriptionSettings;
    setHybridTranscription: (v: HybridTranscriptionSettings) => void;
    
    // UI настройки
    showSessionStats: boolean;
    setShowSessionStats: (v: boolean) => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const settingsHook = useSettings();
    
    // Расширяем хук дополнительными геттерами/сеттерами
    const extendedValue: SettingsContextType = {
        ...settingsHook,
        
        // VAD настройки
        vadMode: settingsHook.settings.vadMode,
        setVADMode: (v) => settingsHook.updateSetting('vadMode', v),
        
        vadMethod: settingsHook.settings.vadMethod,
        setVADMethod: (v) => settingsHook.updateSetting('vadMethod', v),
        
        // UI настройки
        showSessionStats: settingsHook.settings.showSessionStats,
        setShowSessionStats: (v) => settingsHook.updateSetting('showSessionStats', v),
    };
    
    return (
        <SettingsContext.Provider value={extendedValue}>
            {children}
        </SettingsContext.Provider>
    );
};

export const useSettingsContext = () => {
    const context = useContext(SettingsContext);
    if (!context) {
        throw new Error('useSettingsContext must be used within a SettingsProvider');
    }
    return context;
};

// Re-export types
export type { AppSettings };
