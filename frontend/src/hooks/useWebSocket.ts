import { useEffect, useRef, useState, useCallback } from 'react';

type MessageHandler = (data: any) => void;

interface WebSocketHook {
    isConnected: boolean;
    sendMessage: (msg: any) => void;
    subscribe: (type: string, handler: MessageHandler) => () => void;
}

export const useWebSocket = (url: string): WebSocketHook => {
    const [isConnected, setIsConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const handlersRef = useRef<Map<string, Set<MessageHandler>>>(new Map());
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const subscribe = useCallback((type: string, handler: MessageHandler) => {
        if (!handlersRef.current.has(type)) {
            handlersRef.current.set(type, new Set());
        }
        handlersRef.current.get(type)?.add(handler);

        return () => {
            handlersRef.current.get(type)?.delete(handler);
        };
    }, []);

    const notify = (type: string, data: any) => {
        const handlers = handlersRef.current.get(type);
        if (handlers) {
            handlers.forEach(handler => handler(data));
        }
    };

    const connect = useCallback(() => {
        const socket = new WebSocket(url);

        socket.onopen = () => {
            setIsConnected(true);
            console.log('Connected to WebSocket');
            // Re-send initial requests if needed happens in components using this hook
        };

        socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type) {
                    notify(msg.type, msg);
                }
            } catch (e) {
                console.error('WebSocket parse error:', e);
            }
        };

        socket.onclose = () => {
            setIsConnected(false);
            wsRef.current = null;
            reconnectTimeoutRef.current = setTimeout(connect, 3000);
        };

        socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            // Error handling usually leads to close
        };

        wsRef.current = socket;
    }, [url]);

    useEffect(() => {
        connect();
        return () => {
            if (wsRef.current) {
                wsRef.current.close();
            }
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
        };
    }, [connect]);

    const sendMessage = useCallback((msg: any) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(msg));
        } else {
            console.warn('WebSocket not connected, message dropped:', msg);
        }
    }, []);

    return { isConnected, sendMessage, subscribe };
};
