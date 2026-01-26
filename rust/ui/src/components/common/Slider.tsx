/**
 * Slider component in shadcn/ui style
 * Modern range slider with value display
 */

import React, { useState, useRef, useCallback } from 'react';

export interface SliderProps {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    label?: string;
    description?: string;
    showValue?: boolean;
    valueFormat?: (value: number) => string;
    className?: string;
}

export const Slider: React.FC<SliderProps> = ({
    value,
    onChange,
    min = 0,
    max = 100,
    step = 1,
    disabled = false,
    label,
    description,
    showValue = true,
    valueFormat,
    className = '',
}) => {
    const [isDragging, setIsDragging] = useState(false);
    const trackRef = useRef<HTMLDivElement>(null);
    
    // Calculate percentage for styling
    const percentage = ((value - min) / (max - min)) * 100;
    
    // Format display value
    const displayValue = valueFormat ? valueFormat(value) : value.toString();
    
    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        if (!disabled) {
            onChange(Number(e.target.value));
        }
    }, [disabled, onChange]);
    
    const handleMouseDown = () => setIsDragging(true);
    const handleMouseUp = () => setIsDragging(false);
    
    return (
        <div className={`slider-container ${className}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Label and Value Row */}
            {(label || showValue) && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    {label && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <span
                                style={{
                                    fontSize: '0.9rem',
                                    fontWeight: 500,
                                    color: 'var(--text-primary)',
                                }}
                            >
                                {label}
                            </span>
                            {description && (
                                <span
                                    style={{
                                        fontSize: '0.75rem',
                                        color: 'var(--text-muted)',
                                    }}
                                >
                                    {description}
                                </span>
                            )}
                        </div>
                    )}
                    {showValue && (
                        <span
                            style={{
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                color: 'var(--primary, #7c3aed)',
                                minWidth: '40px',
                                textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            {displayValue}
                        </span>
                    )}
                </div>
            )}
            
            {/* Slider Track */}
            <div
                ref={trackRef}
                style={{
                    position: 'relative',
                    width: '100%',
                    height: '24px',
                    display: 'flex',
                    alignItems: 'center',
                }}
            >
                {/* Background Track */}
                <div
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '6px',
                        borderRadius: '3px',
                        background: 'var(--slider-bg, rgba(120, 120, 128, 0.2))',
                    }}
                />
                
                {/* Filled Track */}
                <div
                    style={{
                        position: 'absolute',
                        width: `${percentage}%`,
                        height: '6px',
                        borderRadius: '3px',
                        background: disabled
                            ? 'var(--text-muted)'
                            : 'var(--primary, #7c3aed)',
                        transition: isDragging ? 'none' : 'width 0.1s ease',
                    }}
                />
                
                {/* Native Input (invisible but functional) */}
                <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={handleChange}
                    onMouseDown={handleMouseDown}
                    onMouseUp={handleMouseUp}
                    onTouchStart={handleMouseDown}
                    onTouchEnd={handleMouseUp}
                    disabled={disabled}
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '100%',
                        opacity: 0,
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        margin: 0,
                        zIndex: 2,
                    }}
                />
                
                {/* Custom Thumb */}
                <div
                    style={{
                        position: 'absolute',
                        left: `calc(${percentage}% - 10px)`,
                        width: '20px',
                        height: '20px',
                        borderRadius: '50%',
                        background: 'white',
                        boxShadow: isDragging
                            ? '0 0 0 4px var(--primary-alpha, rgba(124, 58, 237, 0.2)), 0 2px 8px rgba(0, 0, 0, 0.2)'
                            : '0 2px 6px rgba(0, 0, 0, 0.15)',
                        transition: isDragging ? 'box-shadow 0.15s ease' : 'left 0.1s ease, box-shadow 0.15s ease',
                        pointerEvents: 'none',
                        opacity: disabled ? 0.5 : 1,
                    }}
                />
            </div>
            
            {/* Min/Max Labels */}
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.7rem',
                    color: 'var(--text-muted)',
                    opacity: 0.7,
                }}
            >
                <span>{valueFormat ? valueFormat(min) : min}</span>
                <span>{valueFormat ? valueFormat(max) : max}</span>
            </div>
        </div>
    );
};

export default Slider;
