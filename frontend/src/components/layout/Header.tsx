import React from 'react';
import { useWebSocketContext } from '../../context/WebSocketContext';
import { useSessionContext } from '../../context/SessionContext';

interface HeaderProps {
    showSettings: boolean;
    setShowSettings: (v: boolean) => void;
    onShowHelp?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
    showSettings,
    setShowSettings,
    onShowHelp,
}) => {
    const { isConnected } = useWebSocketContext();
    const { isRecording } = useSessionContext();

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

            {/* Center space - recording indicator moved to RecordingOverlay */}
            <div style={{ flex: 1 }} />

            {/* Right: Help & Settings - disabled during recording */}
            <div
                style={{
                    display: 'flex',
                    gap: '0.5rem',
                    alignItems: 'center',
                    WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
            >
                {/* Help button - always available */}
                {onShowHelp && (
                    <button
                        className="btn-icon"
                        onClick={onShowHelp}
                        title="Справка (?)"
                        style={{
                            width: '36px',
                            height: '36px',
                        }}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10"/>
                            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                            <line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                    </button>
                )}
                
                {/* Settings button - disabled during recording */}
                <button
                    className="btn-icon"
                    onClick={() => setShowSettings(!showSettings)}
                    title={isRecording ? "Настройки заблокированы во время записи" : "Настройки (⌘,)"}
                    disabled={isRecording}
                    style={{
                        width: '36px',
                        height: '36px',
                        background: showSettings ? 'var(--glass-bg-active)' : undefined,
                        opacity: isRecording ? 0.4 : 1,
                        pointerEvents: isRecording ? 'none' : 'auto',
                        transition: 'opacity 0.2s ease',
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
