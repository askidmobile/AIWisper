import React, { createContext, useContext } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

interface WebSocketContextType {
    isConnected: boolean;
    sendMessage: (msg: any) => void;
    subscribe: (type: string, handler: (data: any) => void) => () => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const targetAddr = typeof process !== 'undefined'
        ? (process.env.AIWISPER_GRPC_ADDR && process.env.AIWISPER_GRPC_ADDR.trim().length > 0
            ? process.env.AIWISPER_GRPC_ADDR
            : undefined)
        : undefined;
    const ws = useWebSocket(targetAddr);

    return (
        <WebSocketContext.Provider value={ws}>
            {children}
        </WebSocketContext.Provider>
    );
};

export const useWebSocketContext = () => {
    const context = useContext(WebSocketContext);
    if (!context) {
        throw new Error('useWebSocketContext must be used within a WebSocketProvider');
    }
    return context;
};
