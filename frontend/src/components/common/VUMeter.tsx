import React, { useMemo } from 'react';

interface VUMeterProps {
    level: number; // 0-100
    label?: string;
    color?: string;
    height?: number;
    width?: number;
    orientation?: 'horizontal' | 'vertical';
    showLabel?: boolean;
    showValue?: boolean;
    animated?: boolean;
}

/**
 * VU-метр для визуализации уровня звука
 */
export const VUMeter: React.FC<VUMeterProps> = ({
    level,
    label,
    color = 'var(--primary)',
    height = 4,
    width,
    orientation = 'horizontal',
    showLabel = false,
    showValue = false,
    animated = true,
}) => {
    // Нормализуем уровень
    const normalizedLevel = Math.max(0, Math.min(100, level));
    
    // Определяем цвет в зависимости от уровня
    const barColor = useMemo(() => {
        if (normalizedLevel > 90) return '#f44336'; // Красный - перегрузка
        if (normalizedLevel > 70) return '#ff9800'; // Оранжевый - высокий
        return color;
    }, [normalizedLevel, color]);

    if (orientation === 'vertical') {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '4px',
            }}>
                {showLabel && label && (
                    <span style={{ 
                        fontSize: '0.7rem', 
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                    }}>
                        {label}
                    </span>
                )}
                <div style={{
                    width: width || 8,
                    height: height || 60,
                    backgroundColor: 'var(--surface-strong)',
                    borderRadius: '4px',
                    overflow: 'hidden',
                    position: 'relative',
                }}>
                    <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: `${normalizedLevel}%`,
                        backgroundColor: barColor,
                        borderRadius: '4px',
                        transition: animated ? 'height 0.1s ease-out' : 'none',
                        boxShadow: normalizedLevel > 50 ? `0 0 8px ${barColor}` : 'none',
                    }} />
                </div>
                {showValue && (
                    <span style={{ 
                        fontSize: '0.65rem', 
                        color: 'var(--text-muted)',
                        fontFamily: 'monospace',
                    }}>
                        {Math.round(normalizedLevel)}
                    </span>
                )}
            </div>
        );
    }

    // Horizontal orientation
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: width || '100%',
        }}>
            {showLabel && label && (
                <span style={{ 
                    fontSize: '0.75rem', 
                    color: 'var(--text-muted)',
                    minWidth: '30px',
                }}>
                    {label}
                </span>
            )}
            <div style={{
                flex: 1,
                height: height,
                backgroundColor: 'var(--surface-strong)',
                borderRadius: height / 2,
                overflow: 'hidden',
                position: 'relative',
            }}>
                <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    bottom: 0,
                    width: `${normalizedLevel}%`,
                    backgroundColor: barColor,
                    borderRadius: height / 2,
                    transition: animated ? 'width 0.1s ease-out' : 'none',
                    boxShadow: normalizedLevel > 50 ? `0 0 6px ${barColor}` : 'none',
                }} />
            </div>
            {showValue && (
                <span style={{ 
                    fontSize: '0.7rem', 
                    color: 'var(--text-muted)',
                    fontFamily: 'monospace',
                    minWidth: '24px',
                    textAlign: 'right',
                }}>
                    {Math.round(normalizedLevel)}
                </span>
            )}
        </div>
    );
};

/**
 * Стерео VU-метр (два канала)
 */
interface StereoVUMeterProps {
    leftLevel: number;
    rightLevel: number;
    leftLabel?: string;
    rightLabel?: string;
    leftColor?: string;
    rightColor?: string;
    height?: number;
    orientation?: 'horizontal' | 'vertical';
    showLabels?: boolean;
    gap?: number;
}

export const StereoVUMeter: React.FC<StereoVUMeterProps> = ({
    leftLevel,
    rightLevel,
    leftLabel = 'Mic',
    rightLabel = 'Sys',
    leftColor = '#4caf50',
    rightColor = '#2196f3',
    height = 4,
    orientation = 'horizontal',
    showLabels = true,
    gap = 4,
}) => {
    if (orientation === 'vertical') {
        return (
            <div style={{
                display: 'flex',
                gap: `${gap}px`,
                alignItems: 'flex-end',
            }}>
                <VUMeter
                    level={leftLevel}
                    label={leftLabel}
                    color={leftColor}
                    height={60}
                    width={8}
                    orientation="vertical"
                    showLabel={showLabels}
                />
                <VUMeter
                    level={rightLevel}
                    label={rightLabel}
                    color={rightColor}
                    height={60}
                    width={8}
                    orientation="vertical"
                    showLabel={showLabels}
                />
            </div>
        );
    }

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: `${gap}px`,
        }}>
            <VUMeter
                level={leftLevel}
                label={leftLabel}
                color={leftColor}
                height={height}
                orientation="horizontal"
                showLabel={showLabels}
            />
            <VUMeter
                level={rightLevel}
                label={rightLabel}
                color={rightColor}
                height={height}
                orientation="horizontal"
                showLabel={showLabels}
            />
        </div>
    );
};

export default VUMeter;
