import React, { createContext, useContext } from 'react';
import { useSettings, AppSettings } from '../hooks/useSettings';
import { HybridTranscriptionSettings } from '../types/models';

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
    
    theme: 'light' | 'dark';
    setTheme: (v: 'light' | 'dark') => void;
    
    micDevice: string;
    setMicDevice: (v: string) => void;
    
    captureSystem: boolean;
    setCaptureSystem: (v: boolean) => void;
    
    useVoiceIsolation: boolean;
    setUseVoiceIsolation: (v: boolean) => void;
    
    echoCancel: number;
    setEchoCancel: (v: number) => void;
    
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
    
    hybridTranscription: HybridTranscriptionSettings;
    setHybridTranscription: (v: HybridTranscriptionSettings) => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const settingsHook = useSettings();
    
    return (
        <SettingsContext.Provider value={settingsHook}>
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
