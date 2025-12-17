/**
 * Hook for managing macOS permissions
 */

import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Check if running in Tauri
const isTauri = () => '__TAURI__' in window;

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
}

/**
 * Hook for managing macOS permissions
 * Uses tauri-plugin-macos-permissions for permission checks
 */
export const usePermissions = (): UsePermissionsReturn => {
    const [status, setStatus] = useState<PermissionStatus>({
        microphone: false,
        screenRecording: false,
        loading: true,
        error: null,
    });

    const checkMicrophonePermission = useCallback(async (): Promise<boolean> => {
        if (!isTauri()) {
            return true;
        }

        try {
            // Use the plugin command (prefixed with plugin:)
            const granted = await invoke<boolean>('plugin:macos-permissions|check_microphone_permission');
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
            console.log('[Permissions] Requesting microphone permission...');
            // Request permission
            await invoke('plugin:macos-permissions|request_microphone_permission');
            
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
            const granted = await invoke<boolean>('plugin:macos-permissions|check_screen_recording_permission');
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
            console.log('[Permissions] Requesting screen recording permission...');
            await invoke('plugin:macos-permissions|request_screen_recording_permission');
            
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

    // Check permissions on mount
    useEffect(() => {
        checkAllPermissions();
    }, [checkAllPermissions]);

    return {
        status,
        checkMicrophonePermission,
        requestMicrophonePermission,
        checkScreenRecordingPermission,
        requestScreenRecordingPermission,
        checkAllPermissions,
    };
};

export default usePermissions;
