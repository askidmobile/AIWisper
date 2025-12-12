import React, { useState } from 'react';
import { VoicePrint } from '../../types/voiceprint';

interface VoiceprintsSettingsProps {
    voiceprints: VoicePrint[];
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
    onRefresh: () => void;
    isLoading?: boolean;
}

// Форматирование даты
const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    });
};

// Форматирование времени с момента последнего распознавания
const formatLastSeen = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Сегодня';
    if (diffDays === 1) return 'Вчера';
    if (diffDays < 7) return `${diffDays} дн. назад`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} нед. назад`;
    return formatDate(dateStr);
};

// Диалог переименования
interface RenameDialogProps {
    currentName: string;
    onSave: (name: string) => void;
    onClose: () => void;
}

const RenameDialog: React.FC<RenameDialogProps> = ({ currentName, onSave, onClose }) => {
    const [name, setName] = useState(currentName);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim()) {
            onSave(name.trim());
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
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1100,
            }}
            onClick={onClose}
        >
            <div
                style={{
                    backgroundColor: 'var(--surface)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '1.5rem',
                    minWidth: '320px',
                    boxShadow: 'var(--shadow-lg)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <h3 style={{ margin: '0 0 1rem', color: 'var(--text-primary)' }}>
                    Переименовать голос
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

// Диалог подтверждения удаления
interface DeleteDialogProps {
    name: string;
    onConfirm: () => void;
    onClose: () => void;
}

const DeleteDialog: React.FC<DeleteDialogProps> = ({ name, onConfirm, onClose }) => {
    return (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1100,
            }}
            onClick={onClose}
        >
            <div
                style={{
                    backgroundColor: 'var(--surface)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '1.5rem',
                    minWidth: '320px',
                    maxWidth: '400px',
                    boxShadow: 'var(--shadow-lg)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <h3 style={{ margin: '0 0 0.75rem', color: 'var(--text-primary)' }}>
                    Удалить голос?
                </h3>
                <p style={{ margin: '0 0 1.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    Голос «{name}» будет удалён из базы. Это действие нельзя отменить.
                </p>

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
                        type="button"
                        onClick={onConfirm}
                        style={{
                            padding: '0.6rem 1.2rem',
                            borderRadius: 'var(--radius-md)',
                            backgroundColor: 'var(--danger)',
                            color: 'white',
                            border: 'none',
                            cursor: 'pointer',
                        }}
                    >
                        Удалить
                    </button>
                </div>
            </div>
        </div>
    );
};

export const VoiceprintsSettings: React.FC<VoiceprintsSettingsProps> = ({
    voiceprints,
    onRename,
    onDelete,
    onRefresh,
    isLoading = false,
}) => {
    const [editingVoiceprint, setEditingVoiceprint] = useState<VoicePrint | null>(null);
    const [deletingVoiceprint, setDeletingVoiceprint] = useState<VoicePrint | null>(null);

    const handleSaveRename = (name: string) => {
        if (editingVoiceprint) {
            onRename(editingVoiceprint.id, name);
            setEditingVoiceprint(null);
        }
    };

    const handleConfirmDelete = () => {
        if (deletingVoiceprint) {
            onDelete(deletingVoiceprint.id);
            setDeletingVoiceprint(null);
        }
    };

    if (voiceprints.length === 0) {
        return (
            <div
                style={{
                    textAlign: 'center',
                    padding: '2rem 1rem',
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
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="22"/>
                </svg>
                <p style={{ margin: '0 0 0.5rem' }}>Нет сохранённых голосов</p>
                <p style={{ fontSize: '0.85rem', margin: 0 }}>
                    Голоса сохраняются при переименовании спикера с опцией «Запомнить голос»
                </p>
            </div>
        );
    }

    return (
        <div>
            {/* Header with refresh button */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '1rem',
                }}
            >
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    {voiceprints.length} {voiceprints.length === 1 ? 'голос' : 
                        voiceprints.length < 5 ? 'голоса' : 'голосов'}
                </span>
                <button
                    className="btn-icon btn-icon-sm"
                    onClick={onRefresh}
                    disabled={isLoading}
                    title="Обновить список"
                    style={{ width: '28px', height: '28px', opacity: isLoading ? 0.5 : 1 }}
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        style={{ animation: isLoading ? 'spin 1s linear infinite' : 'none' }}
                    >
                        <path d="M23 4v6h-6" />
                        <path d="M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                </button>
            </div>

            {/* Voiceprints list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {voiceprints.map((vp) => (
                    <div
                        key={vp.id}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.75rem',
                            backgroundColor: 'var(--glass-bg)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--glass-border)',
                        }}
                    >
                        {/* Avatar */}
                        <div
                            style={{
                                width: '36px',
                                height: '36px',
                                borderRadius: '50%',
                                backgroundColor: vp.source === 'mic' ? '#4caf50' : '#2196f3',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'white',
                                fontWeight: 'bold',
                                fontSize: '0.9rem',
                                flexShrink: 0,
                            }}
                        >
                            {vp.name.charAt(0).toUpperCase()}
                        </div>

                        {/* Info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                                style={{
                                    fontWeight: 600,
                                    color: 'var(--text-primary)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    fontSize: '0.9rem',
                                }}
                            >
                                {vp.name}
                            </div>
                            <div
                                style={{
                                    fontSize: '0.75rem',
                                    color: 'var(--text-muted)',
                                    display: 'flex',
                                    gap: '0.5rem',
                                }}
                            >
                                <span>{formatLastSeen(vp.lastSeenAt)}</span>
                                <span>·</span>
                                <span>{vp.seenCount} {vp.seenCount === 1 ? 'встреча' : 'встреч'}</span>
                            </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                            <button
                                onClick={() => setEditingVoiceprint(vp)}
                                className="btn-icon btn-icon-sm"
                                title="Переименовать"
                                style={{ width: '28px', height: '28px' }}
                            >
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                >
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                </svg>
                            </button>
                            <button
                                onClick={() => setDeletingVoiceprint(vp)}
                                className="btn-icon btn-icon-sm"
                                title="Удалить"
                                style={{ width: '28px', height: '28px', color: 'var(--danger)' }}
                            >
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                >
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                            </button>
                        </div>
                    </div>
                ))}
            </div>

            {/* Rename Dialog */}
            {editingVoiceprint && (
                <RenameDialog
                    currentName={editingVoiceprint.name}
                    onSave={handleSaveRename}
                    onClose={() => setEditingVoiceprint(null)}
                />
            )}

            {/* Delete Dialog */}
            {deletingVoiceprint && (
                <DeleteDialog
                    name={deletingVoiceprint.name}
                    onConfirm={handleConfirmDelete}
                    onClose={() => setDeletingVoiceprint(null)}
                />
            )}
        </div>
    );
};

export default VoiceprintsSettings;
