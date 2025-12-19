import React, { useEffect, useState, useRef } from 'react';
import { useBackendContext } from '../context/BackendContext';

interface StreamingTranscriptionProps {
    enabled: boolean;
    className?: string;
    compact?: boolean;
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
 * - Volatile text (приглушённый, курсив) — промежуточные гипотезы
 * - Confirmed text (основной цвет) — подтверждённый текст
 * - Плавная анимация перехода
 * - Автоскролл
 * - Индикатор уверенности модели
 */
export const StreamingTranscription: React.FC<StreamingTranscriptionProps> = ({
    enabled,
    className = '',
    compact = false,
}) => {
    const { subscribe } = useBackendContext();
    const [confirmedText, setConfirmedText] = useState('');
    const [volatileText, setVolatileText] = useState('');
    const [confidence, setConfidence] = useState(0);
    const [, setLastUpdate] = useState<number>(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
    const [copied, setCopied] = useState(false);

    // Копирование текста в буфер обмена
    const handleCopy = async () => {
        const textToCopy = confirmedText + (volatileText ? ' ' + volatileText : '');
        if (!textToCopy.trim()) return;

        try {
            await navigator.clipboard.writeText(textToCopy.trim());
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy text:', err);
        }
    };

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

            // Автоскроллим только если пользователь был «внизу».
            if (containerRef.current) {
                const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
                const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
                setShouldAutoScroll(isAtBottom);
            }
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

    const confidenceColor =
        confidence >= 0.85
            ? 'var(--success)'
            : confidence >= 0.7
                ? 'var(--warning-strong)'
                : 'var(--danger)';

    const containerStyle: React.CSSProperties = compact
        ? {
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem',
            padding: '0.5rem 0.25rem 0',
            borderRadius: '6px',
            overflow: 'hidden',
        }
        : {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'linear-gradient(180deg, rgba(59, 130, 246, 0.06) 0%, transparent 100%)',
            borderRadius: '8px',
            border: '1px solid rgba(59, 130, 246, 0.25)',
            overflow: 'hidden'
        };

    return (
        <div
            className={`streaming-transcription ${className}`}
            style={containerStyle}
        >
            {!compact && (
                    <div
                        style={{
                            padding: '0.75rem 1rem',
                            borderBottom: '1px solid rgba(59, 130, 246, 0.25)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            background: 'rgba(59, 130, 246, 0.06)'
                        }}
                    >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <div
                            style={{
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                background: 'var(--primary)',
                                animation: 'streamingPulse 2s ease-in-out infinite'
                            }}
                        />
                        <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            Live Транскрипция
                        </span>
                    </div>

                    {hasContent && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    Уверенность:
                                </span>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                        padding: '0.125rem 0.5rem',
                                        borderRadius: '12px',
                                        background: 'var(--surface-strong)',
                                        border: `1px solid ${confidenceColor}`
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

                            <button
                                onClick={handleCopy}
                                title="Копировать текст"
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.25rem 0.5rem',
                                    borderRadius: '6px',
                                    border: '1px solid rgba(59, 130, 246, 0.35)',
                                    background: copied ? 'rgba(16, 185, 129, 0.12)' : 'var(--surface-strong)',
                                    cursor: 'pointer',
                                    fontSize: '0.75rem',
                                    color: copied ? 'var(--success)' : 'var(--text-secondary)',
                                    transition: 'all 0.2s ease'
                                }}
                            >
                                {copied ? (
                                    <>
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12"/>
                                        </svg>
                                        <span>Скопировано</span>
                                    </>
                                ) : (
                                    <>
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                        </svg>
                                        <span>Копировать</span>
                                    </>
                                )}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Content */}
             <div
                 className="streaming-transcription__scroll"
                 ref={containerRef}
                 onScroll={handleScroll}
                 style={compact ? {
                     flex: 'unset',
                     padding: '0.4rem 0.5rem',
                     overflowY: 'hidden',
                     fontSize: '0.9rem',
                     lineHeight: '1.5',
                     color: 'var(--text-primary)'
                 } : {
                     flex: 1,
                     padding: '1rem',
                     overflowY: 'auto',
                     fontSize: '0.9375rem',
                     lineHeight: '1.6',
                     color: 'var(--text-primary)'
                 }}
             >
                {!hasContent ? (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            height: '100%',
                            color: 'var(--text-muted)',
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
                                    color: 'var(--text-primary)',
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
                                    color: 'var(--text-muted)',
                                    fontStyle: 'italic',
                                    fontWeight: 300,
                                    opacity: 1,
                                     transition: 'all 0.3s ease',
                                     animation: 'streamingFadeIn 0.3s ease-in-out'
                                }}
                            >
                                {volatileText}
                            </span>
                        )}
                    </div>
                )}
            </div>

            {/* Footer hint */}
            {hasContent && !compact && (
                <div
                    style={{
                        padding: '0.5rem 1rem',
                        borderTop: '1px solid rgba(59, 130, 246, 0.1)',
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
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
                                background: 'var(--text-primary)',
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
                                background: 'var(--text-muted)',
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
                @keyframes streamingPulse {
                    0%, 100% {
                        opacity: 1;
                        transform: scale(1);
                    }
                    50% {
                        opacity: 0.5;
                        transform: scale(0.95);
                    }
                }

                @keyframes streamingFadeIn {
                    from {
                        opacity: 0;
                        transform: translateY(-2px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .streaming-transcription__scroll::-webkit-scrollbar {
                    width: 6px;
                }

                .streaming-transcription__scroll::-webkit-scrollbar-track {
                    background: var(--surface);
                    border-radius: 3px;
                }

                .streaming-transcription__scroll::-webkit-scrollbar-thumb {
                    background: rgba(59, 130, 246, 0.3);
                    border-radius: 3px;
                }

                .streaming-transcription__scroll::-webkit-scrollbar-thumb:hover {
                    background: rgba(59, 130, 246, 0.5);
                }
            `}</style>
        </div>
    );
};

export default StreamingTranscription;
