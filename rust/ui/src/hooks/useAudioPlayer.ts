import { useState, useRef, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';

export type PlaybackType = 'full' | 'chunk';

export const useAudioPlayer = () => {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [playingUrl, setPlayingUrl] = useState<string | null>(null);
    const [isCurrentlyPlaying, setIsCurrentlyPlaying] = useState(false);

    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    
    // Track playback type and offset for waveform sync
    const [playbackType, setPlaybackType] = useState<PlaybackType>('full');
    const [playbackOffset, setPlaybackOffset] = useState(0); // offset in seconds from session start
    
    // VU meter levels (0-100)
    const [micLevel, setMicLevel] = useState(0);
    const [sysLevel, setSysLevel] = useState(0);

    // Web Audio API refs
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserLeftRef = useRef<AnalyserNode | null>(null);
    const analyserRightRef = useRef<AnalyserNode | null>(null);
    const audioSourceConnectedRef = useRef(false);
    const leftTimeDataRef = useRef<Float32Array | null>(null);
    const rightTimeDataRef = useRef<Float32Array | null>(null);
    const playbackRafRef = useRef<number | null>(null);
    const lastPlaybackTimeRef = useRef(0);

    // Initialize audio element
    useEffect(() => {
        const audio = new Audio();
        audio.crossOrigin = 'anonymous'; // Required for Web Audio API
        
        audio.onended = () => {
            setPlayingUrl(null);
            setIsCurrentlyPlaying(false);
            resetLevels();
        };
        
        audio.onerror = (e) => {
            console.error('[useAudioPlayer] Audio error:', e);
            setPlayingUrl(null);
            setIsCurrentlyPlaying(false);
            resetLevels();
        };
        
        audio.ontimeupdate = () => setCurrentTime(audio.currentTime);
        audio.onloadedmetadata = () => setDuration(audio.duration);
        
        audio.onplay = () => setIsCurrentlyPlaying(true);
        audio.onpause = () => setIsCurrentlyPlaying(false);

        audioRef.current = audio;
        
        return () => {
            audio.pause();
            if (playbackRafRef.current !== null) {
                cancelAnimationFrame(playbackRafRef.current);
            }
            if (audioContextRef.current) {
                audioContextRef.current.close();
            }
            audioRef.current = null;
        };
    }, []);

    const resetLevels = useCallback(() => {
        setMicLevel(0);
        setSysLevel(0);
        if (playbackRafRef.current !== null) {
            cancelAnimationFrame(playbackRafRef.current);
            playbackRafRef.current = null;
        }
    }, []);

    // Calculate RMS from audio samples
    const calculateRMS = (data: Float32Array): number => {
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            const sample = data[i];
            sum += sample * sample;
        }
        return Math.sqrt(sum / data.length);
    };

    // Convert RMS to VU meter level using dB scale
    const rmsToVuLevel = (rms: number): number => {
        if (rms <= 0) return 0;
        const db = 20 * Math.log10(rms);
        const minDb = -50;
        const maxDb = 0;
        const percent = ((db - minDb) / (maxDb - minDb)) * 100;
        return Math.max(0, Math.min(100, percent));
    };

    // Setup Web Audio API graph
    const setupAudioGraph = useCallback(() => {
        const audioEl = audioRef.current;
        if (!audioEl || audioSourceConnectedRef.current) return;

        if (!audioContextRef.current) {
            audioContextRef.current = new AudioContext();
        }

        if (audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume();
        }

        const source = audioContextRef.current.createMediaElementSource(audioEl);
        const splitter = audioContextRef.current.createChannelSplitter(2);

        analyserLeftRef.current = audioContextRef.current.createAnalyser();
        analyserRightRef.current = audioContextRef.current.createAnalyser();
        
        // Optimized for instant VU meter response
        analyserLeftRef.current.fftSize = 128;
        analyserRightRef.current.fftSize = 128;
        analyserLeftRef.current.smoothingTimeConstant = 0;
        analyserRightRef.current.smoothingTimeConstant = 0;

        leftTimeDataRef.current = new Float32Array(analyserLeftRef.current.fftSize);
        rightTimeDataRef.current = new Float32Array(analyserRightRef.current.fftSize);

        const merger = audioContextRef.current.createChannelMerger(2);

        source.connect(splitter);
        splitter.connect(analyserLeftRef.current, 0);
        splitter.connect(analyserRightRef.current, 1);

        analyserLeftRef.current.connect(merger, 0, 0);
        analyserRightRef.current.connect(merger, 0, 1);
        merger.connect(audioContextRef.current.destination);

        audioSourceConnectedRef.current = true;
    }, []);

    // Audio analysis loop
    const analyzeAudio = useCallback(() => {
        const leftAnalyser = analyserLeftRef.current;
        const rightAnalyser = analyserRightRef.current;
        const el = audioRef.current;

        if (!el || el.paused || el.ended) {
            resetLevels();
            return;
        }

        // Update playback time
        const currentPlaybackTime = el.currentTime;
        if (Math.abs(currentPlaybackTime - lastPlaybackTimeRef.current) > 0.02) {
            lastPlaybackTimeRef.current = currentPlaybackTime;
            setCurrentTime(currentPlaybackTime);
        }

        // Analyze audio levels
        if (leftAnalyser && rightAnalyser && leftTimeDataRef.current && rightTimeDataRef.current) {
            leftAnalyser.getFloatTimeDomainData(leftTimeDataRef.current as Float32Array<ArrayBuffer>);
            rightAnalyser.getFloatTimeDomainData(rightTimeDataRef.current as Float32Array<ArrayBuffer>);

            const micRms = calculateRMS(leftTimeDataRef.current);
            const sysRms = calculateRMS(rightTimeDataRef.current);

            const newMicLevel = rmsToVuLevel(micRms);
            const newSysLevel = rmsToVuLevel(sysRms);

            // Use flushSync for immediate React re-render
            flushSync(() => {
                setMicLevel(newMicLevel);
                setSysLevel(newSysLevel);
            });
        }

        playbackRafRef.current = requestAnimationFrame(analyzeAudio);
    }, [resetLevels]);

    // Internal play function
    const playInternal = useCallback((url: string, type: PlaybackType, offsetMs: number) => {
        const audioEl = audioRef.current;
        if (!audioEl) return;

        // Stop previous analysis loop
        if (playbackRafRef.current !== null) {
            cancelAnimationFrame(playbackRafRef.current);
            playbackRafRef.current = null;
        }

        // Toggle off if same URL
        if (playingUrl === url) {
            audioEl.pause();
            audioEl.currentTime = 0;
            setPlayingUrl(null);
            setCurrentTime(0);
            setPlaybackType('full');
            setPlaybackOffset(0);
            lastPlaybackTimeRef.current = 0;
            resetLevels();
            return;
        }

        audioEl.src = url;
        setCurrentTime(0);
        setPlaybackType(type);
        setPlaybackOffset(offsetMs / 1000); // Convert ms to seconds
        lastPlaybackTimeRef.current = 0;

        // Setup Web Audio API graph (only once)
        setupAudioGraph();

        audioEl.play()
            .then(() => {
                setPlayingUrl(url);
                playbackRafRef.current = requestAnimationFrame(analyzeAudio);
            })
            .catch((err) => {
                console.error('Failed to play audio:', err);
                resetLevels();
                setPlayingUrl(null);
                setPlaybackType('full');
                setPlaybackOffset(0);
            });
    }, [playingUrl, setupAudioGraph, analyzeAudio, resetLevels]);
    
    // Play function for full session (backward compatible)
    const play = useCallback((url: string) => {
        playInternal(url, 'full', 0);
    }, [playInternal]);
    
    // Play function for chunk with offset
    const playChunk = useCallback((url: string, startMs: number) => {
        playInternal(url, 'chunk', startMs);
    }, [playInternal]);

    // Pause function
    const pause = useCallback(() => {
        if (audioRef.current && !audioRef.current.paused) {
            audioRef.current.pause();
        }
    }, []);

    // Stop function
    const stop = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            setPlayingUrl(null);
            setIsCurrentlyPlaying(false);
            setPlaybackType('full');
            setPlaybackOffset(0);
            resetLevels();
        }
    }, [resetLevels]);

    // Seek function
    const seek = useCallback((time: number) => {
        if (audioRef.current) {
            audioRef.current.currentTime = time;
        }
    }, []);

    const isPlayingUrl = useCallback((url: string) => playingUrl === url && isCurrentlyPlaying, [playingUrl, isCurrentlyPlaying]);

    return { 
        play, 
        playChunk,
        pause,
        stop, 
        seek, 
        isPlayingUrl,
        isPlaying: isCurrentlyPlaying,
        playingUrl, 
        currentTime, 
        duration,
        // Playback type and offset for waveform sync
        playbackType,
        playbackOffset,
        isPlayingFullSession: playbackType === 'full',
        // VU meter levels from Web Audio API
        micLevel,
        sysLevel,
    };
};
