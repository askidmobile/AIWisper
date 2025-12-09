import React, { useEffect, useRef, useState } from 'react';
import { WaveformData } from '../utils/waveform';

interface WaveformDisplayProps {
    currentTime: number;
    totalDuration: number;
    isPlaying: boolean;
    playbackOffset?: number;
    onSeek: (absoluteTime: number) => void;
    waveformData?: WaveformData | null;
    loading?: boolean;
    error?: string | null;
    channelLabels?: string[];
}

const formatTime = (t: number) => {
    if (!isFinite(t) || Number.isNaN(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
};

const WaveformDisplay: React.FC<WaveformDisplayProps> = ({
    currentTime,
    totalDuration,
    isPlaying,
    playbackOffset = 0,
    onSeek,
    waveformData,
    loading,
    error,
    channelLabels = ['Mic', 'Sys'],
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [hoverTime, setHoverTime] = useState<number | null>(null);
    const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

    const absoluteTime = Math.max(0, playbackOffset + currentTime);
    const progressPercentRaw = totalDuration > 0 ? (absoluteTime / totalDuration) * 100 : 0;
    const progressPercent = Math.max(0, Math.min(100, progressPercentRaw));
    const hoverPercentRaw =
        hoverTime !== null && totalDuration > 0 ? (hoverTime / totalDuration) * 100 : null;
    const hoverPercent =
        hoverPercentRaw !== null ? Math.max(0, Math.min(100, hoverPercentRaw)) : null;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
        });

        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        const data = waveformData;

        if (!canvas || !container || size.width === 0 || size.height === 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = size.width * dpr;
        canvas.height = size.height * dpr;
        canvas.style.width = `${size.width}px`;
        canvas.style.height = `${size.height}px`;
        ctx.resetTransform();
        ctx.scale(dpr, dpr);

        const width = size.width;
        const height = size.height;
        const channels = data?.channelCount || 2;
        const channelGap = 8;
        const channelHeight = (height - channelGap * (channels - 1)) / channels;

        // Glass background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.fillRect(0, 0, width, height);

        const progressX = (progressPercent / 100) * width;

        if (data) {
            const samples = data.sampleCount;
            const barWidth = width / samples;

            for (let ch = 0; ch < channels; ch++) {
                const channelTop = ch * (channelHeight + channelGap);
                const centerY = channelTop + channelHeight / 2;
                const peaks = data.peaks[ch];
                const rmsData = data.rms[ch];

                // Draw waveform bars
                for (let i = 0; i < samples; i++) {
                    const x = i * barWidth;
                    const isPast = x < progressX;

                    const peak = peaks[i];
                    const rms = rmsData[i];

                    // Peak height (outer, lighter)
                    const peakHeight = peak * (channelHeight * 0.9);
                    // RMS height (inner, brighter)
                    const rmsHeight = rms * (channelHeight * 0.9);

                    // Draw peak (outer envelope)
                    if (isPast) {
                        // Gradient from purple to teal based on intensity
                        const hue = 260 - peak * 90;
                        const alpha = 0.3 + peak * 0.2;
                        ctx.fillStyle = `hsla(${hue}, 70%, 55%, ${alpha})`;
                    } else {
                        ctx.fillStyle = `rgba(255, 255, 255, ${0.08 + peak * 0.08})`;
                    }
                    ctx.fillRect(
                        x + 0.5,
                        centerY - peakHeight / 2,
                        Math.max(1, barWidth - 1),
                        peakHeight
                    );

                    // Draw RMS (inner, more solid)
                    if (isPast) {
                        const hue = 260 - rms * 90;
                        ctx.fillStyle = `hsl(${hue}, 80%, 60%)`;
                    } else {
                        ctx.fillStyle = `rgba(255, 255, 255, ${0.15 + rms * 0.2})`;
                    }
                    ctx.fillRect(
                        x + 0.5,
                        centerY - rmsHeight / 2,
                        Math.max(1, barWidth - 1),
                        rmsHeight
                    );
                }

                // Center line
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, centerY);
                ctx.lineTo(width, centerY);
                ctx.stroke();

                // Channel border
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
                ctx.lineWidth = 1;
                ctx.strokeRect(0.5, channelTop + 0.5, width - 1, channelHeight - 1);
            }
        } else {
            // Fallback placeholder waveform
            const bars = 100;

            for (let ch = 0; ch < channels; ch++) {
                const channelTop = ch * (channelHeight + channelGap);
                const centerY = channelTop + channelHeight / 2;

                for (let i = 0; i < bars; i++) {
                    const x = (i / bars) * width;
                    const isPast = x < progressX;
                    const amplitude = 0.2 + 0.4 * Math.sin((i + ch * 7) * 0.3) * Math.sin(i * 0.1);
                    const h = channelHeight * amplitude;

                    if (isPast) {
                        const hue = 260 - amplitude * 90;
                        ctx.fillStyle = `hsl(${hue}, 75%, 55%)`;
                    } else {
                        ctx.fillStyle = `rgba(255, 255, 255, ${0.1 + amplitude * 0.15})`;
                    }
                    ctx.fillRect(
                        x + 1,
                        centerY - h / 2,
                        width / bars - 2,
                        h
                    );
                }

                // Center line
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, centerY);
                ctx.lineTo(width, centerY);
                ctx.stroke();
            }
        }
    }, [waveformData, size.width, size.height, progressPercent]);

    const handlePointer = (clientX: number) => {
        const container = containerRef.current;
        if (!container || totalDuration <= 0) return;
        const rect = container.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        setHoverTime(percent * totalDuration);
    };

    const handleClick = (clientX: number) => {
        const container = containerRef.current;
        if (!container || totalDuration <= 0) return;
        const rect = container.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        onSeek(percent * totalDuration);
    };

    const labels = (() => {
        const result: string[] = [];
        const count = waveformData?.channelCount || 2;
        for (let i = 0; i < count; i++) {
            result.push(channelLabels[i] || `Ch ${i + 1}`);
        }
        return result;
    })();

    return (
        <div
            className="glass-surface"
            style={{
                padding: '0.75rem 1rem',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--glass-bg)',
                backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                border: '1px solid var(--glass-border)',
            }}
        >
            {/* Time Header */}
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: '0.6rem',
                    fontSize: '0.8rem',
                    fontFamily: 'SF Mono, Menlo, monospace',
                    color: 'var(--text-muted)',
                }}
            >
                <span>{formatTime(absoluteTime)}</span>
                <span style={{ color: 'var(--accent)' }}>
                    {playbackOffset > 0 ? `+${formatTime(playbackOffset)}` : ''}
                </span>
                <span>{formatTime(totalDuration)}</span>
            </div>

            {/* Waveform Canvas */}
            <div
                ref={containerRef}
                style={{
                    position: 'relative',
                    height: '140px',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    userSelect: 'none',
                    border: '1px solid var(--glass-border-subtle)',
                    background: 'var(--glass-bg)',
                }}
                onMouseMove={(e) => handlePointer(e.clientX)}
                onMouseLeave={() => setHoverTime(null)}
                onClick={(e) => handleClick(e.clientX)}
            >
                <canvas
                    ref={canvasRef}
                    style={{ width: '100%', height: '100%', display: 'block' }}
                />

                {/* Channel Labels */}
                {labels.map((label, idx) => {
                    const channels = waveformData?.channelCount || 2;
                    const effectiveHeight = size.height || 140;
                    const channelHeight = (effectiveHeight - 8 * (channels - 1)) / channels;
                    const top = idx * (channelHeight + 8) + 6;
                    return (
                        <span
                            key={label + idx}
                            style={{
                                position: 'absolute',
                                left: '8px',
                                top: `${top}px`,
                                color: 'var(--text-muted)',
                                fontSize: '0.7rem',
                                fontWeight: 'var(--font-weight-medium)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.03em',
                            }}
                        >
                            {label}
                        </span>
                    );
                })}

                {/* Progress line */}
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        width: '2px',
                        left: `${progressPercent}%`,
                        background: 'white',
                        boxShadow: '0 0 12px rgba(255, 255, 255, 0.9)',
                        transition: isPlaying ? 'none' : 'left 0.1s ease',
                        pointerEvents: 'none',
                    }}
                />

                {/* Hover indicator */}
                {hoverPercent !== null && (
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: `${hoverPercent}%`,
                            pointerEvents: 'none',
                        }}
                    >
                        <div
                            style={{
                                position: 'absolute',
                                top: 0,
                                bottom: 0,
                                width: '1px',
                                background: 'rgba(255, 255, 255, 0.4)',
                            }}
                        />
                        <div
                            style={{
                                position: 'absolute',
                                top: '6px',
                                left: '6px',
                                padding: '3px 8px',
                                background: 'var(--glass-bg-elevated)',
                                backdropFilter: 'blur(10px)',
                                borderRadius: 'var(--radius-xs)',
                                border: '1px solid var(--glass-border)',
                                color: 'var(--text-primary)',
                                fontSize: '0.7rem',
                                fontFamily: 'SF Mono, monospace',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {formatTime(hoverTime || 0)}
                        </div>
                    </div>
                )}

                {/* Loading State */}
                {loading && (
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'rgba(0, 0, 0, 0.4)',
                            backdropFilter: 'blur(4px)',
                            color: 'var(--text-secondary)',
                            fontSize: '0.85rem',
                        }}
                    >
                        <svg
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            style={{ animation: 'spin 1s linear infinite', marginRight: '0.5rem' }}
                        >
                            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                        Загружаем аудио...
                    </div>
                )}

                {/* Error State */}
                {error && (
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'rgba(239, 68, 68, 0.1)',
                            color: 'var(--danger)',
                            fontSize: '0.8rem',
                            textAlign: 'center',
                            padding: '0 1rem',
                        }}
                    >
                        {error}
                    </div>
                )}
            </div>
        </div>
    );
};

export default WaveformDisplay;
