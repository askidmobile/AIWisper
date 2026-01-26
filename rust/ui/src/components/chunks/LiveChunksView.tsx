import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Chunk, TranscriptSegment } from '../../types/session';
import { useBackendContext } from '../../context/BackendContext';
import { StreamingTranscription } from '../StreamingTranscription';
import { ChunkSkeleton } from './ChunkSkeleton';

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
    onPlayChunk: (url: string) => void;
    /** Показывать скелетон следующего чанка (во время записи) */
    showSkeleton?: boolean;
}

/**
 * LiveChunksView — отображение чанков в реальном времени с интеграцией стриминга в последний чанк.
 */
export const LiveChunksView: React.FC<LiveChunksViewProps> = ({
    chunks,
    sessionId,
    transcribingChunkId,
    highlightedChunkId,
    onPlayChunk,
    showSkeleton = true,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const { isTauri, sendMessage } = useBackendContext();
    const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
    const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
    const [newChunksCount, setNewChunksCount] = useState(0);
    const lastChunkCountRef = useRef(chunks.length);

    useEffect(() => {
        if (shouldAutoScroll && containerRef.current) {
            containerRef.current.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' });
            setShouldAutoScroll(false);
            setNewChunksCount(0);
        }
    }, [shouldAutoScroll, chunks.length]);

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

    const handleScroll = () => {
        if (!containerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        const atBottom = scrollHeight - scrollTop - clientHeight < 50;
        setIsScrolledToBottom(atBottom);
        if (atBottom) setNewChunksCount(0);
    };

    const scrollToBottom = () => setShouldAutoScroll(true);

    if (chunks.length === 0) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '0.9rem', fontStyle: 'italic' }}>
                Ожидание первого чанка...
            </div>
        );
    }

    return (
        <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div
                ref={containerRef}
                onScroll={handleScroll}
                style={{ flex: 1, overflowY: 'auto', padding: '1rem', fontSize: '0.9rem', minHeight: 0 }}
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
                            isTauri={isTauri}
                            sendMessage={sendMessage}
                            isLast={isLast && !showSkeleton}
                            isTranscribing={isTranscribing}
                            isHighlighted={isHighlighted}
                            onPlayChunk={onPlayChunk}
                        />
                    );
                })}
                
                {/* Скелетон следующего чанка - показывает что запись продолжается */}
                {showSkeleton && (
                    <ChunkSkeleton chunkIndex={chunks.length} />
                )}
            </div>

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
                    }}
                >
                    <span>Новых чанков: {newChunksCount}</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 5v14M19 12l-7 7-7-7" />
                    </svg>
                </button>
            )}
        </div>
    );
};

interface LiveChunkItemProps {
    chunk: Chunk;
    sessionId: string;
    isTauri: boolean | undefined;
    sendMessage: (msg: any) => Promise<any>;
    isLast: boolean;
    isTranscribing: boolean;
    isHighlighted: boolean;
    onPlayChunk: (url: string) => void;
}

const chunkAudioCache = new Map<string, string>();

const LiveChunkItem: React.FC<LiveChunkItemProps> = React.memo(({
    chunk,
    sessionId,
    isTauri,
    sendMessage,
    isLast,
    isTranscribing,
    isHighlighted,
    onPlayChunk,
}) => {
    const [chunkAudioUrl, setChunkAudioUrl] = useState<string | null>(null);
    const [isLoadingAudio, setIsLoadingAudio] = useState(false);

    const durationSec = useMemo(() => (chunk.duration / 1e9).toFixed(1), [chunk.duration]);
    const statusColor = chunk.status === 'completed' ? '#4caf50' : chunk.status === 'error' ? '#f44336' : '#ff9800';
    const statusIcon = chunk.status === 'completed' ? '✓' : chunk.status === 'error' ? '✗' : '⏳';

    const handlePlay = async () => {
        const chunkKey = `${sessionId}:${chunk.index}`;
        if (chunkAudioUrl) {
            onPlayChunk(chunkAudioUrl);
            return;
        }
        const cached = chunkAudioCache.get(chunkKey);
        if (cached) {
            setChunkAudioUrl(cached);
            onPlayChunk(cached);
            return;
        }
        setIsLoadingAudio(true);
        try {
            if (isTauri === true) {
                const result = await sendMessage({ type: 'get_chunk_audio', sessionId, chunkIndex: chunk.index });
                if (result && typeof result === 'string') {
                    chunkAudioCache.set(chunkKey, result);
                    setChunkAudioUrl(result);
                    onPlayChunk(result);
                }
            } else {
                const url = `${API_BASE}/api/sessions/${sessionId}/chunk/${chunk.index}.mp3`;
                chunkAudioCache.set(chunkKey, url);
                setChunkAudioUrl(url);
                onPlayChunk(url);
            }
        } catch (err) {
            console.error('[LiveChunkItem] Failed to load audio', err);
        } finally {
            setIsLoadingAudio(false);
        }
    };

    return (
        <div
            style={{
                padding: '0.8rem 1rem',
                marginBottom: '0.75rem',
                backgroundColor: isTranscribing ? 'rgba(59, 130, 246, 0.08)' : isHighlighted ? 'rgba(16, 185, 129, 0.08)' : 'var(--surface)',
                borderRadius: '10px',
                borderTop: `1px solid ${isTranscribing ? 'rgba(59, 130, 246, 0.3)' : isHighlighted ? 'rgba(16, 185, 129, 0.3)' : 'var(--border)'}`,
                borderRight: `1px solid ${isTranscribing ? 'rgba(59, 130, 246, 0.3)' : isHighlighted ? 'rgba(16, 185, 129, 0.3)' : 'var(--border)'}`,
                borderBottom: `1px solid ${isTranscribing ? 'rgba(59, 130, 246, 0.3)' : isHighlighted ? 'rgba(16, 185, 129, 0.3)' : 'var(--border)'}`,
                borderLeft: `3px solid ${statusColor}`,
                transition: 'all 0.3s ease',
                animation: isTranscribing ? 'transcribing-pulse 2s ease-in-out infinite' : isHighlighted ? 'highlight-flash 0.5s ease-in-out 2' : 'fadeIn 0.3s ease-out',
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600 }}>Чанк #{chunk.index}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>•</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{durationSec}s</span>
                    <span style={{ color: statusColor, fontSize: '0.9rem' }}>{statusIcon}</span>
                </div>

                {chunk.status === 'completed' && (
                    <button
                        onClick={handlePlay}
                        disabled={isLoadingAudio}
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
                            gap: '0.25rem',
                            opacity: isLoadingAudio ? 0.7 : 1,
                        }}
                    >
                        ▶
                    </button>
                )}
            </div>

            <ChunkContent chunk={chunk} />

            {isTranscribing && (
                <div style={{ marginTop: '0.5rem', color: '#3b82f6', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ animation: 'pulse 1s infinite' }}>⏳</span> Распознаётся...
                </div>
            )}

            {chunk.error && (
                <div style={{ marginTop: '0.5rem', color: '#f44336', fontSize: '0.85rem' }}>
                    Ошибка: {chunk.error}
                </div>
            )}

            {isLast && (
                <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px dashed var(--border)', color: 'var(--text-muted)' }}>
                    <StreamingTranscription enabled={true} className="compact-streaming" />
                </div>
            )}
        </div>
    );
});

const ChunkContent: React.FC<{ chunk: Chunk }> = React.memo(({ chunk }) => {
    const speakerInfo = (speaker?: string): SpeakerInfo => {
        if (speaker === 'mic' || speaker === 'Вы') return { name: 'Вы', color: '#4caf50' };
        if (speaker?.startsWith('Speaker ')) {
            const n = parseInt(speaker.replace('Speaker ', ''), 10);
            return { name: `Собеседник ${n + 1}`, color: ['#2196f3', '#e91e63', '#ff9800', '#9c27b0', '#00bcd4', '#8bc34a'][n % 6] };
        }
        if (speaker === 'sys') return { name: 'Собеседник', color: '#2196f3' };
        return { name: speaker || 'Собеседник', color: '#2196f3' };
    };

    if (chunk.dialogue && chunk.dialogue.length > 0) {
        return (
            <div style={{ marginTop: '0.5rem', lineHeight: 1.6 }}>
                {chunk.dialogue.map((seg, idx) => (
                    <DialogueSegment key={idx} segment={seg} getSpeakerDisplayName={speakerInfo} />
                ))}
            </div>
        );
    }

    if (chunk.micText || chunk.sysText) {
        return (
            <div style={{ marginTop: '0.5rem', lineHeight: 1.5 }}>
                {chunk.micText && (
                    <div style={{ color: '#4caf50', marginBottom: '0.3rem' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Вы: </span>
                        {chunk.micText}
                    </div>
                )}
                {chunk.sysText && (
                    <div style={{ color: '#2196f3' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Собеседник: </span>
                        {chunk.sysText}
                    </div>
                )}
            </div>
        );
    }

    if (chunk.transcription) {
        return (
            <div style={{ marginTop: '0.5rem', color: '#ccc', lineHeight: 1.5 }}>
                {chunk.transcription}
            </div>
        );
    }

    return null;
});

const DialogueSegment: React.FC<{ segment: TranscriptSegment; getSpeakerDisplayName: (speaker?: string) => SpeakerInfo }> = ({ segment, getSpeakerDisplayName }) => {
    const speaker = getSpeakerDisplayName(segment.speaker);
    const timeRange = `${formatTime(segment.start)}–${formatTime(segment.end)}`;
    return (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', marginBottom: '0.35rem' }}>
            <span style={{ color: speaker.color, fontWeight: 700, minWidth: '110px', fontSize: '0.85rem' }}>{speaker.name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', minWidth: '88px', textAlign: 'right', fontFamily: 'monospace' }}>{timeRange}</span>
            <span style={{ color: 'var(--text-primary)' }}>{segment.text}</span>
        </div>
    );
};

const formatTime = (ms: number): string => {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

export default LiveChunksView;
