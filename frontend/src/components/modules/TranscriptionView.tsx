import React, { useState, useRef, useEffect } from 'react';
import { useSessionContext } from '../../context/SessionContext';
import { useWebSocketContext } from '../../context/WebSocketContext';
import SessionTabs, { TabType } from '../SessionTabs';
import SummaryView from '../SummaryView';
import { SessionControls } from './SessionControls';
import { TranscriptSegment } from '../../types/session';

const API_BASE = `http://localhost:${process.env.AIWISPER_HTTP_PORT || 18080}`;

interface TranscriptionViewProps {
    onPlayChunk: (url: string) => void;
    playingUrl: string | null;
    ollamaModel: string;
    // New props for player
    isPlaying: boolean;
    onPlaySession: (id: string) => void;
    onPauseSession: () => void;
    currentTime: number;
    duration: number;
    onSeek: (time: number) => void;
}

export const TranscriptionView: React.FC<TranscriptionViewProps> = ({
    onPlayChunk, playingUrl, ollamaModel,
    isPlaying, onPlaySession, onPauseSession, currentTime, duration, onSeek
}) => {
    const {
        currentSession, selectedSession, isRecording,
        generateSummary
    } = useSessionContext();
    const { sendMessage, subscribe } = useWebSocketContext();

    // Local state for UI
    const [activeTab, setActiveTab] = useState<TabType>('dialogue');
    const [shouldAutoScroll, setShouldAutoScroll] = useState(false);

    // Refs
    const transcriptionRef = useRef<HTMLDivElement>(null);
    const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);
    const [transcribingChunkId, setTranscribingChunkId] = useState<string | null>(null);

    // Derived state
    const displaySession = selectedSession || currentSession;
    const chunks = displaySession?.chunks || [];

    // Subscribe to chunk events for highlighting/scrolling
    useEffect(() => {
        const unsubChunkCreated = subscribe('chunk_created', () => {
            setShouldAutoScroll(true);
        });
        const unsubTranscribed = subscribe('chunk_transcribed', (msg) => {
            if (isRecording) setShouldAutoScroll(true);
            setTranscribingChunkId(prev => prev === msg.chunk.id ? null : prev);
            setHighlightedChunkId(msg.chunk.id);
            setTimeout(() => setHighlightedChunkId(null), 2000);
        });

        return () => { unsubChunkCreated(); unsubTranscribed(); };
    }, [subscribe, isRecording]);

    // Auto Scroll logic
    useEffect(() => {
        if (shouldAutoScroll && transcriptionRef.current) {
            transcriptionRef.current.scrollTo({
                top: transcriptionRef.current.scrollHeight,
                behavior: 'smooth'
            });
            setShouldAutoScroll(false);
        }
    }, [shouldAutoScroll]);

    // Compute Dialogue with defensive null checks
    const allDialogue: TranscriptSegment[] = (chunks || [])
        .filter(c => c && c.status === 'completed')
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .flatMap((c) => {
            if (c.dialogue && Array.isArray(c.dialogue) && c.dialogue.length > 0) {
                const chunkOffset = (chunks || [])
                    .filter(prev => prev && (prev.index || 0) < (c.index || 0))
                    .reduce((sum, prev) => sum + ((prev.duration || 0) / 1000000), 0);

                return c.dialogue
                    .filter(seg => seg && typeof seg.start === 'number')
                    .map(seg => ({
                        ...seg,
                        start: (seg.start || 0) + chunkOffset,
                        end: (seg.end || 0) + chunkOffset,
                        text: seg.text || '',
                        speaker: seg.speaker || 'unknown'
                    }));
            }
            return [];
        });

    // Handlers
    const handleRetranscribe = (chunkId: string) => {
        setTranscribingChunkId(chunkId);
        sendMessage({ type: 'retranscribe_chunk', chunkId });
    };

    // Summary state is in SessionContext (summary field),
    // but generating state is handled by events.
    // I need isGeneratingSummary state.
    const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
    const [summaryError, setSummaryError] = useState<string | null>(null);

    useEffect(() => {
        const unsubStart = subscribe('summary_started', () => { setIsGeneratingSummary(true); setSummaryError(null); });
        const unsubEnd = subscribe('summary_completed', () => { setIsGeneratingSummary(false); });
        const unsubErr = subscribe('summary_error', (m) => { setIsGeneratingSummary(false); setSummaryError(m.error); });
        return () => { unsubStart(); unsubEnd(); unsubErr(); };
    }, [subscribe]);

    const handleGenerateSummary = () => {
        if (displaySession) {
            // Use provided ollamaModel or default. URL usually localhost:11434
            generateSummary(displaySession.id, ollamaModel, 'http://localhost:11434');
        }
    };

    return (
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {(selectedSession || isRecording) && (
                <div style={{ flexShrink: 0, backgroundColor: 'var(--app-bg)', borderBottom: '1px solid var(--border)', padding: '0 0' }}>
                    {/* Controls */}
                    {displaySession && !isRecording && (
                        <SessionControls
                            session={displaySession}
                            isPlaying={isPlaying}
                            onPlayPause={() => isPlaying ? onPauseSession() : onPlaySession(displaySession.id)}
                            onSeek={onSeek}
                            currentTime={currentTime}
                            duration={duration || displaySession.totalDuration / 1000} // Fallback to session duration
                            onRetranscribe={() => { /* TODO: Implement global retranscribe */ alert('Retranscribe All (TODO)'); }}
                            onImprove={() => setActiveTab('summary')}
                        />
                    )}

                    {/* SessionTabs */}
                    {displaySession && chunks.length > 0 && (
                        <div style={{ padding: '0 1.5rem' }}>
                            <SessionTabs
                                activeTab={activeTab}
                                onTabChange={setActiveTab}
                                hasSummary={!!displaySession.summary}
                                isGeneratingSummary={isGeneratingSummary}
                                isRecording={isRecording}
                            />
                        </div>
                    )}
                </div>
            )}

            <div ref={transcriptionRef} style={{ flex: 1, padding: '1rem 1.5rem', overflowY: 'auto', overflowX: 'hidden' }}>
                {/* Empty State - Welcome Screen */}
                {chunks.length === 0 && !isRecording && !selectedSession ? (
                    <div style={{ 
                        display: 'flex', 
                        flexDirection: 'column', 
                        alignItems: 'center', 
                        justifyContent: 'center',
                        height: '100%',
                        padding: '2rem',
                        maxWidth: '600px',
                        margin: '0 auto'
                    }}>
                        {/* App Icon */}
                        <div style={{ 
                            width: '80px', 
                            height: '80px', 
                            borderRadius: '20px',
                            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginBottom: '1.5rem',
                            boxShadow: 'var(--shadow-glow-primary)'
                        }}>
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                                <line x1="12" y1="19" x2="12" y2="23"/>
                                <line x1="8" y1="23" x2="16" y2="23"/>
                            </svg>
                        </div>

                        <h1 style={{ 
                            fontSize: '1.5rem', 
                            fontWeight: 'var(--font-weight-bold)',
                            color: 'var(--text-primary)',
                            marginBottom: '0.5rem',
                            textAlign: 'center'
                        }}>
                            AIWisper
                        </h1>
                        <p style={{ 
                            fontSize: '0.95rem', 
                            color: 'var(--text-secondary)',
                            marginBottom: '2rem',
                            textAlign: 'center'
                        }}>
                            Умный транскрибатор с разделением спикеров
                        </p>

                        {/* Quick Start Guide */}
                        <div style={{ 
                            width: '100%',
                            background: 'var(--glass-bg)',
                            backdropFilter: 'blur(var(--glass-blur-light))',
                            borderRadius: 'var(--radius-lg)',
                            border: '1px solid var(--glass-border)',
                            padding: '1.25rem',
                            marginBottom: '1.5rem'
                        }}>
                            <h3 style={{ 
                                fontSize: '0.85rem', 
                                fontWeight: 'var(--font-weight-semibold)',
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                                marginBottom: '1rem'
                            }}>
                                Быстрый старт
                            </h3>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                                    <div style={{ 
                                        width: '28px', 
                                        height: '28px', 
                                        borderRadius: '50%',
                                        background: 'var(--glass-bg-elevated)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        flexShrink: 0,
                                        fontSize: '0.85rem',
                                        fontWeight: 'var(--font-weight-semibold)',
                                        color: 'var(--primary)'
                                    }}>1</div>
                                    <div>
                                        <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 'var(--font-weight-medium)' }}>
                                            Нажмите «Новая запись»
                                        </div>
                                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '2px' }}>
                                            Кнопка внизу боковой панели
                                        </div>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                                    <div style={{ 
                                        width: '28px', 
                                        height: '28px', 
                                        borderRadius: '50%',
                                        background: 'var(--glass-bg-elevated)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        flexShrink: 0,
                                        fontSize: '0.85rem',
                                        fontWeight: 'var(--font-weight-semibold)',
                                        color: 'var(--primary)'
                                    }}>2</div>
                                    <div>
                                        <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 'var(--font-weight-medium)' }}>
                                            Говорите или включите звонок
                                        </div>
                                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '2px' }}>
                                            Записывается микрофон и системный звук
                                        </div>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                                    <div style={{ 
                                        width: '28px', 
                                        height: '28px', 
                                        borderRadius: '50%',
                                        background: 'var(--glass-bg-elevated)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        flexShrink: 0,
                                        fontSize: '0.85rem',
                                        fontWeight: 'var(--font-weight-semibold)',
                                        color: 'var(--primary)'
                                    }}>3</div>
                                    <div>
                                        <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 'var(--font-weight-medium)' }}>
                                            Остановите для получения текста
                                        </div>
                                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '2px' }}>
                                            Транскрипция с разделением «Вы» / «Собеседник»
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Features */}
                        <div style={{ 
                            display: 'grid', 
                            gridTemplateColumns: 'repeat(2, 1fr)', 
                            gap: '0.75rem',
                            width: '100%'
                        }}>
                            <div style={{ 
                                padding: '0.75rem 1rem',
                                background: 'var(--glass-bg)',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--glass-border-subtle)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem'
                            }}>
                                <span style={{ fontSize: '1.1rem' }}>🎯</span>
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Точное распознавание</span>
                            </div>
                            <div style={{ 
                                padding: '0.75rem 1rem',
                                background: 'var(--glass-bg)',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--glass-border-subtle)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem'
                            }}>
                                <span style={{ fontSize: '1.1rem' }}>👥</span>
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Разделение спикеров</span>
                            </div>
                            <div style={{ 
                                padding: '0.75rem 1rem',
                                background: 'var(--glass-bg)',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--glass-border-subtle)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem'
                            }}>
                                <span style={{ fontSize: '1.1rem' }}>📝</span>
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>AI-сводка</span>
                            </div>
                            <div style={{ 
                                padding: '0.75rem 1rem',
                                background: 'var(--glass-bg)',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--glass-border-subtle)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem'
                            }}>
                                <span style={{ fontSize: '1.1rem' }}>🔒</span>
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Локальная обработка</span>
                            </div>
                        </div>

                        <p style={{ 
                            fontSize: '0.75rem', 
                            color: 'var(--text-muted)',
                            marginTop: '1.5rem',
                            textAlign: 'center'
                        }}>
                            Выберите запись слева или начните новую
                        </p>
                    </div>
                ) : chunks.length === 0 && isRecording ? (
                    <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '3rem' }}>
                        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔴</div>
                        <div>Идёт запись... Транскрипция появится после остановки</div>
                    </div>
                ) : (
                    <>
                        {/* Tab: Dialogue */}
                        {activeTab === 'dialogue' && (
                            <>
                                {allDialogue.length > 0 ? (
                                    <div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'var(--surface)', borderRadius: '8px', lineHeight: '1.9', fontSize: '0.95rem' }}>
                                        <h4 style={{ margin: '0 0 1rem 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Диалог</h4>
                                        {allDialogue.map((seg, idx) => {
                                            const isMic = seg.speaker === 'mic';
                                            const totalMs = seg.start || 0;
                                            const mins = Math.floor(totalMs / 60000) || 0;
                                            const secs = Math.floor((totalMs % 60000) / 1000) || 0;
                                            const ms = Math.floor((totalMs % 1000) / 100) || 0;
                                            const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;

                                            // Определяем имя спикера и цвет
                                            let speakerName: string;
                                            let speakerColor: string;
                                            if (isMic) {
                                                speakerName = 'Вы';
                                                speakerColor = '#4caf50';
                                            } else if (seg.speaker?.startsWith('Speaker ')) {
                                                // Извлекаем номер спикера (Speaker 0 -> Собеседник 1)
                                                const speakerNum = parseInt(seg.speaker.replace('Speaker ', ''), 10) || 0;
                                                speakerName = `Собеседник ${speakerNum + 1}`;
                                                // Разные цвета для разных спикеров (оттенки синего/голубого/фиолетового)
                                                const colors = [
                                                    '#2196f3', // Blue
                                                    '#00bcd4', // Cyan
                                                    '#3f51b5', // Indigo
                                                    '#03a9f4', // Light Blue
                                                    '#673ab7', // Deep Purple
                                                    '#5c6bc0'  // Indigo Light
                                                ];
                                                speakerColor = colors[Math.abs(speakerNum) % colors.length];
                                            } else if (seg.speaker === 'sys') {
                                                speakerName = 'Собеседник';
                                                speakerColor = '#2196f3';
                                            } else {
                                                speakerName = seg.speaker || 'Собеседник';
                                                speakerColor = '#2196f3';
                                            }

                                            return (
                                                <div key={idx} style={{ marginBottom: '0.5rem', paddingLeft: '0.5rem', borderLeft: `3px solid ${speakerColor}` }}>
                                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontFamily: 'monospace' }}>[{timeStr}]</span>{' '}
                                                    <span style={{ color: speakerColor, fontWeight: 'bold' }}>{speakerName}:</span>{' '}
                                                    <span style={{ color: 'var(--text-primary)' }}>{seg.text || ''}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    // Fallback text (chunk based)
                                    (chunks || []).filter(chunk => chunk).map(chunk => (
                                        <div key={chunk.id || Math.random()} style={{ marginBottom: '0.8rem', padding: '0.5rem 0.75rem', backgroundColor: 'rgba(255, 255, 255, 0.03)', borderRadius: '4px', color: '#ccc' }}>
                                            {chunk.transcription || ''}
                                        </div>
                                    ))
                                )}
                            </>
                        )}

                        {/* Tab: Chunks */}
                        {activeTab === 'chunks' && (
                            <div>
                                {(chunks || []).filter(chunk => chunk).map(chunk => (
                                    <div key={chunk.id || Math.random()} style={{
                                        padding: '0.6rem 0.8rem', marginBottom: '0.4rem',
                                        backgroundColor: transcribingChunkId === chunk.id ? '#2a2a1a' : highlightedChunkId === chunk.id ? '#1a3a2a' : '#12121f',
                                        borderRadius: '4px', borderLeft: `3px solid ${chunk.status === 'completed' ? '#4caf50' : chunk.status === 'error' ? '#f44336' : '#ff9800'}`
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span style={{ color: '#888' }}>#{chunk.index ?? 0} • {((chunk.duration || 0) / 1e9).toFixed(1)}s</span>
                                            <div style={{ display: 'flex', gap: '5px' }}>
                                                {displaySession && (
                                                    <button onClick={() => onPlayChunk(`${API_BASE}/api/sessions/${displaySession.id}/chunk/${chunk.index ?? 0}.mp3`)}>
                                                        {playingUrl?.includes(`chunk/${chunk.index ?? 0}.mp3`) ? '⏹' : '▶'}
                                                    </button>
                                                )}
                                                <button onClick={() => chunk.id && handleRetranscribe(chunk.id)}>🔄</button>
                                            </div>
                                        </div>
                                        <div style={{ marginTop: '0.4rem', color: '#ccc' }}>{chunk.transcription || ''}</div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Tab: Summary */}
                        {activeTab === 'summary' && displaySession && (
                            <SummaryView
                                summary={displaySession.summary || null}
                                isGenerating={isGeneratingSummary}
                                error={summaryError}
                                onGenerate={handleGenerateSummary}
                                hasTranscription={chunks.some(c => c.status === 'completed')}
                                sessionDate={displaySession.startTime}
                            />
                        )}
                    </>
                )}
            </div>
        </main>
    );
};
