/**
 * BackendContext - Unified backend communication layer
 * 
 * This context provides a unified interface for backend communication
 * that works in both Tauri and Electron/WebSocket environments.
 * 
 * The context is populated by either TauriProvider or WebSocketProvider
 * depending on the runtime environment.
 */

import React, { createContext, useContext } from 'react';

export interface BackendContextType {
    isConnected: boolean;
    isTauri?: boolean;
    sendMessage: (msg: any) => Promise<any>;
    subscribe: (type: string, handler: (data: any) => void) => () => void;
}

// Create context with null default
export const BackendContext = createContext<BackendContextType | null>(null);

/**
 * Hook to access backend context
 * Works in both Tauri and Electron environments
 */
export const useBackendContext = (): BackendContextType => {
    const context = useContext(BackendContext);
    if (!context) {
        throw new Error('useBackendContext must be used within a BackendProvider (TauriProvider or WebSocketProvider)');
    }
    return context;
};

/**
 * BackendProvider that auto-selects Tauri or WebSocket based on environment
 */
export const BackendProvider: React.FC<{ children: React.ReactNode }> = ({ children: _children }) => {
    // This is a placeholder - the actual provider is selected in AppTauri or AppWithProviders
    // based on the environment
    throw new Error('BackendProvider should not be used directly. Use TauriProvider or WebSocketProvider.');
};
