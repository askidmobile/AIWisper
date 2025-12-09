import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useWebSocketContext } from './WebSocketContext';
import { useModelContext } from './ModelContext';
import { DiarizationStatus, ModelState } from '../types/models';

interface DiarizationContextType {
    // Статус
    status: DiarizationStatus;
    isLoading: boolean;
    error: string | null;

    // Модели диаризации
    segmentationModels: ModelState[];
    embeddingModels: ModelState[];

    // Действия
    enableDiarization: (segModelId: string, embModelId: string, provider?: string) => void;
    disableDiarization: () => void;
    refreshStatus: () => void;
}

const DiarizationContext = createContext<DiarizationContextType | null>(null);

export const DiarizationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { sendMessage, subscribe, isConnected } = useWebSocketContext();
    const { models, downloadModel } = useModelContext();

    const [status, setStatus] = useState<DiarizationStatus>({
        enabled: false,
        provider: '',
    });
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

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

    // WebSocket обработчики
    useEffect(() => {
        const unsubEnabled = subscribe('diarization_enabled', (msg) => {
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
            setStatus({
                enabled: msg.diarizationEnabled || false,
                provider: msg.diarizationProvider || '',
            });
        });

        const unsubError = subscribe('diarization_error', (msg) => {
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
        sendMessage({ type: 'disable_diarization' });
    }, [sendMessage]);

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
