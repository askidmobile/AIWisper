import React, { createContext, useContext } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

interface WebSocketContextType {
    isConnected: boolean;
    sendMessage: (msg: any) => void;
    subscribe: (type: string, handler: (data: any) => void) => () => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Hardcoded URL for now, could be config
    const ws = useWebSocket('ws://localhost:8080/ws');

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
