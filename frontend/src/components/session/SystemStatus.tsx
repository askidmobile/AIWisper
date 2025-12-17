import React, { useEffect, useState, useMemo } from 'react';
import { useWebSocketContext } from '../../context/WebSocketContext';
import { useSettingsContext } from '../../context/SettingsContext';

/**
 * Типы стадий обработки
 */
type SystemStage = 
    | 'recording'           // Базовая запись
    | 'vad'                 // Voice Activity Detection
    | 'streaming'           // Стриминг транскрипция
    | 'confirming'          // Подтверждение текста
    | 'chunk_creating'      // Создание чанка
    | 'transcribing'        // Распознавание речи
    | 'hybrid'              // Гибридная обработка
    | 'llm'                 // Обработка LLM
    | 'diarization'         // Анализ спикеров
    | 'voiceprint'          // Сопоставление voiceprints
    | 'finalizing'          // Финальная сборка
    | 'waiting';            // Ожидание аудио

interface SystemStatus {
    stage: SystemStage;
    text: string;
    icon: string;
    color: string;
}

/**
 * Компонент для отображения текущей стадии обработки системы
 * Показывает одну строку с иконкой и текстом
 */
export const SystemStatus: React.FC = () => {
    const { subscribe } = useWebSocketContext();
    const { hybridTranscription } = useSettingsContext();
    
    // Состояния для отслеживания активности различных процессов
    const [lastStreamingUpdate, setLastStreamingUpdate] = useState<number | null>(null);
    const [streamingIsConfirmed, setStreamingIsConfirmed] = useState(false);
    const [lastChunkCreated, setLastChunkCreated] = useState<number | null>(null);
    const [lastChunkTranscribed, setLastChunkTranscribed] = useState<number | null>(null);
    const [lastSpeakersUpdate, setLastSpeakersUpdate] = useState<number | null>(null);
    const [isLLMProcessing, setIsLLMProcessing] = useState(false);
    const [isHybridProcessing, setIsHybridProcessing] = useState(false);

    // Подписка на WebSocket события
    useEffect(() => {
        const unsubStreamingUpdate = subscribe('streaming_update', (msg: any) => {
            setLastStreamingUpdate(Date.now());
            setStreamingIsConfirmed(msg.streamingIsConfirmed || false);
        });

        const unsubChunkCreated = subscribe('chunk_created', () => {
            setLastChunkCreated(Date.now());
        });

        const unsubChunkTranscribed = subscribe('chunk_transcribed', () => {
            setLastChunkTranscribed(Date.now());
            setIsHybridProcessing(false); // Завершена обработка
            setIsLLMProcessing(false);
        });

        const unsubSessionSpeakers = subscribe('session_speakers', () => {
            setLastSpeakersUpdate(Date.now());
        });

        // События для гибридной транскрипции (если будут добавлены)
        const unsubHybridStart = subscribe('hybrid_processing_start', () => {
            setIsHybridProcessing(true);
        });

        const unsubHybridEnd = subscribe('hybrid_processing_end', () => {
            setIsHybridProcessing(false);
        });

        // События для LLM обработки (если будут добавлены)
        const unsubLLMStart = subscribe('llm_processing_start', () => {
            setIsLLMProcessing(true);
        });

        const unsubLLMEnd = subscribe('llm_processing_end', () => {
            setIsLLMProcessing(false);
        });

        return () => {
            unsubStreamingUpdate();
            unsubChunkCreated();
            unsubChunkTranscribed();
            unsubSessionSpeakers();
            unsubHybridStart();
            unsubHybridEnd();
            unsubLLMStart();
            unsubLLMEnd();
        };
    }, [subscribe]);

    // Определение текущего статуса на основе приоритетов
    const currentStatus: SystemStatus = useMemo(() => {
        const now = Date.now();
        const recentThreshold = 3000; // 3 секунды для "недавних" событий

        // Приоритет 1: Обработка LLM
        if (isLLMProcessing) {
            return {
                stage: 'llm',
                text: 'Обработка LLM...',
                icon: '🤖',
                color: '#a855f7' // purple
            };
        }

        // Приоритет 2: Гибридная обработка
        if (isHybridProcessing || (hybridTranscription.enabled && lastChunkTranscribed && now - lastChunkTranscribed < 1000)) {
            return {
                stage: 'hybrid',
                text: 'Гибридная обработка...',
                icon: '⚡',
                color: '#f59e0b' // amber
            };
        }

        // Приоритет 3: Анализ спикеров
        if (lastSpeakersUpdate && now - lastSpeakersUpdate < recentThreshold) {
            return {
                stage: 'diarization',
                text: 'Анализ спикеров...',
                icon: '👥',
                color: '#8b5cf6' // violet
            };
        }

        // Приоритет 4: Распознавание речи
        if (lastChunkTranscribed && now - lastChunkTranscribed < recentThreshold) {
            return {
                stage: 'transcribing',
                text: 'Распознавание речи...',
                icon: '🎤',
                color: '#10b981' // green
            };
        }

        // Приоритет 5: Подтверждение текста
        if (streamingIsConfirmed && lastStreamingUpdate && now - lastStreamingUpdate < 1000) {
            return {
                stage: 'confirming',
                text: 'Подтверждение текста...',
                icon: '✓',
                color: '#10b981' // green
            };
        }

        // Приоритет 6: Стриминг транскрипция
        if (lastStreamingUpdate && now - lastStreamingUpdate < 2000) {
            return {
                stage: 'streaming',
                text: 'Стриминг транскрипция...',
                icon: '📝',
                color: '#3b82f6' // blue
            };
        }

        // Приоритет 7: Создание чанка
        if (lastChunkCreated && now - lastChunkCreated < recentThreshold) {
            return {
                stage: 'chunk_creating',
                text: 'Создание чанка...',
                icon: '📦',
                color: '#6366f1' // indigo
            };
        }

        // Приоритет 8: Ожидание аудио (если долго нет активности)
        if (lastStreamingUpdate && now - lastStreamingUpdate > 10000) {
            return {
                stage: 'waiting',
                text: 'Ожидание аудио...',
                icon: '⏸',
                color: '#9ca3af' // gray
            };
        }

        // Базовая стадия: Идёт запись
        return {
            stage: 'recording',
            text: 'Идёт запись аудио...',
            icon: '🎙',
            color: '#ef4444' // red
        };
    }, [
        isLLMProcessing,
        isHybridProcessing,
        hybridTranscription.enabled,
        lastStreamingUpdate,
        streamingIsConfirmed,
        lastChunkCreated,
        lastChunkTranscribed,
        lastSpeakersUpdate
    ]);

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.4rem 0.75rem',
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '9999px',
                fontSize: '0.85rem',
                fontWeight: 500,
                color: 'white',
                transition: 'all 0.3s ease',
                minWidth: '200px',
            }}
        >
            {/* Иконка с анимацией */}
            <span
                style={{
                    fontSize: '1rem',
                    animation: currentStatus.stage === 'streaming' || currentStatus.stage === 'transcribing'
                        ? 'pulse 2s ease-in-out infinite'
                        : 'none',
                }}
            >
                {currentStatus.icon}
            </span>

            {/* Текст статуса */}
            <span style={{ whiteSpace: 'nowrap' }}>
                {currentStatus.text}
            </span>

            {/* Индикатор активности */}
            <div
                style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: currentStatus.color,
                    boxShadow: `0 0 8px ${currentStatus.color}`,
                    animation: 'pulse 2s ease-in-out infinite',
                }}
            />

            {/* CSS для анимаций */}
            <style>{`
                @keyframes pulse {
                    0%, 100% {
                        opacity: 1;
                        transform: scale(1);
                    }
                    50% {
                        opacity: 0.6;
                        transform: scale(0.95);
                    }
                }
            `}</style>
        </div>
    );
};

export default SystemStatus;
