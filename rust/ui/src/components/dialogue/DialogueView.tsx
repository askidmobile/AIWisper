import React, { useRef, useEffect, useCallback } from 'react';
import { TranscriptSegment } from '../../types/session';

interface SpeakerInfo {
    name: string;
    color: string;
}

interface DialogueViewProps {
    dialogue: TranscriptSegment[];
    currentSegmentIndex: number;
    isPlaying: boolean;
    autoScrollEnabled: boolean;
    onSegmentClick: (startMs: number) => void;
    onToggleAutoScroll: () => void;
    getSpeakerDisplayName: (speaker?: string) => SpeakerInfo;
}

/**
 * Компонент для отображения диалога с таймкодами
 */
export const DialogueView: React.FC<DialogueViewProps> = ({
    dialogue,
    currentSegmentIndex,
    isPlaying,
    autoScrollEnabled,
    onSegmentClick,
    onToggleAutoScroll,
    getSpeakerDisplayName,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const segmentRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());

    // Автоскролл к текущему сегменту
    useEffect(() => {
        if (!autoScrollEnabled || currentSegmentIndex < 0) return;
        
        const segmentEl = segmentRefs.current.get(currentSegmentIndex);
        if (segmentEl && containerRef.current) {
            segmentEl.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
            });
        }
    }, [currentSegmentIndex, autoScrollEnabled]);

    const setSegmentRef = useCallback((index: number, el: HTMLDivElement | null) => {
        segmentRefs.current.set(index, el);
    }, []);

    if (dialogue.length === 0) {
        return (
            <div style={{
                marginBottom: '1.5rem',
                padding: '2rem',
                backgroundColor: 'var(--surface)',
                borderRadius: '8px',
                textAlign: 'center',
                color: 'var(--text-muted)',
            }}>
                Диалог пуст
            </div>
        );
    }

    return (
        <div 
            ref={containerRef}
            style={{
                marginBottom: '1.5rem',
                padding: '1rem',
                backgroundColor: 'var(--surface)',
                borderRadius: '8px',
                lineHeight: '1.9',
                fontSize: '0.95rem',
                position: 'relative',
                wordWrap: 'break-word',
                overflowWrap: 'break-word'
            }}
        >
            {/* Header */}
            <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                marginBottom: '1rem' 
            }}>
                <h4 style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    Диалог
                </h4>
                {isPlaying && (
                    <AutoScrollButton 
                        enabled={autoScrollEnabled} 
                        onToggle={onToggleAutoScroll} 
                    />
                )}
            </div>

            {/* Dialogue Items */}
            {dialogue.map((seg, idx) => (
                <DialogueItem
                    key={idx}
                    segment={seg}
                    index={idx}
                    isCurrent={idx === currentSegmentIndex}
                    speakerInfo={getSpeakerDisplayName(seg.speaker)}
                    onClick={() => onSegmentClick(seg.start)}
                    setRef={(el) => setSegmentRef(idx, el)}
                />
            ))}
        </div>
    );
};

/**
 * Кнопка автоскролла
 */
interface AutoScrollButtonProps {
    enabled: boolean;
    onToggle: () => void;
}

const AutoScrollButton: React.FC<AutoScrollButtonProps> = ({ enabled, onToggle }) => (
    <button
        onClick={onToggle}
        style={{
            padding: '4px 8px',
            fontSize: '0.75rem',
            backgroundColor: enabled ? 'var(--primary)' : 'transparent',
            color: enabled ? 'white' : 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            cursor: 'pointer',
            transition: 'all 0.2s'
        }}
        title={enabled ? 'Автоскролл включён' : 'Автоскролл выключен'}
    >
        {enabled ? '📍 Следить' : '📍 Не следить'}
    </button>
);

/**
 * Элемент диалога
 */
interface DialogueItemProps {
    segment: TranscriptSegment;
    index: number;
    isCurrent: boolean;
    speakerInfo: SpeakerInfo;
    onClick: () => void;
    setRef: (el: HTMLDivElement | null) => void;
}

const DialogueItem: React.FC<DialogueItemProps> = ({
    segment,
    isCurrent,
    speakerInfo,
    onClick,
    setRef,
}) => {
    const timeStr = formatTimestamp(segment.start);

    return (
        <div 
            ref={setRef}
            onClick={onClick}
            style={{
                marginBottom: '0.5rem',
                paddingLeft: '0.5rem',
                paddingRight: '0.5rem',
                paddingTop: '0.25rem',
                paddingBottom: '0.25rem',
                borderLeft: `3px solid ${isCurrent ? 'var(--primary)' : speakerInfo.color}`,
                backgroundColor: isCurrent ? 'rgba(138, 43, 226, 0.15)' : 'transparent',
                borderRadius: isCurrent ? '0 4px 4px 0' : '0',
                transition: 'all 0.2s ease',
                cursor: 'pointer',
                position: 'relative'
            }}
        >
            {/* Индикатор текущего сегмента */}
            {isCurrent && (
                <div style={{
                    position: 'absolute',
                    left: '-3px',
                    top: 0,
                    bottom: 0,
                    width: '3px',
                    backgroundColor: 'var(--primary)',
                    boxShadow: '0 0 8px var(--primary)',
                    animation: 'pulse 1.5s ease-in-out infinite'
                }} />
            )}
            
            {/* Timestamp */}
            <span style={{
                color: isCurrent ? 'var(--primary)' : 'var(--text-muted)',
                fontSize: '0.8rem',
                fontFamily: 'monospace',
                fontWeight: isCurrent ? 'bold' : 'normal'
            }}>
                [{timeStr}]
            </span>
            {' '}
            
            {/* Speaker */}
            <span style={{
                color: speakerInfo.color,
                fontWeight: 'bold'
            }}>
                {speakerInfo.name}:
            </span>
            {' '}
            
            {/* Text */}
            <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                {segment.text}
            </span>
        </div>
    );
};

/**
 * Форматирование таймстампа MM:SS.d
 */
const formatTimestamp = (totalMs: number): string => {
    const mins = Math.floor(totalMs / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = Math.floor((totalMs % 1000) / 100); // десятые доли секунды
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;
};

export default DialogueView;
