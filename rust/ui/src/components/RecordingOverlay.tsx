import React, { useEffect, useState, useRef } from 'react';
import { useSessionContext } from '../context/SessionContext';
import { useBackendContext } from '../context/BackendContext';
// StreamingTranscription временно отключён
// import { StreamingTranscription } from './StreamingTranscription';

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
    const { isRecording, currentSession, isStopping } = useSessionContext();
    const { sendMessage } = useBackendContext();
    const [duration, setDuration] = useState(0);
    const [waveData, setWaveData] = useState<number[]>(Array(32).fill(0.3));
    const animationRef = useRef<number | null>(null);
    
    // Состояние mute для каналов
    const [micMuted, setMicMuted] = useState(false);
    const [sysMuted, setSysMuted] = useState(false);
    
    // Состояние для плавной анимации появления/исчезновения
    const [shouldRender, setShouldRender] = useState(isRecording);
    const [isAnimating, setIsAnimating] = useState(false);
    // Streaming временно отключён
    // const [showStreaming, setShowStreaming] = useState(false);

    // Управление анимацией появления/исчезновения
    useEffect(() => {
        if (isRecording) {
            setShouldRender(true);
            // Сбрасываем состояние mute при начале записи
            setMicMuted(false);
            setSysMuted(false);
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
            // setShowStreaming(false);
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

            {/* Mute Buttons */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                }}
            >
                {/* Mic Mute Button */}
                <button
                    onClick={() => {
                        const newMuted = !micMuted;
                        setMicMuted(newMuted);
                        sendMessage({ type: 'set_channel_mute', channel: 'mic', muted: newMuted });
                    }}
                    title={micMuted ? 'Включить запись микрофона' : 'Отключить запись микрофона'}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '32px',
                        height: '32px',
                        padding: 0,
                        background: micMuted ? 'rgba(239, 68, 68, 0.3)' : 'rgba(76, 175, 80, 0.2)',
                        border: `1px solid ${micMuted ? 'rgba(239, 68, 68, 0.5)' : 'rgba(76, 175, 80, 0.4)'}`,
                        borderRadius: '8px',
                        color: micMuted ? '#ef4444' : '#4caf50',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                        WebkitAppRegion: 'no-drag',
                    } as React.CSSProperties}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'scale(1.05)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'scale(1)';
                    }}
                >
                    {micMuted ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="1" y1="1" x2="23" y2="23" />
                            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                            <line x1="12" y1="19" x2="12" y2="23" />
                            <line x1="8" y1="23" x2="16" y2="23" />
                        </svg>
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="23" />
                            <line x1="8" y1="23" x2="16" y2="23" />
                        </svg>
                    )}
                </button>

                {/* System Audio Mute Button */}
                <button
                    onClick={() => {
                        const newMuted = !sysMuted;
                        setSysMuted(newMuted);
                        sendMessage({ type: 'set_channel_mute', channel: 'sys', muted: newMuted });
                    }}
                    title={sysMuted ? 'Включить запись системного звука' : 'Отключить запись системного звука'}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '32px',
                        height: '32px',
                        padding: 0,
                        background: sysMuted ? 'rgba(239, 68, 68, 0.3)' : 'rgba(33, 150, 243, 0.2)',
                        border: `1px solid ${sysMuted ? 'rgba(239, 68, 68, 0.5)' : 'rgba(33, 150, 243, 0.4)'}`,
                        borderRadius: '8px',
                        color: sysMuted ? '#ef4444' : '#2196f3',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                        WebkitAppRegion: 'no-drag',
                    } as React.CSSProperties}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'scale(1.05)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'scale(1)';
                    }}
                >
                    {sysMuted ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <line x1="23" y1="9" x2="17" y2="15" />
                            <line x1="17" y1="9" x2="23" y2="15" />
                        </svg>
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                        </svg>
                    )}
                </button>
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

            {/* Stop Button */}
            <button
                onClick={onStop}
                disabled={isStopping}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.5rem 1.25rem',
                    background: isStopping ? 'rgba(156, 163, 175, 0.9)' : 'rgba(239, 68, 68, 0.9)',
                    border: 'none',
                    borderRadius: '9999px',
                    color: 'white',
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    cursor: isStopping ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease',
                    boxShadow: isStopping ? '0 2px 12px rgba(156, 163, 175, 0.4)' : '0 2px 12px rgba(239, 68, 68, 0.4)',
                    opacity: isStopping ? 0.7 : 1,
                    WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
                onMouseEnter={(e) => {
                    if (!isStopping) {
                        e.currentTarget.style.background = 'rgba(220, 38, 38, 1)';
                        e.currentTarget.style.transform = 'scale(1.02)';
                    }
                }}
                onMouseLeave={(e) => {
                    if (!isStopping) {
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.9)';
                        e.currentTarget.style.transform = 'scale(1)';
                    }
                }}
            >
                {isStopping ? (
                    <>
                        <svg 
                            width="14" 
                            height="14" 
                            viewBox="0 0 24 24" 
                            fill="none" 
                            stroke="currentColor" 
                            strokeWidth="2"
                            style={{ animation: 'spin 1s linear infinite' }}
                        >
                            <circle cx="12" cy="12" r="10" opacity="0.25" />
                            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                        </svg>
                        Сохранение...
                    </>
                ) : (
                    <>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                        Остановить
                    </>
                )}
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
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div>
        </>
    );
};

export default RecordingOverlay;
