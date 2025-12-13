import React, { useState, useCallback } from 'react';
import { WebSocketProvider } from './context/WebSocketContext';
import { SessionProvider } from './context/SessionContext';
import { ModelProvider } from './context/ModelContext';
import { SettingsProvider } from './context/SettingsContext';
import { DiarizationProvider } from './context/DiarizationContext';
import { AudioProvider } from './context/AudioContext';
import { MainLayout } from './components/layout/MainLayout';

/**
 * Новая версия приложения с модульной архитектурой.
 * Использует контексты и хуки вместо монолитного App.tsx.
 * 
 * Порядок провайдеров важен:
 * 1. WebSocketProvider - базовое соединение
 * 2. ModelProvider - управление моделями
 * 3. SessionProvider - управление сессиями (зависит от WebSocket)
 * 4. SettingsProvider - настройки приложения
 * 5. DiarizationProvider - диаризация (зависит от WebSocket)
 * 6. AudioProvider - VU-метры и звуковые сигналы
 */
export const AppWithProviders: React.FC = () => {
    const [logs, setLogs] = useState<string[]>([]);

    const addLog = useCallback((msg: string) => {
        const time = new Date().toLocaleTimeString();
        setLogs(prev => [`[${time}] ${msg}`, ...prev].slice(0, 100));
    }, []);

    return (
        <WebSocketProvider>
            <ModelProvider>
                <SessionProvider>
                    <SettingsProvider>
                        <DiarizationProvider>
                            <AudioProvider>
                                <MainLayout logs={logs} addLog={addLog} />
                            </AudioProvider>
                        </DiarizationProvider>
                    </SettingsProvider>
                </SessionProvider>
            </ModelProvider>
        </WebSocketProvider>
    );
};

export default AppWithProviders;
