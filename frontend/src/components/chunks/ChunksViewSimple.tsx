import React from 'react';
import { Chunk, TranscriptSegment } from '../../types/session';

const API_BASE = `http://localhost:${(globalThis as any).AIWISPER_HTTP_PORT || 18080}`;

// Цвета для разных спикеров (как в legacy)
const SPEAKER_COLORS = ['#2196f3', '#e91e63', '#ff9800', '#9c27b0', '#00bcd4', '#8bc34a'];

// Определение имени и цвета спикера
const getSpeakerInfo = (speaker?: string): { name: string; color: string } => {
    if (speaker === 'mic' || speaker === 'Вы') {
        return { name: 'Вы', color: '#4caf50' };
    } else if (speaker?.startsWith('Speaker ')) {
        const speakerNum = parseInt(speaker.replace('Speaker ', ''), 10);
        return {
            name: `Собеседник ${speakerNum + 1}`,
            color: SPEAKER_COLORS[speakerNum % SPEAKER_COLORS.length]
        };
    } else if (speaker === 'sys') {
        return { name: 'Собеседник', color: '#2196f3' };
    } else {
        return { name: speaker || 'Собеседник', color: '#2196f3' };
    }
};

// Форматирование времени
const formatTime = (ms: number): string => {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

interface ChunksViewSimpleProps {
    chunks: Chunk[];
    sessionId: string;
    playingUrl: string | null;
    highlightedChunkId: string | null;
    transcribingChunkId: string | null;
    isFullTranscribing?: boolean; // Блокировка во время полной ретранскрибации
    onPlayChunk: (url: string) => void;
    onRetranscribe: (chunkId: string) => void;
}

/**
 * Упрощённый компонент для отображения списка чанков с подсветкой спикеров
 */
export const ChunksViewSimple: React.FC<ChunksViewSimpleProps> = ({
    chunks,
    sessionId,
    playingUrl,
    highlightedChunkId,
    transcribingChunkId,
    isFullTranscribing = false,
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
                        isRetranscribeDisabled={isFullTranscribing}
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
    isRetranscribeDisabled?: boolean; // Блокировка кнопки ретранскрибации
    onPlay: () => void;
    onRetranscribe: () => void;
}

const ChunkItem: React.FC<ChunkItemProps> = ({
    chunk,
    isPlaying,
    isHighlighted,
    isTranscribing,
    isRetranscribeDisabled = false,
    onPlay,
    onRetranscribe,
}) => {
    const durationSec = ((chunk.duration || 0) / 1e9).toFixed(1);

    // Определяем есть ли диалог с разными спикерами
    const hasDialogue = chunk.dialogue && chunk.dialogue.length > 0;
    const hasMicSys = chunk.micText || chunk.sysText;

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
                        disabled={isRetranscribeDisabled || isTranscribing}
                        title={isRetranscribeDisabled ? "Дождитесь завершения ретранскрибации" : "Повторить транскрипцию"}
                        style={{
                            padding: '0.25rem 0.5rem',
                            backgroundColor: 'var(--surface-strong)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--text-muted)',
                            cursor: (isRetranscribeDisabled || isTranscribing) ? 'not-allowed' : 'pointer',
                            opacity: (isRetranscribeDisabled || isTranscribing) ? 0.4 : 1,
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
            <div style={{ marginTop: '0.5rem', lineHeight: 1.6 }}>
                {hasDialogue ? (
                    // Отображаем диалог с разными спикерами
                    <DialogueContent dialogue={chunk.dialogue!} chunkStartMs={chunk.startMs} />
                ) : hasMicSys ? (
                    // Отображаем mic/sys разделение
                    <MicSysContent micText={chunk.micText} sysText={chunk.sysText} />
                ) : (
                    // Простой текст
                    <div style={{ color: 'var(--text-secondary)' }}>
                        {chunk.transcription || ''}
                    </div>
                )}
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

/**
 * Компонент для отображения диалога с разными спикерами
 */
const DialogueContent: React.FC<{ dialogue: TranscriptSegment[]; chunkStartMs: number }> = ({ dialogue }) => {
    return (
        <div>
            {dialogue.map((seg, idx) => {
                const { name: speakerName, color: speakerColor } = getSpeakerInfo(seg.speaker);
                const timeStr = formatTime(seg.start);

                return (
                    <div 
                        key={idx}
                        style={{
                            marginBottom: '0.4rem',
                            paddingLeft: '0.5rem',
                            paddingRight: '0.5rem',
                            paddingTop: '0.2rem',
                            paddingBottom: '0.2rem',
                            borderLeft: `3px solid ${speakerColor}`,
                            borderRadius: '0 4px 4px 0',
                        }}
                    >
                        <span style={{
                            color: 'var(--text-muted)',
                            fontSize: '0.8rem',
                            fontFamily: 'monospace',
                        }}>
                            [{timeStr}]
                        </span>
                        {' '}
                        <span style={{
                            color: speakerColor,
                            fontWeight: 'bold',
                        }}>
                            {speakerName}:
                        </span>
                        {' '}
                        <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                            {seg.text}
                        </span>
                    </div>
                );
            })}
        </div>
    );
};

/**
 * Компонент для отображения mic/sys разделения
 */
const MicSysContent: React.FC<{ micText?: string; sysText?: string }> = ({ micText, sysText }) => {
    return (
        <div>
            {micText && (
                <div style={{
                    marginBottom: '0.4rem',
                    borderLeft: '3px solid #4caf50',
                    paddingLeft: '0.5rem',
                    paddingTop: '0.2rem',
                    paddingBottom: '0.2rem',
                    borderRadius: '0 4px 4px 0',
                }}>
                    <span style={{ color: '#4caf50', fontWeight: 'bold', fontSize: '0.85rem' }}>Вы: </span>
                    <span style={{ color: 'var(--text-primary)' }}>{micText}</span>
                </div>
            )}
            {sysText && (
                <div style={{
                    marginBottom: '0.4rem',
                    borderLeft: '3px solid #2196f3',
                    paddingLeft: '0.5rem',
                    paddingTop: '0.2rem',
                    paddingBottom: '0.2rem',
                    borderRadius: '0 4px 4px 0',
                }}>
                    <span style={{ color: '#2196f3', fontWeight: 'bold', fontSize: '0.85rem' }}>Собеседник: </span>
                    <span style={{ color: 'var(--text-primary)' }}>{sysText}</span>
                </div>
            )}
        </div>
    );
};

export default ChunksViewSimple;
