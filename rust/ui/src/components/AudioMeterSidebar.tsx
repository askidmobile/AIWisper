import React, { useState, useEffect } from 'react';

interface AudioMeterSidebarProps {
    micLevel: number;  // 0-100
    sysLevel: number;  // 0-100
    isActive: boolean; // Show when recording or playing
}

export const AudioMeterSidebar: React.FC<AudioMeterSidebarProps> = ({
    micLevel, sysLevel, isActive
}) => {
    // Состояние для отложенного скрытия (чтобы анимация успела проиграться)
    const [shouldRender, setShouldRender] = useState(isActive);
    const [isAnimating, setIsAnimating] = useState(false);

    useEffect(() => {
        if (isActive) {
            // Показываем сразу
            setShouldRender(true);
            // Небольшая задержка для запуска анимации после mount
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setIsAnimating(true);
                });
            });
        } else {
            // Начинаем анимацию скрытия
            setIsAnimating(false);
            // Убираем из DOM после завершения анимации
            const timer = setTimeout(() => {
                setShouldRender(false);
            }, 300); // Длительность анимации
            return () => clearTimeout(timer);
        }
    }, [isActive]);

    // Не рендерим если не нужно
    if (!shouldRender) {
        return null;
    }

    return (
        <div style={{
            width: isAnimating ? '55px' : '0px',
            minWidth: isAnimating ? '55px' : '0px',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'stretch',
            gap: '6px',
            padding: isAnimating ? '12px 8px' : '12px 0',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.15) 100%)',
            borderLeft: isAnimating ? '1px solid var(--border)' : '0px solid transparent',
            opacity: isAnimating ? 1 : 0,
            overflow: 'hidden',
            transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1), min-width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, padding 0.3s ease, border-left 0.3s ease',
        }}>
            {/* Microphone Level */}
            <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '4px'
            }}>
                <div style={{
                    flex: 1,
                    width: '12px',
                    background: 'var(--surface-strong)',
                    borderRadius: '6px',
                    position: 'relative',
                    overflow: 'hidden',
                    boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.3)'
                }}>
                    <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: `${micLevel}%`,
                        background: micLevel > 70
                            ? 'linear-gradient(to top, #ff5722, #ff9800)'
                            : 'linear-gradient(to top, #4caf50, #8bc34a)',
                        borderRadius: '6px',
                        transition: 'height 0.08s ease-out',
                        boxShadow: micLevel > 50 ? '0 0 10px rgba(76, 175, 80, 0.5)' : 'none'
                    }} />
                </div>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>🎤</span>
            </div>

            {/* System Level */}
            <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '4px'
            }}>
                <div style={{
                    flex: 1,
                    width: '12px',
                    background: 'var(--surface-strong)',
                    borderRadius: '6px',
                    position: 'relative',
                    overflow: 'hidden',
                    boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.3)'
                }}>
                    <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: `${sysLevel}%`,
                        background: sysLevel > 70
                            ? 'linear-gradient(to top, #e91e63, #f44336)'
                            : 'linear-gradient(to top, #2196f3, #03a9f4)',
                        borderRadius: '6px',
                        transition: 'height 0.08s ease-out',
                        boxShadow: sysLevel > 50 ? '0 0 10px rgba(33, 150, 243, 0.5)' : 'none'
                    }} />
                </div>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>🔊</span>
            </div>
        </div>
    );
};

export default AudioMeterSidebar;
