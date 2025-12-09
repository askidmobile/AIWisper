import React, { useEffect, useState } from 'react';
import { useWebSocketContext } from '../../context/WebSocketContext';
import { useSessionContext } from '../../context/SessionContext';

const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

interface HeaderProps {
    showSettings: boolean;
    setShowSettings: (v: boolean) => void;
}

export const Header: React.FC<HeaderProps> = ({
    showSettings,
    setShowSettings,
}) => {
    const { isConnected } = useWebSocketContext();
    const { isRecording, currentSession } = useSessionContext();
    const [duration, setDuration] = useState(0);

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isRecording && currentSession) {
            const start = new Date(currentSession.startTime).getTime();
            interval = setInterval(() => {
                const now = new Date().getTime();
                setDuration(Math.floor((now - start) / 1000));
            }, 1000);
        } else {
            setDuration(0);
        }
        return () => clearInterval(interval);
    }, [isRecording, currentSession]);

    return (
        <header
            style={{
                padding: '0.75rem 1.5rem',
                paddingLeft: '88px', // Traffic lights offset
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'transparent',
                WebkitAppRegion: 'drag',
                userSelect: 'none',
                minHeight: '52px',
            } as React.CSSProperties}
        >
            {/* Left: Connection Status Indicator */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                }}
            >
                <div
                    style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: isConnected ? 'var(--success)' : 'var(--danger)',
                        boxShadow: isConnected
                            ? '0 0 12px var(--success)'
                            : '0 0 12px var(--danger)',
                        transition: 'all var(--duration-normal) var(--transition-smooth)',
                    }}
                />
            </div>

            {/* Center: Recording Timer (only when recording) */}
            {isRecording && (
                <div
                    className="animate-scale-in"
                    style={{
                        position: 'absolute',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        padding: '0.4rem 1rem',
                        borderRadius: 'var(--radius-capsule)',
                        background: 'rgba(239, 68, 68, 0.15)',
                        backdropFilter: 'blur(var(--glass-blur-light))',
                        WebkitBackdropFilter: 'blur(var(--glass-blur-light))',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        WebkitAppRegion: 'no-drag',
                    } as React.CSSProperties}
                >
                    <div
                        style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: '#ef4444',
                            animation: 'pulse 1s infinite',
                        }}
                    />
                    <span
                        style={{
                            fontFamily: 'SF Mono, Menlo, monospace',
                            fontSize: '0.9rem',
                            fontWeight: 'var(--font-weight-semibold)',
                            color: 'var(--text-primary)',
                        }}
                    >
                        {formatDuration(duration)}
                    </span>
                </div>
            )}

            {/* Right: Settings only */}
            <div
                style={{
                    display: 'flex',
                    gap: '0.5rem',
                    alignItems: 'center',
                    WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
            >
                <button
                    className="btn-icon"
                    onClick={() => setShowSettings(!showSettings)}
                    title="Настройки"
                    style={{
                        width: '36px',
                        height: '36px',
                        background: showSettings ? 'var(--glass-bg-active)' : undefined,
                    }}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                </button>
            </div>
        </header>
    );
};
