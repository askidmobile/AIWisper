import React from 'react';
import { Chunk, TranscriptSegment } from '../../types/session';

const API_BASE = `http://localhost:${(globalThis as any).AIWISPER_HTTP_PORT || 18080}`;

interface SpeakerInfo {
    name: string;
    color: string;
}

interface ChunksViewProps {
    chunks: Chunk[];
    sessionId: string;
    playingChunkUrl: string | null;
    highlightedChunkId: string | null;
    transcribingChunkId: string | null;
    
    // Обработчики
    onPlayChunk: (sessionId: string, chunkIndex: number) => void;
    onRetranscribe: (chunkId: string) => void;
    getSpeakerDisplayName: (speaker?: string) => SpeakerInfo;
}

/**
 * Компонент для отображения списка чанков
 */
export const ChunksView: React.FC<ChunksViewProps> = ({
    chunks,
    sessionId,
    playingChunkUrl,
    highlightedChunkId,
    transcribingChunkId,
    onPlayChunk,
    onRetranscribe,
    getSpeakerDisplayName,
}) => {

    return (
        <div style={{ fontSize: '0.85rem' }}>
            <h4 style={{ margin: '0 0 0.75rem 0', color: '#888' }}>
                Чанки ({chunks.length})
            </h4>
            
            {chunks.map(chunk => {
                const chunkAudioUrl = `${API_BASE}/api/sessions/${sessionId}/chunk/${chunk.index}.mp3`;
                const isPlaying = playingChunkUrl === chunkAudioUrl;
                const isHighlighted = highlightedChunkId === chunk.id;
                const isTranscribing = transcribingChunkId === chunk.id || chunk.status === 'transcribing';

                return (
                    <ChunkItem
                        key={chunk.id}
                        chunk={chunk}
                        isPlaying={isPlaying}
                        isHighlighted={isHighlighted}
                        isTranscribing={isTranscribing}
                        onPlay={() => onPlayChunk(sessionId, chunk.index)}
                        onRetranscribe={() => onRetranscribe(chunk.id)}
                        getSpeakerDisplayName={getSpeakerDisplayName}
                    />
                );
            })}
        </div>
    );
};

/**
 * Элемент чанка
 */
interface ChunkItemProps {
    chunk: Chunk;
    isPlaying: boolean;
    isHighlighted: boolean;
    isTranscribing: boolean;
    onPlay: () => void;
    onRetranscribe: () => void;
    getSpeakerDisplayName: (speaker?: string) => SpeakerInfo;
}

const ChunkItem: React.FC<ChunkItemProps> = ({
    chunk,
    isPlaying,
    isHighlighted,
    isTranscribing,
    onPlay,
    onRetranscribe,
    getSpeakerDisplayName,
}) => {
    const durationSec = (chunk.duration / 1000000000).toFixed(1);
    const statusColor = chunk.status === 'completed' ? '#4caf50' 
        : chunk.status === 'error' ? '#f44336' 
        : '#ff9800';
    const statusIcon = chunk.status === 'completed' ? '✓' 
        : chunk.status === 'error' ? '✗' 
        : '⏳';

    // Real-Time Factor (скорость обработки) - опционально из расширенного типа
    const processingTime = (chunk as any).processingTime;
    const rtf = processingTime && processingTime > 0
        ? ((chunk.duration / 1000000000) / (processingTime / 1000)).toFixed(1)
        : null;

    return (
        <div style={{
            padding: '0.6rem 0.8rem',
            marginBottom: '0.4rem',
            backgroundColor: isTranscribing ? '#2a2a1a' : isHighlighted ? '#1a3a2a' : '#12121f',
            borderRadius: '4px',
            borderLeft: `3px solid ${statusColor}`,
            transition: 'background-color 0.3s ease',
            animation: isTranscribing 
                ? 'transcribing-pulse 1s ease-in-out infinite' 
                : isHighlighted 
                    ? 'highlight-pulse 0.5s ease-in-out 2' 
                    : 'none'
        }}>
            {/* Header */}
            <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                gap: '0.5rem' 
            }}>
                <span style={{ color: '#888' }}>
                    #{chunk.index} • {durationSec}s •
                    <span style={{ marginLeft: '0.3rem', color: statusColor }}>
                        {statusIcon}
                    </span>
                    {rtf && (
                        <span 
                            style={{ marginLeft: '0.3rem', color: '#9c27b0', fontSize: '0.75rem' }} 
                            title="Real-Time Factor (скорость обработки)"
                        >
                            {rtf}x
                        </span>
                    )}
                </span>
                
                {/* Action Buttons */}
                <div style={{ display: 'flex', gap: '0.3rem' }}>
                    <button
                        onClick={onPlay}
                        style={{
                            padding: '0.15rem 0.4rem',
                            fontSize: '0.7rem',
                            backgroundColor: isPlaying ? '#f44336' : '#2196f3',
                            color: 'white',
                            border: 'none',
                            borderRadius: '3px',
                            cursor: 'pointer'
                        }}
                    >
                        {isPlaying ? '⏹' : '▶'}
                    </button>
                    
                    {(chunk.status === 'completed' || chunk.status === 'transcribing' || chunk.status === 'error') && (
                        <button
                            onClick={onRetranscribe}
                            title="Повторить транскрипцию"
                            style={{
                                padding: '0.15rem 0.4rem',
                                fontSize: '0.7rem',
                                backgroundColor: '#333',
                                border: 'none',
                                borderRadius: '3px',
                                color: '#888',
                                cursor: 'pointer'
                            }}
                        >
                            🔄
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <ChunkContent 
                chunk={chunk} 
                getSpeakerDisplayName={getSpeakerDisplayName} 
            />

            {/* Transcribing indicator */}
            {isTranscribing && (
                <div style={{ 
                    marginTop: '0.4rem', 
                    color: '#ff9800', 
                    fontSize: '0.8rem', 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem' 
                }}>
                    <span style={{ animation: 'pulse 1s infinite' }}>⏳</span> 
                    Распознаётся...
                </div>
            )}

            {/* Error */}
            {chunk.error && (
                <div style={{ marginTop: '0.4rem', color: '#f44336', fontSize: '0.8rem' }}>
                    Ошибка: {chunk.error}
                </div>
            )}
        </div>
    );
};

/**
 * Контент чанка (диалог или текст)
 */
interface ChunkContentProps {
    chunk: Chunk;
    getSpeakerDisplayName: (speaker?: string) => SpeakerInfo;
}

const ChunkContent: React.FC<ChunkContentProps> = ({ chunk, getSpeakerDisplayName }) => {
    // Диалог с таймстемпами
    if (chunk.dialogue && chunk.dialogue.length > 0) {
        return (
            <div style={{ marginTop: '0.4rem', lineHeight: '1.7' }}>
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
            <div style={{ marginTop: '0.4rem', lineHeight: '1.5' }}>
                {chunk.micText && (
                    <div style={{ color: '#4caf50', marginBottom: '0.3rem' }}>
                        <span style={{ color: '#888', fontSize: '0.8rem' }}>Вы: </span>
                        {chunk.micText}
                    </div>
                )}
                {chunk.sysText && (
                    <div style={{ color: '#2196f3' }}>
                        <span style={{ color: '#888', fontSize: '0.8rem' }}>Собеседник: </span>
                        {chunk.sysText}
                    </div>
                )}
            </div>
        );
    }

    // Моно режим - просто текст
    if (chunk.transcription) {
        return (
            <div style={{ marginTop: '0.4rem', color: '#ccc', lineHeight: '1.5' }}>
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
            marginBottom: '0.3rem',
            paddingLeft: '0.4rem',
            borderLeft: `2px solid ${speakerColor}`
        }}>
            <span style={{
                color: '#666',
                fontSize: '0.7rem',
                fontFamily: 'monospace'
            }}>
                [{timeStr}]
            </span>
            {' '}
            <span style={{
                color: speakerColor,
                fontSize: '0.8rem',
                fontWeight: 'bold'
            }}>
                {speakerName}:
            </span>
            {' '}
            <span style={{ color: '#ccc' }}>
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

export default ChunksView;
