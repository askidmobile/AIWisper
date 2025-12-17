import React, { useState, useEffect } from 'react';
import { TranscriptSegment, TranscriptWord } from '../../types/session';

/**
 * Компонент горизонтальной линии индикатора воспроизведения
 * Линия плавно движется по тексту диалога, показывая текущую позицию воспроизведения
 */
export const PlaybackProgressLine: React.FC<{
    currentTimeMs: number;
    segments: TranscriptSegment[];
    dialogueContainerRef: React.RefObject<HTMLDivElement | null>;
    segmentRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
}> = ({ currentTimeMs, segments, dialogueContainerRef, segmentRefs }) => {
    const [lineTop, setLineTop] = useState<number | null>(null);
    
    useEffect(() => {
        if (!dialogueContainerRef.current || segments.length === 0) {
            setLineTop(null);
            return;
        }
        
        const container = dialogueContainerRef.current;
        
        // Если время до первого сегмента
        if (segments.length > 0 && currentTimeMs < segments[0].start) {
            const firstEl = segmentRefs.current.get(0);
            if (firstEl) {
                const rect = firstEl.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                setLineTop(rect.top - containerRect.top - 4);
            }
            return;
        }
        
        // Ищем позицию линии
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const segEl = segmentRefs.current.get(i);
            
            if (!segEl) continue;
            
            const rect = segEl.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            const segTop = rect.top - containerRect.top;
            const segHeight = rect.height;
            
            // Время внутри сегмента - вычисляем позицию пропорционально
            if (currentTimeMs >= seg.start && currentTimeMs <= seg.end) {
                const duration = seg.end - seg.start;
                const progress = duration > 0 ? (currentTimeMs - seg.start) / duration : 0;
                setLineTop(segTop + (segHeight * progress));
                return;
            }
            
            // Время между сегментами
            if (i < segments.length - 1) {
                const nextSeg = segments[i + 1];
                if (currentTimeMs > seg.end && currentTimeMs < nextSeg.start) {
                    // Интерполируем между концом текущего и началом следующего
                    const nextEl = segmentRefs.current.get(i + 1);
                    if (nextEl) {
                        const nextRect = nextEl.getBoundingClientRect();
                        const nextTop = nextRect.top - containerRect.top;
                        const gapStart = segTop + segHeight;
                        const gapEnd = nextTop;
                        const gapDuration = nextSeg.start - seg.end;
                        const gapProgress = gapDuration > 0 ? (currentTimeMs - seg.end) / gapDuration : 0;
                        setLineTop(gapStart + (gapEnd - gapStart) * gapProgress);
                    } else {
                        setLineTop(segTop + segHeight + 4);
                    }
                    return;
                }
            }
        }
        
        // После последнего сегмента
        const lastIdx = segments.length - 1;
        const lastSeg = segments[lastIdx];
        if (currentTimeMs >= lastSeg.end) {
            const lastEl = segmentRefs.current.get(lastIdx);
            if (lastEl) {
                const rect = lastEl.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                setLineTop(rect.top - containerRect.top + rect.height + 2);
            }
        }
    }, [currentTimeMs, segments, dialogueContainerRef, segmentRefs]);
    
    if (lineTop === null) return null;
    
    return (
        <div
            style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: lineTop,
                height: '2px',
                background: 'linear-gradient(90deg, var(--primary) 0%, var(--primary) 80%, transparent 100%)',
                boxShadow: '0 0 8px var(--primary), 0 0 4px var(--primary)',
                zIndex: 50,
                pointerEvents: 'none',
                transition: 'top 0.15s linear',
            }}
        />
    );
};

/**
 * Компонент индикатора позиции на скроллбаре (точка справа)
 * Показывает где находится текущая позиция воспроизведения относительно всего контента
 */
export const ScrollbarPositionIndicator: React.FC<{
    currentTimeMs: number;
    segments: TranscriptSegment[];
    scrollContainerRef: React.RefObject<HTMLDivElement | null>;
    dialogueContainerRef: React.RefObject<HTMLDivElement | null>;
    segmentRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
    onClickScrollToPlayback: () => void;
}> = ({ currentTimeMs, segments, scrollContainerRef, dialogueContainerRef, segmentRefs, onClickScrollToPlayback }) => {
    const [indicator, setIndicator] = useState<{ top: number; visible: boolean; isOutOfView: boolean }>({ 
        top: 0, 
        visible: false, 
        isOutOfView: false 
    });
    
    useEffect(() => {
        const scrollContainer = scrollContainerRef.current;
        const dialogueContainer = dialogueContainerRef.current;
        
        if (!scrollContainer || !dialogueContainer || segments.length === 0) {
            setIndicator({ top: 0, visible: false, isOutOfView: false });
            return;
        }
        
        // Находим абсолютную позицию линии в контенте
        let contentPosition: number | null = null;
        const dialogueRect = dialogueContainer.getBoundingClientRect();
        const scrollRect = scrollContainer.getBoundingClientRect();
        const dialogueOffsetInScroll = dialogueRect.top - scrollRect.top + scrollContainer.scrollTop;
        
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const segEl = segmentRefs.current.get(i);
            
            if (!segEl) continue;
            
            const rect = segEl.getBoundingClientRect();
            const segTopInDialogue = rect.top - dialogueRect.top;
            const segTopInScroll = dialogueOffsetInScroll + segTopInDialogue;
            const segHeight = rect.height;
            
            if (currentTimeMs >= seg.start && currentTimeMs <= seg.end) {
                const duration = seg.end - seg.start;
                const progress = duration > 0 ? (currentTimeMs - seg.start) / duration : 0;
                contentPosition = segTopInScroll + (segHeight * progress);
                break;
            }
            
            if (i < segments.length - 1) {
                const nextSeg = segments[i + 1];
                if (currentTimeMs > seg.end && currentTimeMs < nextSeg.start) {
                    contentPosition = segTopInScroll + segHeight;
                    break;
                }
            }
            
            if (i === segments.length - 1 && currentTimeMs >= seg.start) {
                const duration = seg.end - seg.start;
                const progress = duration > 0 ? Math.min(1, (currentTimeMs - seg.start) / duration) : 1;
                contentPosition = segTopInScroll + (segHeight * progress);
            }
        }
        
        if (contentPosition === null) {
            setIndicator({ top: 0, visible: false, isOutOfView: false });
            return;
        }
        
        // Вычисляем позицию точки на скроллбаре
        const scrollHeight = scrollContainer.scrollHeight;
        const clientHeight = scrollContainer.clientHeight;
        const scrollTop = scrollContainer.scrollTop;
        
        // Позиция точки пропорционально высоте контейнера
        const indicatorPercent = contentPosition / scrollHeight;
        const indicatorTop = indicatorPercent * clientHeight;
        
        // Проверяем, видна ли линия на экране
        const isOutOfView = contentPosition < scrollTop || contentPosition > scrollTop + clientHeight - 20;
        
        setIndicator({ 
            top: Math.max(8, Math.min(clientHeight - 8, indicatorTop)), 
            visible: true, 
            isOutOfView 
        });
    }, [currentTimeMs, segments, scrollContainerRef, dialogueContainerRef, segmentRefs]);
    
    if (!indicator.visible) return null;
    
    return (
        <div
            onClick={onClickScrollToPlayback}
            style={{
                position: 'absolute',
                right: '4px',
                top: indicator.top,
                width: indicator.isOutOfView ? '10px' : '6px',
                height: indicator.isOutOfView ? '10px' : '6px',
                borderRadius: '50%',
                backgroundColor: 'var(--primary)',
                boxShadow: indicator.isOutOfView 
                    ? '0 0 10px var(--primary), 0 0 20px var(--primary)' 
                    : '0 0 4px var(--primary)',
                zIndex: 100,
                cursor: 'pointer',
                transform: 'translateY(-50%)',
                transition: 'top 0.15s linear, width 0.2s ease, height 0.2s ease, box-shadow 0.2s ease',
                animation: indicator.isOutOfView ? 'pulse 1.5s ease-in-out infinite' : 'none',
            }}
            title="Нажмите для перехода к текущей позиции воспроизведения"
        />
    );
};

/**
 * Компонент для отображения слова с визуализацией confidence
 */
export const ConfidenceWord: React.FC<{ word: TranscriptWord; showConfidence: boolean }> = ({ word, showConfidence }) => {
    if (!showConfidence || !word.p || word.p >= 0.7) {
        // Высокая уверенность или confidence не показываем - обычный текст
        return <span>{word.text} </span>;
    }
    
    // Низкая уверенность - подсвечиваем
    const isVeryLow = word.p < 0.4;
    const isLow = word.p < 0.7;
    
    const style: React.CSSProperties = {
        backgroundColor: isVeryLow 
            ? 'rgba(255, 152, 0, 0.25)' // Оранжевый для очень низкой
            : isLow 
                ? 'rgba(255, 193, 7, 0.15)' // Жёлтый для низкой
                : 'transparent',
        borderRadius: '2px',
        padding: '0 2px',
        cursor: 'help',
        borderBottom: isVeryLow ? '1px dashed rgba(255, 152, 0, 0.6)' : undefined,
    };
    
    return (
        <span 
            style={style} 
            title={`Уверенность: ${Math.round(word.p * 100)}%`}
        >
            {word.text}{' '}
        </span>
    );
};

/**
 * Компонент для отображения текста сегмента с confidence
 */
export const SegmentText: React.FC<{ 
    segment: TranscriptSegment; 
    showConfidence: boolean;
    isCurrentSegment: boolean;
}> = ({ segment, showConfidence, isCurrentSegment }) => {
    // Если нет слов или не показываем confidence - просто текст
    if (!showConfidence || !segment.words || segment.words.length === 0) {
        return (
            <span style={{ color: isCurrentSegment ? 'var(--text-primary)' : 'var(--text-primary)' }}>
                {segment.text || ''}
            </span>
        );
    }
    
    // Отображаем слова с confidence
    return (
        <span style={{ color: isCurrentSegment ? 'var(--text-primary)' : 'var(--text-primary)' }}>
            {segment.words.map((word, idx) => (
                <ConfidenceWord key={idx} word={word} showConfidence={showConfidence} />
            ))}
        </span>
    );
};
