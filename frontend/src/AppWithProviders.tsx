import React, { useState, useCallback } from 'react';
import { WebSocketProvider } from './context/WebSocketContext';
import { SessionProvider } from './context/SessionContext';
import { ModelProvider } from './context/ModelContext';
import { SettingsProvider } from './context/SettingsContext';
import { MainLayout } from './components/layout/MainLayout';

/**
 * Новая версия приложения с модульной архитектурой.
 * Использует контексты и хуки вместо монолитного App.tsx.
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
                        <MainLayout logs={logs} addLog={addLog} />
                    </SettingsProvider>
                </SessionProvider>
            </ModelProvider>
        </WebSocketProvider>
    );
};

export default AppWithProviders;
