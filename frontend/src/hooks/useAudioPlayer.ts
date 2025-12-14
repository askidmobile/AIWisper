import { useState, useRef, useCallback, useEffect } from 'react';

export const useAudioPlayer = () => {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
    const [playingUrl, setPlayingUrl] = useState<string | null>(null);
    const [isCurrentlyPlaying, setIsCurrentlyPlaying] = useState(false);

    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    // Initialize audio element
    useEffect(() => {
        const audio = new Audio();
        
        audio.onended = () => {
            console.log('[useAudioPlayer] Audio ended');
            setPlayingUrl(null);
            setIsCurrentlyPlaying(false);
        };
        
        audio.onerror = (e) => {
            console.error('[useAudioPlayer] Audio error:', e);
            setPlayingUrl(null);
            setIsCurrentlyPlaying(false);
        };
        
        audio.ontimeupdate = () => setCurrentTime(audio.currentTime);
        audio.onloadedmetadata = () => setDuration(audio.duration);
        
        // Отслеживаем реальное состояние воспроизведения
        audio.onplay = () => {
            console.log('[useAudioPlayer] onplay event');
            setIsCurrentlyPlaying(true);
        };
        audio.onpause = () => {
            console.log('[useAudioPlayer] onpause event');
            setIsCurrentlyPlaying(false);
        };

        audioRef.current = audio;
        setAudioElement(audio); // Сохраняем в состояние для реактивности
        return () => {
            audio.pause();
            audioRef.current = null;
            setAudioElement(null);
        };
    }, []);

    // Функция воспроизведения - только запускает воспроизведение
    const play = useCallback((url: string) => {
        if (!audioRef.current) return;

        console.log('[useAudioPlayer] play() called', { url, currentPlayingUrl: playingUrl });

        if (playingUrl === url) {
            // Тот же URL - продолжаем воспроизведение с текущей позиции
            console.log('[useAudioPlayer] Same URL, resuming playback');
            audioRef.current.play().catch(console.error);
        } else {
            // Новый URL - загружаем и играем
            console.log('[useAudioPlayer] New URL, loading and playing');
            audioRef.current.src = url;
            audioRef.current.play().catch(console.error);
            setPlayingUrl(url);
        }
    }, [playingUrl]);

    // Функция паузы - только ставит на паузу
    const pause = useCallback(() => {
        console.log('[useAudioPlayer] pause() called, audio paused:', audioRef.current?.paused);
        if (audioRef.current && !audioRef.current.paused) {
            audioRef.current.pause();
        }
    }, []);

    const stop = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            setPlayingUrl(null);
            setIsCurrentlyPlaying(false);
        }
    }, []);

    const seek = useCallback((time: number) => {
        if (audioRef.current) {
            audioRef.current.currentTime = time;
        }
    }, []);

    const isPlayingUrl = useCallback((url: string) => playingUrl === url && isCurrentlyPlaying, [playingUrl, isCurrentlyPlaying]);

    return { 
        play, 
        pause,
        stop, 
        seek, 
        isPlayingUrl, // Функция для проверки конкретного URL
        isPlaying: isCurrentlyPlaying, // Boolean состояние воспроизведения
        playingUrl, 
        currentTime, 
        duration,
        audioElement, // Доступ к audio элементу для VU-метров
    };
};
