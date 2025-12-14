import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useWebSocketContext } from './WebSocketContext';
import { useModelContext } from './ModelContext';
import { DiarizationStatus, ModelState } from '../types/models';

// Electron IPC для настроек
const electron = typeof window !== 'undefined' && (window as any).require ? (window as any).require('electron') : null;
const ipcRenderer = electron?.ipcRenderer;

// Ключ для localStorage (fallback)
const SETTINGS_KEY = 'aiwisper_settings';

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

// Загрузка настроек диаризации из общих настроек приложения
const loadDiarizationSettings = async (): Promise<DiarizationSettings | null> => {
    try {
        let settings: any = null;
        
        if (ipcRenderer) {
            settings = await ipcRenderer.invoke('load-settings');
        } else {
            const saved = localStorage.getItem(SETTINGS_KEY);
            if (saved) {
                settings = JSON.parse(saved);
            }
        }
        
        if (settings && settings.diarizationEnabled !== undefined) {
            return {
                enabled: settings.diarizationEnabled,
                segModelId: settings.diarizationSegModelId || '',
                embModelId: settings.diarizationEmbModelId || '',
                provider: settings.diarizationProvider || 'auto',
            };
        }
    } catch (e) {
        console.error('Failed to load diarization settings:', e);
    }
    return null;
};

// Сохранение настроек диаризации в общие настройки приложения
const saveDiarizationSettings = async (diarSettings: DiarizationSettings) => {
    try {
        let currentSettings: any = {};
        
        if (ipcRenderer) {
            currentSettings = await ipcRenderer.invoke('load-settings') || {};
            const updated = {
                ...currentSettings,
                diarizationEnabled: diarSettings.enabled,
                diarizationSegModelId: diarSettings.segModelId,
                diarizationEmbModelId: diarSettings.embModelId,
                diarizationProvider: diarSettings.provider,
            };
            await ipcRenderer.invoke('save-settings', updated);
        } else {
            const saved = localStorage.getItem(SETTINGS_KEY);
            if (saved) {
                currentSettings = JSON.parse(saved);
            }
            const updated = {
                ...currentSettings,
                diarizationEnabled: diarSettings.enabled,
                diarizationSegModelId: diarSettings.segModelId,
                diarizationEmbModelId: diarSettings.embModelId,
                diarizationProvider: diarSettings.provider,
            };
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
        }
    } catch (e) {
        console.error('Failed to save diarization settings:', e);
    }
};

export const DiarizationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { sendMessage, subscribe, isConnected } = useWebSocketContext();
    const { models, downloadModel, backendModelConfirmed, activeModelId } = useModelContext();

    const [status, setStatus] = useState<DiarizationStatus>({
        enabled: false,
        provider: '',
    });
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [savedSettings, setSavedSettings] = useState<DiarizationSettings | null>(null);
    const autoEnableAttempted = useRef(false);
    const settingsLoaded = useRef(false);

    // Фильтруем модели диаризации
    const segmentationModels = models.filter(
        (m) => m.engine === 'diarization' && m.diarizationType === 'segmentation'
    );
    const embeddingModels = models.filter(
        (m) => m.engine === 'diarization' && m.diarizationType === 'embedding'
    );

    // Загрузка настроек при старте
    useEffect(() => {
        if (settingsLoaded.current) return;
        settingsLoaded.current = true;
        
        loadDiarizationSettings().then(settings => {
            console.log('[Diarization] Loaded settings:', settings);
            setSavedSettings(settings);
        });
    }, []);

    // Запрос статуса при подключении и сброс флагов при отключении
    useEffect(() => {
        if (isConnected) {
            sendMessage({ type: 'get_diarization_status' });
        } else {
            // Сбрасываем флаги при отключении для корректного переподключения
            autoEnableAttempted.current = false;
        }
    }, [isConnected, sendMessage]);

    // Автоматическое включение диаризации при старте, если была включена
    useEffect(() => {
        if (!isConnected || autoEnableAttempted.current || !savedSettings) return;
        
        console.log('[Diarization] Auto-enable check:', {
            isConnected,
            autoEnableAttempted: autoEnableAttempted.current,
            savedSettingsEnabled: savedSettings?.enabled,
            provider: savedSettings?.provider,
            modelsCount: models.length,
            backendModelConfirmed,
            activeModelId
        });
        
        if (!savedSettings.enabled) {
            console.log('[Diarization] Auto-enable skipped: savedSettings.enabled is false');
            return;
        }
        
        // Ждём подтверждения от backend, что модель транскрипции действительно загружена
        // (не просто из localStorage, а реально активна на backend)
        if (!backendModelConfirmed) {
            console.log('[Diarization] Auto-enable waiting: backend model not confirmed yet');
            return;
        }
        
        // FluidAudio (coreml) не требует моделей диаризации - они скачиваются автоматически
        if (savedSettings.provider === 'coreml') {
            autoEnableAttempted.current = true;
            console.log('[Diarization] Auto-enabling FluidAudio (coreml)...');
            setIsLoading(true);
            setError(null);
            
            sendMessage({
                type: 'enable_diarization',
                segmentationModelPath: '',
                embeddingModelPath: '',
                diarizationProvider: 'coreml',
            });
            return;
        }
        
        // Для Sherpa-ONNX нужны модели
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
    }, [isConnected, savedSettings, models, sendMessage, backendModelConfirmed, activeModelId]);

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
            setIsLoading(true);
            setError(null);
            
            // FluidAudio (coreml) не требует моделей - они скачиваются автоматически
            if (provider === 'coreml') {
                console.log('[Diarization] Enabling FluidAudio (coreml)...');
                
                // Сохраняем настройки
                const settings: DiarizationSettings = {
                    enabled: true,
                    segModelId: '',
                    embModelId: '',
                    provider: 'coreml',
                };
                saveDiarizationSettings(settings);
                setSavedSettings(settings);

                sendMessage({
                    type: 'enable_diarization',
                    segmentationModelPath: '',
                    embeddingModelPath: '',
                    diarizationProvider: 'coreml',
                });
                return;
            }
            
            // Для Sherpa-ONNX нужны модели
            const segModel = segmentationModels.find((m) => m.id === segModelId);
            const embModel = embeddingModels.find((m) => m.id === embModelId);

            if (!segModel || !embModel) {
                setError('Модели не найдены');
                setIsLoading(false);
                return;
            }

            // Проверяем что модели скачаны
            if (segModel.status !== 'downloaded' && segModel.status !== 'active') {
                setError('Сначала скачайте модель сегментации');
                downloadModel(segModelId);
                setIsLoading(false);
                return;
            }
            if (embModel.status !== 'downloaded' && embModel.status !== 'active') {
                setError('Сначала скачайте модель эмбеддингов');
                downloadModel(embModelId);
                setIsLoading(false);
                return;
            }

            if (!segModel.path || !embModel.path) {
                setError('Пути к моделям не найдены');
                setIsLoading(false);
                return;
            }

            // Сохраняем настройки
            const settings: DiarizationSettings = {
                enabled: true,
                segModelId,
                embModelId,
                provider,
            };
            saveDiarizationSettings(settings);
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
            saveDiarizationSettings(settings);
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
