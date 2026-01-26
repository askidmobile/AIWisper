import { useState, useCallback, useRef, useEffect } from 'react';
import { WaveformData, computeWaveform } from '../utils/waveform';

const API_BASE = `http://localhost:${process.env.AIWISPER_HTTP_PORT || 18080}`;

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
            // 1. Пробуем загрузить из кеша
            const cacheResp = await fetch(`${API_BASE}/api/waveform/${sessionId}`, { signal });
            if (cacheResp.ok && cacheResp.status !== 204) {
                const cachedWaveform = await cacheResp.json();
                if (cachedWaveform && currentSessionIdRef.current === sessionId) {
                    console.log('[useWaveform] Loaded from cache');
                    setWaveformData(cachedWaveform);
                    setStatus('ready');
                    return;
                }
            }

            // 2. Кеша нет - вычисляем из аудио
            console.log('[useWaveform] Computing from audio...');
            const url = `${API_BASE}/api/sessions/${sessionId}/full.mp3`;
            const resp = await fetch(url, { signal });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            
            const arr = await resp.arrayBuffer();
            if (signal.aborted || currentSessionIdRef.current !== sessionId) return;

            const ctx = new AudioContext();
            const decoded = await ctx.decodeAudioData(arr);
            if (signal.aborted || currentSessionIdRef.current !== sessionId) {
                ctx.close();
                return;
            }

            const waveform = computeWaveform(decoded);
            ctx.close();

            if (currentSessionIdRef.current === sessionId) {
                setWaveformData(waveform);
                setStatus('ready');

                // 3. Сохраняем в кеш (асинхронно, не блокируем UI)
                fetch(`${API_BASE}/api/waveform/${sessionId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(waveform),
                }).then(() => {
                    console.log('[useWaveform] Saved to cache');
                }).catch(err => {
                    console.warn('[useWaveform] Failed to save cache:', err);
                });
            }
        } catch (err) {
            if (signal.aborted) return;
            
            console.error('[useWaveform] Failed to build waveform', err);
            setWaveformData(null);
            setStatus('error');
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [waveformData]);

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
