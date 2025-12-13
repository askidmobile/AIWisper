import React from 'react';
import { Chunk } from '../../types/session';

const API_BASE = `http://localhost:${(globalThis as any).AIWISPER_HTTP_PORT || 18080}`;

interface ChunksViewSimpleProps {
    chunks: Chunk[];
    sessionId: string;
    playingUrl: string | null;
    highlightedChunkId: string | null;
    transcribingChunkId: string | null;
    onPlayChunk: (url: string) => void;
    onRetranscribe: (chunkId: string) => void;
}

/**
 * Упрощённый компонент для отображения списка чанков
 * Совместим с API TranscriptionView
 */
export const ChunksViewSimple: React.FC<ChunksViewSimpleProps> = ({
    chunks,
    sessionId,
    playingUrl,
    highlightedChunkId,
    transcribingChunkId,
    onPlayChunk,
    onRetranscribe,
}) => {
    const validChunks = (chunks || []).filter(chunk => chunk);

    if (validChunks.length === 0) {
        return (
            <div style={{ 
                textAlign: 'center', 
                color: 'var(--text-muted)', 
                padding: '2rem' 
            }}>
                Нет чанков для отображения
            </div>
        );
    }

    return (
        <div>
            {validChunks.map(chunk => {
                const chunkUrl = `${API_BASE}/api/sessions/${sessionId}/chunk/${chunk.index ?? 0}.mp3`;
                const isPlaying = playingUrl?.includes(`chunk/${chunk.index ?? 0}.mp3`) ?? false;
                const isHighlighted = highlightedChunkId === chunk.id;
                const isTranscribing = transcribingChunkId === chunk.id || chunk.status === 'transcribing';

                return (
                    <ChunkItem
                        key={chunk.id || `chunk-${chunk.index}`}
                        chunk={chunk}
                        chunkUrl={chunkUrl}
                        isPlaying={isPlaying}
                        isHighlighted={isHighlighted}
                        isTranscribing={isTranscribing}
                        onPlay={() => onPlayChunk(chunkUrl)}
                        onRetranscribe={() => chunk.id && onRetranscribe(chunk.id)}
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
    chunkUrl: string;
    isPlaying: boolean;
    isHighlighted: boolean;
    isTranscribing: boolean;
    onPlay: () => void;
    onRetranscribe: () => void;
}

const ChunkItem: React.FC<ChunkItemProps> = ({
    chunk,
    isPlaying,
    isHighlighted,
    isTranscribing,
    onPlay,
    onRetranscribe,
}) => {
    const durationSec = ((chunk.duration || 0) / 1e9).toFixed(1);
    const statusColor = chunk.status === 'completed' ? '#4caf50' 
        : chunk.status === 'error' ? '#f44336' 
        : '#ff9800';

    return (
        <div style={{
            padding: '0.6rem 0.8rem',
            marginBottom: '0.4rem',
            backgroundColor: isTranscribing ? '#2a2a1a' : isHighlighted ? '#1a3a2a' : '#12121f',
            borderRadius: '4px',
            borderLeft: `3px solid ${statusColor}`,
            transition: 'background-color 0.3s ease',
        }}>
            {/* Header */}
            <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center' 
            }}>
                <span style={{ color: '#888' }}>
                    #{chunk.index ?? 0} • {durationSec}s
                </span>
                
                <div style={{ display: 'flex', gap: '5px' }}>
                    <button
                        onClick={onPlay}
                        style={{
                            padding: '0.15rem 0.4rem',
                            fontSize: '0.75rem',
                            backgroundColor: isPlaying ? '#f44336' : '#2196f3',
                            color: 'white',
                            border: 'none',
                            borderRadius: '3px',
                            cursor: 'pointer'
                        }}
                    >
                        {isPlaying ? '⏹' : '▶'}
                    </button>
                    
                    <button
                        onClick={onRetranscribe}
                        title="Повторить транскрипцию"
                        style={{
                            padding: '0.15rem 0.4rem',
                            fontSize: '0.75rem',
                            backgroundColor: '#333',
                            border: 'none',
                            borderRadius: '3px',
                            color: '#888',
                            cursor: 'pointer'
                        }}
                    >
                        🔄
                    </button>
                </div>
            </div>

            {/* Content */}
            <div style={{ marginTop: '0.4rem', color: '#ccc' }}>
                {chunk.transcription || ''}
            </div>

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

export default ChunksViewSimple;
