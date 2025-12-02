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
    switch (status) {
        case 'active':
            return <span style={{ color: '#4ade80', fontSize: '0.8rem' }}>● Активна</span>;
        case 'downloaded':
            if (requiresPython) {
                return <span style={{ color: '#a78bfa', fontSize: '0.8rem' }}>☁ Онлайн</span>;
            }
            return <span style={{ color: '#60a5fa', fontSize: '0.8rem' }}>✓ Скачана</span>;
        case 'downloading':
            return <span style={{ color: '#fbbf24', fontSize: '0.8rem' }}>⬇ {progress?.toFixed(0)}%</span>;
        case 'error':
            return <span style={{ color: '#f87171', fontSize: '0.8rem' }}>✕ Ошибка</span>;
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
            backgroundColor: '#1a1a2e',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '0.75rem',
            border: isActive ? '2px solid #4ade80' : '1px solid #333',
        }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <LanguageIcon languages={model.languages} />
                    <span style={{ fontWeight: 'bold', fontSize: '1rem' }}>{model.name}</span>
                    {model.recommended && (
                        <span style={{ 
                            backgroundColor: '#4ade80', 
                            color: '#000', 
                            padding: '0.1rem 0.4rem', 
                            borderRadius: '4px',
                            fontSize: '0.7rem',
                            fontWeight: 'bold'
                        }}>
                            Рекомендуется
                        </span>
                    )}
                </div>
                <StatusBadge status={model.status} progress={model.progress} requiresPython={model.requiresPython} />
            </div>

            {/* Info */}
            <div style={{ fontSize: '0.85rem', color: '#888', marginBottom: '0.5rem' }}>
                {model.size} • Скорость: {model.speed}
                {model.wer && <span> • WER: {model.wer}</span>}
                {model.type === 'faster-whisper' && <span> • Faster-Whisper</span>}
                {model.requiresPython && <span> • Авто-загрузка</span>}
            </div>

            {/* Description */}
            <div style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '0.75rem' }}>
                {model.description}
            </div>

            {/* Progress bar */}
            {isDownloading && (
                <div style={{ marginBottom: '0.75rem' }}>
                    <div style={{
                        backgroundColor: '#333',
                        borderRadius: '4px',
                        height: '6px',
                        overflow: 'hidden'
                    }}>
                        <div style={{
                            backgroundColor: '#fbbf24',
                            height: '100%',
                            width: `${model.progress || 0}%`,
                            transition: 'width 0.3s ease'
                        }} />
                    </div>
                </div>
            )}

            {/* Error */}
            {model.error && (
                <div style={{ 
                    color: '#f87171', 
                    fontSize: '0.8rem', 
                    marginBottom: '0.5rem',
                    padding: '0.5rem',
                    backgroundColor: 'rgba(248, 113, 113, 0.1)',
                    borderRadius: '4px'
                }}>
                    {model.error}
                </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
                {!isDownloaded && !isDownloading && (
                    <button
                        onClick={onDownload}
                        style={{
                            padding: '0.4rem 0.8rem',
                            backgroundColor: '#3b82f6',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '0.85rem'
                        }}
                    >
                        Скачать
                    </button>
                )}

                {isDownloading && (
                    <button
                        onClick={onCancelDownload}
                        style={{
                            padding: '0.4rem 0.8rem',
                            backgroundColor: '#6b7280',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '0.85rem'
                        }}
                    >
                        Отмена
                    </button>
                )}

                {isDownloaded && !isActive && (
                    <>
                        <button
                            onClick={onSetActive}
                            style={{
                                padding: '0.4rem 0.8rem',
                                backgroundColor: '#4ade80',
                                color: '#000',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '0.85rem',
                                fontWeight: 'bold'
                            }}
                        >
                            Использовать
                        </button>
                        {!model.requiresPython && (
                            <button
                                onClick={onDelete}
                                style={{
                                    padding: '0.4rem 0.8rem',
                                    backgroundColor: 'transparent',
                                    color: '#f87171',
                                    border: '1px solid #f87171',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem'
                                }}
                            >
                                Удалить
                            </button>
                        )}
                    </>
                )}

                {isActive && (
                    <span style={{ 
                        padding: '0.4rem 0.8rem',
                        color: '#4ade80',
                        fontSize: '0.85rem'
                    }}>
                        ✓ Используется
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
    const [filter, setFilter] = useState<'all' | 'downloaded' | 'ggml' | 'faster-whisper'>('all');

    // Фильтрация моделей
    const filteredModels = models.filter(m => {
        if (filter === 'downloaded') return m.status === 'downloaded' || m.status === 'active';
        if (filter === 'ggml') return m.type === 'ggml';
        if (filter === 'faster-whisper') return m.type === 'faster-whisper';
        return true;
    });

    // Сортировка: рекомендуемые первые, потом по размеру
    const sortedModels = [...filteredModels].sort((a, b) => {
        if (a.recommended && !b.recommended) return -1;
        if (!a.recommended && b.recommended) return 1;
        return a.sizeBytes - b.sizeBytes;
    });

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000
        }}>
            <div style={{
                backgroundColor: '#12121f',
                borderRadius: '12px',
                width: '90%',
                maxWidth: '600px',
                maxHeight: '80vh',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
            }}>
                {/* Header */}
                <div style={{
                    padding: '1rem 1.5rem',
                    borderBottom: '1px solid #333',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                }}>
                    <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Модели Whisper</h2>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: '#888',
                            fontSize: '1.5rem',
                            cursor: 'pointer',
                            padding: '0.25rem'
                        }}
                    >
                        ×
                    </button>
                </div>

                {/* Filters */}
                <div style={{
                    padding: '0.75rem 1.5rem',
                    borderBottom: '1px solid #333',
                    display: 'flex',
                    gap: '0.5rem',
                    flexWrap: 'wrap'
                }}>
                    {[
                        { key: 'all', label: 'Все' },
                        { key: 'downloaded', label: 'Скачанные' },
                        { key: 'ggml', label: 'GGML' },
                        { key: 'faster-whisper', label: 'Faster-Whisper' }
                    ].map(({ key, label }) => (
                        <button
                            key={key}
                            onClick={() => setFilter(key as any)}
                            style={{
                                padding: '0.3rem 0.6rem',
                                backgroundColor: filter === key ? '#3b82f6' : '#333',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '0.8rem'
                            }}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Models list */}
                <div style={{
                    padding: '1rem 1.5rem',
                    overflowY: 'auto',
                    flex: 1
                }}>
                    {sortedModels.length === 0 ? (
                        <div style={{ textAlign: 'center', color: '#888', padding: '2rem' }}>
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
                    borderTop: '1px solid #333',
                    fontSize: '0.8rem',
                    color: '#666'
                }}>
                    Модели хранятся локально. GGML модели работают с whisper.cpp, 
                    Faster-Whisper — с CTranslate2 (требует Python).
                </div>
            </div>
        </div>
    );
}
