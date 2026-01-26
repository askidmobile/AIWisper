import { useState, useEffect, useCallback } from 'react';
import { useBackendContext } from '../context/BackendContext';

export interface StreamingTranscriptionState {
    enabled: boolean;
    confirmedText: string;
    volatileText: string;
    confidence: number;
    lastUpdate: number;
}

export interface UseStreamingTranscriptionReturn extends StreamingTranscriptionState {
    enable: () => void;
    disable: () => void;
    reset: () => void;
    toggle: () => void;
}

/**
 * Hook для управления streaming транскрипцией
 * 
 * @param autoEnable - Автоматически включать при монтировании
 * @returns Состояние и методы управления streaming
 */
export const useStreamingTranscription = (
    autoEnable: boolean = false
): UseStreamingTranscriptionReturn => {
    const { sendMessage, subscribe } = useBackendContext();
    
    const [enabled, setEnabled] = useState(autoEnable);
    const [confirmedText, setConfirmedText] = useState('');
    const [volatileText, setVolatileText] = useState('');
    const [confidence, setConfidence] = useState(0);
    const [lastUpdate, setLastUpdate] = useState(0);

    // Enable streaming
    const enable = useCallback(() => {
        sendMessage({
            type: 'enable_streaming',
            data: 'true'
        });
        setEnabled(true);
    }, [sendMessage]);

    // Disable streaming
    const disable = useCallback(() => {
        sendMessage({
            type: 'disable_streaming',
            data: 'false'
        });
        setEnabled(false);
        // Сброс состояния
        setConfirmedText('');
        setVolatileText('');
        setConfidence(0);
    }, [sendMessage]);

    // Reset state
    const reset = useCallback(() => {
        setConfirmedText('');
        setVolatileText('');
        setConfidence(0);
        setLastUpdate(0);
    }, []);

    // Toggle
    const toggle = useCallback(() => {
        if (enabled) {
            disable();
        } else {
            enable();
        }
    }, [enabled, enable, disable]);

    // Auto-enable on mount
    useEffect(() => {
        if (autoEnable) {
            enable();
        }
        
        return () => {
            if (autoEnable) {
                disable();
            }
        };
    }, [autoEnable]); // Только при изменении autoEnable

    // Subscribe to streaming updates
    useEffect(() => {
        if (!enabled) return;

        const unsubscribe = subscribe('streaming_update', (msg: any) => {
            const text = msg.streamingText || '';
            const isConfirmed = msg.streamingIsConfirmed || false;
            const conf = msg.streamingConfidence || 0;
            const timestamp = msg.streamingTimestamp || Date.now();

            setLastUpdate(timestamp);
            setConfidence(conf);

            if (isConfirmed) {
                // Confirmed: добавляем к confirmed text, очищаем volatile
                setConfirmedText(prev => {
                    const newText = prev ? `${prev} ${text}` : text;
                    return newText.trim();
                });
                setVolatileText('');
            } else {
                // Volatile: обновляем volatile text
                setVolatileText(text);
            }
        });

        return () => unsubscribe();
    }, [enabled, subscribe]);

    return {
        enabled,
        confirmedText,
        volatileText,
        confidence,
        lastUpdate,
        enable,
        disable,
        reset,
        toggle
    };
};

export default useStreamingTranscription;
