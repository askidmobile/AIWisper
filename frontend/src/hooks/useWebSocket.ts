import { useEffect, useRef, useState, useCallback } from 'react';
import { createGrpcSocket, RPC_READY_STATE, RpcSocketLike } from '../utils/grpcStream';

type MessageHandler = (data: any) => void;

interface WebSocketHook {
    isConnected: boolean;
    sendMessage: (msg: any) => void;
    subscribe: (type: string, handler: MessageHandler) => () => void;
}

export const useWebSocket = (url?: string): WebSocketHook => {
    const [isConnected, setIsConnected] = useState(false);
    const initialAddr = url && url.trim().length > 0 ? url : undefined;
    const [resolvedAddr, setResolvedAddr] = useState<string | undefined>(initialAddr);
    const wsRef = useRef<RpcSocketLike | null>(null);
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

    useEffect(() => {
        if (url && url.trim().length > 0) {
            setResolvedAddr(url);
            return;
        }
        try {
            // Пробуем получить адрес gRPC через IPC из main (Electron)
            const { ipcRenderer } = window.require?.('electron') || {};
            if (ipcRenderer?.invoke) {
                ipcRenderer.invoke('get-grpc-address')
                    .then((addr: string) => setResolvedAddr(addr))
                    .catch(() => setResolvedAddr(undefined));
                return;
            }
        } catch {
            // игнорируем, fallback ниже
        }
        setResolvedAddr(undefined);
    }, [url]);

    const connect = useCallback(() => {
        if (!resolvedAddr || resolvedAddr.trim().length === 0) {
            return;
        }
        const socket = createGrpcSocket(resolvedAddr);

        socket.onopen = () => {
            setIsConnected(true);
            console.log('Connected to backend (gRPC)');
            // Re-send initial requests if needed happens in components using this hook
        };

        socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type) {
                    notify(msg.type, msg);
                }
            } catch (e) {
                console.error('gRPC parse error:', e);
            }
        };

        socket.onclose = () => {
            setIsConnected(false);
            wsRef.current = null;
            reconnectTimeoutRef.current = setTimeout(connect, 3000);
        };

        socket.onerror = (error) => {
            console.error('gRPC stream error:', error);
            // Error handling usually leads to close
        };

        wsRef.current = socket;
    }, [resolvedAddr]);

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
    }, [connect, resolvedAddr]);

    const sendMessage = useCallback((msg: any) => {
        if (wsRef.current?.readyState === RPC_READY_STATE.OPEN) {
            wsRef.current.send(JSON.stringify(msg));
        } else {
            console.warn('gRPC not connected, message dropped:', msg);
        }
    }, []);

    return { isConnected, sendMessage, subscribe };
};
