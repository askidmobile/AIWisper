/**
 * Switch component in shadcn/ui style
 * iOS-style toggle switch
 */

import React from 'react';

export interface SwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    size?: 'sm' | 'md' | 'lg';
    label?: string;
    description?: string;
    id?: string;
    className?: string;
}

export const Switch: React.FC<SwitchProps> = ({
    checked,
    onChange,
    disabled = false,
    size = 'md',
    label,
    description,
    id,
    className = '',
}) => {
    const switchId = id || `switch-${Math.random().toString(36).slice(2, 9)}`;
    
    // Size configurations
    const sizes = {
        sm: { width: 36, height: 20, thumb: 16, translate: 16 },
        md: { width: 44, height: 24, thumb: 20, translate: 20 },
        lg: { width: 52, height: 28, thumb: 24, translate: 24 },
    };
    
    const { width, height, thumb, translate } = sizes[size];
    
    const handleClick = () => {
        if (!disabled) {
            onChange(!checked);
        }
    };
    
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleClick();
        }
    };
    
    return (
        <div className={`switch-container ${className}`} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
            <button
                id={switchId}
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={label}
                disabled={disabled}
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                style={{
                    position: 'relative',
                    display: 'inline-flex',
                    flexShrink: 0,
                    width: `${width}px`,
                    height: `${height}px`,
                    borderRadius: `${height}px`,
                    border: 'none',
                    padding: '2px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    background: checked
                        ? 'var(--primary, #7c3aed)'
                        : 'var(--switch-bg, rgba(120, 120, 128, 0.32))',
                    transition: 'background-color 0.2s ease',
                    opacity: disabled ? 0.5 : 1,
                    outline: 'none',
                }}
                onFocus={(e) => {
                    e.currentTarget.style.boxShadow = '0 0 0 2px var(--primary-alpha, rgba(124, 58, 237, 0.3))';
                }}
                onBlur={(e) => {
                    e.currentTarget.style.boxShadow = 'none';
                }}
            >
                <span
                    style={{
                        display: 'block',
                        width: `${thumb}px`,
                        height: `${thumb}px`,
                        borderRadius: '50%',
                        background: 'white',
                        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.12)',
                        transition: 'transform 0.2s ease',
                        transform: checked ? `translateX(${translate}px)` : 'translateX(0)',
                    }}
                />
            </button>
            
            {(label || description) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                    {label && (
                        <label
                            htmlFor={switchId}
                            style={{
                                fontSize: '0.9rem',
                                fontWeight: 500,
                                color: 'var(--text-primary)',
                                cursor: disabled ? 'not-allowed' : 'pointer',
                            }}
                            onClick={handleClick}
                        >
                            {label}
                        </label>
                    )}
                    {description && (
                        <span
                            style={{
                                fontSize: '0.8rem',
                                color: 'var(--text-muted)',
                                lineHeight: 1.4,
                            }}
                        >
                            {description}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};

export default Switch;
