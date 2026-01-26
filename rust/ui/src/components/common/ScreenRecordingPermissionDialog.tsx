/**
 * Dialog shown when Screen Recording permission is required but not granted.
 * Explains the need and provides button to open System Preferences.
 */

import React from 'react';

interface ScreenRecordingPermissionDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenSettings: () => void;
    onDisableSystemAudio: () => void;
}

export const ScreenRecordingPermissionDialog: React.FC<ScreenRecordingPermissionDialogProps> = ({
    isOpen,
    onClose,
    onOpenSettings,
    onDisableSystemAudio,
}) => {
    if (!isOpen) return null;

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            backdropFilter: 'blur(4px)',
        }}>
            <div style={{
                background: 'var(--bg-secondary, #1a1a2e)',
                borderRadius: '16px',
                padding: '2rem',
                maxWidth: '450px',
                width: '90%',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
            }}>
                {/* Icon */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'center',
                    marginBottom: '1.5rem',
                }}>
                    <div style={{
                        width: '64px',
                        height: '64px',
                        borderRadius: '16px',
                        background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(239, 68, 68, 0.1) 100%)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '32px',
                    }}>
                        🔒
                    </div>
                </div>

                {/* Title */}
                <h2 style={{
                    margin: 0,
                    marginBottom: '1rem',
                    textAlign: 'center',
                    color: 'var(--text-primary, #fff)',
                    fontSize: '1.25rem',
                    fontWeight: 600,
                }}>
                    Требуется разрешение на запись экрана
                </h2>

                {/* Description */}
                <p style={{
                    margin: 0,
                    marginBottom: '1.5rem',
                    textAlign: 'center',
                    color: 'var(--text-secondary, #888)',
                    lineHeight: 1.6,
                    fontSize: '0.9rem',
                }}>
                    Для записи системного аудио (звуков приложений, видео, музыки) AIWisper
                    требуется разрешение на запись экрана в настройках macOS.
                </p>

                {/* Info box */}
                <div style={{
                    background: 'rgba(59, 130, 246, 0.1)',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    borderRadius: '8px',
                    padding: '0.75rem 1rem',
                    marginBottom: '1.5rem',
                }}>
                    <p style={{
                        margin: 0,
                        color: 'var(--text-secondary, #888)',
                        fontSize: '0.8rem',
                        lineHeight: 1.5,
                    }}>
                        <strong style={{ color: '#3b82f6' }}>Примечание:</strong> После включения
                        разрешения может потребоваться перезапуск приложения.
                    </p>
                </div>

                {/* Buttons */}
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                }}>
                    <button
                        onClick={onOpenSettings}
                        style={{
                            width: '100%',
                            padding: '0.875rem 1.5rem',
                            background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '10px',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: '0.95rem',
                            transition: 'transform 0.2s, box-shadow 0.2s',
                        }}
                        onMouseOver={(e) => {
                            e.currentTarget.style.transform = 'translateY(-1px)';
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(79, 70, 229, 0.4)';
                        }}
                        onMouseOut={(e) => {
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.boxShadow = 'none';
                        }}
                    >
                        Открыть Системные настройки
                    </button>

                    <button
                        onClick={onDisableSystemAudio}
                        style={{
                            width: '100%',
                            padding: '0.75rem 1.5rem',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'var(--text-secondary, #888)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '10px',
                            cursor: 'pointer',
                            fontWeight: 500,
                            fontSize: '0.9rem',
                            transition: 'background 0.2s',
                        }}
                        onMouseOver={(e) => {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                        }}
                        onMouseOut={(e) => {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                        }}
                    >
                        Отключить запись системного аудио
                    </button>

                    <button
                        onClick={onClose}
                        style={{
                            width: '100%',
                            padding: '0.5rem',
                            background: 'transparent',
                            color: 'var(--text-tertiary, #666)',
                            border: 'none',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            fontWeight: 400,
                            fontSize: '0.85rem',
                        }}
                    >
                        Отмена
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ScreenRecordingPermissionDialog;
