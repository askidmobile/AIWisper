import { useState, useEffect, useRef, useCallback } from 'react';

interface UseRecordingReturn {
    isRecording: boolean;
    isStopping: boolean;
    recordingDuration: number;
    recordingWave: number[];
    
    // Действия (для внешнего управления)
    setIsRecording: (v: boolean) => void;
    setIsStopping: (v: boolean) => void;
    resetRecording: () => void;
}

/**
 * Хук для управления состоянием записи
 * Включает таймер длительности и анимацию волновой формы
 */
export const useRecording = (): UseRecordingReturn => {
    const [isRecording, setIsRecording] = useState(false);
    const [isStopping, setIsStopping] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const [recordingWave, setRecordingWave] = useState<number[]>(Array(24).fill(0.3));
    
    const recordingStartRef = useRef<number | null>(null);
    const waveAnimationRef = useRef<number | null>(null);

    // Таймер записи
    useEffect(() => {
        let interval: NodeJS.Timeout | null = null;

        if (isRecording) {
            recordingStartRef.current = Date.now();
            interval = setInterval(() => {
                if (recordingStartRef.current) {
                    setRecordingDuration(Math.floor((Date.now() - recordingStartRef.current) / 1000));
                }
            }, 1000);
        } else {
            setRecordingDuration(0);
            recordingStartRef.current = null;
        }

        return () => {
            if (interval) clearInterval(interval);
        };
    }, [isRecording]);

    // Анимация волновой формы во время записи
    useEffect(() => {
        if (!isRecording) {
            setRecordingWave(Array(24).fill(0.3));
            return;
        }

        const animate = () => {
            setRecordingWave(prev => prev.map((_, i) => {
                const base = 0.3 + Math.sin(Date.now() / 180 + i * 0.6) * 0.2;
                const random = Math.random() * 0.35;
                return Math.min(1, Math.max(0.15, base + random));
            }));
            waveAnimationRef.current = requestAnimationFrame(animate);
        };
        animate();

        return () => {
            if (waveAnimationRef.current) {
                cancelAnimationFrame(waveAnimationRef.current);
            }
        };
    }, [isRecording]);

    const resetRecording = useCallback(() => {
        setIsRecording(false);
        setIsStopping(false);
        setRecordingDuration(0);
        setRecordingWave(Array(24).fill(0.3));
        recordingStartRef.current = null;
    }, []);

    return {
        isRecording,
        isStopping,
        recordingDuration,
        recordingWave,
        setIsRecording,
        setIsStopping,
        resetRecording,
    };
};

/**
 * Звуковой сигнал "пип" при начале записи (Web Audio API)
 */
export const playBeep = (frequency: number = 800, duration: number = 150, volume: number = 0.3) => {
    try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';

        gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration / 1000);

        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + duration / 1000);
    } catch (err) {
        console.error('Failed to play beep:', err);
    }
};

/**
 * Форматирование времени MM:SS
 */
export const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};
