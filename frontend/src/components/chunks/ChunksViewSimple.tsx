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
    const statusColor = chunk.status === 'completed' ? 'var(--success)' 
        : chunk.status === 'error' ? 'var(--danger)' 
        : 'var(--warning)';

    return (
        <div style={{
            padding: '0.75rem 1rem',
            marginBottom: '0.5rem',
            backgroundColor: isTranscribing 
                ? 'rgba(255, 152, 0, 0.1)' 
                : isHighlighted 
                    ? 'rgba(76, 175, 80, 0.1)' 
                    : 'var(--surface)',
            borderRadius: 'var(--radius-md)',
            borderLeft: `3px solid ${statusColor}`,
            transition: 'background-color 0.3s ease',
            border: '1px solid var(--glass-border-subtle)',
        }}>
            {/* Header */}
            <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center' 
            }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    #{chunk.index ?? 0} • {durationSec}s
                </span>
                
                <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                        onClick={onPlay}
                        title={isPlaying ? 'Остановить' : 'Воспроизвести'}
                        style={{
                            padding: '0.25rem 0.5rem',
                            backgroundColor: isPlaying ? 'var(--danger)' : 'var(--primary)',
                            color: 'white',
                            border: 'none',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                    >
                        {isPlaying ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                <rect x="6" y="4" width="4" height="16" rx="1"/>
                                <rect x="14" y="4" width="4" height="16" rx="1"/>
                            </svg>
                        ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5 3 19 12 5 21 5 3"/>
                            </svg>
                        )}
                    </button>
                    
                    <button
                        onClick={onRetranscribe}
                        title="Повторить транскрипцию"
                        style={{
                            padding: '0.25rem 0.5rem',
                            backgroundColor: 'var(--surface-strong)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M23 4v6h-6"/>
                            <path d="M1 20v-6h6"/>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                        </svg>
                    </button>
                </div>
            </div>

            {/* Content */}
            <div style={{ marginTop: '0.5rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {chunk.transcription || ''}
            </div>

            {/* Transcribing indicator */}
            {isTranscribing && (
                <div style={{ 
                    marginTop: '0.5rem', 
                    color: 'var(--warning)', 
                    fontSize: '0.8rem', 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem' 
                }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                    Распознаётся...
                </div>
            )}

            {/* Error */}
            {chunk.error && (
                <div style={{ marginTop: '0.5rem', color: 'var(--danger)', fontSize: '0.8rem' }}>
                    Ошибка: {chunk.error}
                </div>
            )}
        </div>
    );
};

export default ChunksViewSimple;
