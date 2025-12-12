import React, { useState, useRef, useEffect } from 'react';

interface HelpTooltipProps {
    title: string;
    children: React.ReactNode;
    position?: 'top' | 'bottom' | 'left' | 'right';
    maxWidth?: number;
}

/**
 * Компонент HelpTooltip - иконка (?) с всплывающей подсказкой
 * При клике показывает модальное окно с подробной информацией
 */
export const HelpTooltip: React.FC<HelpTooltipProps> = ({
    title,
    children,
    position = 'bottom',
    maxWidth = 400,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    // Закрытие при клике вне tooltip
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                tooltipRef.current &&
                !tooltipRef.current.contains(event.target as Node) &&
                buttonRef.current &&
                !buttonRef.current.contains(event.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    // Закрытие по Escape
    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
        }

        return () => {
            document.removeEventListener('keydown', handleEscape);
        };
    }, [isOpen]);

    const getPositionStyles = (): React.CSSProperties => {
        switch (position) {
            case 'top':
                return {
                    bottom: '100%',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    marginBottom: '8px',
                };
            case 'bottom':
                return {
                    top: '100%',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    marginTop: '8px',
                };
            case 'left':
                return {
                    right: '100%',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    marginRight: '8px',
                };
            case 'right':
                return {
                    left: '100%',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    marginLeft: '8px',
                };
            default:
                return {};
        }
    };

    return (
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            <button
                ref={buttonRef}
                onClick={() => setIsOpen(!isOpen)}
                style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    border: '1px solid var(--text-muted)',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--primary)';
                    e.currentTarget.style.color = 'var(--primary)';
                }}
                onMouseLeave={(e) => {
                    if (!isOpen) {
                        e.currentTarget.style.borderColor = 'var(--text-muted)';
                        e.currentTarget.style.color = 'var(--text-muted)';
                    }
                }}
                aria-label={`Справка: ${title}`}
                title="Нажмите для подробной информации"
            >
                ?
            </button>

            {isOpen && (
                <div
                    ref={tooltipRef}
                    style={{
                        position: 'absolute',
                        zIndex: 1000,
                        ...getPositionStyles(),
                    }}
                >
                    <div
                        style={{
                            background: 'var(--surface-strong)',
                            border: '1px solid var(--border)',
                            borderRadius: '12px',
                            padding: '16px',
                            maxWidth: `${maxWidth}px`,
                            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
                            animation: 'fadeIn 0.2s ease',
                        }}
                    >
                        {/* Заголовок */}
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                marginBottom: '12px',
                                paddingBottom: '8px',
                                borderBottom: '1px solid var(--border)',
                            }}
                        >
                            <span
                                style={{
                                    fontSize: '0.95rem',
                                    fontWeight: 600,
                                    color: 'var(--text-primary)',
                                }}
                            >
                                {title}
                            </span>
                            <button
                                onClick={() => setIsOpen(false)}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--text-muted)',
                                    cursor: 'pointer',
                                    fontSize: '18px',
                                    padding: '0 4px',
                                    lineHeight: 1,
                                }}
                                aria-label="Закрыть"
                            >
                                &times;
                            </button>
                        </div>

                        {/* Контент */}
                        <div
                            style={{
                                fontSize: '0.85rem',
                                color: 'var(--text-secondary)',
                                lineHeight: 1.6,
                            }}
                        >
                            {children}
                        </div>
                    </div>
                </div>
            )}

            <style>{`
                @keyframes fadeIn {
                    from {
                        opacity: 0;
                        transform: translateX(-50%) translateY(-4px);
                    }
                    to {
                        opacity: 1;
                        transform: translateX(-50%) translateY(0);
                    }
                }
            `}</style>
        </div>
    );
};

export default HelpTooltip;
