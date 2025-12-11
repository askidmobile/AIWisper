import React, { useEffect, useState, useRef } from 'react';
import { useWebSocketContext } from '../context/WebSocketContext';

interface StreamingTranscriptionProps {
    enabled: boolean;
    className?: string;
}

interface StreamingUpdate {
    text: string;
    isConfirmed: boolean;
    confidence: number;
    timestamp: number;
}

/**
 * StreamingTranscription - компонент для отображения real-time транскрипции
 * 
 * Особенности:
 * - Volatile text (серый, курсив) - промежуточные гипотезы
 * - Confirmed text (чёрный, нормальный) - подтверждённый текст
 * - Плавная анимация перехода
 * - Автоскролл
 * - Индикатор уверенности модели
 */
export const StreamingTranscription: React.FC<StreamingTranscriptionProps> = ({
    enabled,
    className = ''
}) => {
    const { subscribe } = useWebSocketContext();
    const [confirmedText, setConfirmedText] = useState('');
    const [volatileText, setVolatileText] = useState('');
    const [confidence, setConfidence] = useState(0);
    const [lastUpdate, setLastUpdate] = useState<number>(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

    // Подписка на streaming updates
    useEffect(() => {
        if (!enabled) {
            // Сброс при отключении
            setConfirmedText('');
            setVolatileText('');
            setConfidence(0);
            return;
        }

        const unsubscribe = subscribe('streaming_update', (msg: any) => {
            const update: StreamingUpdate = {
                text: msg.streamingText || '',
                isConfirmed: msg.streamingIsConfirmed || false,
                confidence: msg.streamingConfidence || 0,
                timestamp: msg.streamingTimestamp || Date.now()
            };

            setLastUpdate(update.timestamp);
            setConfidence(update.confidence);

            if (update.isConfirmed) {
                // Confirmed: добавляем к confirmed text, очищаем volatile
                setConfirmedText(prev => {
                    const newText = prev ? `${prev} ${update.text}` : update.text;
                    return newText.trim();
                });
                setVolatileText('');
            } else {
                // Volatile: обновляем volatile text
                setVolatileText(update.text);
            }

            // Включаем автоскролл при новом обновлении
            setShouldAutoScroll(true);
        });

        return () => unsubscribe();
    }, [enabled, subscribe]);

    // Автоскролл
    useEffect(() => {
        if (shouldAutoScroll && containerRef.current) {
            containerRef.current.scrollTo({
                top: containerRef.current.scrollHeight,
                behavior: 'smooth'
            });
            setShouldAutoScroll(false);
        }
    }, [shouldAutoScroll, confirmedText, volatileText]);

    // Обработка ручного скролла (отключаем автоскролл)
    const handleScroll = () => {
        if (!containerRef.current) return;
        
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
        
        setShouldAutoScroll(isAtBottom);
    };

    if (!enabled) {
        return null;
    }

    const hasContent = confirmedText || volatileText;
    const confidencePercent = Math.round(confidence * 100);
    const confidenceColor = confidence >= 0.85 ? '#10b981' : confidence >= 0.7 ? '#f59e0b' : '#ef4444';

    return (
        <div
            className={`streaming-transcription ${className}`}
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                background: 'linear-gradient(180deg, rgba(59, 130, 246, 0.05) 0%, transparent 100%)',
                borderRadius: '8px',
                border: '1px solid rgba(59, 130, 246, 0.2)',
                overflow: 'hidden'
            }}
        >
            {/* Header */}
            <div
                style={{
                    padding: '0.75rem 1rem',
                    borderBottom: '1px solid rgba(59, 130, 246, 0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'rgba(59, 130, 246, 0.05)'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {/* Pulsing indicator */}
                    <div
                        style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: '#3b82f6',
                            animation: 'pulse 2s ease-in-out infinite'
                        }}
                    />
                    <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#1f2937' }}>
                        Live Транскрипция
                    </span>
                </div>

                {/* Confidence indicator */}
                {hasContent && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                            Уверенность:
                        </span>
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.125rem 0.5rem',
                                borderRadius: '12px',
                                background: 'rgba(255, 255, 255, 0.8)',
                                border: `1px solid ${confidenceColor}20`
                            }}
                        >
                            <div
                                style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '50%',
                                    background: confidenceColor
                                }}
                            />
                            <span
                                style={{
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                    color: confidenceColor
                                }}
                            >
                                {confidencePercent}%
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {/* Content */}
            <div
                ref={containerRef}
                onScroll={handleScroll}
                style={{
                    flex: 1,
                    padding: '1rem',
                    overflowY: 'auto',
                    fontSize: '0.9375rem',
                    lineHeight: '1.6',
                    color: '#1f2937'
                }}
            >
                {!hasContent ? (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            height: '100%',
                            color: '#9ca3af',
                            fontSize: '0.875rem'
                        }}
                    >
                        Ожидание аудио...
                    </div>
                ) : (
                    <div>
                        {/* Confirmed text */}
                        {confirmedText && (
                            <span
                                style={{
                                    color: '#1f2937',
                                    fontWeight: 400,
                                    transition: 'all 0.3s ease'
                                }}
                            >
                                {confirmedText}
                            </span>
                        )}

                        {/* Separator */}
                        {confirmedText && volatileText && ' '}

                        {/* Volatile text */}
                        {volatileText && (
                            <span
                                style={{
                                    color: '#9ca3af',
                                    fontStyle: 'italic',
                                    fontWeight: 300,
                                    opacity: 0.8,
                                    transition: 'all 0.3s ease',
                                    animation: 'fadeIn 0.3s ease-in-out'
                                }}
                            >
                                {volatileText}
                            </span>
                        )}
                    </div>
                )}
            </div>

            {/* Footer hint */}
            {hasContent && (
                <div
                    style={{
                        padding: '0.5rem 1rem',
                        borderTop: '1px solid rgba(59, 130, 246, 0.1)',
                        fontSize: '0.75rem',
                        color: '#9ca3af',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '1rem'
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <div
                            style={{
                                width: '12px',
                                height: '2px',
                                background: '#1f2937',
                                borderRadius: '1px'
                            }}
                        />
                        <span>Подтверждённый</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <div
                            style={{
                                width: '12px',
                                height: '2px',
                                background: '#9ca3af',
                                borderRadius: '1px',
                                opacity: 0.6
                            }}
                        />
                        <span style={{ fontStyle: 'italic' }}>Промежуточный</span>
                    </div>
                </div>
            )}

            {/* CSS animations */}
            <style>{`
                @keyframes pulse {
                    0%, 100% {
                        opacity: 1;
                        transform: scale(1);
                    }
                    50% {
                        opacity: 0.5;
                        transform: scale(0.95);
                    }
                }

                @keyframes fadeIn {
                    from {
                        opacity: 0;
                        transform: translateY(-2px);
                    }
                    to {
                        opacity: 0.8;
                        transform: translateY(0);
                    }
                }

                .streaming-transcription::-webkit-scrollbar {
                    width: 6px;
                }

                .streaming-transcription::-webkit-scrollbar-track {
                    background: rgba(0, 0, 0, 0.05);
                    border-radius: 3px;
                }

                .streaming-transcription::-webkit-scrollbar-thumb {
                    background: rgba(59, 130, 246, 0.3);
                    border-radius: 3px;
                }

                .streaming-transcription::-webkit-scrollbar-thumb:hover {
                    background: rgba(59, 130, 246, 0.5);
                }
            `}</style>
        </div>
    );
};

export default StreamingTranscription;
