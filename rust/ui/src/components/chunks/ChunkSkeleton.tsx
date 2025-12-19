import React from 'react';

interface ChunkSkeletonProps {
    /** Номер чанка (для отображения) */
    chunkIndex?: number;
    /** Дополнительные стили */
    style?: React.CSSProperties;
}

/**
 * ChunkSkeleton — скелетон чанка, показывающий что идёт запись/распознавание.
 * Отображается под реальными чанками во время записи.
 */
export const ChunkSkeleton: React.FC<ChunkSkeletonProps> = ({
    chunkIndex,
    style,
}) => {
    return (
        <div
            style={{
                padding: '0.8rem 1rem',
                marginBottom: '0.75rem',
                backgroundColor: 'rgba(59, 130, 246, 0.05)',
                borderRadius: '10px',
                border: '1px dashed rgba(59, 130, 246, 0.3)',
                borderLeft: '3px solid rgba(59, 130, 246, 0.5)',
                animation: 'skeleton-pulse 2s ease-in-out infinite',
                ...style,
            }}
        >
            {/* Заголовок чанка */}
            <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                marginBottom: '0.75rem' 
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {chunkIndex !== undefined ? (
                        <span style={{ 
                            color: 'rgba(59, 130, 246, 0.7)', 
                            fontSize: '0.8rem', 
                            fontWeight: 600 
                        }}>
                            Чанк #{chunkIndex}
                        </span>
                    ) : (
                        <div 
                            style={{ 
                                width: '70px', 
                                height: '14px', 
                                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                                borderRadius: '4px',
                                animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
                            }} 
                        />
                    )}
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>•</span>
                    <div style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '0.35rem',
                        color: 'rgba(59, 130, 246, 0.7)',
                        fontSize: '0.75rem',
                    }}>
                        <span style={{ 
                            animation: 'recording-dot 1s ease-in-out infinite',
                            fontSize: '0.6rem',
                        }}>
                            ●
                        </span>
                        <span>Запись...</span>
                    </div>
                </div>
                
                {/* Индикатор записи */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '3px',
                }}>
                    {[...Array(4)].map((_, i) => (
                        <div
                            key={i}
                            style={{
                                width: '3px',
                                height: '12px',
                                backgroundColor: 'rgba(59, 130, 246, 0.5)',
                                borderRadius: '2px',
                                animation: `waveform-bar 0.8s ease-in-out ${i * 0.1}s infinite`,
                            }}
                        />
                    ))}
                </div>
            </div>

            {/* Скелетон текста - имитация строк транскрипции */}
            <div style={{ marginTop: '0.5rem' }}>
                {/* Строка 1: длинная */}
                <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem',
                    marginBottom: '0.5rem',
                }}>
                    {/* Имя спикера */}
                    <div 
                        style={{ 
                            width: '60px', 
                            height: '12px', 
                            backgroundColor: 'rgba(76, 175, 80, 0.2)',
                            borderRadius: '3px',
                            flexShrink: 0,
                        }} 
                    />
                    {/* Текст */}
                    <div 
                        style={{ 
                            flex: 1,
                            height: '12px', 
                            backgroundColor: 'rgba(255, 255, 255, 0.08)',
                            borderRadius: '3px',
                            animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
                        }} 
                    />
                </div>
                
                {/* Строка 2: средняя */}
                <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem',
                    marginBottom: '0.5rem',
                }}>
                    <div 
                        style={{ 
                            width: '80px', 
                            height: '12px', 
                            backgroundColor: 'rgba(33, 150, 243, 0.2)',
                            borderRadius: '3px',
                            flexShrink: 0,
                        }} 
                    />
                    <div 
                        style={{ 
                            width: '70%',
                            height: '12px', 
                            backgroundColor: 'rgba(255, 255, 255, 0.08)',
                            borderRadius: '3px',
                            animation: 'skeleton-shimmer 1.5s ease-in-out 0.2s infinite',
                        }} 
                    />
                </div>

                {/* Строка 3: короткая (исчезающая) */}
                <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem',
                    opacity: 0.5,
                }}>
                    <div 
                        style={{ 
                            width: '60px', 
                            height: '12px', 
                            backgroundColor: 'rgba(76, 175, 80, 0.15)',
                            borderRadius: '3px',
                            flexShrink: 0,
                        }} 
                    />
                    <div 
                        style={{ 
                            width: '40%',
                            height: '12px', 
                            backgroundColor: 'rgba(255, 255, 255, 0.05)',
                            borderRadius: '3px',
                            animation: 'skeleton-shimmer 1.5s ease-in-out 0.4s infinite',
                        }} 
                    />
                </div>
            </div>

            {/* Статус */}
            <div style={{ 
                marginTop: '0.75rem', 
                paddingTop: '0.5rem',
                borderTop: '1px dashed rgba(59, 130, 246, 0.2)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                color: 'rgba(59, 130, 246, 0.7)',
                fontSize: '0.8rem',
            }}>
                <div style={{
                    width: '14px',
                    height: '14px',
                    border: '2px solid rgba(59, 130, 246, 0.3)',
                    borderTopColor: 'rgba(59, 130, 246, 0.7)',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                }} />
                <span>Ожидание распознавания...</span>
            </div>

            {/* CSS анимации */}
            <style>{`
                @keyframes skeleton-pulse {
                    0%, 100% { 
                        opacity: 1;
                        background-color: rgba(59, 130, 246, 0.05);
                    }
                    50% { 
                        opacity: 0.7;
                        background-color: rgba(59, 130, 246, 0.08);
                    }
                }
                
                @keyframes skeleton-shimmer {
                    0% { 
                        opacity: 0.3;
                    }
                    50% { 
                        opacity: 0.6;
                    }
                    100% { 
                        opacity: 0.3;
                    }
                }
                
                @keyframes recording-dot {
                    0%, 100% { 
                        opacity: 0.4;
                        transform: scale(0.8);
                    }
                    50% { 
                        opacity: 1;
                        transform: scale(1.2);
                    }
                }
                
                @keyframes waveform-bar {
                    0%, 100% { 
                        height: 6px;
                        opacity: 0.4;
                    }
                    50% { 
                        height: 14px;
                        opacity: 0.8;
                    }
                }
                
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
};

export default ChunkSkeleton;
