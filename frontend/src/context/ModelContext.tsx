import React, { createContext, useContext, useEffect, useState } from 'react';
import { useWebSocketContext } from './WebSocketContext';
import { ModelState, OllamaModel } from '../types/models';

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

    // Initial fetch
    useEffect(() => {
        if (isConnected) {
            sendMessage({ type: 'get_models' });
        }
    }, [isConnected, sendMessage]);

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

        const unsubActive = subscribe('active_model_changed', (msg) => setActiveModelId(msg.modelId));

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
    const setActiveModel = (id: string) => sendMessage({ type: 'set_active_model', modelId: id });
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
