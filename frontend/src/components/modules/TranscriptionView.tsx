import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useSessionContext } from '../../context/SessionContext';
import { useWebSocketContext } from '../../context/WebSocketContext';
import SessionTabs, { TabType } from '../SessionTabs';
import SummaryView from '../SummaryView';
import { SessionControls } from './SessionControls';
import { TranscriptSegment } from '../../types/session';
import { SessionSpeaker } from '../../types/voiceprint';

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
    // Session speakers for custom names
    sessionSpeakers?: SessionSpeaker[];
}

export const TranscriptionView: React.FC<TranscriptionViewProps> = ({
    onPlayChunk, playingUrl, ollamaModel,
    isPlaying, onPlaySession, onPauseSession, currentTime, duration, onSeek,
    sessionSpeakers = []
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
    const segmentRefs = useRef<Map<number, HTMLDivElement>>(new Map());
    const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);
    const [transcribingChunkId, setTranscribingChunkId] = useState<string | null>(null);
    const [autoScrollToPlayback, setAutoScrollToPlayback] = useState(true);

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
    // ВАЖНО: Backend уже применяет chunk.StartMs к timestamps сегментов (transcription.go:390-397)
    // Поэтому НЕ добавляем chunkOffset здесь - timestamps уже глобальные
    const allDialogue: TranscriptSegment[] = useMemo(() => (chunks || [])
        .filter(c => c && c.status === 'completed')
        .flatMap((c) => {
            if (c.dialogue && Array.isArray(c.dialogue) && c.dialogue.length > 0) {
                return c.dialogue
                    .filter(seg => seg && typeof seg.start === 'number')
                    .map(seg => ({
                        ...seg,
                        start: seg.start || 0,
                        end: seg.end || 0,
                        text: seg.text || '',
                        speaker: seg.speaker || 'unknown'
                    }));
            }
            return [];
        })
        // ВАЖНО: Сортируем по времени начала для правильного порядка диалога
        // Mic и Sys сегменты могут идти вперемешку по времени, нужно упорядочить
        .sort((a, b) => a.start - b.start), [chunks]);

    // Находим текущий сегмент по времени воспроизведения
    const currentTimeMs = currentTime * 1000; // секунды -> миллисекунды
    const currentSegmentIndex = useMemo(() => {
        if (!isPlaying || allDialogue.length === 0) return -1;
        
        // Ищем сегмент, в который попадает текущее время
        for (let i = 0; i < allDialogue.length; i++) {
            const seg = allDialogue[i];
            if (currentTimeMs >= seg.start && currentTimeMs < seg.end) {
                return i;
            }
            // Если между сегментами - показываем предыдущий
            if (i < allDialogue.length - 1 && currentTimeMs >= seg.end && currentTimeMs < allDialogue[i + 1].start) {
                return i;
            }
        }
        // Если после последнего сегмента
        if (allDialogue.length > 0 && currentTimeMs >= allDialogue[allDialogue.length - 1].start) {
            return allDialogue.length - 1;
        }
        return -1;
    }, [currentTimeMs, isPlaying, allDialogue]);

    // Вычисляем позицию индикатора на скроллбаре (0-100%)
    const scrollbarIndicatorPosition = useMemo(() => {
        if (allDialogue.length === 0 || duration <= 0) return 0;
        return Math.min(100, Math.max(0, (currentTime / duration) * 100));
    }, [currentTime, duration, allDialogue.length]);

    // Автоскролл к текущему сегменту при воспроизведении
    useEffect(() => {
        if (!isPlaying || !autoScrollToPlayback || currentSegmentIndex < 0) return;
        
        const segmentEl = segmentRefs.current.get(currentSegmentIndex);
        if (segmentEl && transcriptionRef.current) {
            const container = transcriptionRef.current;
            const segmentRect = segmentEl.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            
            // Скроллим только если сегмент вне видимой области
            const isVisible = segmentRect.top >= containerRect.top && segmentRect.bottom <= containerRect.bottom;
            if (!isVisible) {
                segmentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }, [currentSegmentIndex, isPlaying, autoScrollToPlayback]);

    // Обработчик клика по сегменту для перемотки
    const handleSegmentClick = useCallback((segmentStart: number) => {
        const timeInSeconds = segmentStart / 1000;
        onSeek(timeInSeconds);
    }, [onSeek]);

    // Сохраняем ref для сегмента
    const setSegmentRef = useCallback((idx: number, el: HTMLDivElement | null) => {
        if (el) {
            segmentRefs.current.set(idx, el);
        } else {
            segmentRefs.current.delete(idx);
        }
    }, []);

    // Функция для получения отображаемого имени спикера
    // Приоритет: sessionSpeakers (кастомные имена) > дефолтные имена
    const getSpeakerDisplayName = useCallback((speaker: string): { name: string; color: string } => {
        const defaultColors = {
            mic: '#4caf50',
            sys: '#2196f3',
            speakers: ['#2196f3', '#00bcd4', '#3f51b5', '#03a9f4', '#673ab7', '#5c6bc0']
        };

        // Проверяем кастомные имена из sessionSpeakers
        if (sessionSpeakers.length > 0) {
            // Ищем по разным форматам спикера
            const found = sessionSpeakers.find(s => {
                if (speaker === 'mic' || speaker === 'Вы') {
                    return s.isMic;
                }
                if (speaker === 'sys' || speaker === 'Собеседник') {
                    return !s.isMic && s.localId === 0;
                }
                if (speaker.startsWith('Speaker ')) {
                    const num = parseInt(speaker.replace('Speaker ', ''), 10);
                    return !s.isMic && s.localId === num;
                }
                if (speaker.startsWith('Собеседник ')) {
                    const num = parseInt(speaker.replace('Собеседник ', ''), 10);
                    return !s.isMic && s.localId === (num - 1);
                }
                // Прямое совпадение по displayName (для уже переименованных)
                return s.displayName === speaker;
            });

            if (found) {
                const colorIdx = found.isMic ? -1 : found.localId;
                const color = found.isMic 
                    ? defaultColors.mic 
                    : defaultColors.speakers[Math.abs(colorIdx) % defaultColors.speakers.length];
                return { name: found.displayName, color };
            }
        }

        // Дефолтная логика если не нашли в sessionSpeakers
        if (speaker === 'mic') {
            return { name: 'Вы', color: defaultColors.mic };
        }
        if (speaker === 'sys' || speaker === 'Собеседник') {
            return { name: 'Собеседник', color: defaultColors.sys };
        }
        if (speaker.startsWith('Speaker ')) {
            const num = parseInt(speaker.replace('Speaker ', ''), 10) || 0;
            return { 
                name: `Собеседник ${num + 1}`, 
                color: defaultColors.speakers[Math.abs(num) % defaultColors.speakers.length] 
            };
        }
        if (speaker.startsWith('Собеседник ')) {
            const num = parseInt(speaker.replace('Собеседник ', ''), 10) || 1;
            return { 
                name: speaker, 
                color: defaultColors.speakers[Math.abs(num - 1) % defaultColors.speakers.length] 
            };
        }

        // Кастомное имя - возвращаем как есть
        return { name: speaker, color: defaultColors.sys };
    }, [sessionSpeakers]);

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

            <div 
                ref={transcriptionRef} 
                style={{ flex: 1, padding: '1rem 1.5rem', overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
                onScroll={() => {
                    // Отключаем автоскролл при ручной прокрутке во время воспроизведения
                    if (isPlaying) setAutoScrollToPlayback(false);
                }}
            >
                {/* Индикатор позиции воспроизведения на скроллбаре */}
                {isPlaying && allDialogue.length > 0 && (
                    <div 
                        style={{
                            position: 'fixed',
                            right: '8px',
                            top: `calc(${scrollbarIndicatorPosition}% + 100px)`, // +100px для header offset
                            width: '6px',
                            height: '20px',
                            backgroundColor: 'var(--primary)',
                            borderRadius: '3px',
                            zIndex: 100,
                            boxShadow: '0 0 8px var(--primary)',
                            transition: 'top 0.1s linear',
                            cursor: 'pointer',
                            pointerEvents: 'auto'
                        }}
                        onClick={() => setAutoScrollToPlayback(true)}
                        title="Нажмите для автоскролла к текущей позиции"
                    />
                )}
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
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                            <h4 style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Диалог</h4>
                                            {isPlaying && (
                                                <button
                                                    onClick={() => setAutoScrollToPlayback(!autoScrollToPlayback)}
                                                    style={{
                                                        padding: '4px 8px',
                                                        fontSize: '0.75rem',
                                                        backgroundColor: autoScrollToPlayback ? 'var(--primary)' : 'transparent',
                                                        color: autoScrollToPlayback ? 'white' : 'var(--text-muted)',
                                                        border: '1px solid var(--border)',
                                                        borderRadius: '4px',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s'
                                                    }}
                                                    title={autoScrollToPlayback ? 'Автоскролл включён' : 'Автоскролл выключен'}
                                                >
                                                    {autoScrollToPlayback ? '📍 Следить' : '📍 Не следить'}
                                                </button>
                                            )}
                                        </div>
                                        {allDialogue.map((seg, idx) => {
                                            const totalMs = seg.start || 0;
                                            const mins = Math.floor(totalMs / 60000) || 0;
                                            const secs = Math.floor((totalMs % 60000) / 1000) || 0;
                                            const ms = Math.floor((totalMs % 1000) / 100) || 0;
                                            const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;

                                            // Получаем имя и цвет спикера (с учётом кастомных имён из sessionSpeakers)
                                            const { name: speakerName, color: speakerColor } = getSpeakerDisplayName(seg.speaker || '');

                                            const isCurrentSegment = idx === currentSegmentIndex;

                                            return (
                                                <div 
                                                    key={idx} 
                                                    ref={(el) => setSegmentRef(idx, el)}
                                                    onClick={() => handleSegmentClick(seg.start)}
                                                    style={{ 
                                                        marginBottom: '0.5rem', 
                                                        paddingLeft: '0.5rem', 
                                                        paddingRight: '0.5rem',
                                                        paddingTop: '0.25rem',
                                                        paddingBottom: '0.25rem',
                                                        borderLeft: `3px solid ${speakerColor}`,
                                                        backgroundColor: isCurrentSegment ? 'rgba(138, 43, 226, 0.15)' : 'transparent',
                                                        borderRadius: isCurrentSegment ? '0 4px 4px 0' : '0',
                                                        transition: 'background-color 0.2s ease',
                                                        cursor: 'pointer',
                                                        position: 'relative'
                                                    }}
                                                >
                                                    {/* Индикатор текущего сегмента */}
                                                    {isCurrentSegment && (
                                                        <div style={{
                                                            position: 'absolute',
                                                            left: '-3px',
                                                            top: 0,
                                                            bottom: 0,
                                                            width: '3px',
                                                            backgroundColor: 'var(--primary)',
                                                            boxShadow: '0 0 8px var(--primary)',
                                                            animation: 'pulse 1.5s ease-in-out infinite'
                                                        }} />
                                                    )}
                                                    <span 
                                                        style={{ 
                                                            color: isCurrentSegment ? 'var(--primary)' : 'var(--text-muted)', 
                                                            fontSize: '0.8rem', 
                                                            fontFamily: 'monospace',
                                                            fontWeight: isCurrentSegment ? 'bold' : 'normal'
                                                        }}
                                                    >
                                                        [{timeStr}]
                                                    </span>{' '}
                                                    <span style={{ color: speakerColor, fontWeight: 'bold' }}>{speakerName}:</span>{' '}
                                                    <span style={{ color: isCurrentSegment ? 'var(--text-primary)' : 'var(--text-primary)' }}>{seg.text || ''}</span>
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
                                ollamaModel={ollamaModel}
                            />
                        )}
                    </>
                )}
            </div>
        </main>
    );
};
