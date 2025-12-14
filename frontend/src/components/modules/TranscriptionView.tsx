import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useSessionContext } from '../../context/SessionContext';
import { useWebSocketContext } from '../../context/WebSocketContext';
import { useSettingsContext } from '../../context/SettingsContext';
import { useModelContext } from '../../context/ModelContext';
import SessionTabs, { TabType } from '../SessionTabs';
import SummaryView from '../SummaryView';
import SpeakersTab from './SpeakersTab';
import { SessionControls } from './SessionControls';
import { SessionStats } from './SessionStats';
import { TranscriptSegment } from '../../types/session';
import { SessionSpeaker } from '../../types/voiceprint';
import { RecordingView } from '../views/RecordingView';
import { WelcomeViewSimple } from '../views/WelcomeViewSimple';
import { ChunksViewSimple } from '../chunks/ChunksViewSimple';
import { 
    PlaybackProgressLine, 
    ScrollbarPositionIndicator, 
    SegmentText 
} from '../dialogue/DialogueHelpers';
import { WaveformData } from '../../utils/waveform';

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
    // Retranscribe all chunks
    onRetranscribeAll?: () => void;
    // Speaker management
    onRenameSpeaker?: (localId: number, newName: string, saveAsVoiceprint: boolean) => void;
    onPlaySpeakerSample?: (localId: number) => void;
    onStopSpeakerSample?: () => void;
    playingSpeakerId?: number | null;
    // Waveform props
    waveformData?: WaveformData | null;
    waveformLoading?: boolean;
    waveformError?: string | null;
}

export const TranscriptionView: React.FC<TranscriptionViewProps> = ({
    onPlayChunk, playingUrl, ollamaModel,
    isPlaying, onPlaySession, onPauseSession, currentTime, duration, onSeek,
    sessionSpeakers = [],
    onRetranscribeAll,
    onRenameSpeaker,
    onPlaySpeakerSample,
    onStopSpeakerSample,
    playingSpeakerId,
    waveformData,
    waveformLoading,
    waveformError
}) => {
    const {
        currentSession, selectedSession, isRecording,
        generateSummary
    } = useSessionContext();
    const { sendMessage, subscribe } = useWebSocketContext();
    const { activeModelId } = useModelContext();
    const { 
        language, 
        hybridTranscription,
        ollamaModel: settingsOllamaModel,
        ollamaUrl 
    } = useSettingsContext();

    // Local state for UI
    const [activeTab, setActiveTab] = useState<TabType>('dialogue');
    const [shouldAutoScroll, setShouldAutoScroll] = useState(false);
    const [showConfidence, setShowConfidence] = useState(false); // Показывать confidence слов

    // Refs
    const transcriptionRef = useRef<HTMLDivElement>(null); // Scroll container
    const dialogueContainerRef = useRef<HTMLDivElement>(null); // Dialogue content container
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
        if (speaker === 'mic' || speaker === 'Вы') {
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
        if (!displaySession) return;
        
        setTranscribingChunkId(chunkId);
        sendMessage({ 
            type: 'retranscribe_chunk', 
            sessionId: displaySession.id,
            data: chunkId,
            model: activeModelId,
            language: language,
            // Настройки гибридной транскрипции
            hybridEnabled: hybridTranscription.enabled,
            hybridSecondaryModelId: hybridTranscription.secondaryModelId,
            hybridConfidenceThreshold: hybridTranscription.confidenceThreshold,
            hybridContextWords: hybridTranscription.contextWords,
            hybridUseLLMForMerge: hybridTranscription.useLLMForMerge,
            hybridMode: hybridTranscription.mode,
            hybridHotwords: hybridTranscription.hotwords,
            // Модель Ollama для LLM - используем prop или из настроек
            hybridOllamaModel: ollamaModel || settingsOllamaModel,
            hybridOllamaUrl: ollamaUrl,
        });
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
                    {/* Controls with integrated Waveform */}
                    {displaySession && !isRecording && (
                        <SessionControls
                            session={displaySession}
                            isPlaying={isPlaying}
                            onPlayPause={() => {
                                if (isPlaying) {
                                    onPauseSession();
                                } else {
                                    onPlaySession(displaySession.id);
                                }
                            }}
                            onSeek={onSeek}
                            currentTime={currentTime}
                            duration={duration || displaySession.totalDuration / 1000} // Fallback to session duration
                            onRetranscribe={() => onRetranscribeAll?.()}
                            onImprove={() => setActiveTab('summary')}
                            waveformData={waveformData}
                            waveformLoading={waveformLoading}
                            waveformError={waveformError}
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
                                speakersCount={sessionSpeakers.length}
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
                {/* Индикатор позиции воспроизведения на скроллбаре (точка справа) */}
                {isPlaying && allDialogue.length > 0 && activeTab === 'dialogue' && (
                    <ScrollbarPositionIndicator
                        currentTimeMs={currentTimeMs}
                        segments={allDialogue}
                        scrollContainerRef={transcriptionRef}
                        dialogueContainerRef={dialogueContainerRef}
                        segmentRefs={segmentRefs}
                        onClickScrollToPlayback={() => setAutoScrollToPlayback(true)}
                    />
                )}
                {/* Empty State - Welcome Screen */}
                {chunks.length === 0 && !isRecording && !selectedSession ? (
                    <WelcomeViewSimple />
                ) : chunks.length === 0 && isRecording ? (
                    <RecordingView />
                ) : (
                    <>
                        {/* Tab: Dialogue */}
                        {activeTab === 'dialogue' && (
                            <>
                                {allDialogue.length > 0 ? (
                                    <div 
                                        ref={dialogueContainerRef}
                                        style={{ 
                                            marginBottom: '1.5rem', 
                                            padding: '1rem', 
                                            backgroundColor: 'var(--surface)', 
                                            borderRadius: '8px', 
                                            lineHeight: '1.9', 
                                            fontSize: '0.95rem',
                                            position: 'relative' // Для позиционирования линии воспроизведения
                                        }}
                                    >
                                        {/* Горизонтальная линия индикатора воспроизведения */}
                                        {isPlaying && (
                                            <PlaybackProgressLine
                                                currentTimeMs={currentTimeMs}
                                                segments={allDialogue}
                                                dialogueContainerRef={dialogueContainerRef}
                                                segmentRefs={segmentRefs}
                                            />
                                        )}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '8px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                <h4 style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Диалог</h4>
                                                {displaySession && (
                                                    <SessionStats
                                                        dialogue={allDialogue}
                                                        totalDuration={displaySession.totalDuration}
                                                        isCompact={true}
                                                    />
                                                )}
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                            {isPlaying && (
                                                <button
                                                    onClick={() => setAutoScrollToPlayback(!autoScrollToPlayback)}
                                                    style={{
                                                        padding: '4px 10px',
                                                        fontSize: '0.75rem',
                                                        backgroundColor: autoScrollToPlayback 
                                                            ? 'var(--glass-bg-elevated)' 
                                                            : 'transparent',
                                                        color: autoScrollToPlayback 
                                                            ? 'var(--text-primary)' 
                                                            : 'var(--text-muted)',
                                                        border: autoScrollToPlayback 
                                                            ? '1px solid var(--glass-border)' 
                                                            : '1px solid var(--border)',
                                                        borderRadius: '6px',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s',
                                                        backdropFilter: autoScrollToPlayback ? 'blur(8px)' : 'none',
                                                        WebkitBackdropFilter: autoScrollToPlayback ? 'blur(8px)' : 'none',
                                                    }}
                                                    title={autoScrollToPlayback ? 'Автоскролл включён' : 'Автоскролл выключен'}
                                                >
                                                    {autoScrollToPlayback ? '📍 Следить' : '📍 Следить'}
                                                </button>
                                            )}
                                            {/* Кнопка показа confidence */}
                                            <button
                                                onClick={() => setShowConfidence(!showConfidence)}
                                                style={{
                                                    padding: '4px 10px',
                                                    fontSize: '0.75rem',
                                                    backgroundColor: showConfidence 
                                                        ? 'var(--glass-bg-elevated)' 
                                                        : 'transparent',
                                                    color: showConfidence 
                                                        ? 'var(--text-primary)' 
                                                        : 'var(--text-muted)',
                                                    border: showConfidence 
                                                        ? '1px solid var(--glass-border)' 
                                                        : '1px solid var(--border)',
                                                    borderRadius: '6px',
                                                    cursor: 'pointer',
                                                    transition: 'all 0.2s',
                                                    backdropFilter: showConfidence ? 'blur(8px)' : 'none',
                                                    WebkitBackdropFilter: showConfidence ? 'blur(8px)' : 'none',
                                                }}
                                                title={showConfidence 
                                                    ? 'Скрыть подсветку уверенности распознавания' 
                                                    : 'Показать слова с низкой уверенностью распознавания (жёлтый <70%, оранжевый <40%)'
                                                }
                                            >
                                                {showConfidence ? '🎯 Confidence' : '🎯 Confidence'}
                                            </button>
                                            </div>
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
                                                    <SegmentText segment={seg} showConfidence={showConfidence} isCurrentSegment={isCurrentSegment} />
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
                        {activeTab === 'chunks' && displaySession && (
                            <ChunksViewSimple
                                chunks={chunks}
                                sessionId={displaySession.id}
                                playingUrl={playingUrl}
                                highlightedChunkId={highlightedChunkId}
                                transcribingChunkId={transcribingChunkId}
                                onPlayChunk={onPlayChunk}
                                onRetranscribe={handleRetranscribe}
                            />
                        )}

                        {/* Tab: Stats */}
                        {activeTab === 'stats' && displaySession && (
                            <SessionStats
                                dialogue={allDialogue}
                                totalDuration={displaySession.totalDuration}
                            />
                        )}

                        {/* Tab: Speakers */}
                        {activeTab === 'speakers' && displaySession && onRenameSpeaker && (
                            <SpeakersTab
                                sessionId={displaySession.id}
                                speakers={sessionSpeakers}
                                onRename={onRenameSpeaker}
                                onPlaySample={onPlaySpeakerSample}
                                onStopSample={onStopSpeakerSample}
                                playingSpeakerId={playingSpeakerId}
                            />
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
