import React, { useEffect, useState, useRef } from 'react';
import { useSessionContext } from '../context/SessionContext';
import { StreamingTranscription } from './StreamingTranscription';

const formatDuration = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

interface RecordingOverlayProps {
    onStop: () => void;
}

export const RecordingOverlay: React.FC<RecordingOverlayProps> = ({ onStop }) => {
    const { isRecording, currentSession } = useSessionContext();
    const [duration, setDuration] = useState(0);
    const [waveData, setWaveData] = useState<number[]>(Array(32).fill(0.3));
    const [showStreaming, setShowStreaming] = useState(false);
    const animationRef = useRef<number | null>(null);
    
    // Состояние для плавной анимации появления/исчезновения
    const [shouldRender, setShouldRender] = useState(isRecording);
    const [isAnimating, setIsAnimating] = useState(false);

    // Управление анимацией появления/исчезновения
    useEffect(() => {
        if (isRecording) {
            setShouldRender(true);
            // Запускаем анимацию появления после mount
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setIsAnimating(true);
                });
            });
        } else {
            // Начинаем анимацию исчезновения
            setIsAnimating(false);
            // Убираем из DOM после завершения анимации
            const timer = setTimeout(() => {
                setShouldRender(false);
            }, 300);
            return () => clearTimeout(timer);
        }
    }, [isRecording]);

    // Timer
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isRecording && currentSession) {
            const start = new Date(currentSession.startTime).getTime();
            interval = setInterval(() => {
                const now = new Date().getTime();
                setDuration(Math.floor((now - start) / 1000));
            }, 100);
        } else {
            setDuration(0);
        }
        return () => clearInterval(interval);
    }, [isRecording, currentSession]);

    // Wave animation
    useEffect(() => {
        if (!isRecording) return;

        const animate = () => {
            setWaveData(prev => prev.map((_, i) => {
                const base = 0.3 + Math.sin(Date.now() / 200 + i * 0.5) * 0.2;
                const random = Math.random() * 0.4;
                return Math.min(1, Math.max(0.1, base + random));
            }));
            animationRef.current = requestAnimationFrame(animate);
        };
        animate();

        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        };
    }, [isRecording]);

    if (!shouldRender) return null;

    return (
        <>
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 100,
                background: 'linear-gradient(180deg, rgba(239, 68, 68, 0.15) 0%, transparent 100%)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                borderBottom: '1px solid rgba(239, 68, 68, 0.2)',
                padding: '0.5rem 1.5rem',
                paddingTop: '0.75rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '2rem',
                WebkitAppRegion: 'drag',
                // Анимация появления/исчезновения
                opacity: isAnimating ? 1 : 0,
                transform: isAnimating ? 'translateY(0)' : 'translateY(-100%)',
                transition: 'opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1), transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            } as React.CSSProperties}
        >
            {/* Left Section - Recording Status */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                }}
            >
                {/* Pulsing Record Indicator */}
                <div
                    style={{
                        position: 'relative',
                        width: '12px',
                        height: '12px',
                    }}
                >
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            borderRadius: '50%',
                            background: '#ef4444',
                            animation: 'recordPulseRing 1.5s infinite',
                        }}
                    />
                    <div
                        style={{
                            position: 'absolute',
                            inset: '2px',
                            borderRadius: '50%',
                            background: '#ef4444',
                            boxShadow: '0 0 12px rgba(239, 68, 68, 0.8)',
                        }}
                    />
                </div>

                <span
                    style={{
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: '#ef4444',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                    }}
                >
                    Запись
                </span>
            </div>

            {/* Center - Waveform Visualization */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2px',
                    height: '28px',
                }}
            >
                {waveData.map((height, i) => (
                    <div
                        key={i}
                        style={{
                            width: '3px',
                            height: `${height * 100}%`,
                            minHeight: '4px',
                            background: `linear-gradient(to top, rgba(239, 68, 68, 0.6), rgba(239, 68, 68, ${0.3 + height * 0.7}))`,
                            borderRadius: '2px',
                            transition: 'height 0.1s ease-out',
                        }}
                    />
                ))}
            </div>

            {/* Timer */}
            <div
                style={{
                    fontFamily: 'SF Mono, Menlo, Monaco, monospace',
                    fontSize: '1.2rem',
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    minWidth: '80px',
                    textAlign: 'center',
                    letterSpacing: '0.02em',
                }}
            >
                {formatDuration(duration)}
            </div>

            {/* Streaming Toggle Button */}
            <button
                onClick={() => setShowStreaming(!showStreaming)}
                title={showStreaming ? "Скрыть live транскрипцию" : "Показать live транскрипцию"}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    padding: '0.5rem 0.9rem',
                    background: showStreaming ? 'rgba(108, 92, 231, 0.9)' : 'rgba(255, 255, 255, 0.15)',
                    border: showStreaming ? '1px solid rgba(108, 92, 231, 0.5)' : '1px solid rgba(255, 255, 255, 0.3)',
                    borderRadius: '9999px',
                    color: 'white',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    boxShadow: showStreaming ? '0 2px 12px rgba(108, 92, 231, 0.4)' : 'none',
                    WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
                onMouseEnter={(e) => {
                    if (showStreaming) {
                        e.currentTarget.style.background = 'rgba(98, 82, 221, 1)';
                    } else {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.25)';
                    }
                    e.currentTarget.style.transform = 'scale(1.02)';
                }}
                onMouseLeave={(e) => {
                    if (showStreaming) {
                        e.currentTarget.style.background = 'rgba(108, 92, 231, 0.9)';
                    } else {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)';
                    }
                    e.currentTarget.style.transform = 'scale(1)';
                }}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Live
            </button>

            {/* Stop Button */}
            <button
                onClick={onStop}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.5rem 1.25rem',
                    background: 'rgba(239, 68, 68, 0.9)',
                    border: 'none',
                    borderRadius: '9999px',
                    color: 'white',
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    boxShadow: '0 2px 12px rgba(239, 68, 68, 0.4)',
                    WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
                onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(220, 38, 38, 1)';
                    e.currentTarget.style.transform = 'scale(1.02)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(239, 68, 68, 0.9)';
                    e.currentTarget.style.transform = 'scale(1)';
                }}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
                Остановить
            </button>

            <style>{`
                @keyframes recordPulseRing {
                    0%, 100% {
                        transform: scale(1);
                        opacity: 1;
                    }
                    50% {
                        transform: scale(1.8);
                        opacity: 0;
                    }
                }
            `}</style>
        </div>

        {/* Streaming Transcription Panel */}
        {showStreaming && (
            <div
                style={{
                    position: 'fixed',
                    top: '60px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: '90%',
                    maxWidth: '800px',
                    maxHeight: '40vh',
                    zIndex: 99,
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: '12px',
                    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
                    overflow: 'hidden',
                    animation: 'slideDown 0.2s ease-out',
                }}
            >
                <div
                    style={{
                        padding: '0.75rem 1rem',
                        borderBottom: '1px solid var(--border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: 'var(--surface-strong)',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            Live Транскрипция
                        </span>
                        <span
                            style={{
                                fontSize: '0.7rem',
                                color: 'var(--success)',
                                backgroundColor: 'rgba(0, 184, 148, 0.14)',
                                padding: '2px 6px',
                                borderRadius: '999px',
                            }}
                        >
                            Real-time
                        </span>
                    </div>
                    <button
                        onClick={() => setShowStreaming(false)}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                            fontSize: '1.2rem',
                            padding: '0.25rem',
                            lineHeight: 1,
                        }}
                    >
                        ×
                    </button>
                </div>
                <StreamingTranscription enabled={showStreaming} />
                <style>{`
                    @keyframes slideDown {
                        from {
                            opacity: 0;
                            transform: translateX(-50%) translateY(-10px);
                        }
                        to {
                            opacity: 1;
                            transform: translateX(-50%) translateY(0);
                        }
                    }
                `}</style>
            </div>
        )}
        </>
    );
};

export default RecordingOverlay;
