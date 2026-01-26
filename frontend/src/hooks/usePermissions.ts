/**
 * Hook for managing macOS permissions in Tauri environment
 * 
 * Uses tauri-plugin-macos-permissions for permission checks.
 * In non-Tauri environments (Electron, browser), returns granted permissions by default.
 * 
 * This hook uses the global __TAURI__ object instead of dynamic imports
 * to avoid build issues when Tauri dependencies are not installed.
 */

import { useState, useCallback, useEffect } from 'react';

// Check if running in Tauri environment
const isTauri = () => '__TAURI__' in window;

// Get Tauri invoke function from global object
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTauriCore = (): { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any> } | null => {
    if (!isTauri()) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauriGlobal = (window as any).__TAURI__;
    if (!tauriGlobal?.core?.invoke) {
        console.warn('[Permissions] Tauri core.invoke not available');
        return null;
    }
    return tauriGlobal.core;
};

export interface PermissionStatus {
    microphone: boolean;
    screenRecording: boolean;
    loading: boolean;
    error: string | null;
}

export interface UsePermissionsReturn {
    status: PermissionStatus;
    checkMicrophonePermission: () => Promise<boolean>;
    requestMicrophonePermission: () => Promise<boolean>;
    checkScreenRecordingPermission: () => Promise<boolean>;
    requestScreenRecordingPermission: () => Promise<boolean>;
    checkAllPermissions: () => Promise<void>;
    openScreenRecordingSettings: () => Promise<void>;
}

/**
 * Hook for managing macOS permissions
 * Uses tauri-plugin-macos-permissions for permission checks
 */
export const usePermissions = (): UsePermissionsReturn => {
    const [status, setStatus] = useState<PermissionStatus>({
        microphone: !isTauri(), // In non-Tauri, assume granted
        screenRecording: !isTauri(), // In non-Tauri, assume granted
        loading: isTauri(), // Only loading in Tauri
        error: null,
    });

    const checkMicrophonePermission = useCallback(async (): Promise<boolean> => {
        if (!isTauri()) {
            return true;
        }

        try {
            const core = getTauriCore();
            if (!core) return true;
            
            const granted = await core.invoke('plugin:macos-permissions|check_microphone_permission') as boolean;
            console.log('[Permissions] Microphone permission:', granted);
            setStatus(prev => ({ ...prev, microphone: granted }));
            return granted;
        } catch (error) {
            console.error('[Permissions] Failed to check microphone permission:', error);
            setStatus(prev => ({ ...prev, error: String(error) }));
            return false;
        }
    }, []);

    const requestMicrophonePermission = useCallback(async (): Promise<boolean> => {
        if (!isTauri()) {
            return true;
        }

        try {
            const core = getTauriCore();
            if (!core) return true;
            
            console.log('[Permissions] Requesting microphone permission...');
            
            // Request permission
            await core.invoke('plugin:macos-permissions|request_microphone_permission');
            
            // Wait a bit for the system dialog and then check status
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Check if granted after request
            const granted = await checkMicrophonePermission();
            return granted;
        } catch (error) {
            console.error('[Permissions] Failed to request microphone permission:', error);
            setStatus(prev => ({ ...prev, error: String(error) }));
            return false;
        }
    }, [checkMicrophonePermission]);

    const checkScreenRecordingPermission = useCallback(async (): Promise<boolean> => {
        if (!isTauri()) {
            return true;
        }

        try {
            const core = getTauriCore();
            if (!core) return true;
            
            const granted = await core.invoke('plugin:macos-permissions|check_screen_recording_permission') as boolean;
            console.log('[Permissions] Screen recording permission:', granted);
            setStatus(prev => ({ ...prev, screenRecording: granted }));
            return granted;
        } catch (error) {
            console.error('[Permissions] Failed to check screen recording permission:', error);
            setStatus(prev => ({ ...prev, error: String(error) }));
            return false;
        }
    }, []);

    const requestScreenRecordingPermission = useCallback(async (): Promise<boolean> => {
        if (!isTauri()) {
            return true;
        }

        try {
            const core = getTauriCore();
            if (!core) return true;
            
            console.log('[Permissions] Requesting screen recording permission...');
            await core.invoke('plugin:macos-permissions|request_screen_recording_permission');
            
            // Wait a bit for the system dialog
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Check if granted after request
            const granted = await checkScreenRecordingPermission();
            return granted;
        } catch (error) {
            console.error('[Permissions] Failed to request screen recording permission:', error);
            setStatus(prev => ({ ...prev, error: String(error) }));
            return false;
        }
    }, [checkScreenRecordingPermission]);

    const openScreenRecordingSettings = useCallback(async (): Promise<void> => {
        if (!isTauri()) {
            return;
        }

        try {
            const core = getTauriCore();
            if (!core) return;
            
            // Open System Preferences > Privacy & Security > Screen Recording
            await core.invoke('plugin:shell|open', {
                path: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
            });
        } catch (error) {
            console.error('[Permissions] Failed to open system preferences:', error);
            // Fallback: try general Security preferences
            try {
                const core = getTauriCore();
                if (core) {
                    await core.invoke('plugin:shell|open', {
                        path: 'x-apple.systempreferences:com.apple.preference.security'
                    });
                }
            } catch {
                // Ignore
            }
        }
    }, []);

    const checkAllPermissions = useCallback(async () => {
        if (!isTauri()) {
            setStatus({
                microphone: true,
                screenRecording: true,
                loading: false,
                error: null,
            });
            return;
        }

        setStatus(prev => ({ ...prev, loading: true, error: null }));
        
        try {
            const [mic, screen] = await Promise.all([
                checkMicrophonePermission(),
                checkScreenRecordingPermission(),
            ]);
            
            setStatus({
                microphone: mic,
                screenRecording: screen,
                loading: false,
                error: null,
            });
        } catch (error) {
            setStatus(prev => ({
                ...prev,
                loading: false,
                error: String(error),
            }));
        }
    }, [checkMicrophonePermission, checkScreenRecordingPermission]);

    // Check permissions on mount (only in Tauri)
    useEffect(() => {
        if (isTauri()) {
            checkAllPermissions();
        }
    }, [checkAllPermissions]);

    return {
        status,
        checkMicrophonePermission,
        requestMicrophonePermission,
        checkScreenRecordingPermission,
        requestScreenRecordingPermission,
        checkAllPermissions,
        openScreenRecordingSettings,
    };
};

export default usePermissions;
