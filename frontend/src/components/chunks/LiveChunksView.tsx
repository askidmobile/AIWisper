import React, { useRef, useEffect, useState } from 'react';
import { Chunk, TranscriptSegment } from '../../types/session';
import { StreamingTranscription } from '../StreamingTranscription';

const API_BASE = `http://localhost:${(globalThis as any).AIWISPER_HTTP_PORT || 18080}`;

interface SpeakerInfo {
    name: string;
    color: string;
}

interface LiveChunksViewProps {
    chunks: Chunk[];
    sessionId: string;
    transcribingChunkId: string | null;
    highlightedChunkId: string | null;
    
    // Handlers
    onPlayChunk: (sessionId: string, chunkIndex: number) => void;
    getSpeakerDisplayName: (speaker?: string) => SpeakerInfo;
}

/**
 * Компонент для отображения чанков в реальном времени во время записи
 * Адаптирован из ChunksView с добавлением:
 * - Автопрокрутки к последнему чанку
 * - Интеграции StreamingTranscription в последний чанк
 * - Индикатора новых чанков
 */
export const LiveChunksView: React.FC<LiveChunksViewProps> = ({
    chunks,
    sessionId,
    transcribingChunkId,
    highlightedChunkId,
    onPlayChunk,
    getSpeakerDisplayName,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
    const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
    const [newChunksCount, setNewChunksCount] = useState(0);
    const lastChunkCountRef = useRef(chunks.length);

    // Автопрокрутка к последнему чанку
    useEffect(() => {
        if (shouldAutoScroll && containerRef.current) {
            containerRef.current.scrollTo({
                top: containerRef.current.scrollHeight,
                behavior: 'smooth'
            });
            setShouldAutoScroll(false);
            setNewChunksCount(0);
        }
    }, [shouldAutoScroll, chunks.length]);

    // Отслеживание новых чанков
    useEffect(() => {
        if (chunks.length > lastChunkCountRef.current) {
            if (!isScrolledToBottom) {
                setNewChunksCount(prev => prev + (chunks.length - lastChunkCountRef.current));
            } else {
                setShouldAutoScroll(true);
            }
        }
        lastChunkCountRef.current = chunks.length;
    }, [chunks.length, isScrolledToBottom]);

    // Обработка скролла
    const handleScroll = () => {
        if (!containerRef.current) return;
        
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
        
        setIsScrolledToBottom(isAtBottom);
        
        if (isAtBottom) {
            setNewChunksCount(0);
        }
    };

    // Скролл вниз по клику на индикатор
    const scrollToBottom = () => {
        setShouldAutoScroll(true);
    };

    if (chunks.length === 0) {
        return (
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: 'var(--text-muted)',
                    fontSize: '0.9rem',
                    fontStyle: 'italic'
                }}
            >
                Ожидание первого чанка...
            </div>
        );
    }

    return (
        <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
            {/* Список чанков */}
            <div
                ref={containerRef}
                onScroll={handleScroll}
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '1rem',
                    fontSize: '0.85rem'
                }}
            >
                {chunks.map((chunk, index) => {
                    const isLast = index === chunks.length - 1;
                    const isTranscribing = transcribingChunkId === chunk.id || chunk.status === 'transcribing';
                    const isHighlighted = highlightedChunkId === chunk.id;

                    return (
                        <LiveChunkItem
                            key={chunk.id}
                            chunk={chunk}
                            sessionId={sessionId}
                            isLast={isLast}
                            isTranscribing={isTranscribing}
                            isHighlighted={isHighlighted}
                            onPlay={() => onPlayChunk(sessionId, chunk.index)}
                            getSpeakerDisplayName={getSpeakerDisplayName}
                        />
                    );
                })}
            </div>

            {/* Индикатор новых чанков */}
            {!isScrolledToBottom && newChunksCount > 0 && (
                <button
                    onClick={scrollToBottom}
                    style={{
                        position: 'absolute',
                        bottom: '1rem',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        padding: '0.5rem 1rem',
                        background: 'var(--primary)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '9999px',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        transition: 'all 0.2s ease',
                        animation: 'slideUp 0.3s ease-out'
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateX(-50%) scale(1.05)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateX(-50%) scale(1)';
                    }}
                >
                    <span>Новых чанков: {newChunksCount}</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 5v14M19 12l-7 7-7-7"/>
                    </svg>
                </button>
            )}

            {/* CSS анимации */}
            <style>{`
                @keyframes slideUp {
                    from {
                        opacity: 0;
                        transform: translateX(-50%) translateY(20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateX(-50%) translateY(0);
                    }
                }
            `}</style>
        </div>
    );
};

/**
 * Элемент чанка в live режиме
 */
interface LiveChunkItemProps {
    chunk: Chunk;
    sessionId: string;
    isLast: boolean;
    isTranscribing: boolean;
    isHighlighted: boolean;
    onPlay: () => void;
    getSpeakerDisplayName: (speaker?: string) => SpeakerInfo;
}

const LiveChunkItem: React.FC<LiveChunkItemProps> = ({
    chunk,
    isLast,
    isTranscribing,
    isHighlighted,
    onPlay,
    getSpeakerDisplayName,
}) => {
    const durationSec = (chunk.duration / 1000000000).toFixed(1);
    const statusColor = chunk.status === 'completed' ? '#4caf50' 
        : chunk.status === 'error' ? '#f44336' 
        : '#ff9800';
    const statusIcon = chunk.status === 'completed' ? '✓' 
        : chunk.status === 'error' ? '✗' 
        : '⏳';

    return (
        <div
            style={{
                padding: '0.75rem 1rem',
                marginBottom: '0.75rem',
                backgroundColor: isTranscribing 
                    ? 'rgba(59, 130, 246, 0.08)' 
                    : isHighlighted 
                        ? 'rgba(16, 185, 129, 0.08)' 
                        : 'var(--surface)',
                borderRadius: '8px',
                border: `1px solid ${isTranscribing ? 'rgba(59, 130, 246, 0.3)' : isHighlighted ? 'rgba(16, 185, 129, 0.3)' : 'var(--border)'}`,
                borderLeft: `3px solid ${statusColor}`,
                transition: 'all 0.3s ease',
                animation: isTranscribing 
                    ? 'transcribing-pulse 2s ease-in-out infinite' 
                    : isHighlighted 
                        ? 'highlight-flash 0.5s ease-in-out 2' 
                        : 'fadeIn 0.3s ease-out'
            }}
        >
            {/* Header */}
            <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                marginBottom: '0.5rem'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600 }}>
                        Чанк #{chunk.index}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                        •
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                        {durationSec}s
                    </span>
                    <span style={{ color: statusColor, fontSize: '0.9rem' }}>
                        {statusIcon}
                    </span>
                </div>
                
                {/* Play Button */}
                {chunk.status === 'completed' && (
                    <button
                        onClick={onPlay}
                        style={{
                            padding: '0.25rem 0.5rem',
                            fontSize: '0.75rem',
                            backgroundColor: 'var(--primary)',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem'
                        }}
                    >
                        <span>▶</span>
                    </button>
                )}
            </div>

            {/* Content */}
            <ChunkContent 
                chunk={chunk} 
                isLast={isLast}
                isTranscribing={isTranscribing}
                getSpeakerDisplayName={getSpeakerDisplayName} 
            />

            {/* Transcribing indicator */}
            {isTranscribing && (
                <div style={{ 
                    marginTop: '0.5rem', 
                    color: '#3b82f6', 
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem' 
                }}>
                    <span style={{ animation: 'pulse 1.5s infinite' }}>⏳</span> 
                    Транскрибируется...
                </div>
            )}

            {/* Error */}
            {chunk.error && (
                <div style={{ marginTop: '0.5rem', color: '#f44336', fontSize: '0.75rem' }}>
                    Ошибка: {chunk.error}
                </div>
            )}

            {/* CSS анимации */}
            <style>{`
                @keyframes transcribing-pulse {
                    0%, 100% {
                        background-color: rgba(59, 130, 246, 0.08);
                        border-color: rgba(59, 130, 246, 0.3);
                    }
                    50% {
                        background-color: rgba(59, 130, 246, 0.15);
                        border-color: rgba(59, 130, 246, 0.5);
                    }
                }

                @keyframes highlight-flash {
                    0%, 100% {
                        background-color: rgba(16, 185, 129, 0.08);
                        border-color: rgba(16, 185, 129, 0.3);
                    }
                    50% {
                        background-color: rgba(16, 185, 129, 0.2);
                        border-color: rgba(16, 185, 129, 0.6);
                    }
                }

                @keyframes fadeIn {
                    from {
                        opacity: 0;
                        transform: translateY(-10px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                @keyframes pulse {
                    0%, 100% {
                        opacity: 1;
                    }
                    50% {
                        opacity: 0.5;
                    }
                }
            `}</style>
        </div>
    );
};

/**
 * Контент чанка (диалог или streaming)
 */
interface ChunkContentProps {
    chunk: Chunk;
    isLast: boolean;
    isTranscribing: boolean;
    getSpeakerDisplayName: (speaker?: string) => SpeakerInfo;
}

const ChunkContent: React.FC<ChunkContentProps> = ({ 
    chunk, 
    isLast, 
    isTranscribing,
    getSpeakerDisplayName 
}) => {
    // Если это последний чанк и он транскрибируется - показываем streaming
    if (isLast && isTranscribing) {
        return (
            <div style={{ marginTop: '0.5rem' }}>
                {/* Существующий диалог (если есть) */}
                {chunk.dialogue && chunk.dialogue.length > 0 && (
                    <div style={{ marginBottom: '0.75rem', lineHeight: '1.7' }}>
                        {chunk.dialogue.map((seg, idx) => (
                            <DialogueSegment 
                                key={idx} 
                                segment={seg} 
                                getSpeakerDisplayName={getSpeakerDisplayName} 
                            />
                        ))}
                    </div>
                )}
                
                {/* Streaming транскрипция */}
                <div style={{ 
                    padding: '0.5rem',
                    background: 'rgba(59, 130, 246, 0.05)',
                    borderRadius: '4px',
                    border: '1px dashed rgba(59, 130, 246, 0.3)'
                }}>
                    <StreamingTranscription enabled={true} compact={true} />
                </div>
            </div>
        );
    }

    // Диалог с таймстемпами
    if (chunk.dialogue && chunk.dialogue.length > 0) {
        return (
            <div style={{ marginTop: '0.5rem', lineHeight: '1.7' }}>
                {chunk.dialogue.map((seg, idx) => (
                    <DialogueSegment 
                        key={idx} 
                        segment={seg} 
                        getSpeakerDisplayName={getSpeakerDisplayName} 
                    />
                ))}
            </div>
        );
    }

    // Fallback: старый формат без сегментов
    if (chunk.micText || chunk.sysText) {
        return (
            <div style={{ marginTop: '0.5rem', lineHeight: '1.5' }}>
                {chunk.micText && (
                    <div style={{ color: '#4caf50', marginBottom: '0.3rem' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Вы: </span>
                        {chunk.micText}
                    </div>
                )}
                {chunk.sysText && (
                    <div style={{ color: '#2196f3' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Собеседник: </span>
                        {chunk.sysText}
                    </div>
                )}
            </div>
        );
    }

    // Моно режим - просто текст
    if (chunk.transcription) {
        return (
            <div style={{ marginTop: '0.5rem', color: 'var(--text-primary)', lineHeight: '1.5' }}>
                {chunk.transcription}
            </div>
        );
    }

    return null;
};

/**
 * Сегмент диалога внутри чанка
 */
interface DialogueSegmentProps {
    segment: TranscriptSegment;
    getSpeakerDisplayName: (speaker?: string) => SpeakerInfo;
}

const DialogueSegment: React.FC<DialogueSegmentProps> = ({ segment, getSpeakerDisplayName }) => {
    const { name: speakerName, color: speakerColor } = getSpeakerDisplayName(segment.speaker);
    const timeStr = formatTimestamp(segment.start);

    return (
        <div style={{
            marginBottom: '0.4rem',
            paddingLeft: '0.5rem',
            borderLeft: `2px solid ${speakerColor}`
        }}>
            <span style={{
                color: 'var(--text-muted)',
                fontSize: '0.7rem',
                fontFamily: 'monospace'
            }}>
                [{timeStr}]
            </span>
            {' '}
            <span style={{
                color: speakerColor,
                fontSize: '0.8rem',
                fontWeight: 600
            }}>
                {speakerName}:
            </span>
            {' '}
            <span style={{ color: 'var(--text-primary)' }}>
                {segment.text}
            </span>
        </div>
    );
};

/**
 * Форматирование таймстампа MM:SS.d
 */
const formatTimestamp = (totalMs: number): string => {
    const mins = Math.floor(totalMs / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = Math.floor((totalMs % 1000) / 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;
};

export default LiveChunksView;
