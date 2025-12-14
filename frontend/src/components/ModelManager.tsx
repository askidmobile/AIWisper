import { useState } from 'react';
import { ModelState, ModelStatus } from '../types/models';

interface ModelManagerProps {
    models: ModelState[];
    activeModelId: string | null;
    onDownload: (modelId: string) => void;
    onCancelDownload: (modelId: string) => void;
    onDelete: (modelId: string) => void;
    onSetActive: (modelId: string) => void;
    onClose: () => void;
}

// Иконка для языка
const LanguageIcon = ({ languages }: { languages: string[] }) => {
    if (languages.includes('ru') && languages.length === 1) {
        return <span title="Русский">🇷🇺</span>;
    }
    if (languages.includes('en') && languages.length === 1) {
        return <span title="English">🇬🇧</span>;
    }
    return <span title="Мультиязычная">🌍</span>;
};

// Статус бейдж
const StatusBadge = ({ status, progress, requiresPython }: { status: ModelStatus; progress?: number; requiresPython?: boolean }) => {
    const badgeStyle: React.CSSProperties = {
        fontSize: '0.75rem',
        padding: '0.15rem 0.5rem',
        borderRadius: 'var(--radius-capsule)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
    };

    switch (status) {
        case 'active':
            return (
                <span style={{ 
                    ...badgeStyle, 
                    background: 'rgba(52, 211, 153, 0.15)', 
                    color: 'var(--success)',
                    border: '1px solid rgba(52, 211, 153, 0.3)'
                }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--success)' }} />
                    Активна
                </span>
            );
        case 'downloaded':
            if (requiresPython) {
                return (
                    <span style={{ 
                        ...badgeStyle, 
                        background: 'rgba(139, 92, 246, 0.15)', 
                        color: 'var(--primary-light)',
                        border: '1px solid rgba(139, 92, 246, 0.3)'
                    }}>
                        Онлайн
                    </span>
                );
            }
            return (
                <span style={{ 
                    ...badgeStyle, 
                    background: 'rgba(96, 165, 250, 0.15)', 
                    color: '#60a5fa',
                    border: '1px solid rgba(96, 165, 250, 0.3)'
                }}>
                    Готова
                </span>
            );
        case 'downloading':
            return (
                <span style={{ 
                    ...badgeStyle, 
                    background: 'rgba(251, 191, 36, 0.15)', 
                    color: 'var(--warning)',
                    border: '1px solid rgba(251, 191, 36, 0.3)'
                }}>
                    {progress?.toFixed(0)}%
                </span>
            );
        case 'error':
            return (
                <span style={{ 
                    ...badgeStyle, 
                    background: 'rgba(248, 113, 113, 0.15)', 
                    color: 'var(--danger)',
                    border: '1px solid rgba(248, 113, 113, 0.3)'
                }}>
                    Ошибка
                </span>
            );
        default:
            return null;
    }
};

// Карточка модели
const ModelCard = ({ 
    model, 
    isActive,
    onDownload, 
    onCancelDownload,
    onDelete, 
    onSetActive 
}: { 
    model: ModelState;
    isActive: boolean;
    onDownload: () => void;
    onCancelDownload: () => void;
    onDelete: () => void;
    onSetActive: () => void;
}) => {
    const isDownloaded = model.status === 'downloaded' || model.status === 'active';
    const isDownloading = model.status === 'downloading';

    return (
        <div style={{
            background: isActive ? 'rgba(52, 211, 153, 0.08)' : 'var(--glass-bg)',
            borderRadius: 'var(--radius-md)',
            padding: '1rem',
            marginBottom: '0.75rem',
            border: isActive ? '1px solid rgba(52, 211, 153, 0.3)' : '1px solid var(--glass-border-subtle)',
            transition: 'all 0.15s ease',
        }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <LanguageIcon languages={model.languages} />
                    <span style={{ fontWeight: 'var(--font-weight-semibold)', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                        {model.name}
                    </span>
                    {model.recommended && (
                        <span style={{ 
                            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))', 
                            color: 'white', 
                            padding: '0.1rem 0.5rem', 
                            borderRadius: 'var(--radius-capsule)',
                            fontSize: '0.7rem',
                            fontWeight: 'var(--font-weight-semibold)'
                        }}>
                            Рекомендуется
                        </span>
                    )}
                </div>
                <StatusBadge status={model.status} progress={model.progress} requiresPython={model.requiresPython} />
            </div>

            {/* Info */}
            <div style={{ 
                fontSize: '0.8rem', 
                color: 'var(--text-muted)', 
                marginBottom: '0.5rem',
                display: 'flex',
                gap: '0.75rem',
                flexWrap: 'wrap',
                alignItems: 'center'
            }}>
                <span>{model.size}</span>
                <span>•</span>
                <span>Скорость: {model.speed}</span>
                {model.wer && <><span>•</span><span>WER: {model.wer}</span></>}
                {model.type === 'coreml' && (
                    <>
                        <span>•</span>
                        <span style={{ 
                            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                            color: 'white',
                            padding: '0.1rem 0.4rem',
                            borderRadius: 'var(--radius-capsule)',
                            fontSize: '0.7rem',
                            fontWeight: 'var(--font-weight-semibold)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.2rem'
                        }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z"/>
                            </svg>
                            ANE
                        </span>
                    </>
                )}
            </div>

            {/* Description */}
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.4 }}>
                {model.description}
                {model.type === 'coreml' && (
                    <div style={{ 
                        marginTop: '0.5rem',
                        padding: '0.5rem 0.75rem',
                        background: 'rgba(102, 126, 234, 0.1)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid rgba(102, 126, 234, 0.2)',
                        fontSize: '0.8rem',
                        color: 'var(--text-secondary)'
                    }}>
                        💡 Модель скачивается автоматически при первом использовании (~640 MB)
                    </div>
                )}
            </div>

            {/* Progress bar */}
            {isDownloading && (
                <div style={{ marginBottom: '0.75rem' }}>
                    <div style={{
                        background: 'var(--glass-bg-elevated)',
                        borderRadius: 'var(--radius-capsule)',
                        height: '6px',
                        overflow: 'hidden'
                    }}>
                        <div style={{
                            background: 'linear-gradient(90deg, var(--warning), #f59e0b)',
                            height: '100%',
                            width: `${model.progress || 0}%`,
                            transition: 'width 0.3s ease',
                            borderRadius: 'var(--radius-capsule)'
                        }} />
                    </div>
                </div>
            )}

            {/* Error */}
            {model.error && (
                <div style={{ 
                    color: 'var(--danger)', 
                    fontSize: '0.8rem', 
                    marginBottom: '0.5rem',
                    padding: '0.5rem 0.75rem',
                    background: 'rgba(248, 113, 113, 0.1)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid rgba(248, 113, 113, 0.2)'
                }}>
                    {model.error}
                </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {!isDownloaded && !isDownloading && model.type !== 'coreml' && (
                    <button
                        className="btn-capsule btn-capsule-primary"
                        onClick={onDownload}
                        style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}
                    >
                        Скачать
                    </button>
                )}
                
                {/* CoreML модели не требуют ручного скачивания */}
                {!isDownloaded && !isDownloading && model.type === 'coreml' && (
                    <button
                        className="btn-capsule btn-capsule-primary"
                        onClick={onSetActive}
                        style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}
                    >
                        Использовать
                    </button>
                )}

                {isDownloading && (
                    <button
                        className="btn-capsule"
                        onClick={onCancelDownload}
                        style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}
                    >
                        Отмена
                    </button>
                )}

                {isDownloaded && !isActive && (
                    <>
                        <button
                            className="btn-capsule"
                            onClick={onSetActive}
                            style={{ 
                                padding: '0.4rem 0.9rem', 
                                fontSize: '0.85rem',
                                background: 'rgba(52, 211, 153, 0.15)',
                                border: '1px solid rgba(52, 211, 153, 0.3)',
                                color: 'var(--success)'
                            }}
                        >
                            Использовать
                        </button>
                        {!model.requiresPython && (
                            <button
                                className="btn-capsule"
                                onClick={onDelete}
                                style={{ 
                                    padding: '0.4rem 0.9rem', 
                                    fontSize: '0.85rem',
                                    background: 'transparent',
                                    border: '1px solid rgba(248, 113, 113, 0.3)',
                                    color: 'var(--danger)'
                                }}
                            >
                                Удалить
                            </button>
                        )}
                    </>
                )}

                {isActive && (
                    <span style={{ 
                        padding: '0.4rem 0.9rem',
                        color: 'var(--success)',
                        fontSize: '0.85rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem'
                    }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        Используется
                    </span>
                )}
            </div>
        </div>
    );
};

export default function ModelManager({
    models,
    activeModelId,
    onDownload,
    onCancelDownload,
    onDelete,
    onSetActive,
    onClose
}: ModelManagerProps) {
    const [filter, setFilter] = useState<'all' | 'downloaded' | 'ggml' | 'onnx' | 'coreml'>('all');

    // Фильтрация моделей - только модели транскрипции (не диаризации)
    const filteredModels = models.filter(m => {
        // Исключаем модели диаризации - они управляются через настройки
        if (m.engine === 'diarization') return false;
        
        if (filter === 'downloaded') return m.status === 'downloaded' || m.status === 'active';
        if (filter === 'ggml') return m.type === 'ggml';
        if (filter === 'onnx') return m.type === 'onnx';
        if (filter === 'coreml') return m.type === 'coreml';
        return true;
    });

    // Сортировка: рекомендуемые первые, потом по размеру
    const sortedModels = [...filteredModels].sort((a, b) => {
        if (a.recommended && !b.recommended) return -1;
        if (!a.recommended && b.recommended) return 1;
        return a.sizeBytes - b.sizeBytes;
    });

    const filterButtons = [
        { key: 'all', label: 'Все' },
        { key: 'downloaded', label: 'Скачанные' },
        { key: 'ggml', label: 'Whisper' },
        { key: 'onnx', label: 'GigaAM' },
        { key: 'coreml', label: 'Parakeet' }
    ];

    return (
        <div 
            className="animate-scale-in"
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0, 0, 0, 0.6)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: 1100
            }}
            onClick={onClose}
        >
            <div 
                style={{
                    background: 'var(--glass-bg-elevated)',
                    backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    borderRadius: 'var(--radius-xl)',
                    width: '90%',
                    maxWidth: '600px',
                    maxHeight: '80vh',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    boxShadow: 'var(--shadow-elevated)',
                    border: '1px solid var(--glass-border)'
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div style={{
                    padding: '1.25rem 1.5rem',
                    borderBottom: '1px solid var(--glass-border-subtle)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexShrink: 0
                }}>
                    <h2 style={{ 
                        margin: 0, 
                        fontSize: '1.2rem', 
                        fontWeight: 'var(--font-weight-bold)',
                        color: 'var(--text-primary)'
                    }}>
                        Модели транскрипции
                    </h2>
                    <button
                        className="btn-icon"
                        onClick={onClose}
                        style={{ width: '32px', height: '32px' }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>

                {/* Filters */}
                <div style={{
                    padding: '0.75rem 1.5rem',
                    borderBottom: '1px solid var(--glass-border-subtle)',
                    flexShrink: 0
                }}>
                    <div className="segmented-control" style={{ display: 'inline-flex' }}>
                        {filterButtons.map(({ key, label }) => (
                            <button
                                key={key}
                                className={`segmented-control-item ${filter === key ? 'active' : ''}`}
                                onClick={() => setFilter(key as any)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Models list */}
                <div style={{
                    padding: '1rem 1.5rem',
                    overflowY: 'auto',
                    flex: 1
                }}>
                    {sortedModels.length === 0 ? (
                        <div style={{ 
                            textAlign: 'center', 
                            color: 'var(--text-muted)', 
                            padding: '2rem',
                            fontSize: '0.9rem'
                        }}>
                            Нет моделей для отображения
                        </div>
                    ) : (
                        sortedModels.map(model => (
                            <ModelCard
                                key={model.id}
                                model={model}
                                isActive={model.id === activeModelId}
                                onDownload={() => onDownload(model.id)}
                                onCancelDownload={() => onCancelDownload(model.id)}
                                onDelete={() => onDelete(model.id)}
                                onSetActive={() => onSetActive(model.id)}
                            />
                        ))
                    )}
                </div>

                {/* Footer */}
                <div style={{
                    padding: '0.75rem 1.5rem',
                    borderTop: '1px solid var(--glass-border-subtle)',
                    fontSize: '0.8rem',
                    color: 'var(--text-muted)',
                    flexShrink: 0
                }}>
                    Модели хранятся локально. GGML — whisper.cpp, GigaAM — ONNX, Parakeet — CoreML (Apple Neural Engine).
                </div>
            </div>
        </div>
    );
}
