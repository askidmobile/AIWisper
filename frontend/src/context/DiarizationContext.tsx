import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useWebSocketContext } from './WebSocketContext';
import { useModelContext } from './ModelContext';
import { DiarizationStatus, ModelState } from '../types/models';

// Ключ для localStorage
const DIARIZATION_SETTINGS_KEY = 'aiwisper_diarization';

interface DiarizationSettings {
    enabled: boolean;
    segModelId: string;
    embModelId: string;
    provider: string;
}

interface DiarizationContextType {
    // Статус
    status: DiarizationStatus;
    isLoading: boolean;
    error: string | null;

    // Модели диаризации
    segmentationModels: ModelState[];
    embeddingModels: ModelState[];
    
    // Сохранённые настройки
    savedSettings: DiarizationSettings | null;

    // Действия
    enableDiarization: (segModelId: string, embModelId: string, provider?: string) => void;
    disableDiarization: () => void;
    refreshStatus: () => void;
}

const DiarizationContext = createContext<DiarizationContextType | null>(null);

// Загрузка настроек из localStorage
const loadSettings = (): DiarizationSettings | null => {
    try {
        const saved = localStorage.getItem(DIARIZATION_SETTINGS_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load diarization settings:', e);
    }
    return null;
};

// Сохранение настроек в localStorage
const saveSettings = (settings: DiarizationSettings) => {
    try {
        localStorage.setItem(DIARIZATION_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save diarization settings:', e);
    }
};

export const DiarizationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { sendMessage, subscribe, isConnected } = useWebSocketContext();
    const { models, downloadModel } = useModelContext();

    const [status, setStatus] = useState<DiarizationStatus>({
        enabled: false,
        provider: '',
    });
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [savedSettings, setSavedSettings] = useState<DiarizationSettings | null>(loadSettings);
    const autoEnableAttempted = useRef(false);

    // Фильтруем модели диаризации
    const segmentationModels = models.filter(
        (m) => m.engine === 'diarization' && m.diarizationType === 'segmentation'
    );
    const embeddingModels = models.filter(
        (m) => m.engine === 'diarization' && m.diarizationType === 'embedding'
    );

    // Запрос статуса при подключении
    useEffect(() => {
        if (isConnected) {
            sendMessage({ type: 'get_diarization_status' });
        }
    }, [isConnected, sendMessage]);

    // Автоматическое включение диаризации при старте, если была включена
    useEffect(() => {
        // Детальная диагностика
        console.log('[Diarization] Auto-enable check:', {
            isConnected,
            autoEnableAttempted: autoEnableAttempted.current,
            savedSettingsEnabled: savedSettings?.enabled,
            modelsCount: models.length
        });
        
        if (!isConnected || autoEnableAttempted.current) return;
        if (!savedSettings?.enabled) {
            console.log('[Diarization] Auto-enable skipped: savedSettings.enabled is false');
            return;
        }
        
        // Ждём пока модели загрузятся
        if (models.length === 0) {
            console.log('[Diarization] Auto-enable waiting: models not loaded yet');
            return;
        }
        
        const segModel = models.find(m => m.id === savedSettings.segModelId);
        const embModel = models.find(m => m.id === savedSettings.embModelId);
        
        console.log('[Diarization] Models found:', {
            segModel: segModel ? { id: segModel.id, status: segModel.status, path: segModel.path } : null,
            embModel: embModel ? { id: embModel.id, status: embModel.status, path: embModel.path } : null
        });
        
        // Проверяем что модели существуют и скачаны
        if (!segModel || !embModel) {
            console.log('[Diarization] Auto-enable skipped: models not found');
            return;
        }
        if (segModel.status !== 'downloaded' && segModel.status !== 'active') {
            console.log('[Diarization] Auto-enable skipped: segModel not downloaded');
            return;
        }
        if (embModel.status !== 'downloaded' && embModel.status !== 'active') {
            console.log('[Diarization] Auto-enable skipped: embModel not downloaded');
            return;
        }
        if (!segModel.path || !embModel.path) {
            console.log('[Diarization] Auto-enable skipped: model paths missing');
            return;
        }
        
        // Отмечаем что попытка была
        autoEnableAttempted.current = true;
        
        console.log('[Diarization] Auto-enabling with settings:', savedSettings);
        setIsLoading(true);
        setError(null);
        
        sendMessage({
            type: 'enable_diarization',
            segmentationModelPath: segModel.path,
            embeddingModelPath: embModel.path,
            diarizationProvider: savedSettings.provider,
        });
    }, [isConnected, savedSettings, models, sendMessage]);

    // WebSocket обработчики
    useEffect(() => {
        const unsubEnabled = subscribe('diarization_enabled', (msg) => {
            console.log('[Diarization] Enabled successfully:', msg.diarizationProvider);
            setStatus({
                enabled: true,
                provider: msg.diarizationProvider || 'cpu',
            });
            setIsLoading(false);
            setError(null);
        });

        const unsubDisabled = subscribe('diarization_disabled', () => {
            setStatus({ enabled: false, provider: '' });
            setIsLoading(false);
        });

        const unsubStatus = subscribe('diarization_status', (msg) => {
            console.log('[Diarization] Status received:', { enabled: msg.diarizationEnabled, provider: msg.diarizationProvider });
            setStatus({
                enabled: msg.diarizationEnabled || false,
                provider: msg.diarizationProvider || '',
            });
        });

        const unsubError = subscribe('diarization_error', (msg) => {
            console.error('[Diarization] Error from backend:', msg.error);
            setError(msg.error || 'Ошибка диаризации');
            setIsLoading(false);
        });

        return () => {
            unsubEnabled();
            unsubDisabled();
            unsubStatus();
            unsubError();
        };
    }, [subscribe]);

    const enableDiarization = useCallback(
        (segModelId: string, embModelId: string, provider: string = 'auto') => {
            // Находим модели
            const segModel = segmentationModels.find((m) => m.id === segModelId);
            const embModel = embeddingModels.find((m) => m.id === embModelId);

            if (!segModel || !embModel) {
                setError('Модели не найдены');
                return;
            }

            // Проверяем что модели скачаны
            if (segModel.status !== 'downloaded' && segModel.status !== 'active') {
                setError('Сначала скачайте модель сегментации');
                downloadModel(segModelId);
                return;
            }
            if (embModel.status !== 'downloaded' && embModel.status !== 'active') {
                setError('Сначала скачайте модель эмбеддингов');
                downloadModel(embModelId);
                return;
            }

            if (!segModel.path || !embModel.path) {
                setError('Пути к моделям не найдены');
                return;
            }

            setIsLoading(true);
            setError(null);
            
            // Сохраняем настройки в localStorage
            const settings: DiarizationSettings = {
                enabled: true,
                segModelId,
                embModelId,
                provider,
            };
            saveSettings(settings);
            setSavedSettings(settings);

            sendMessage({
                type: 'enable_diarization',
                segmentationModelPath: segModel.path,
                embeddingModelPath: embModel.path,
                diarizationProvider: provider,
            });
        },
        [segmentationModels, embeddingModels, sendMessage, downloadModel]
    );

    const disableDiarization = useCallback(() => {
        setIsLoading(true);
        
        // Обновляем сохранённые настройки - отключаем
        if (savedSettings) {
            const settings: DiarizationSettings = {
                ...savedSettings,
                enabled: false,
            };
            saveSettings(settings);
            setSavedSettings(settings);
        }
        
        sendMessage({ type: 'disable_diarization' });
    }, [sendMessage, savedSettings]);

    const refreshStatus = useCallback(() => {
        sendMessage({ type: 'get_diarization_status' });
    }, [sendMessage]);

    return (
        <DiarizationContext.Provider
            value={{
                status,
                isLoading,
                error,
                segmentationModels,
                embeddingModels,
                savedSettings,
                enableDiarization,
                disableDiarization,
                refreshStatus,
            }}
        >
            {children}
        </DiarizationContext.Provider>
    );
};

export const useDiarizationContext = () => {
    const context = useContext(DiarizationContext);
    if (!context) {
        throw new Error('useDiarizationContext must be used within a DiarizationProvider');
    }
    return context;
};
