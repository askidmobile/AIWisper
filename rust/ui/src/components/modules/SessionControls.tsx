import React, { useRef, useState, useEffect } from 'react';
import { Session } from '../../types/session';
import { useExport } from '../../hooks/useExport';
import { useSessionContext } from '../../context/SessionContext';
import { useBackendContext } from '../../context/BackendContext';
import WaveformDisplay from '../WaveformDisplay';
import { WaveformData } from '../../utils/waveform';

type WaveformViewMode = 'simple' | 'detailed' | 'hidden';

interface SessionControlsProps {
    session: Session;
    isPlaying: boolean;
    isPlayingFullSession?: boolean; // true если воспроизводится full.mp3, false если чанк
    playbackOffset?: number; // offset in seconds for chunk playback (to sync with waveform)
    onPlayPause: () => void;
    onSeek: (time: number) => void;
    currentTime: number;
    duration: number;
    onRetranscribe: () => void;
    onImprove: () => void;
    // Waveform props
    waveformData?: WaveformData | null;
    waveformLoading?: boolean;
    waveformError?: string | null;
}

export const SessionControls: React.FC<SessionControlsProps> = ({
    session,
    isPlaying,
    isPlayingFullSession = false,
    playbackOffset = 0,
    onPlayPause,
    onSeek,
    currentTime,
    duration,
    onRetranscribe,
    onImprove,
    waveformData,
    waveformLoading,
    waveformError,
}) => {
    const timelineRef = useRef<HTMLDivElement>(null);
    const [hoverTime, setHoverTime] = useState<number | null>(null);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [showExportMenu, setShowExportMenu] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);
    
    // Title editing state
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [editedTitle, setEditedTitle] = useState(session.title || '');
    
    // Tags editing state
    const [showTagsEditor, setShowTagsEditor] = useState(false);
    const [newTag, setNewTag] = useState('');
    
    const { sendMessage } = useBackendContext();
    
    // Full retranscription state from context
    const {
        isFullTranscribing,
        fullTranscriptionProgress,
        fullTranscriptionStatus,
        fullTranscriptionError,
        fullTranscriptionSessionId,
        cancelFullTranscription,
        isRecording,
    } = useSessionContext();
    
    // Update edited title when session changes
    useEffect(() => {
        setEditedTitle(session.title || '');
    }, [session.title]);
    
    // Check if this session is being retranscribed
    const isThisSessionTranscribing = isFullTranscribing && fullTranscriptionSessionId === session.id;
    
    // Waveform view mode - persist in localStorage
    const [waveformViewMode, setWaveformViewMode] = useState<WaveformViewMode>(() => {
        const saved = localStorage.getItem('waveformViewMode');
        return (saved === 'simple' || saved === 'detailed' || saved === 'hidden') ? saved : 'simple';
    });
    
    useEffect(() => {
        localStorage.setItem('waveformViewMode', waveformViewMode);
    }, [waveformViewMode]);
    
    const { copyToClipboard, exportTXT, exportSRT, exportVTT, exportJSON, exportMarkdown } = useExport();

    const handleTimelineClick = (e: React.MouseEvent) => {
        if (!timelineRef.current || duration === 0) return;
        const rect = timelineRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percent = Math.min(Math.max(x / rect.width, 0), 1);
        onSeek(percent * duration);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!timelineRef.current || duration === 0) return;
        const rect = timelineRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percent = Math.min(Math.max(x / rect.width, 0), 1);
        setHoverTime(percent * duration);
    };

    const formatTime = (t: number) => {
        if (!isFinite(t) || isNaN(t)) return '0:00';
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    // Для простого waveform всегда используем длительность сессии
    const sessionDuration = (session.totalDuration || 0) / 1000;
    
    // displayDuration используется для кнопок перемотки и детального waveform
    const displayDuration =
        isFinite(duration) && duration > 0 ? duration : sessionDuration;

    const handleSkip = (seconds: number) => {
        const newTime = Math.max(0, Math.min(currentTime + seconds, displayDuration));
        onSeek(newTime);
    };

    const cycleSpeed = () => {
        const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
        const currentIndex = speeds.indexOf(playbackSpeed);
        const nextIndex = (currentIndex + 1) % speeds.length;
        setPlaybackSpeed(speeds[nextIndex]);
    };

    // Прогресс для простого waveform - показываем только при воспроизведении полной сессии
    // При воспроизведении чанка currentTime относится к чанку, а не к сессии
    const progress = isPlayingFullSession && sessionDuration > 0 
        ? (currentTime / sessionDuration) * 100 
        : 0;
    
    // Title handlers
    const handleSaveTitle = () => {
        if (editedTitle.trim() && editedTitle !== session.title) {
            sendMessage({
                type: 'update_session_title',
                sessionId: session.id,
                title: editedTitle.trim(),
            });
        }
        setIsEditingTitle(false);
    };
    
    const handleCancelTitleEdit = () => {
        setEditedTitle(session.title || '');
        setIsEditingTitle(false);
    };
    
    // Tags handlers
    const handleAddTag = () => {
        const tag = newTag.trim();
        if (tag && !session.tags?.includes(tag)) {
            const newTags = [...(session.tags || []), tag];
            sendMessage({
                type: 'update_session_tags',
                sessionId: session.id,
                tags: newTags,
            });
            setNewTag('');
        }
    };
    
    const handleRemoveTag = (tag: string) => {
        const newTags = (session.tags || []).filter(t => t !== tag);
        sendMessage({
            type: 'update_session_tags',
            sessionId: session.id,
            tags: newTags,
        });
    };

    return (
        <div
            className="glass-surface"
            style={{
                margin: '0 1rem 1rem',
                padding: '1rem 1.25rem',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--glass-bg)',
                backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                border: '1px solid var(--glass-border)',
            }}
        >
            {/* Session Title & Tags */}
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: '1rem',
                    gap: '1rem',
                }}
            >
                <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Editable Title */}
                    {isEditingTitle ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                            <input
                                type="text"
                                value={editedTitle}
                                onChange={(e) => setEditedTitle(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveTitle();
                                    if (e.key === 'Escape') handleCancelTitleEdit();
                                }}
                                autoFocus
                                style={{
                                    flex: 1,
                                    padding: '0.4rem 0.6rem',
                                    fontSize: '1.1rem',
                                    fontWeight: 600,
                                    background: 'var(--glass-bg)',
                                    border: '1px solid var(--primary)',
                                    borderRadius: '8px',
                                    color: 'var(--text-primary)',
                                    outline: 'none',
                                }}
                            />
                            <button
                                onClick={handleSaveTitle}
                                style={{
                                    padding: '0.4rem',
                                    background: 'var(--primary)',
                                    border: 'none',
                                    borderRadius: '6px',
                                    color: 'white',
                                    cursor: 'pointer',
                                }}
                                title="Сохранить"
                            >
                                ✓
                            </button>
                            <button
                                onClick={handleCancelTitleEdit}
                                style={{
                                    padding: '0.4rem',
                                    background: 'var(--glass-bg)',
                                    border: '1px solid var(--border)',
                                    borderRadius: '6px',
                                    color: 'var(--text-muted)',
                                    cursor: 'pointer',
                                }}
                                title="Отмена"
                            >
                                ✕
                            </button>
                        </div>
                    ) : (
                        <h3
                            onClick={() => setIsEditingTitle(true)}
                            style={{
                                margin: 0,
                                fontSize: '1.1rem',
                                fontWeight: 'var(--font-weight-semibold)',
                                color: 'var(--text-primary)',
                                marginBottom: '0.25rem',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                            }}
                            title="Нажмите для редактирования"
                        >
                            {session.title || 'Запись без названия'}
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                style={{ opacity: 0.4 }}
                            >
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                        </h3>
                    )}
                    
                    {/* Date & Tags Row */}
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: '0.5rem',
                        }}
                    >
                        <span
                            style={{
                                fontSize: '0.8rem',
                                color: 'var(--text-muted)',
                            }}
                        >
                            {session.startTime ? new Date(session.startTime).toLocaleDateString('ru-RU', {
                                day: 'numeric',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                            }) : 'Дата неизвестна'}
                        </span>
                        
                        {/* Tags Display - inline with date */}
                        {session.tags && session.tags.length > 0 && (
                            <>
                                <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>•</span>
                                {session.tags.map((tag) => (
                                    <span
                                        key={tag}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '0.2rem',
                                            padding: '0.1rem 0.4rem',
                                            fontSize: '0.7rem',
                                            background: 'var(--primary-alpha)',
                                            color: 'var(--primary)',
                                            borderRadius: '4px',
                                            fontWeight: 500,
                                        }}
                                    >
                                        {tag}
                                        <button
                                            onClick={() => handleRemoveTag(tag)}
                                            style={{
                                                background: 'none',
                                                border: 'none',
                                                padding: '0 0 0 2px',
                                                cursor: 'pointer',
                                                color: 'var(--primary)',
                                                fontSize: '0.6rem',
                                                lineHeight: 1,
                                                opacity: 0.6,
                                            }}
                                            title="Удалить тег"
                                        >
                                            ✕
                                        </button>
                                    </span>
                                ))}
                            </>
                        )}
                    </div>
                </div>
                
                {/* Add Tag Button/Input */}
                <div style={{ position: 'relative' }}>
                    {showTagsEditor ? (
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.4rem',
                            }}
                        >
                            <input
                                type="text"
                                value={newTag}
                                onChange={(e) => setNewTag(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleAddTag();
                                    if (e.key === 'Escape') {
                                        setShowTagsEditor(false);
                                        setNewTag('');
                                    }
                                }}
                                placeholder="Новый тег..."
                                autoFocus
                                style={{
                                    width: '120px',
                                    padding: '0.35rem 0.6rem',
                                    fontSize: '0.8rem',
                                    background: 'var(--glass-bg)',
                                    border: '1px solid var(--primary)',
                                    borderRadius: '8px',
                                    color: 'var(--text-primary)',
                                    outline: 'none',
                                }}
                            />
                            <button
                                onClick={handleAddTag}
                                disabled={!newTag.trim()}
                                style={{
                                    padding: '0.35rem 0.5rem',
                                    background: newTag.trim() ? 'var(--primary)' : 'var(--glass-bg)',
                                    border: 'none',
                                    borderRadius: '6px',
                                    color: newTag.trim() ? 'white' : 'var(--text-muted)',
                                    cursor: newTag.trim() ? 'pointer' : 'not-allowed',
                                    fontSize: '0.8rem',
                                }}
                            >
                                +
                            </button>
                            <button
                                onClick={() => {
                                    setShowTagsEditor(false);
                                    setNewTag('');
                                }}
                                style={{
                                    padding: '0.35rem 0.5rem',
                                    background: 'var(--glass-bg)',
                                    border: '1px solid var(--border)',
                                    borderRadius: '6px',
                                    color: 'var(--text-muted)',
                                    cursor: 'pointer',
                                    fontSize: '0.8rem',
                                }}
                            >
                                ✕
                            </button>
                        </div>
                    ) : (
                        <button
                            className="btn-capsule"
                            onClick={() => setShowTagsEditor(true)}
                            style={{
                                padding: '0.35rem 0.75rem',
                                fontSize: '0.8rem',
                                gap: '0.3rem',
                            }}
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            Добавить тег
                        </button>
                    )}
                </div>
            </div>

            {/* Playback Controls */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    marginBottom: '1rem',
                    flexWrap: 'nowrap',
                    minWidth: 0,
                }}
            >
                {/* -10 sec */}
                <button
                    className="btn-icon"
                    onClick={() => handleSkip(-10)}
                    title="Назад 10 сек"
                    style={{
                        width: '36px',
                        height: '36px',
                    }}
                >
                    <span
                        style={{
                            fontSize: '0.65rem',
                            fontWeight: 'var(--font-weight-semibold)',
                        }}
                    >
                        10
                    </span>
                </button>

                {/* Play/Pause */}
                <button
                    className="btn-icon btn-icon-lg"
                    onClick={onPlayPause}
                    title={isPlaying ? 'Пауза' : 'Воспроизвести'}
                    style={{
                        width: '52px',
                        height: '52px',
                        background: 'var(--glass-bg-elevated)',
                        border: '1px solid var(--glass-border)',
                    }}
                >
                    {isPlaying ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                    ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="6 3 20 12 6 21 6 3" />
                        </svg>
                    )}
                </button>

                {/* +10 sec */}
                <button
                    className="btn-icon"
                    onClick={() => handleSkip(10)}
                    title="Вперёд 10 сек"
                    style={{
                        width: '36px',
                        height: '36px',
                    }}
                >
                    <span
                        style={{
                            fontSize: '0.65rem',
                            fontWeight: 'var(--font-weight-semibold)',
                        }}
                    >
                        10
                    </span>
                </button>

                {/* Speed Control */}
                <button
                    className="btn-capsule"
                    onClick={cycleSpeed}
                    title="Скорость воспроизведения"
                    style={{
                        marginLeft: '0.5rem',
                        padding: '0.3rem 0.6rem',
                        fontSize: '0.8rem',
                        minWidth: '42px',
                    }}
                >
                    {playbackSpeed}x
                </button>

                {/* Waveform View Mode Toggle */}
                <div style={{
                    display: 'flex',
                    gap: '2px',
                    marginLeft: '0.75rem',
                    background: 'var(--glass-bg-elevated)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '2px',
                    border: '1px solid var(--glass-border-subtle)',
                }}>
                    <button
                        onClick={() => setWaveformViewMode('simple')}
                        title="Простой вид"
                        style={{
                            padding: '6px 8px',
                            background: waveformViewMode === 'simple' ? 'var(--primary)' : 'transparent',
                            color: waveformViewMode === 'simple' ? 'white' : 'var(--text-muted)',
                            border: 'none',
                            borderRadius: 'var(--radius-xs)',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="10" width="3" height="4" rx="1" />
                            <rect x="8" y="7" width="3" height="10" rx="1" />
                            <rect x="13" y="9" width="3" height="6" rx="1" />
                            <rect x="18" y="6" width="3" height="12" rx="1" />
                        </svg>
                    </button>
                    <button
                        onClick={() => setWaveformViewMode('detailed')}
                        title="Детальный вид (Mic/Sys)"
                        style={{
                            padding: '6px 8px',
                            background: waveformViewMode === 'detailed' ? 'var(--primary)' : 'transparent',
                            color: waveformViewMode === 'detailed' ? 'white' : 'var(--text-muted)',
                            border: 'none',
                            borderRadius: 'var(--radius-xs)',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M2 6h20" />
                            <path d="M4 6v-1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-1z" />
                            <path d="M10 6v-2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-2z" />
                            <path d="M2 18h20" />
                            <path d="M6 18v-1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-1z" />
                            <path d="M12 18v-3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-1z" />
                        </svg>
                    </button>
                    <button
                        onClick={() => setWaveformViewMode('hidden')}
                        title="Свернуть"
                        style={{
                            padding: '6px 8px',
                            background: waveformViewMode === 'hidden' ? 'var(--primary)' : 'transparent',
                            color: waveformViewMode === 'hidden' ? 'white' : 'var(--text-muted)',
                            border: 'none',
                            borderRadius: 'var(--radius-xs)',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="4 14 10 14 10 20" />
                            <polyline points="20 10 14 10 14 4" />
                            <line x1="14" y1="10" x2="21" y2="3" />
                            <line x1="3" y1="21" x2="10" y2="14" />
                        </svg>
                    </button>
                </div>

                {/* Action Buttons */}
                <div className="action-buttons-container">
                    {/* Retranscribe Button */}
                    <button
                        className="btn-capsule btn-capsule-responsive"
                        onClick={onRetranscribe}
                        title="Ретранскрибировать"
                        disabled={isFullTranscribing || isRecording}
                        style={{
                            padding: '0.4rem 0.75rem',
                            fontSize: '0.8rem',
                            gap: '0.4rem',
                            opacity: (isFullTranscribing || isRecording) ? 0.5 : 1,
                            cursor: (isFullTranscribing || isRecording) ? 'not-allowed' : 'pointer',
                        }}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <path d="M23 4v6h-6" />
                            <path d="M1 20v-6h6" />
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                        </svg>
                        <span className="btn-text-responsive">
                            {isThisSessionTranscribing ? 'Идёт...' : 'Ретранскрибировать'}
                        </span>
                    </button>

                    {/* Improve Button */}
                    <button
                        className="btn-capsule btn-capsule-primary btn-capsule-responsive"
                        onClick={onImprove}
                        title="Улучшить текст"
                        style={{
                            padding: '0.4rem 0.75rem',
                            fontSize: '0.8rem',
                            gap: '0.4rem',
                        }}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                        <span className="btn-text-responsive">Улучшить</span>
                    </button>

                    {/* Export Menu */}
                    <div style={{ position: 'relative' }}>
                        <button
                            className="btn-capsule btn-capsule-responsive"
                            onClick={() => setShowExportMenu(!showExportMenu)}
                            title="Экспорт"
                            style={{
                                padding: '0.4rem 0.75rem',
                                fontSize: '0.8rem',
                                gap: '0.4rem',
                            }}
                        >
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                            <span className="btn-text-responsive">Экспорт</span>
                        </button>
                        
                        {showExportMenu && (
                            <>
                                {/* Backdrop */}
                                <div
                                    style={{
                                        position: 'fixed',
                                        inset: 0,
                                        zIndex: 99,
                                    }}
                                    onClick={() => setShowExportMenu(false)}
                                />
                                
                                {/* Menu - Liquid Glass Effect */}
                                <div
                                    style={{
                                        position: 'absolute',
                                        top: 'calc(100% + 8px)',
                                        right: 0,
                                        background: 'rgba(30, 30, 35, 0.75)',
                                        backdropFilter: 'blur(24px) saturate(180%)',
                                        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                                        borderRadius: 'var(--radius-lg)',
                                        border: '1px solid rgba(255, 255, 255, 0.12)',
                                        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
                                        padding: '0.5rem',
                                        minWidth: '180px',
                                        zIndex: 100,
                                    }}
                                >
                                    <button
                                        onClick={async () => {
                                            const success = await copyToClipboard(session);
                                            if (success) {
                                                setCopySuccess(true);
                                                setTimeout(() => setCopySuccess(false), 2000);
                                            }
                                            setShowExportMenu(false);
                                        }}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 0.75rem',
                                            background: 'transparent',
                                            border: 'none',
                                            borderRadius: 'var(--radius-md)',
                                            color: 'rgba(255, 255, 255, 0.95)',
                                            fontSize: '0.85rem',
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.6rem',
                                            transition: 'background 0.15s ease',
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                    >
                                        Копировать текст {copySuccess && '(Скопировано!)'}
                                    </button>
                                    
                                    <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.08)', margin: '0.25rem 0.5rem' }} />
                                    
                                    <button
                                        onClick={() => { exportTXT(session); setShowExportMenu(false); }}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 0.75rem',
                                            background: 'transparent',
                                            border: 'none',
                                            borderRadius: 'var(--radius-md)',
                                            color: 'rgba(255, 255, 255, 0.95)',
                                            fontSize: '0.85rem',
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.6rem',
                                            transition: 'background 0.15s ease',
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                    >
                                        Текст (.txt)
                                    </button>
                                    
                                    <button
                                        onClick={() => { exportSRT(session); setShowExportMenu(false); }}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 0.75rem',
                                            background: 'transparent',
                                            border: 'none',
                                            borderRadius: 'var(--radius-md)',
                                            color: 'rgba(255, 255, 255, 0.95)',
                                            fontSize: '0.85rem',
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.6rem',
                                            transition: 'background 0.15s ease',
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                    >
                                        Субтитры (.srt)
                                    </button>
                                    
                                    <button
                                        onClick={() => { exportVTT(session); setShowExportMenu(false); }}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 0.75rem',
                                            background: 'transparent',
                                            border: 'none',
                                            borderRadius: 'var(--radius-md)',
                                            color: 'rgba(255, 255, 255, 0.95)',
                                            fontSize: '0.85rem',
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.6rem',
                                            transition: 'background 0.15s ease',
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                    >
                                        WebVTT (.vtt)
                                    </button>
                                    
                                    <button
                                        onClick={() => { exportJSON(session); setShowExportMenu(false); }}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 0.75rem',
                                            background: 'transparent',
                                            border: 'none',
                                            borderRadius: 'var(--radius-md)',
                                            color: 'rgba(255, 255, 255, 0.95)',
                                            fontSize: '0.85rem',
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.6rem',
                                            transition: 'background 0.15s ease',
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                    >
                                        JSON (.json)
                                    </button>
                                    
                                    <button
                                        onClick={() => { exportMarkdown(session); setShowExportMenu(false); }}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 0.75rem',
                                            background: 'transparent',
                                            border: 'none',
                                            borderRadius: 'var(--radius-md)',
                                            color: 'rgba(255, 255, 255, 0.95)',
                                            fontSize: '0.85rem',
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.6rem',
                                            transition: 'background 0.15s ease',
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                    >
                                        Markdown (.md)
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Waveform Visualization */}
            {waveformViewMode !== 'hidden' && (
            <div>

                {waveformViewMode === 'simple' ? (
                    /* Simple Timeline View */
                    <>
                        <div
                            ref={timelineRef}
                            onClick={handleTimelineClick}
                            onMouseMove={handleMouseMove}
                            onMouseLeave={() => setHoverTime(null)}
                            style={{
                                height: '48px',
                                background: 'var(--glass-bg)',
                                borderRadius: 'var(--radius-md)',
                                position: 'relative',
                                cursor: 'pointer',
                                overflow: 'hidden',
                                border: '1px solid var(--glass-border-subtle)',
                            }}
                        >
                            {/* Waveform Bars */}
                            <div
                                style={{
                                    position: 'absolute',
                                    inset: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '2px',
                                    padding: '0 4px',
                                }}
                            >
                                {(session.chunks || []).length > 0
                                    ? (session.chunks || []).filter(c => c).map((c, i, arr) => {
                                          const isPast = (i / arr.length) * 100 < progress;
                                          const height = 30 + ((c.transcription || '').length % 60);
                                          return (
                                              <div
                                                  key={c.id || i}
                                                  style={{
                                                      flex: 1,
                                                      height: `${height}%`,
                                                      background: isPast
                                                          ? 'linear-gradient(to top, var(--primary), var(--accent))'
                                                          : 'var(--glass-bg-hover)',
                                                      borderRadius: '2px',
                                                      transition: 'background var(--duration-fast)',
                                                  }}
                                              />
                                          );
                                      })
                                    : // Generate placeholder bars if no chunks
                                      Array.from({ length: 50 }).map((_, i) => {
                                          const isPast = (i / 50) * 100 < progress;
                                          const height = 20 + Math.random() * 60;
                                          return (
                                              <div
                                                  key={i}
                                                  style={{
                                                      flex: 1,
                                                      height: `${height}%`,
                                                      background: isPast
                                                          ? 'linear-gradient(to top, var(--primary), var(--accent))'
                                                          : 'var(--glass-bg-hover)',
                                                      borderRadius: '2px',
                                                      transition: 'background var(--duration-fast)',
                                                  }}
                                              />
                                          );
                                      })}
                            </div>

                            {/* Progress Indicator */}
                            <div
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    bottom: 0,
                                    left: `${progress}%`,
                                    width: '2px',
                                    background: 'white',
                                    boxShadow: '0 0 10px rgba(255, 255, 255, 0.8)',
                                    pointerEvents: 'none',
                                    transition: 'left 0.1s linear',
                                }}
                            />

                            {/* Hover Tooltip */}
                            {hoverTime !== null && (
                                <div
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        bottom: 0,
                                        left: `${(hoverTime / displayDuration) * 100}%`,
                                        width: '1px',
                                        background: 'var(--text-muted)',
                                        pointerEvents: 'none',
                                    }}
                                >
                                    <div
                                        style={{
                                            position: 'absolute',
                                            bottom: 'calc(100% + 4px)',
                                            left: '50%',
                                            transform: 'translateX(-50%)',
                                            background: 'var(--glass-bg-elevated)',
                                            backdropFilter: 'blur(10px)',
                                            padding: '2px 6px',
                                            borderRadius: 'var(--radius-xs)',
                                            fontSize: '0.7rem',
                                            fontFamily: 'SF Mono, monospace',
                                            color: 'var(--text-primary)',
                                            whiteSpace: 'nowrap',
                                            border: '1px solid var(--glass-border)',
                                        }}
                                    >
                                        {formatTime(hoverTime)}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Time Display for Simple View */}
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                marginTop: '0.5rem',
                                fontSize: '0.75rem',
                                fontFamily: 'SF Mono, Menlo, monospace',
                                color: 'var(--text-muted)',
                            }}
                        >
                            <span>{formatTime(currentTime)}</span>
                            <span>{formatTime(displayDuration)}</span>
                        </div>
                    </>
                ) : (
                    /* Detailed Waveform View (Mic/Sys) */
                    <WaveformDisplay
                        currentTime={currentTime}
                        playbackOffset={playbackOffset}
                        totalDuration={waveformData?.duration || displayDuration}
                        isPlaying={isPlaying}
                        waveformData={waveformData}
                        loading={waveformLoading}
                        error={waveformError}
                        channelLabels={['Mic', 'Sys']}
                        onSeek={onSeek}
                    />
                )}
            </div>
            )}

            {/* Retranscription Progress */}
            {isThisSessionTranscribing && (
                <div
                    style={{
                        marginTop: '1rem',
                        padding: '1rem',
                        background: 'var(--glass-bg-elevated)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--primary-alpha)',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div
                                style={{
                                    width: '8px',
                                    height: '8px',
                                    borderRadius: '50%',
                                    background: 'var(--primary)',
                                    animation: 'pulse 1s infinite',
                                }}
                            />
                            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                Ретранскрипция
                            </span>
                        </div>
                        <button
                            onClick={cancelFullTranscription}
                            title="Отменить"
                            style={{
                                padding: '0.25rem 0.5rem',
                                fontSize: '0.75rem',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                borderRadius: 'var(--radius-sm)',
                                color: '#ef4444',
                                cursor: 'pointer',
                                transition: 'all 0.2s',
                            }}
                        >
                            Отмена
                        </button>
                    </div>
                    
                    {/* Progress Bar */}
                    <div
                        style={{
                            height: '6px',
                            background: 'var(--glass-bg)',
                            borderRadius: '3px',
                            overflow: 'hidden',
                            marginBottom: '0.5rem',
                        }}
                    >
                        <div
                            style={{
                                height: '100%',
                                width: `${fullTranscriptionProgress * 100}%`,
                                background: 'linear-gradient(90deg, var(--primary), var(--accent))',
                                borderRadius: '3px',
                                transition: 'width 0.3s ease',
                            }}
                        />
                    </div>
                    
                    {/* Status Text */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {fullTranscriptionStatus || 'Обработка...'}
                        </span>
                        <span style={{ fontSize: '0.75rem', fontFamily: 'SF Mono, monospace', color: 'var(--text-muted)' }}>
                            {Math.round(fullTranscriptionProgress * 100)}%
                        </span>
                    </div>
                </div>
            )}

            {/* Retranscription Error */}
            {fullTranscriptionError && fullTranscriptionSessionId === session.id && (
                <div
                    style={{
                        marginTop: '1rem',
                        padding: '0.75rem 1rem',
                        background: 'rgba(239, 68, 68, 0.1)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        color: '#ef4444',
                        fontSize: '0.85rem',
                    }}
                >
                    <strong>Ошибка:</strong> {fullTranscriptionError}
                </div>
            )}
        </div>
    );
};
