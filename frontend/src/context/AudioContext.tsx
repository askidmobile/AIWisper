import React, { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react';

interface AudioContextType {
    // VU-метры записи (от WebSocket)
    micLevel: number;
    sysLevel: number;
    setMicLevel: (level: number) => void;
    setSysLevel: (level: number) => void;
    
    // VU-метры воспроизведения (от Web Audio API)
    playbackMicLevel: number;
    playbackSysLevel: number;
    
    // Звуковые сигналы
    playBeep: (frequency?: number, duration?: number, volume?: number) => void;
    
    // Анализаторы для воспроизведения
    connectAnalysers: (audioElement: HTMLAudioElement) => void;
    disconnectAnalysers: () => void;
    
    // Состояние
    isAnalyserConnected: boolean;
}

const AudioContext = createContext<AudioContextType | null>(null);

/**
 * Провайдер аудио контекста для VU-метров и звуковых сигналов
 */
export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // VU-метры записи
    const [micLevel, setMicLevel] = useState(0);
    const [sysLevel, setSysLevel] = useState(0);
    
    // VU-метры воспроизведения
    const [playbackMicLevel, setPlaybackMicLevel] = useState(0);
    const [playbackSysLevel, setPlaybackSysLevel] = useState(0);
    
    // Web Audio API refs
    const audioContextRef = useRef<globalThis.AudioContext | null>(null);
    const analyserLeftRef = useRef<AnalyserNode | null>(null);
    const analyserRightRef = useRef<AnalyserNode | null>(null);
    const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
    const splitterRef = useRef<ChannelSplitterNode | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const [isAnalyserConnected, setIsAnalyserConnected] = useState(false);

    /**
     * Звуковой сигнал "пип"
     */
    const playBeep = useCallback((
        frequency: number = 800, 
        duration: number = 150, 
        volume: number = 0.3
    ) => {
        try {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);

            oscillator.frequency.value = frequency;
            oscillator.type = 'sine';

            gainNode.gain.setValueAtTime(volume, ctx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration / 1000);

            oscillator.start(ctx.currentTime);
            oscillator.stop(ctx.currentTime + duration / 1000);
            
            // Закрываем контекст после завершения
            setTimeout(() => ctx.close(), duration + 100);
        } catch (err) {
            console.error('[AudioContext] Failed to play beep:', err);
        }
    }, []);

    /**
     * Подключение анализаторов к аудио элементу
     */
    const connectAnalysers = useCallback((audioElement: HTMLAudioElement) => {
        try {
            // Создаём или переиспользуем AudioContext
            if (!audioContextRef.current) {
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            }
            const ctx = audioContextRef.current;

            // Отключаем предыдущий источник
            if (sourceRef.current) {
                try {
                    sourceRef.current.disconnect();
                } catch (e) {
                    // Игнорируем ошибки отключения
                }
            }

            // Создаём новый источник
            sourceRef.current = ctx.createMediaElementSource(audioElement);
            
            // Создаём сплиттер для стерео
            splitterRef.current = ctx.createChannelSplitter(2);
            
            // Создаём анализаторы
            analyserLeftRef.current = ctx.createAnalyser();
            analyserRightRef.current = ctx.createAnalyser();
            
            analyserLeftRef.current.fftSize = 256;
            analyserRightRef.current.fftSize = 256;

            // Подключаем цепочку
            sourceRef.current.connect(splitterRef.current);
            splitterRef.current.connect(analyserLeftRef.current, 0);
            splitterRef.current.connect(analyserRightRef.current, 1);
            
            // Подключаем к выходу (чтобы звук был слышен)
            sourceRef.current.connect(ctx.destination);

            setIsAnalyserConnected(true);
            
            // Запускаем анимацию уровней
            startLevelAnimation();
            
            console.log('[AudioContext] Analysers connected');
        } catch (err) {
            console.error('[AudioContext] Failed to connect analysers:', err);
        }
    }, []);

    /**
     * Отключение анализаторов
     */
    const disconnectAnalysers = useCallback(() => {
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
        
        if (sourceRef.current) {
            try {
                sourceRef.current.disconnect();
            } catch (e) {
                // Игнорируем
            }
            sourceRef.current = null;
        }
        
        setPlaybackMicLevel(0);
        setPlaybackSysLevel(0);
        setIsAnalyserConnected(false);
        
        console.log('[AudioContext] Analysers disconnected');
    }, []);

    /**
     * Анимация уровней VU-метров
     */
    const startLevelAnimation = useCallback(() => {
        const animate = () => {
            if (!analyserLeftRef.current || !analyserRightRef.current) {
                return;
            }

            const leftData = new Uint8Array(analyserLeftRef.current.frequencyBinCount);
            const rightData = new Uint8Array(analyserRightRef.current.frequencyBinCount);
            
            analyserLeftRef.current.getByteFrequencyData(leftData);
            analyserRightRef.current.getByteFrequencyData(rightData);

            // Вычисляем RMS уровень
            const leftLevel = calculateRMS(leftData);
            const rightLevel = calculateRMS(rightData);

            setPlaybackMicLevel(leftLevel);
            setPlaybackSysLevel(rightLevel);

            animationFrameRef.current = requestAnimationFrame(animate);
        };
        
        animate();
    }, []);

    // Очистка при размонтировании
    useEffect(() => {
        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            if (audioContextRef.current) {
                audioContextRef.current.close();
            }
        };
    }, []);

    return (
        <AudioContext.Provider value={{
            micLevel,
            sysLevel,
            setMicLevel,
            setSysLevel,
            playbackMicLevel,
            playbackSysLevel,
            playBeep,
            connectAnalysers,
            disconnectAnalysers,
            isAnalyserConnected,
        }}>
            {children}
        </AudioContext.Provider>
    );
};

/**
 * Хук для использования аудио контекста
 */
export const useAudioContext = () => {
    const context = useContext(AudioContext);
    if (!context) {
        throw new Error('useAudioContext must be used within an AudioProvider');
    }
    return context;
};

/**
 * Вычисление RMS уровня из массива частот
 */
const calculateRMS = (data: Uint8Array): number => {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        const normalized = data[i] / 255;
        sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / data.length);
    // Нормализуем к 0-100
    return Math.min(100, rms * 200);
};

export default AudioProvider;
