import React, { useMemo, useState } from 'react';
import { useSessionContext } from '../../context/SessionContext';
import { groupSessionsByTime, formatDuration, formatDate, formatTime } from '../../utils/groupSessions';

// Интерфейс для статистики
interface SessionStats {
    totalSessions: number;
    totalDuration: number; // в секундах
    avgDuration: number; // в секундах
    totalChunks: number;
}

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
    const { sessions, selectedSession, selectSession, isRecording } = useSessionContext();
    const [showStats, setShowStats] = useState(false);

    const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);

    // Вычисляем статистику
    const stats = useMemo((): SessionStats => {
        if (sessions.length === 0) {
            return { totalSessions: 0, totalDuration: 0, avgDuration: 0, totalChunks: 0 };
        }

        let totalDuration = 0;
        let totalChunks = 0;

        sessions.forEach(session => {
            // Длительность в секундах
            totalDuration += (session.totalDuration || 0) / 1000;
            // Количество чанков
            totalChunks += session.chunksCount || 0;
        });

        return {
            totalSessions: sessions.length,
            totalDuration,
            avgDuration: totalDuration / sessions.length,
            totalChunks
        };
    }, [sessions]);

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
                position: 'relative',
            }}
        >
            {/* Recording Lock Overlay */}
            {isRecording && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.5)',
                        backdropFilter: 'blur(2px)',
                        zIndex: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 'var(--radius-xl)',
                    }}
                >
                    <div
                        style={{
                            textAlign: 'center',
                            padding: '1.5rem',
                        }}
                    >
                        <div
                            style={{
                                width: '48px',
                                height: '48px',
                                borderRadius: '50%',
                                background: 'rgba(239, 68, 68, 0.2)',
                                border: '2px solid rgba(239, 68, 68, 0.4)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                margin: '0 auto 1rem',
                            }}
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                            </svg>
                        </div>
                        <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.25rem' }}>
                            Запись идёт
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                            Навигация заблокирована
                        </div>
                    </div>
                </div>
            )}
            {/* Header with macOS traffic lights offset */}
            <div
                style={{
                    padding: '0.75rem 1rem',
                    paddingTop: '0.5rem',
                    marginTop: '28px', // Offset for macOS traffic lights
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
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                    <button
                        className="btn-icon btn-icon-sm"
                        onClick={() => window.location.reload()}
                        title="Обновить список"
                        style={{
                            width: '32px',
                            height: '32px',
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M23 4v6h-6"/>
                            <path d="M1 20v-6h6"/>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                        </svg>
                    </button>
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
                    <button
                        className="btn-icon btn-icon-sm"
                        onClick={() => setShowStats(!showStats)}
                        title="Статистика"
                        style={{
                            width: '32px',
                            height: '32px',
                            background: showStats ? 'var(--primary-alpha)' : undefined,
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="20" x2="18" y2="10"/>
                            <line x1="12" y1="20" x2="12" y2="4"/>
                            <line x1="6" y1="20" x2="6" y2="14"/>
                        </svg>
                    </button>
                </div>
            </div>

            {/* Stats Panel */}
            {showStats && sessions.length > 0 && (
                <div
                    style={{
                        padding: '0.75rem 1rem',
                        borderBottom: '1px solid var(--glass-border-subtle)',
                        background: 'var(--surface-alpha)',
                    }}
                >
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--primary)' }}>
                                {stats.totalSessions}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                Записей
                            </div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--success)' }}>
                                {formatDuration(stats.totalDuration)}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                Всего
                            </div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--warning)' }}>
                                {formatDuration(stats.avgDuration)}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                Средняя
                            </div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--info)' }}>
                                {stats.totalChunks}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                Чанков
                            </div>
                        </div>
                    </div>
                </div>
            )}

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

            {/* New Recording Button / Recording Status */}
            <div
                style={{
                    padding: '0.75rem 1rem',
                    borderTop: '1px solid var(--glass-border-subtle)',
                }}
            >
                <button
                    className="btn-capsule"
                    onClick={onStartRecording}
                    disabled={isRecording}
                    style={{
                        width: '100%',
                        justifyContent: 'center',
                        padding: '0.6rem 1rem',
                        gap: '0.4rem',
                        background: isRecording 
                            ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.8), rgba(220, 38, 38, 0.8))'
                            : 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                        border: 'none',
                        color: 'white',
                        cursor: isRecording ? 'default' : 'pointer',
                    }}
                >
                    {isRecording ? (
                        <>
                            <div
                                style={{
                                    width: '8px',
                                    height: '8px',
                                    borderRadius: '50%',
                                    background: 'white',
                                    animation: 'pulse 1s infinite',
                                }}
                            />
                            Идёт запись...
                        </>
                    ) : (
                        <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <line x1="12" y1="5" x2="12" y2="19"/>
                                <line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            Новая запись
                        </>
                    )}
                </button>
            </div>
        </aside>
    );
};
