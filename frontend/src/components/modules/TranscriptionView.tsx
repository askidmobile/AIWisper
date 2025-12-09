import React, { useState, useRef, useEffect } from 'react';
import { useSessionContext } from '../../context/SessionContext';
import { useWebSocketContext } from '../../context/WebSocketContext';
import SessionTabs, { TabType } from '../SessionTabs';
import SummaryView from '../SummaryView';
import { SessionControls } from './SessionControls';
import { TranscriptSegment } from '../../types/session';

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

    // Compute Dialogue
    const allDialogue: TranscriptSegment[] = chunks
        .filter(c => c.status === 'completed')
        .sort((a, b) => a.index - b.index)
        .flatMap((c) => {
            if (c.dialogue && c.dialogue.length > 0) {
                const chunkOffset = chunks
                    .filter(prev => prev.index < c.index)
                    .reduce((sum, prev) => sum + (prev.duration / 1000000), 0);

                return c.dialogue.map(seg => ({
                    ...seg,
                    start: seg.start + chunkOffset,
                    end: seg.end + chunkOffset
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

            <div ref={transcriptionRef} style={{ flex: 1, padding: '1rem 1.5rem', overflowY: 'auto' }}>
                {/* Empty State */}
                {chunks.length === 0 && !isRecording && !selectedSession ? (
                    <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '3rem' }}>
                        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🎙</div>
                        <div>Нажмите «Запись» чтобы начать</div>
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
                                            const totalMs = seg.start;
                                            const mins = Math.floor(totalMs / 60000);
                                            const secs = Math.floor((totalMs % 60000) / 1000);
                                            const ms = Math.floor((totalMs % 1000) / 100);
                                            const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;

                                            return (
                                                <div key={idx} style={{ marginBottom: '0.5rem', paddingLeft: '0.5rem', borderLeft: isMic ? '3px solid #4caf50' : '3px solid #2196f3' }}>
                                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontFamily: 'monospace' }}>[{timeStr}]</span>{' '}
                                                    <span style={{ color: isMic ? '#4caf50' : '#2196f3', fontWeight: 'bold' }}>{isMic ? 'Вы' : 'Собеседник'}:</span>{' '}
                                                    <span style={{ color: 'var(--text-primary)' }}>{seg.text}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    // Fallback text (chunk based)
                                    chunks.map(chunk => (
                                        <div key={chunk.id} style={{ marginBottom: '0.8rem', padding: '0.5rem 0.75rem', backgroundColor: 'rgba(255, 255, 255, 0.03)', borderRadius: '4px', color: '#ccc' }}>
                                            {chunk.transcription}
                                        </div>
                                    ))
                                )}
                            </>
                        )}

                        {/* Tab: Chunks */}
                        {activeTab === 'chunks' && (
                            <div>
                                {chunks.map(chunk => (
                                    <div key={chunk.id} style={{
                                        padding: '0.6rem 0.8rem', marginBottom: '0.4rem',
                                        backgroundColor: transcribingChunkId === chunk.id ? '#2a2a1a' : highlightedChunkId === chunk.id ? '#1a3a2a' : '#12121f',
                                        borderRadius: '4px', borderLeft: `3px solid ${chunk.status === 'completed' ? '#4caf50' : chunk.status === 'error' ? '#f44336' : '#ff9800'}`
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span style={{ color: '#888' }}>#{chunk.index} • {(chunk.duration / 1e9).toFixed(1)}s</span>
                                            <div style={{ display: 'flex', gap: '5px' }}>
                                                {displaySession && (
                                                    <button onClick={() => onPlayChunk(`http://localhost:8080/api/sessions/${displaySession.id}/chunk/${chunk.index}.mp3`)}>
                                                        {playingUrl?.includes(`chunk/${chunk.index}.mp3`) ? '⏹' : '▶'}
                                                    </button>
                                                )}
                                                <button onClick={() => handleRetranscribe(chunk.id)}>🔄</button>
                                            </div>
                                        </div>
                                        <div style={{ marginTop: '0.4rem', color: '#ccc' }}>{chunk.transcription}</div>
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
