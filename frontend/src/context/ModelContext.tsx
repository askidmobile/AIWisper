import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { useWebSocketContext } from './WebSocketContext';
import { ModelState, OllamaModel } from '../types/models';

// Electron IPC для настроек
const electron = typeof window !== 'undefined' && (window as any).require ? (window as any).require('electron') : null;
const ipcRenderer = electron?.ipcRenderer;

// Ключ для localStorage (fallback)
const SETTINGS_KEY = 'aiwisper_settings';

// Загрузка сохранённой модели
const loadSavedModelId = async (): Promise<string | null> => {
    try {
        if (ipcRenderer) {
            const settings = await ipcRenderer.invoke('load-settings');
            return settings?.modelId || null;
        } else {
            const saved = localStorage.getItem(SETTINGS_KEY);
            if (saved) {
                const settings = JSON.parse(saved);
                return settings?.modelId || null;
            }
        }
    } catch (e) {
        console.error('Failed to load saved model:', e);
    }
    return null;
};

// Сохранение активной модели
const saveModelId = async (modelId: string) => {
    try {
        if (ipcRenderer) {
            const settings = await ipcRenderer.invoke('load-settings') || {};
            await ipcRenderer.invoke('save-settings', { ...settings, modelId });
        } else {
            const saved = localStorage.getItem(SETTINGS_KEY);
            const settings = saved ? JSON.parse(saved) : {};
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, modelId }));
        }
    } catch (e) {
        console.error('Failed to save model:', e);
    }
};

interface ModelContextType {
    models: ModelState[];
    activeModelId: string | null;
    ollamaModels: OllamaModel[];
    ollamaError: string | null;
    ollamaModelsLoading: boolean;

    // Actions
    downloadModel: (id: string) => void;
    cancelDownload: (id: string) => void;
    deleteModel: (id: string) => void;
    setActiveModel: (id: string) => void;
    fetchOllamaModels: (url: string) => void;
}

const ModelContext = createContext<ModelContextType | null>(null);

export const ModelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { sendMessage, subscribe, isConnected } = useWebSocketContext();
    const [models, setModels] = useState<ModelState[]>([]);
    const [activeModelId, setActiveModelId] = useState<string | null>(null);
    const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
    const [ollamaError, setOllamaError] = useState<string | null>(null);
    const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
    const savedModelLoaded = useRef(false);
    const savedModelId = useRef<string | null>(null);

    // Загрузка сохранённой модели при старте
    useEffect(() => {
        if (savedModelLoaded.current) return;
        savedModelLoaded.current = true;
        
        loadSavedModelId().then(modelId => {
            console.log('[Model] Loaded saved model:', modelId);
            savedModelId.current = modelId;
            if (modelId) {
                setActiveModelId(modelId);
            }
        });
    }, []);

    // Initial fetch
    useEffect(() => {
        if (isConnected) {
            sendMessage({ type: 'get_models' });
        }
    }, [isConnected, sendMessage]);

    // Активация сохранённой модели после загрузки списка моделей
    useEffect(() => {
        if (!isConnected || models.length === 0 || !savedModelId.current) return;
        
        const savedModel = models.find(m => m.id === savedModelId.current);
        if (savedModel && (savedModel.status === 'downloaded' || savedModel.status === 'active')) {
            console.log('[Model] Activating saved model:', savedModelId.current);
            sendMessage({ type: 'set_active_model', modelId: savedModelId.current });
            savedModelId.current = null; // Сбрасываем чтобы не активировать повторно
        }
    }, [isConnected, models, sendMessage]);

    // WebSocket Handlers
    useEffect(() => {
        const unsubList = subscribe('models_list', (msg) => {
            setModels(msg.models || []);
            const active = (msg.models || []).find((m: ModelState) => m.status === 'active');
            if (active) {
                setActiveModelId(active.id);
            }
        });

        const unsubProgress = subscribe('model_progress', (msg) => {
            setModels(prev => prev.map(m =>
                m.id === msg.modelId
                    ? { ...m, status: msg.data, progress: msg.progress, error: msg.error }
                    : m
            ));
        });

        const unsubActive = subscribe('active_model_changed', (msg) => {
            console.log('[Model] Active model changed:', msg.modelId);
            setActiveModelId(msg.modelId);
            // Сохраняем в настройки
            if (msg.modelId) {
                saveModelId(msg.modelId);
            }
        });

        const unsubDeleted = subscribe('model_deleted', () => sendMessage({ type: 'get_models' }));

        const unsubOllama = subscribe('ollama_models', (msg) => {
            setOllamaModelsLoading(false);
            if (msg.error) {
                setOllamaError(msg.error);
                setOllamaModels([]);
            } else {
                setOllamaError(null);
                setOllamaModels(msg.ollamaModels || []);
            }
        });

        return () => {
            unsubList(); unsubProgress(); unsubActive(); unsubDeleted(); unsubOllama();
        };
    }, [subscribe, sendMessage]);

    const downloadModel = (id: string) => sendMessage({ type: 'download_model', modelId: id });
    const cancelDownload = (id: string) => sendMessage({ type: 'cancel_download', modelId: id });
    const deleteModel = (id: string) => sendMessage({ type: 'delete_model', modelId: id });
    const setActiveModel = (id: string) => {
        sendMessage({ type: 'set_active_model', modelId: id });
    };
    const fetchOllamaModels = (url: string) => {
        setOllamaModelsLoading(true);
        sendMessage({ type: 'get_ollama_models', ollamaUrl: url });
    };

    return (
        <ModelContext.Provider value={{
            models, activeModelId, ollamaModels, ollamaError, ollamaModelsLoading,
            downloadModel, cancelDownload, deleteModel, setActiveModel, fetchOllamaModels
        }}>
            {children}
        </ModelContext.Provider>
    );
};

export const useModelContext = () => {
    const context = useContext(ModelContext);
    if (!context) throw new Error('useModelContext must be used within a ModelProvider');
    return context;
};
