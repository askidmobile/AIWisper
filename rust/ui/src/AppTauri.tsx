/**
 * Tauri version of the application.
 * Uses TauriProvider instead of WebSocketProvider.
 * 
 * This is the entry point for the Tauri app.
 */

import React, { useCallback, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TauriProvider } from './context/TauriContext';
import { SessionProvider } from './context/SessionContext';
import { ModelProvider } from './context/ModelContext';
import { SettingsProvider } from './context/SettingsContext';
import { DiarizationProvider } from './context/DiarizationContext';
import { AudioProvider } from './context/AudioContext';
import { ProvidersProvider } from './context/ProvidersContext';
import { MainLayout } from './components/layout/MainLayout';
import { PermissionsScreen } from './components/PermissionsScreen';

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

    // Permission state
    const [permissionsChecked, setPermissionsChecked] = useState(false);
    const [hasMicrophonePermission, setHasMicrophonePermission] = useState(false);
    const [hasScreenRecordingPermission, setHasScreenRecordingPermission] = useState(false);
    const [permissionsSkipped, setPermissionsSkipped] = useState(false);

    // Check permissions on mount
    useEffect(() => {
        const checkPermissions = async () => {
            if (!isTauri()) {
                console.log('[AppTauri] Not in Tauri environment, skipping permission check');
                setHasMicrophonePermission(true);
                setHasScreenRecordingPermission(true);
                setPermissionsChecked(true);
                return;
            }

            console.log('[AppTauri] Checking permissions...');

            // Check if user has already confirmed permissions in this app
            const permissionsConfirmed = localStorage.getItem('aiwisper_permissions_confirmed');
            
            try {
                // Check microphone permission using Tauri invoke
                console.log('[AppTauri] Calling check_microphone_permission...');
                const micGranted = await invoke<boolean>('plugin:macos-permissions|check_microphone_permission');
                setHasMicrophonePermission(micGranted);
                console.log('[AppTauri] Microphone permission:', micGranted);

                // Check screen recording permission
                console.log('[AppTauri] Calling check_screen_recording_permission...');
                const screenGranted = await invoke<boolean>('plugin:macos-permissions|check_screen_recording_permission');
                setHasScreenRecordingPermission(screenGranted);
                console.log('[AppTauri] Screen recording permission:', screenGranted);

                // If permissions were previously confirmed by user AND microphone is granted, skip
                if (permissionsConfirmed === 'true' && micGranted) {
                    console.log('[AppTauri] Permissions previously confirmed, skipping screen');
                    setPermissionsSkipped(true);
                } else if (!micGranted) {
                    console.log('[AppTauri] Microphone NOT granted, showing permissions screen');
                } else {
                    // micGranted is true but not confirmed - could be inherited from Terminal
                    // Show permissions screen anyway to ensure proper TCC registration
                    console.log('[AppTauri] Microphone granted but not confirmed by user, showing permissions screen');
                }
            } catch (error) {
                console.error('[AppTauri] Failed to check permissions:', error);
                console.error('[AppTauri] Error details:', JSON.stringify(error, null, 2));
                // Show permissions screen on error so user can see what's happening
                setHasMicrophonePermission(false);
            } finally {
                setPermissionsChecked(true);
            }
        };

        checkPermissions();
    }, []);

    // Request microphone permission
    const handleRequestMicrophone = useCallback(async (): Promise<boolean> => {
        if (!isTauri()) return true;

        try {
            console.log('[AppTauri] Requesting microphone permission...');
            
            // Try forcing access via Rust backend (opens audio stream)
            // This is more reliable for triggering the OS dialog because it actually uses the device
            try {
                console.log('[AppTauri] Invoking force request_microphone_access...');
                await invoke('request_microphone_access');
            } catch (e) {
                console.error('[AppTauri] Force request failed:', e);
            }

            // Also try the plugin method as backup
            try {
                await invoke('plugin:macos-permissions|request_microphone_permission');
            } catch (e) {
                console.error('[AppTauri] Plugin request failed:', e);
            }
            
            // Wait for system dialog interaction
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Check if granted
            const granted = await invoke<boolean>('plugin:macos-permissions|check_microphone_permission');
            setHasMicrophonePermission(granted);
            console.log('[AppTauri] Microphone permission after request:', granted);
            return granted;
        } catch (error) {
            console.error('[AppTauri] Failed to request microphone permission:', error);
            return false;
        }
    }, []);

    // Request screen recording permission
    const handleRequestScreenRecording = useCallback(async (): Promise<boolean> => {
        if (!isTauri()) return true;

        try {
            console.log('[AppTauri] Requesting screen recording permission...');
            await invoke('plugin:macos-permissions|request_screen_recording_permission');
            
            // Wait for system dialog
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Check if granted
            const granted = await invoke<boolean>('plugin:macos-permissions|check_screen_recording_permission');
            setHasScreenRecordingPermission(granted);
            return granted;
        } catch (error) {
            console.error('[AppTauri] Failed to request screen recording permission:', error);
            return false;
        }
    }, []);

    // Open system preferences
    const handleOpenSystemPreferences = useCallback(async () => {
        if (!isTauri()) return;

        try {
            // Open Privacy & Security > Microphone
            await invoke('plugin:shell|open', { 
                path: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' 
            });
        } catch (error) {
            console.error('[AppTauri] Failed to open system preferences:', error);
            // Fallback: try with shell plugin
            try {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
            } catch {
                // Ignore
            }
        }
    }, []);

    // Continue to app
    const handleContinue = useCallback(() => {
        // Save that user has confirmed permissions
        localStorage.setItem('aiwisper_permissions_confirmed', 'true');
        setPermissionsSkipped(true);
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

    // Show loading while checking permissions
    if (!permissionsChecked) {
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
                <div style={{
                    width: '48px',
                    height: '48px',
                    border: '3px solid rgba(79, 70, 229, 0.3)',
                    borderTopColor: '#4f46e5',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                }} />
                <style>{`
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                `}</style>
                <p style={{ color: '#888' }}>Проверка разрешений...</p>
            </div>
        );
    }

    // Show permissions screen if microphone not granted and not skipped
    if (!hasMicrophonePermission && !permissionsSkipped) {
        return (
            <PermissionsScreen
                hasMicrophonePermission={hasMicrophonePermission}
                hasScreenRecordingPermission={hasScreenRecordingPermission}
                onRequestMicrophone={handleRequestMicrophone}
                onRequestScreenRecording={handleRequestScreenRecording}
                onContinue={handleContinue}
                onOpenSystemPreferences={handleOpenSystemPreferences}
            />
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
