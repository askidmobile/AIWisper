/**
 * Tauri version of the application.
 * Uses TauriProvider instead of WebSocketProvider.
 * 
 * This is the entry point for the Tauri app.
 */

import React, { useCallback } from 'react';
import { TauriProvider } from './context/TauriContext';
import { SessionProvider } from './context/SessionContext';
import { ModelProvider } from './context/ModelContext';
import { SettingsProvider } from './context/SettingsContext';
import { DiarizationProvider } from './context/DiarizationContext';
import { AudioProvider } from './context/AudioContext';
import { ProvidersProvider } from './context/ProvidersContext';
import { MainLayout } from './components/layout/MainLayout';

/**
 * Check if running in Tauri environment
 */
const isTauri = () => '__TAURI__' in window;

/**
 * Tauri application with providers.
 * 
 * Provider order:
 * 1. TauriProvider - Tauri IPC communication (replaces WebSocketProvider)
 * 2. ModelProvider - model management
 * 3. SessionProvider - session management
 * 4. SettingsProvider - application settings
 * 5. ProvidersProvider - STT/LLM provider settings
 * 6. DiarizationProvider - speaker diarization
 * 7. AudioProvider - VU meters and audio signals
 */
export const AppTauri: React.FC = () => {
    const addLog = useCallback((msg: string) => {
        console.log(`[AIWisper] ${msg}`);
    }, []);

    // If not in Tauri, show error
    if (!isTauri()) {
        return (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100vh',
                background: '#0a0a14',
                color: '#fff',
                flexDirection: 'column',
                gap: '1rem',
            }}>
                <h1>AIWisper</h1>
                <p>This app requires Tauri runtime.</p>
                <p style={{ color: '#888', fontSize: '0.875rem' }}>
                    Please run with: <code>cargo tauri dev</code>
                </p>
            </div>
        );
    }

    return (
        <TauriProvider>
            <ModelProvider>
                <SessionProviderTauri>
                    <SettingsProvider>
                        <ProvidersProvider>
                            <DiarizationProvider>
                                <AudioProvider>
                                    <MainLayout addLog={addLog} />
                                </AudioProvider>
                            </DiarizationProvider>
                        </ProvidersProvider>
                    </SettingsProvider>
                </SessionProviderTauri>
            </ModelProvider>
        </TauriProvider>
    );
};

/**
 * Session provider wrapper that uses TauriContext instead of WebSocketContext.
 * This is needed because SessionProvider imports useWebSocketContext directly.
 */
const SessionProviderTauri: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // For now, we'll use the existing SessionProvider which will need to be modified
    // to use a unified backend context. This is a temporary solution.
    return <SessionProvider>{children}</SessionProvider>;
};

export default AppTauri;
