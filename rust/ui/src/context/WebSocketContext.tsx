import React from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { BackendContext, BackendContextType } from './BackendContext';

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const targetAddr = typeof process !== 'undefined'
        ? (process.env.AIWISPER_GRPC_ADDR && process.env.AIWISPER_GRPC_ADDR.trim().length > 0
            ? process.env.AIWISPER_GRPC_ADDR
            : undefined)
        : undefined;
    const ws = useWebSocket(targetAddr);

    const contextValue: BackendContextType = {
        ...ws,
        isTauri: false,
    };

    return (
        <BackendContext.Provider value={contextValue}>
            {children}
        </BackendContext.Provider>
    );
};

/**
 * Hook to get WebSocketContext specifically
 * Prefer useBackendContext for cross-environment compatibility
 */
export const useWebSocketContext = () => {
    const context = React.useContext(BackendContext);
    if (!context) {
        throw new Error('useWebSocketContext must be used within a WebSocketProvider');
    }
    return context;
};
