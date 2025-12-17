/**
 * Экран запроса разрешений при первом запуске
 * Показывается если нет разрешения на микрофон
 */

import React, { useState, useCallback } from 'react';

interface PermissionsScreenProps {
    hasMicrophonePermission: boolean;
    hasScreenRecordingPermission: boolean;
    onRequestMicrophone: () => Promise<boolean>;
    onRequestScreenRecording: () => Promise<boolean>;
    onContinue: () => void;
    onOpenSystemPreferences: () => void;
}

export const PermissionsScreen: React.FC<PermissionsScreenProps> = ({
    hasMicrophonePermission,
    hasScreenRecordingPermission,
    onRequestMicrophone,
    onRequestScreenRecording,
    onContinue,
    onOpenSystemPreferences,
}) => {
    const [requesting, setRequesting] = useState(false);
    const [micRequested, setMicRequested] = useState(false);

    const handleRequestMicrophone = useCallback(async () => {
        setRequesting(true);
        try {
            const granted = await onRequestMicrophone();
            setMicRequested(true);
            if (!granted) {
                // Если не получили разрешение, откроем системные настройки
                // через 1 секунду показываем сообщение
            }
        } finally {
            setRequesting(false);
        }
    }, [onRequestMicrophone]);

    const handleRequestScreenRecording = useCallback(async () => {
        setRequesting(true);
        try {
            await onRequestScreenRecording();
        } finally {
            setRequesting(false);
        }
    }, [onRequestScreenRecording]);

    // Если микрофон разрешён, можно продолжить
    const canContinue = hasMicrophonePermission;

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            background: 'linear-gradient(135deg, #0a0a14 0%, #1a1a2e 100%)',
            color: '#fff',
            flexDirection: 'column',
            gap: '2rem',
            padding: '2rem',
        }}>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1rem',
            }}>
                <div style={{
                    width: '64px',
                    height: '64px',
                    background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
                    borderRadius: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '28px',
                    fontWeight: 'bold',
                }}>
                    AW
                </div>
                <h1 style={{ margin: 0, fontSize: '2rem' }}>AIWisper</h1>
            </div>

            <div style={{
                maxWidth: '500px',
                textAlign: 'center',
            }}>
                <h2 style={{ marginBottom: '1rem', color: '#e5e5e5' }}>
                    Требуется доступ к микрофону
                </h2>
                <p style={{ color: '#888', lineHeight: 1.6, marginBottom: '2rem' }}>
                    Для записи и транскрипции речи AIWisper необходим доступ к микрофону вашего компьютера.
                </p>
            </div>

            <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
                width: '100%',
                maxWidth: '400px',
            }}>
                {/* Микрофон */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '1rem 1.5rem',
                    background: hasMicrophonePermission ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                    border: `1px solid ${hasMicrophonePermission ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255, 255, 255, 0.1)'}`,
                    borderRadius: '12px',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <span style={{ fontSize: '1.5rem' }}>🎤</span>
                        <div>
                            <div style={{ fontWeight: 500 }}>Микрофон</div>
                            <div style={{ fontSize: '0.75rem', color: '#888' }}>
                                {hasMicrophonePermission ? 'Разрешён' : 'Требуется разрешение'}
                            </div>
                        </div>
                    </div>
                    {hasMicrophonePermission ? (
                        <span style={{ color: '#22c55e', fontSize: '1.25rem' }}>✓</span>
                    ) : (
                        <button
                            onClick={handleRequestMicrophone}
                            disabled={requesting}
                            style={{
                                padding: '0.5rem 1rem',
                                background: '#4f46e5',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '8px',
                                cursor: requesting ? 'wait' : 'pointer',
                                opacity: requesting ? 0.7 : 1,
                                fontWeight: 500,
                            }}
                        >
                            {requesting ? 'Запрос...' : 'Разрешить'}
                        </button>
                    )}
                </div>

                {/* Запись экрана (опционально) */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '1rem 1.5rem',
                    background: hasScreenRecordingPermission ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255, 255, 255, 0.03)',
                    border: `1px solid ${hasScreenRecordingPermission ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255, 255, 255, 0.05)'}`,
                    borderRadius: '12px',
                    opacity: 0.8,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <span style={{ fontSize: '1.5rem' }}>🖥️</span>
                        <div>
                            <div style={{ fontWeight: 500 }}>Запись системного аудио</div>
                            <div style={{ fontSize: '0.75rem', color: '#888' }}>
                                {hasScreenRecordingPermission ? 'Разрешён' : 'Опционально'}
                            </div>
                        </div>
                    </div>
                    {hasScreenRecordingPermission ? (
                        <span style={{ color: '#22c55e', fontSize: '1.25rem' }}>✓</span>
                    ) : (
                        <button
                            onClick={handleRequestScreenRecording}
                            disabled={requesting}
                            style={{
                                padding: '0.5rem 1rem',
                                background: 'rgba(255, 255, 255, 0.1)',
                                color: '#888',
                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                borderRadius: '8px',
                                cursor: requesting ? 'wait' : 'pointer',
                                opacity: requesting ? 0.7 : 1,
                                fontWeight: 500,
                            }}
                        >
                            Настроить
                        </button>
                    )}
                </div>
            </div>

            {/* Если запрос был сделан, но разрешение не получено */}
            {micRequested && !hasMicrophonePermission && (
                <div style={{
                    maxWidth: '400px',
                    padding: '1rem',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '12px',
                    textAlign: 'center',
                }}>
                    <p style={{ color: '#f87171', margin: 0, marginBottom: '0.75rem' }}>
                        Доступ к микрофону не был предоставлен
                    </p>
                    <p style={{ color: '#888', fontSize: '0.875rem', margin: 0, marginBottom: '1rem' }}>
                        Пожалуйста, откройте Системные настройки → Конфиденциальность и безопасность → Микрофон
                        и разрешите доступ для AIWisper, затем перезапустите приложение.
                    </p>
                    <button
                        onClick={onOpenSystemPreferences}
                        style={{
                            padding: '0.5rem 1rem',
                            background: 'rgba(255, 255, 255, 0.1)',
                            color: '#fff',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            fontWeight: 500,
                        }}
                    >
                        Открыть Системные настройки
                    </button>
                </div>
            )}

            {/* Кнопка продолжить */}
            <button
                onClick={onContinue}
                disabled={!canContinue}
                style={{
                    padding: '0.75rem 2rem',
                    background: canContinue ? 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' : 'rgba(255, 255, 255, 0.1)',
                    color: canContinue ? '#fff' : '#666',
                    border: 'none',
                    borderRadius: '12px',
                    cursor: canContinue ? 'pointer' : 'not-allowed',
                    fontWeight: 600,
                    fontSize: '1rem',
                    marginTop: '1rem',
                }}
            >
                {canContinue ? 'Продолжить' : 'Требуется разрешение на микрофон'}
            </button>
        </div>
    );
};

export default PermissionsScreen;
