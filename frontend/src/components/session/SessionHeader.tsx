import React, { useState } from 'react';
import { Session } from '../../types/session';

interface SessionHeaderProps {
    session: Session;
    
    // Состояния воспроизведения
    isPlaying: boolean;
    
    // Состояния операций
    isFullTranscribing: boolean;
    isImproving: boolean;
    isDiarizing: boolean;
    hasDialogue: boolean;
    copySuccess: boolean;
    
    // Обработчики
    onPlayPause: () => void;
    onExportCopy: () => void;
    onExportTxt: () => void;
    onExportSrt: () => void;
    onExportVtt: () => void;
    onExportJson: () => void;
    onExportMarkdown: () => void;
    onRetranscribe: () => void;
    onImprove: () => void;
    onDiarize: () => void;
    onDelete: () => void;
    onClose: () => void;
}

/**
 * Форматирование даты в локальный формат
 */
const formatDate = (isoString: string): string => {
    const date = new Date(isoString);
    return date.toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
};

/**
 * Форматирование длительности MM:SS
 */
const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Заголовок сессии с кнопками управления
 */
export const SessionHeader: React.FC<SessionHeaderProps> = ({
    session,
    isPlaying,
    isFullTranscribing,
    isImproving,
    isDiarizing,
    hasDialogue,
    copySuccess,
    onPlayPause,
    onExportCopy,
    onExportTxt,
    onExportSrt,
    onExportVtt,
    onExportJson,
    onExportMarkdown,
    onRetranscribe,
    onImprove,
    onDiarize,
    onDelete,
    onClose,
}) => {
    const [showShareMenu, setShowShareMenu] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const isStereo = session.chunks.length > 0 && session.chunks[0].isStereo;
    const durationSeconds = session.totalDuration / 1000000000;

    return (
        <>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1rem',
                padding: '1rem',
                background: 'var(--surface)',
                borderRadius: 'var(--radius-lg)',
                marginBottom: '1rem',
                border: '1px solid var(--glass-border-subtle)',
            }}>
                {/* Play/Pause Button */}
                <PlayButton isPlaying={isPlaying} onClick={onPlayPause} />

                {/* Title and Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                        fontSize: '1.1rem',
                        marginBottom: '0.2rem',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                    }}>
                        {session.title || 'Запись'}
                    </div>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        color: 'var(--text-muted)',
                        fontSize: '0.8rem',
                        flexWrap: 'wrap'
                    }}>
                        <span>{formatDate(session.startTime)}</span>
                        <span>•</span>
                        <span>{formatDuration(durationSeconds)}</span>
                        {isStereo && (
                            <>
                                <span>•</span>
                                <span style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--success)',
                                    backgroundColor: 'rgba(0, 184, 148, 0.12)',
                                    padding: '2px 6px',
                                    borderRadius: '999px'
                                }}>
                                    Стерео
                                </span>
                            </>
                        )}
                    </div>
                </div>

                {/* Action Buttons */}
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexShrink: 0 }}>
                    {/* Export Button */}
                    <ExportMenu
                        isOpen={showShareMenu}
                        onToggle={() => setShowShareMenu(!showShareMenu)}
                        copySuccess={copySuccess}
                        onCopy={onExportCopy}
                        onTxt={onExportTxt}
                        onSrt={onExportSrt}
                        onVtt={onExportVtt}
                        onJson={onExportJson}
                        onMarkdown={onExportMarkdown}
                    />

                    {/* Retranscribe Button */}
                    <ActionButton
                        onClick={onRetranscribe}
                        disabled={isFullTranscribing}
                        isActive={isFullTranscribing}
                        activeColor="rgba(156, 39, 176, 0.2)"
                        activeTextColor="#9c27b0"
                        title="Распознать заново"
                        icon={<RetranscribeIcon />}
                    />

                    {/* AI Improve Button */}
                    <ActionButton
                        onClick={onImprove}
                        disabled={isImproving || isDiarizing || isFullTranscribing || !hasDialogue}
                        isActive={isImproving}
                        activeColor="rgba(156, 39, 176, 0.2)"
                        activeTextColor="#9c27b0"
                        title="Улучшить с AI"
                        icon={<ImproveIcon />}
                        dimmed={!hasDialogue}
                    />

                    {/* AI Diarize Button */}
                    <ActionButton
                        onClick={onDiarize}
                        disabled={isDiarizing || isImproving || isFullTranscribing || !hasDialogue}
                        isActive={isDiarizing}
                        activeColor="rgba(33, 150, 243, 0.2)"
                        activeTextColor="#2196f3"
                        title="Разбить по собеседникам (AI)"
                        icon={<DiarizeIcon />}
                        dimmed={!hasDialogue}
                    />

                    {/* Delete Button */}
                    <ActionButton
                        onClick={() => setShowDeleteConfirm(true)}
                        title="Удалить запись"
                        icon={<DeleteIcon />}
                    />

                    {/* Close Button */}
                    <ActionButton
                        onClick={onClose}
                        title="Закрыть"
                        icon={<span>✕</span>}
                    />
                </div>
            </div>

            {/* Delete Confirmation Modal */}
            {showDeleteConfirm && (
                <DeleteConfirmModal
                    sessionTitle={session.title}
                    onCancel={() => setShowDeleteConfirm(false)}
                    onConfirm={() => {
                        setShowDeleteConfirm(false);
                        onDelete();
                    }}
                />
            )}
        </>
    );
};

// ============ Подкомпоненты ============

interface PlayButtonProps {
    isPlaying: boolean;
    onClick: () => void;
}

const PlayButton: React.FC<PlayButtonProps> = ({ isPlaying, onClick }) => (
    <button
        onClick={onClick}
        style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            border: 'none',
            background: isPlaying
                ? 'linear-gradient(135deg, #f44336, #e91e63)'
                : 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
            color: 'white',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: isPlaying
                ? '0 4px 20px rgba(244, 67, 54, 0.4)'
                : '0 4px 20px rgba(108, 92, 231, 0.4)',
            transition: 'all 0.3s ease',
            transform: 'scale(1)',
            flexShrink: 0
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
    >
        {isPlaying ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
        ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
            </svg>
        )}
    </button>
);

interface ActionButtonProps {
    onClick: () => void;
    disabled?: boolean;
    isActive?: boolean;
    activeColor?: string;
    activeTextColor?: string;
    title: string;
    icon: React.ReactNode;
    dimmed?: boolean;
}

const ActionButton: React.FC<ActionButtonProps> = ({
    onClick,
    disabled,
    isActive,
    activeColor,
    activeTextColor,
    title,
    icon,
    dimmed,
}) => (
    <button
        onClick={onClick}
        disabled={disabled}
        title={title}
        style={{
            width: '36px',
            height: '36px',
            padding: 0,
            backgroundColor: isActive ? activeColor : 'var(--surface-strong)',
            color: isActive ? activeTextColor : 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            cursor: disabled ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
            animation: isActive ? 'pulse 1.5s ease-in-out infinite' : 'none',
            opacity: dimmed ? 0.5 : 1
        }}
    >
        {icon}
    </button>
);

interface ExportMenuProps {
    isOpen: boolean;
    onToggle: () => void;
    copySuccess: boolean;
    onCopy: () => void;
    onTxt: () => void;
    onSrt: () => void;
    onVtt: () => void;
    onJson: () => void;
    onMarkdown: () => void;
}

const ExportMenu: React.FC<ExportMenuProps> = ({
    isOpen,
    onToggle,
    copySuccess,
    onCopy,
    onTxt,
    onSrt,
    onVtt,
    onJson,
    onMarkdown,
}) => (
    <div style={{ position: 'relative' }} data-share-menu>
        <button
            onClick={onToggle}
            title="Экспорт (⌘E)"
            style={{
                width: '36px',
                height: '36px',
                padding: 0,
                backgroundColor: copySuccess ? 'rgba(76, 175, 80, 0.2)' : 'var(--surface-strong)',
                color: copySuccess ? '#4caf50' : 'var(--text-muted)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s ease'
            }}
        >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
            </svg>
        </button>
        {isOpen && (
            <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '4px',
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                zIndex: 100,
                minWidth: '160px',
                overflow: 'hidden'
            }}>
                <ExportMenuItem onClick={onCopy} icon="📋" label="Копировать текст" />
                <ExportMenuItem onClick={onTxt} icon="📄" label="Скачать .txt" />
                <ExportMenuItem onClick={onSrt} icon="🎬" label="Скачать .srt (субтитры)" />
                <ExportMenuItem onClick={onVtt} icon="🌐" label="Скачать .vtt (WebVTT)" />
                <div style={{ borderTop: '1px solid var(--border)', margin: '0.3rem 0' }} />
                <ExportMenuItem onClick={onJson} icon="📊" label="Скачать .json (данные)" />
                <ExportMenuItem onClick={onMarkdown} icon="📝" label="Скачать .md (Markdown)" />
            </div>
        )}
    </div>
);

const ExportMenuItem: React.FC<{ onClick: () => void; icon: string; label: string }> = ({ onClick, icon, label }) => (
    <button
        onClick={onClick}
        style={{
            width: '100%',
            padding: '0.6rem 1rem',
            background: 'none',
            border: 'none',
            color: 'var(--text-primary)',
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: '0.85rem'
        }}
    >
        {icon} {label}
    </button>
);

interface DeleteConfirmModalProps {
    sessionTitle?: string;
    onCancel: () => void;
    onConfirm: () => void;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ sessionTitle, onCancel, onConfirm }) => (
    <div style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
    }}>
        <div style={{
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            padding: '1.5rem',
            maxWidth: '400px',
            width: '90%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.4)'
        }}>
            <h3 style={{ margin: '0 0 1rem', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
                Удалить запись?
            </h3>
            <p style={{ margin: '0 0 1.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Запись "{sessionTitle || 'Без названия'}" будет удалена безвозвратно.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button
                    onClick={onCancel}
                    style={{
                        padding: '0.6rem 1.2rem',
                        backgroundColor: 'var(--surface-strong)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        fontSize: '0.9rem'
                    }}
                >
                    Отмена
                </button>
                <button
                    onClick={onConfirm}
                    style={{
                        padding: '0.6rem 1.2rem',
                        backgroundColor: '#dc2626',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        fontSize: '0.9rem'
                    }}
                >
                    Удалить
                </button>
            </div>
        </div>
    </div>
);

// ============ Иконки ============

const RetranscribeIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M23 4v6h-6" />
        <path d="M1 20v-6h6" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
);

const ImproveIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
    </svg>
);

const DiarizeIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
);

const DeleteIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
);

export default SessionHeader;
