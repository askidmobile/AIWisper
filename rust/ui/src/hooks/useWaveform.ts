import { useState, useCallback, useRef, useEffect } from 'react';
import { WaveformData } from '../utils/waveform';
import { useBackendContext } from '../context/BackendContext';

export type WaveformStatus = 'idle' | 'loading' | 'ready' | 'error';

interface UseWaveformReturn {
    waveformData: WaveformData | null;
    status: WaveformStatus;
    error: string | null;
    
    // Уровни для VU-метров (из waveformData)
    levelSlices: {
        mic: number[];
        sys: number[];
        sliceDuration: number;
        duration: number;
    } | null;
    
    // Действия
    loadWaveform: (sessionId: string) => Promise<void>;
    clearWaveform: () => void;
}

/**
 * Хук для загрузки и кеширования волновой формы сессии
 */
export const useWaveform = (): UseWaveformReturn => {
    const { sendMessage, isTauri } = useBackendContext();
    const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
    const [status, setStatus] = useState<WaveformStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    
    // Текущий sessionId для отмены устаревших запросов
    const currentSessionIdRef = useRef<string | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    // Вычисляем levelSlices из waveformData
    const levelSlices = waveformData ? {
        mic: waveformData.rmsAbsolute?.[0] || waveformData.peaks[0] || [],
        sys: waveformData.rmsAbsolute?.[1] || waveformData.rmsAbsolute?.[0] || waveformData.peaks[1] || waveformData.peaks[0] || [],
        sliceDuration: waveformData.sampleDuration,
        duration: waveformData.duration,
    } : null;

    const loadWaveform = useCallback(async (sessionId: string) => {
        // Если уже загружена для этой сессии - не перезагружаем
        if (currentSessionIdRef.current === sessionId && waveformData) {
            return;
        }

        // Отменяем предыдущий запрос
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;

        currentSessionIdRef.current = sessionId;
        setStatus('loading');
        setError(null);

        try {
            // В Tauri просим бэкенд вернуть готовую waveform
            if (!isTauri) {
                setStatus('error');
                setError('Требуется Tauri backend');
                return;
            }

            const res = await sendMessage({ type: 'get_waveform', sessionId });
            if (signal.aborted || currentSessionIdRef.current !== sessionId) return;

            // Handle both wrapped { waveform: ... } and direct waveform object
            const waveform = res?.waveform || res;
            
            if (waveform && (waveform.peaks || waveform.sampleDuration)) {
                // Ensure required fields have defaults
                const normalizedWaveform: WaveformData = {
                    peaks: waveform.peaks || [],
                    rms: waveform.rms || waveform.peaks || [],
                    rmsAbsolute: waveform.rmsAbsolute || waveform.peaks || [],
                    sampleDuration: waveform.sampleDuration || 0.05,
                    sampleCount: waveform.sampleCount || waveform.peaks?.[0]?.length || 0,
                    duration: waveform.duration || 0,
                    channelCount: waveform.channelCount || waveform.peaks?.length || 2,
                };
                setWaveformData(normalizedWaveform);
                setStatus('ready');
                return;
            }

            throw new Error(res?.error || 'waveform not available');
        } catch (err) {
            if (signal.aborted) return;
            
            console.error('[useWaveform] Failed to build waveform', err);
            setWaveformData(null);
            setStatus('error');
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [waveformData, isTauri, sendMessage]);

    const clearWaveform = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        currentSessionIdRef.current = null;
        setWaveformData(null);
        setStatus('idle');
        setError(null);
    }, []);

    // Очистка при размонтировании
    useEffect(() => {
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, []);

    return {
        waveformData,
        status,
        error,
        levelSlices,
        loadWaveform,
        clearWaveform,
    };
};
