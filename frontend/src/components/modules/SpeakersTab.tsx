import React, { useState } from 'react';
import { SessionSpeaker } from '../../types/voiceprint';

interface SpeakersTabProps {
    sessionId: string;
    speakers: SessionSpeaker[];
    onRename: (localId: number, name: string, saveAsVoiceprint: boolean) => void;
    onPlaySample?: (localId: number) => void;
    onStopSample?: () => void;
    playingSpeakerId?: number | null;
}

// Цвета для разных спикеров
const SPEAKER_COLORS = ['#4caf50', '#2196f3', '#e91e63', '#ff9800', '#9c27b0', '#00bcd4', '#8bc34a'];

const getSpeakerColor = (localId: number, isMic: boolean): string => {
    if (isMic) return SPEAKER_COLORS[0]; // Зелёный для "Вы"
    return SPEAKER_COLORS[(localId + 1) % SPEAKER_COLORS.length];
};

const formatDuration = (seconds: number): string => {
    if (seconds < 60) {
        return `${Math.round(seconds)}с`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}м ${secs}с`;
};

interface RenameDialogProps {
    currentName: string;
    isRecognized: boolean;
    onSave: (name: string, saveGlobal: boolean) => void;
    onClose: () => void;
}

const RenameDialog: React.FC<RenameDialogProps> = ({
    currentName,
    isRecognized,
    onSave,
    onClose,
}) => {
    const [name, setName] = useState(currentName);
    const [saveGlobal, setSaveGlobal] = useState(!isRecognized);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim()) {
            onSave(name.trim(), saveGlobal);
        }
    };

    return (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000,
            }}
            onClick={onClose}
            onKeyDown={(e) => {
                // Блокируем ВСЕ клавиши кроме Escape на уровне overlay
                // чтобы предотвратить срабатывание глобальных хоткеев (Space для воспроизведения)
                if (e.code !== 'Escape') {
                    e.stopPropagation();
                }
            }}
        >
            <div
                style={{
                    background: 'var(--glass-bg-elevated)',
                    backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    borderRadius: 'var(--radius-xl)',
                    padding: '1.5rem',
                    minWidth: '320px',
                    boxShadow: 'var(--shadow-elevated)',
                    border: '1px solid var(--glass-border)',
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    // Дополнительная защита на уровне диалога
                    if (e.code !== 'Escape') {
                        e.stopPropagation();
                    }
                }}
            >
                <h3 style={{ margin: '0 0 1rem', color: 'var(--text-primary)' }}>
                    Переименовать спикера
                </h3>

                <form onSubmit={handleSubmit}>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Введите имя"
                        autoFocus
                        style={{
                            width: '100%',
                            padding: '0.75rem',
                            fontSize: '1rem',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border)',
                            backgroundColor: 'var(--surface-strong)',
                            color: 'var(--text-primary)',
                            marginBottom: '1rem',
                            boxSizing: 'border-box',
                        }}
                    />

                    <label
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            marginBottom: '1.5rem',
                            cursor: 'pointer',
                            color: 'var(--text-secondary)',
                            fontSize: '0.9rem',
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={saveGlobal}
                            onChange={(e) => setSaveGlobal(e.target.checked)}
                            style={{ width: '16px', height: '16px' }}
                        />
                        Запомнить голос (для будущих сессий)
                    </label>

                    <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                        <button
                            type="button"
                            onClick={onClose}
                            className="btn-secondary"
                            style={{
                                padding: '0.6rem 1.2rem',
                                borderRadius: 'var(--radius-md)',
                            }}
                        >
                            Отмена
                        </button>
                        <button
                            type="submit"
                            className="btn-primary"
                            style={{
                                padding: '0.6rem 1.2rem',
                                borderRadius: 'var(--radius-md)',
                            }}
                        >
                            Сохранить
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default function SpeakersTab({
    sessionId: _sessionId,  // Зарезервировано для будущего использования
    speakers,
    onRename,
    onPlaySample,
    onStopSample,
    playingSpeakerId,
}: SpeakersTabProps) {
    void _sessionId; // Suppress unused variable warning
    const [editingSpeaker, setEditingSpeaker] = useState<SessionSpeaker | null>(null);

    const handleSaveRename = (name: string, saveGlobal: boolean) => {
        if (editingSpeaker) {
            onRename(editingSpeaker.localId, name, saveGlobal);
            setEditingSpeaker(null);
        }
    };

    // Сортируем: сначала "Вы", потом по localId
    const sortedSpeakers = [...speakers].sort((a, b) => {
        if (a.isMic && !b.isMic) return -1;
        if (!a.isMic && b.isMic) return 1;
        return a.localId - b.localId;
    });

    if (speakers.length === 0) {
        return (
            <div
                style={{
                    padding: '2rem',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                }}
            >
                <svg
                    width="48"
                    height="48"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    style={{ marginBottom: '1rem', opacity: 0.5 }}
                >
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <p>Нет данных о спикерах</p>
                <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                    Спикеры появятся после транскрипции с диаризацией
                </p>
            </div>
        );
    }

    return (
        <div style={{ padding: '1rem' }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginBottom: '1rem',
                    color: 'var(--text-secondary)',
                    fontSize: '0.85rem',
                }}
            >
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                >
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span>{speakers.length} {speakers.length === 1 ? 'спикер' : 'спикеров'}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {sortedSpeakers.map((speaker) => {
                    const color = getSpeakerColor(speaker.localId, speaker.isMic);

                    return (
                        <div
                            key={speaker.localId}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '1rem',
                                padding: '1rem',
                                backgroundColor: 'var(--surface-strong)',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--border)',
                            }}
                        >
                            {/* Avatar */}
                            <div
                                style={{
                                    width: '40px',
                                    height: '40px',
                                    borderRadius: '50%',
                                    backgroundColor: color,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'white',
                                    fontWeight: 'bold',
                                    fontSize: '1rem',
                                    flexShrink: 0,
                                }}
                            >
                                {speaker.displayName.charAt(0).toUpperCase()}
                            </div>

                            {/* Info */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.5rem',
                                        marginBottom: '0.25rem',
                                    }}
                                >
                                    <span
                                        style={{
                                            fontWeight: 600,
                                            color: 'var(--text-primary)',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {speaker.displayName}
                                    </span>
                                    {speaker.isRecognized && (
                                        <span
                                            style={{
                                                fontSize: '0.7rem',
                                                padding: '2px 6px',
                                                borderRadius: '999px',
                                                backgroundColor: 'rgba(76, 175, 80, 0.15)',
                                                color: '#4caf50',
                                            }}
                                        >
                                            Известен
                                        </span>
                                    )}
                                </div>
                                <div
                                    style={{
                                        fontSize: '0.85rem',
                                        color: 'var(--text-muted)',
                                        display: 'flex',
                                        gap: '0.75rem',
                                    }}
                                >
                                    <span>{speaker.segmentCount} фраз</span>
                                    <span>{formatDuration(speaker.totalDuration)}</span>
                                </div>
                            </div>

                            {/* Actions */}
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                {onPlaySample && speaker.hasSample && (
                                    <button
                                        onClick={() => {
                                            if (playingSpeakerId === speaker.localId && onStopSample) {
                                                onStopSample();
                                            } else {
                                                onPlaySample(speaker.localId);
                                            }
                                        }}
                                        className="btn-icon btn-icon-sm"
                                        title={playingSpeakerId === speaker.localId ? "Остановить" : "Прослушать голос"}
                                        style={{ 
                                            width: '32px', 
                                            height: '32px',
                                            color: playingSpeakerId === speaker.localId ? 'var(--primary)' : undefined,
                                        }}
                                    >
                                        {playingSpeakerId === speaker.localId ? (
                                            <svg
                                                width="14"
                                                height="14"
                                                viewBox="0 0 24 24"
                                                fill="currentColor"
                                            >
                                                <rect x="6" y="4" width="4" height="16" />
                                                <rect x="14" y="4" width="4" height="16" />
                                            </svg>
                                        ) : (
                                            <svg
                                                width="14"
                                                height="14"
                                                viewBox="0 0 24 24"
                                                fill="currentColor"
                                            >
                                                <path d="M8 5v14l11-7z" />
                                            </svg>
                                        )}
                                    </button>
                                )}

                                {!speaker.isMic && (
                                    <button
                                        onClick={() => setEditingSpeaker(speaker)}
                                        className="btn-icon btn-icon-sm"
                                        title="Переименовать"
                                        style={{ width: '32px', height: '32px' }}
                                    >
                                        <svg
                                            width="14"
                                            height="14"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                        >
                                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {editingSpeaker && (
                <RenameDialog
                    currentName={editingSpeaker.displayName}
                    isRecognized={editingSpeaker.isRecognized}
                    onSave={handleSaveRename}
                    onClose={() => setEditingSpeaker(null)}
                />
            )}
        </div>
    );
}
