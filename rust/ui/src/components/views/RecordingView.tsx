import React, { useEffect, useState, useRef } from 'react';
import { useSessionContext } from '../../context/SessionContext';
import { useBackendContext } from '../../context/BackendContext';
import { LiveChunksView } from '../chunks/LiveChunksView';
import { ChunkSkeleton } from '../chunks/ChunkSkeleton';
import { StreamingTranscription } from '../StreamingTranscription';
import { useSettingsContext } from '../../context/SettingsContext';

interface RecordingStatus {
    state: 'initializing' | 'waiting_chunk' | 'recording' | 'transcribing';
    chunkIndex?: number;
    message: string;
}

export const RecordingView: React.FC = () => {
    const { currentSession } = useSessionContext();
    const { subscribe, sendMessage } = useBackendContext();
    const { enableStreaming } = useSettingsContext();
    const chunks = currentSession?.chunks || [];



    const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);
    const [transcribingChunkId, setTranscribingChunkId] = useState<string | null>(null);
    const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>({
        state: 'initializing',
        message: 'Инициализация записи...'
    });
    const containerRef = useRef<HTMLDivElement>(null);

    // Обновляем статус на основе состояния сессии
    useEffect(() => {
        if (!currentSession) {
            setRecordingStatus({
                state: 'initializing',
                message: 'Инициализация записи...'
            });
            return;
        }

        const completedChunks = chunks.filter(c => c.status === 'completed').length;
        const pendingChunks = chunks.filter(c => c.status === 'pending' || c.status === 'transcribing').length;

        if (chunks.length === 0) {
            setRecordingStatus({
                state: 'waiting_chunk',
                message: 'Ожидание первого аудио-фрагмента...'
            });
        } else if (pendingChunks > 0) {
            setRecordingStatus({
                state: 'transcribing',
                chunkIndex: chunks.length,
                message: `Транскрибируется фрагмент ${completedChunks + 1}/${chunks.length}...`
            });
        } else {
            setRecordingStatus({
                state: 'recording',
                message: `Записано фрагментов: ${completedChunks}`
            });
        }
    }, [currentSession, chunks]);

    useEffect(() => {
        if (!currentSession) return;

        const handleCreated = (msg: any) => {
            if (msg.sessionId !== currentSession.id) return;
            setHighlightedChunkId(msg.chunk.id);
            setRecordingStatus({
                state: 'transcribing',
                chunkIndex: msg.chunk.index,
                message: `Создан фрагмент ${msg.chunk.index + 1}, транскрибируется...`
            });
            setTimeout(() => setHighlightedChunkId(null), 1200);
        };
        
        const handleTranscribing = (msg: any) => {
            if (msg.sessionId !== currentSession.id) return;
            setTranscribingChunkId(msg.chunkId);
            setRecordingStatus({
                state: 'transcribing',
                message: 'Распознаётся речь...'
            });
        };
        
        const handleTranscribed = (msg: any) => {
            if (msg.sessionId !== currentSession.id) return;
            setTranscribingChunkId(prev => (prev === msg.chunk.id ? null : prev));
            setHighlightedChunkId(msg.chunk.id);
            setRecordingStatus({
                state: 'recording',
                message: `Фрагмент ${msg.chunk.index + 1} распознан`
            });
            setTimeout(() => setHighlightedChunkId(null), 2000);
        };

        const unsubCreated = subscribe('chunk_created', handleCreated);
        const unsubTranscribing = subscribe('chunk_transcribing', handleTranscribing);
        const unsubTranscribed = subscribe('chunk_transcribed', handleTranscribed);

        return () => {
            unsubCreated?.();
            unsubTranscribing?.();
            unsubTranscribed?.();
        };
    }, [currentSession, subscribe]);

    // Автоскролл при новых чанках
    useEffect(() => {
        if (containerRef.current && chunks.length > 0) {
            containerRef.current.scrollTo({
                top: containerRef.current.scrollHeight,
                behavior: 'smooth'
            });
        }
    }, [chunks.length]);

    // Рендер индикатора статуса
    const renderStatusIndicator = () => {
        const statusColors: Record<RecordingStatus['state'], string> = {
            initializing: '#f59e0b', // amber
            waiting_chunk: '#3b82f6', // blue
            recording: '#10b981', // green
            transcribing: '#8b5cf6' // purple
        };

        const statusIcons: Record<RecordingStatus['state'], React.ReactNode> = {
            initializing: (
                <div style={{ 
                    width: '16px', 
                    height: '16px', 
                    border: '2px solid rgba(245, 158, 11, 0.3)',
                    borderTopColor: '#f59e0b',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite'
                }} />
            ),
            waiting_chunk: (
                <div style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    background: '#3b82f6',
                    animation: 'pulse-dot 1.5s ease-in-out infinite'
                }} />
            ),
            recording: (
                <div style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    background: '#10b981',
                    boxShadow: '0 0 8px #10b981'
                }} />
            ),
            transcribing: (
                <div style={{ 
                    width: '16px', 
                    height: '16px', 
                    border: '2px solid rgba(139, 92, 246, 0.3)',
                    borderTopColor: '#8b5cf6',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite'
                }} />
            )
        };

        return (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.75rem 1rem',
                background: `linear-gradient(135deg, ${statusColors[recordingStatus.state]}15 0%, transparent 100%)`,
                borderRadius: '10px',
                border: `1px solid ${statusColors[recordingStatus.state]}30`,
                marginBottom: '1rem'
            }}>
                {statusIcons[recordingStatus.state]}
                <span style={{ 
                    fontSize: '0.9rem', 
                    fontWeight: 500, 
                    color: statusColors[recordingStatus.state],
                    letterSpacing: '0.01em'
                }}>
                    {recordingStatus.message}
                </span>
            </div>
        );
    };

    if (!currentSession) {
        return (
            <div style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center', 
                justifyContent: 'center',
                height: '100%',
                minHeight: '400px',
                color: 'white', 
                textAlign: 'center', 
                padding: '2rem',
            }}>
                {/* Большая иконка микрофона для визуальной идентификации */}
                <div style={{
                    fontSize: '8rem',
                    marginBottom: '1.5rem',
                    filter: 'drop-shadow(0 0 20px rgba(239, 68, 68, 0.5))',
                    animation: 'pulse-mic-init 2s ease-in-out infinite'
                }}>
                    🎙️
                </div>
                <div style={{ 
                    width: '48px', 
                    height: '48px', 
                    marginBottom: '1.5rem',
                    border: '3px solid var(--glass-border)',
                    borderTopColor: '#ef4444',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite'
                }} />
                <div style={{ 
                    fontSize: '1.2rem', 
                    fontWeight: 600,
                    color: '#ef4444',
                    marginBottom: '0.5rem'
                }}>
                    Инициализация записи...
                </div>
                <div style={{ fontSize: '0.9rem', opacity: 0.7 }}>
                    Подготовка аудио-захвата
                </div>
                <style>{`
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                    @keyframes pulse-mic-init {
                        0%, 100% { 
                            opacity: 0.8; 
                            transform: scale(1);
                        }
                        50% { 
                            opacity: 0.4; 
                            transform: scale(1.05);
                        }
                    }
                `}</style>
            </div>
        );
    }

    // Если нет чанков - показываем скелетон первого чанка
    if (chunks.length === 0) {
        return (
            <div style={{ 
                height: '100%', 
                display: 'flex', 
                flexDirection: 'column', 
                padding: '1rem' 
            }}>
                {renderStatusIndicator()}
                
                {/* Стриминговая транскрипция */}
                {enableStreaming && (
                    <div style={{ 
                        minHeight: '120px',
                        marginBottom: '1rem'
                    }}>
                        <StreamingTranscription enabled={true} />
                    </div>
                )}
                
                {/* Скелетон первого чанка - показывает что идёт запись */}
                <div style={{ marginBottom: '1rem' }}>
                    <ChunkSkeleton chunkIndex={0} />
                </div>
                
                {/* Информация о записи */}
                <div style={{ 
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '1.5rem',
                    color: 'var(--text-muted)',
                    textAlign: 'center',
                    backgroundColor: 'rgba(59, 130, 246, 0.03)',
                    borderRadius: '12px',
                    border: '1px dashed rgba(59, 130, 246, 0.2)',
                }}>
                    <div style={{ 
                        fontSize: '3rem', 
                        marginBottom: '0.75rem',
                        animation: 'pulse-mic 2s ease-in-out infinite'
                    }}>
                        🎙️
                    </div>
                    <div style={{ 
                        fontSize: '1rem', 
                        fontWeight: 600,
                        color: 'var(--primary)',
                        marginBottom: '0.25rem'
                    }}>
                        Запись активна
                    </div>
                    <div style={{ fontSize: '0.85rem', opacity: 0.7 }}>
                        Первый фрагмент появится через несколько секунд
                    </div>
                </div>

                <style>{`
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                    @keyframes pulse-dot {
                        0%, 100% { opacity: 1; transform: scale(1); }
                        50% { opacity: 0.5; transform: scale(0.8); }
                    }
                    @keyframes pulse-opacity {
                        0%, 100% { opacity: 0.5; }
                        50% { opacity: 0.3; }
                    }
                    @keyframes pulse-mic {
                        0%, 100% { opacity: 0.8; transform: scale(1); }
                        50% { opacity: 0.5; transform: scale(1.05); }
                    }
                `}</style>
            </div>
        );
    }

    // Есть чанки - показываем полный интерфейс
    return (
        <div 
            style={{ 
                height: '100%', 
                display: 'flex', 
                flexDirection: 'column', 
                padding: '1rem',
                overflow: 'hidden',
                minHeight: 0
            }}
        >
            {renderStatusIndicator()}

            <div 
                ref={containerRef}
                style={{
                    flex: 1,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0
                }}
            >
                <LiveChunksView
                    chunks={chunks}
                    sessionId={currentSession.id}
                    transcribingChunkId={transcribingChunkId}
                    highlightedChunkId={highlightedChunkId}
                    onPlayChunk={(url) => {
                        sendMessage({ type: 'play_audio_url', url });
                    }}
                    showSkeleton={true}
                />
            </div>

            <style>{`
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                @keyframes pulse-dot {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.5; transform: scale(0.8); }
                }
            `}</style>
        </div>
    );
};

export default RecordingView;
