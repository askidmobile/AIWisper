import React from 'react';
import { useSessionContext } from '../../context/SessionContext';

interface AudioMeterBarProps {
    // Optional: for playback mode, pass levels externally
    playbackMicLevel?: number;
    playbackSysLevel?: number;
}

export const AudioMeterBar: React.FC<AudioMeterBarProps> = ({
    playbackMicLevel,
    playbackSysLevel
}) => {
    const { micLevel, sysLevel, isRecording } = useSessionContext();

    // Use playback levels if provided, otherwise use recording levels
    const displayMicLevel = playbackMicLevel !== undefined ? playbackMicLevel : micLevel;
    const displaySysLevel = playbackSysLevel !== undefined ? playbackSysLevel : sysLevel;

    // Only show if recording or playback levels are provided
    const showMeter = isRecording || playbackMicLevel !== undefined || playbackSysLevel !== undefined;

    if (!showMeter) return null;

    return (
        <div style={{
            width: '24px',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '4px',
            padding: '8px 4px',
            background: 'var(--surface)',
            borderLeft: '1px solid var(--border)'
        }}>
            {/* Mic Level */}
            <div style={{
                flex: 1,
                width: '8px',
                background: 'var(--surface-strong)',
                borderRadius: '4px',
                position: 'relative',
                overflow: 'hidden'
            }}>
                <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: `${displayMicLevel}%`,
                    background: 'linear-gradient(to top, #4caf50, #8bc34a)',
                    borderRadius: '4px',
                    transition: 'height 0.1s ease'
                }} />
            </div>
            <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>🎤</span>

            {/* System Level */}
            <div style={{
                flex: 1,
                width: '8px',
                background: 'var(--surface-strong)',
                borderRadius: '4px',
                position: 'relative',
                overflow: 'hidden'
            }}>
                <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: `${displaySysLevel}%`,
                    background: 'linear-gradient(to top, #2196f3, #03a9f4)',
                    borderRadius: '4px',
                    transition: 'height 0.1s ease'
                }} />
            </div>
            <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>🔊</span>
        </div>
    );
};
