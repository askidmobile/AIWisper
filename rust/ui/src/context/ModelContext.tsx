import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { useBackendContext } from './BackendContext';
import { ModelState, OllamaModel } from '../types/models';

interface ModelContextType {
    models: ModelState[];
    activeModelId: string | null;
    // Флаг подтверждения модели от backend (не из localStorage)
    // Используется для ожидания реальной загрузки модели перед включением диаризации
    backendModelConfirmed: boolean;
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
    const { sendMessage, subscribe, isConnected } = useBackendContext();
    const [models, setModels] = useState<ModelState[]>([]);
    const [activeModelId, setActiveModelId] = useState<string | null>(null);
    // Флаг подтверждения модели от backend (не из localStorage)
    const [backendModelConfirmed, setBackendModelConfirmed] = useState(false);
    const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
    const [ollamaError, setOllamaError] = useState<string | null>(null);
    const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
    const settingsLoaded = useRef(false);

    // Загрузка настроек с backend при подключении
    useEffect(() => {
        if (!isConnected || settingsLoaded.current) return;
        settingsLoaded.current = true;
        
        const loadSettings = async () => {
            try {
                const result = await sendMessage({ type: 'get_settings' });
                console.log('[Model] Loaded settings from backend:', result);
                // Settings содержит whisperModel (snake_case от backend преобразуется в whisper_model)
                const modelId = result?.whisperModel || result?.whisper_model;
                if (modelId) {
                    console.log('[Model] Setting active model from backend settings:', modelId);
                    setActiveModelId(modelId);
                }
            } catch (e) {
                console.error('[Model] Failed to load settings:', e);
            }
        };
        loadSettings();
    }, [isConnected, sendMessage]);

    // Initial fetch
    useEffect(() => {
        console.log('[Model] isConnected changed to:', isConnected);
        if (isConnected) {
            const fetchModels = async () => {
                console.log('[Model] Fetching models...');
                try {
                    const result = await sendMessage({ type: 'get_models' });
                    console.log('[Model] Result from sendMessage:', result);
                    console.log('[Model] Result type:', typeof result);
                    console.log('[Model] Result keys:', result ? Object.keys(result) : 'null');
                    // For Tauri, result is returned directly
                    if (result && result.models) {
                        console.log('[Model] Setting models from direct result:', result.models.length, 'models');
                        console.log('[Model] Downloaded models:', result.models.filter((m: any) => m.status === 'downloaded').map((m: any) => m.id));
                        setModels(result.models);
                    } else {
                        console.warn('[Model] No models in result, result was:', result);
                    }
                } catch (err) {
                    console.error('[Model] Error fetching models:', err);
                }
            };
            fetchModels();
        }
    }, [isConnected, sendMessage]);

    // Активация сохранённой модели после загрузки списка моделей
    useEffect(() => {
        if (!isConnected || models.length === 0 || !activeModelId) return;
        
        const savedModel = models.find(m => m.id === activeModelId);
        if (savedModel && (savedModel.status === 'downloaded' || savedModel.status === 'active')) {
            console.log('[Model] Confirming active model with backend:', activeModelId);
            // Отправляем backend команду активации сохранённой модели
            sendMessage({ type: 'set_active_model', modelId: activeModelId });
        }
    }, [isConnected, models]); // Не включаем activeModelId и sendMessage в deps чтобы срабатывало только при загрузке моделей

    // Сброс флага при отключении WebSocket
    useEffect(() => {
        if (!isConnected) {
            setBackendModelConfirmed(false);
        }
    }, [isConnected]);

    // WebSocket Handlers
    useEffect(() => {
        const unsubList = subscribe('models_list', (msg: any) => {
            console.log('[Model] models_list event received:', msg);
            console.log('[Model] Downloaded models from event:', (msg.models || []).filter((m: any) => m.status === 'downloaded').map((m: any) => m.id));
            setModels(msg.models || []);
            const active = (msg.models || []).find((m: ModelState) => m.status === 'active');
            if (active) {
                console.log('[Model] Backend confirmed active model from models_list:', active.id);
                setBackendModelConfirmed(true);
                setActiveModelId(active.id);
            }
        });

        const unsubProgress = subscribe('model_progress', (msg: any) => {
            setModels(prev => prev.map(m =>
                m.id === msg.modelId
                    ? { ...m, status: msg.data, progress: msg.progress, error: msg.error }
                    : m
            ));
        });

        const unsubActive = subscribe('active_model_changed', (msg: any) => {
            console.log('[Model] Backend confirmed active model changed:', msg.modelId);
            setBackendModelConfirmed(true);
            setActiveModelId(msg.modelId);
            // Настройки сохраняются на backend автоматически
        });

        const unsubDeleted = subscribe('model_deleted', () => sendMessage({ type: 'get_models' }));

        const unsubOllama = subscribe('ollama_models', (msg: any) => {
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
    const fetchOllamaModels = async (url: string) => {
        setOllamaModelsLoading(true);
        setOllamaError(null);
        try {
            // For Tauri, sendMessage returns the result directly
            const result = await sendMessage({ type: 'get_ollama_models', url });
            if (result && Array.isArray(result)) {
                // Convert to OllamaModel format
                const ollamaModels: OllamaModel[] = result.map((m: any) => ({
                    name: m.name || m.id,
                    size: m.sizeBytes || m.size || 0,
                    isCloud: false,
                    family: '',
                    parameters: '',
                }));
                setOllamaModels(ollamaModels);
            } else {
                // Legacy WebSocket response handling via subscribe
            }
        } catch (error: any) {
            setOllamaError(error.message || 'Failed to fetch Ollama models');
        } finally {
            setOllamaModelsLoading(false);
        }
    };

    return (
        <ModelContext.Provider value={{
            models, activeModelId, backendModelConfirmed, ollamaModels, ollamaError, ollamaModelsLoading,
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
