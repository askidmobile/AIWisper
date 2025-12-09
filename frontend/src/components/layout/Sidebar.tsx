import React, { useMemo } from 'react';
import { useSessionContext } from '../../context/SessionContext';
import { groupSessionsByTime, formatDuration, formatDate, formatTime } from '../../utils/groupSessions';

interface SidebarProps {
    onStartRecording: () => void;
}

const openDataFolder = async () => {
    try {
        const electron = (window as any).require ? (window as any).require('electron') : null;
        if (electron) {
            await electron.ipcRenderer.invoke('open-data-folder');
        }
    } catch (err) {
        console.error('Failed to open data folder:', err);
    }
};

export const Sidebar: React.FC<SidebarProps> = ({ onStartRecording }) => {
    const { sessions, selectedSession, selectSession } = useSessionContext();

    const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);

    return (
        <aside
            className="glass-surface-elevated"
            style={{
                width: '300px',
                margin: 'var(--spacing-inset)',
                marginRight: 0,
                borderRadius: 'var(--radius-xl)',
                background: 'var(--sidebar-bg)',
                backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                border: '1px solid var(--glass-border)',
                boxShadow: 'var(--shadow-glass)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
            }}
        >
            {/* Header */}
            <div
                style={{
                    padding: '1rem 1.25rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                }}
            >
                <h2
                    style={{
                        margin: 0,
                        fontSize: '1.2rem',
                        fontWeight: 'var(--font-weight-bold)',
                        letterSpacing: '-0.02em',
                        color: 'var(--text-primary)',
                    }}
                >
                    Все записи
                </h2>
                <button
                    className="btn-icon btn-icon-sm"
                    onClick={openDataFolder}
                    title="Открыть папку с записями"
                    style={{
                        width: '32px',
                        height: '32px',
                    }}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                </button>
            </div>

            {/* Sessions List */}
            <div
                className="scroll-soft-edges"
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    paddingBottom: '1rem',
                }}
            >
                {sessions.length === 0 ? (
                    <div
                        style={{
                            padding: '2rem 1rem',
                            color: 'var(--text-muted)',
                            textAlign: 'center',
                            fontSize: '0.9rem',
                        }}
                    >
                        Нет записей
                    </div>
                ) : (
                    groupedSessions.map((group) => (
                        <div key={group.label}>
                            {/* Group Header */}
                            <div className="group-header">{group.label}</div>

                            {/* Sessions in Group */}
                            {group.sessions.map((session) => {
                                const isSelected = selectedSession?.id === session.id;
                                const durationSec = session.totalDuration / 1000;

                                return (
                                    <div
                                        key={session.id}
                                        className={`session-item ${isSelected ? 'selected' : ''}`}
                                        onClick={() => selectSession(session.id)}
                                    >
                                        {/* Title */}
                                        <div
                                            style={{
                                                fontSize: '0.95rem',
                                                fontWeight: 'var(--font-weight-semibold)',
                                                color: 'var(--text-primary)',
                                                marginBottom: '0.35rem',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            {session.title || `Запись ${formatDate(session.startTime)}`}
                                        </div>

                                        {/* Meta Info */}
                                        <div
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.5rem',
                                                fontSize: '0.8rem',
                                                color: 'var(--text-muted)',
                                            }}
                                        >
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
                                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                                                <line x1="16" y1="2" x2="16" y2="6"/>
                                                <line x1="8" y1="2" x2="8" y2="6"/>
                                                <line x1="3" y1="10" x2="21" y2="10"/>
                                            </svg>
                                            <span>{formatDate(session.startTime)}, {formatTime(session.startTime)}</span>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
                                                <circle cx="12" cy="12" r="10"/>
                                                <polyline points="12 6 12 12 16 14"/>
                                            </svg>
                                            <span>{formatDuration(durationSec)}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))
                )}
            </div>

            {/* New Recording Button */}
            <div
                style={{
                    padding: '0.75rem 1rem',
                    borderTop: '1px solid var(--glass-border-subtle)',
                }}
            >
                <button
                    className="btn-capsule"
                    onClick={onStartRecording}
                    style={{
                        width: '100%',
                        justifyContent: 'center',
                        padding: '0.6rem 1rem',
                        gap: '0.4rem',
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Новая запись
                </button>
            </div>
        </aside>
    );
};
