import React, { useEffect, useState } from 'react';
import { LiveChunksView } from '../chunks/LiveChunksView';
import { useSessionContext } from '../../context/SessionContext';
import { useWebSocketContext } from '../../context/WebSocketContext';

/**
 * Экран во время записи.
 * Отображается при isRecording = true.
 * Показывает чанки в реальном времени с live транскрипцией.
 */
export const RecordingView: React.FC = () => {
    const { currentSession } = useSessionContext();
    const { subscribe } = useWebSocketContext();
    const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);
    const [transcribingChunkId, setTranscribingChunkId] = useState<string | null>(null);

    // Подписка на события чанков
    useEffect(() => {
        const unsubChunkTranscribed = subscribe('chunk_transcribed', (msg: any) => {
            // Убираем индикацию транскрипции
            setTranscribingChunkId(prev => prev === msg.chunk?.id ? null : prev);
            
            // Добавляем highlight на 2 секунды
            if (msg.chunk?.id) {
                setHighlightedChunkId(msg.chunk.id);
                setTimeout(() => setHighlightedChunkId(null), 2000);
            }
        });

        const unsubChunkCreated = subscribe('chunk_created', (msg: any) => {
            // Устанавливаем новый чанк как транскрибируемый
            if (msg.chunk?.id) {
                setTranscribingChunkId(msg.chunk.id);
            }
        });

        return () => {
            unsubChunkTranscribed();
            unsubChunkCreated();
        };
    }, [subscribe]);

    // Функция для получения информации о спикере
    const getSpeakerDisplayName = (speaker?: string) => {
        // Базовая реализация - можно расширить
        if (!speaker || speaker === 'unknown') {
            return { name: 'Неизвестный', color: '#9ca3af' };
        }
        
        // Определяем цвет по ID спикера
        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
        const speakerNum = parseInt(speaker.replace(/\D/g, '')) || 0;
        const color = colors[speakerNum % colors.length];
        
        return { name: speaker, color };
    };

    // Обработчик воспроизведения чанка
    const handlePlayChunk = (sessionId: string, chunkIndex: number) => {
        // Базовая реализация - можно расширить через props
        console.log('Play chunk:', sessionId, chunkIndex);
    };

    const chunks = currentSession?.chunks || [];

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                padding: '1.5rem',
                maxWidth: '1400px',
                margin: '0 auto',
                width: '100%'
            }}
        >
            {/* Header */}
            <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '0.75rem', 
                marginBottom: '1.5rem',
                paddingBottom: '1rem',
                borderBottom: '1px solid var(--border)'
            }}>
                <div
                    style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        background: '#ef4444',
                        boxShadow: '0 0 0 6px rgba(239, 68, 68, 0.12)',
                        animation: 'recordPulseRing 1.5s infinite'
                    }}
                />
                <div>
                    <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--text-primary)' }}>
                        Идёт запись — транскрипция в реальном времени
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '2px' }}>
                        Чанки появляются автоматически по мере обработки
                    </div>
                </div>
            </div>

            {/* Live Chunks View */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                <LiveChunksView
                    chunks={chunks}
                    sessionId={currentSession?.id || ''}
                    transcribingChunkId={transcribingChunkId}
                    highlightedChunkId={highlightedChunkId}
                    onPlayChunk={handlePlayChunk}
                    getSpeakerDisplayName={getSpeakerDisplayName}
                />
            </div>

            <style>{`
                @keyframes recordPulseRing {
                    0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.25); }
                    70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
                }
            `}</style>
        </div>
    );
};

export default RecordingView;
