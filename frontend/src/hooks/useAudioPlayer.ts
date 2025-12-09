import { useState, useRef, useCallback, useEffect } from 'react';

export const useAudioPlayer = () => {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [playingUrl, setPlayingUrl] = useState<string | null>(null);

    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    // Initialize audio element
    useEffect(() => {
        const audio = new Audio();
        audio.onended = () => setPlayingUrl(null);
        audio.onerror = (e) => {
            console.error('Audio playback error:', e);
            setPlayingUrl(null);
        };
        audio.ontimeupdate = () => setCurrentTime(audio.currentTime);
        audio.onloadedmetadata = () => setDuration(audio.duration);

        audioRef.current = audio;
        return () => {
            audio.pause();
            audioRef.current = null;
        };
    }, []);

    const play = useCallback((url: string) => {
        if (!audioRef.current) return;

        if (playingUrl === url) {
            // Stop if already playing same url
            audioRef.current.pause();
            setPlayingUrl(null);
        } else {
            audioRef.current.src = url;
            audioRef.current.play().catch(console.error);
            setPlayingUrl(url);
        }
    }, [playingUrl]);

    const stop = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
            setPlayingUrl(null);
        }
    }, []);

    const seek = useCallback((time: number) => {
        if (audioRef.current) {
            audioRef.current.currentTime = time;
        }
    }, []);

    const isPlaying = useCallback((url: string) => playingUrl === url, [playingUrl]);

    return { play, stop, seek, isPlaying, playingUrl, currentTime, duration };
};
