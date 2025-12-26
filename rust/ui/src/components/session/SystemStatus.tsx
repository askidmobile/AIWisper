import React, { useEffect, useMemo, useState } from 'react';
import { useBackendContext } from '../../context/BackendContext';
import { useSessionContext } from '../../context/SessionContext';
import { useSettingsContext } from '../../context/SettingsContext';

type SystemStage =
    | 'recording'
    | 'vad'
    | 'streaming'
    | 'confirming'
    | 'chunk_creating'
    | 'transcribing'
    | 'hybrid'
    | 'llm'
    | 'diarization'
    | 'voiceprint'
    | 'finalizing'
    | 'waiting';

interface SystemStatusState {
    stage: SystemStage;
    text: string;
    icon: string;
    color: string;
}

/**
 * Однострочный индикатор текущей стадии обработки.
 */
export const SystemStatus: React.FC = () => {
    const { subscribe } = useBackendContext();
    const { isFinalizing, finalizingMessage } = useSessionContext();
    const { hybridTranscription } = useSettingsContext();

    const [lastStreamingUpdate, setLastStreamingUpdate] = useState<number | null>(null);
    const [streamingIsConfirmed, setStreamingIsConfirmed] = useState(false);
    const [lastChunkCreated, setLastChunkCreated] = useState<number | null>(null);
    const [lastChunkTranscribed, setLastChunkTranscribed] = useState<number | null>(null);
    const [lastSpeakersUpdate, setLastSpeakersUpdate] = useState<number | null>(null);
    const [isLLMProcessing, setIsLLMProcessing] = useState(false);
    const [isHybridProcessing, setIsHybridProcessing] = useState(false);

    useEffect(() => {
        const unsubStreamingUpdate = subscribe('streaming_update', (msg: any) => {
            setLastStreamingUpdate(Date.now());
            setStreamingIsConfirmed(msg.streamingIsConfirmed || false);
        });

        const unsubChunkCreated = subscribe('chunk_created', () => setLastChunkCreated(Date.now()));

        const unsubChunkTranscribed = subscribe('chunk_transcribed', () => {
            setLastChunkTranscribed(Date.now());
            setIsHybridProcessing(false);
            setIsLLMProcessing(false);
        });

        const unsubSessionSpeakers = subscribe('session_speakers', () => setLastSpeakersUpdate(Date.now()));

        const unsubHybridStart = subscribe('hybrid_processing_start', () => setIsHybridProcessing(true));
        const unsubHybridEnd = subscribe('hybrid_processing_end', () => setIsHybridProcessing(false));

        const unsubLLMStart = subscribe('llm_processing_start', () => setIsLLMProcessing(true));
        const unsubLLMEnd = subscribe('llm_processing_end', () => setIsLLMProcessing(false));

        return () => {
            unsubStreamingUpdate();
            unsubChunkCreated();
            unsubChunkTranscribed();
            unsubSessionSpeakers();
            unsubHybridStart();
            unsubHybridEnd();
            unsubLLMStart();
            unsubLLMEnd();
        };
    }, [subscribe]);

    const currentStatus: SystemStatusState = useMemo(() => {
        const now = Date.now();
        const recent = 3000;

        // Финализация (склейка MP3 сегментов) - высший приоритет
        if (isFinalizing) {
            return { 
                stage: 'finalizing', 
                text: finalizingMessage || 'Сохранение записи...', 
                icon: '💾', 
                color: '#f59e0b' 
            };
        }

        if (isLLMProcessing) {
            return { stage: 'llm', text: 'Обработка LLM...', icon: '🤖', color: '#a855f7' };
        }

        if (isHybridProcessing || (hybridTranscription.enabled && lastChunkTranscribed && now - lastChunkTranscribed < 1000)) {
            return { stage: 'hybrid', text: 'Гибридная обработка...', icon: '⚡', color: '#f59e0b' };
        }

        if (lastSpeakersUpdate && now - lastSpeakersUpdate < recent) {
            return { stage: 'diarization', text: 'Анализ спикеров...', icon: '👥', color: '#8b5cf6' };
        }

        if (lastChunkTranscribed && now - lastChunkTranscribed < recent) {
            return { stage: 'transcribing', text: 'Распознавание речи...', icon: '🎤', color: '#10b981' };
        }

        if (streamingIsConfirmed && lastStreamingUpdate && now - lastStreamingUpdate < 1000) {
            return { stage: 'confirming', text: 'Подтверждение текста...', icon: '✓', color: '#10b981' };
        }

        if (lastStreamingUpdate && now - lastStreamingUpdate < 2000) {
            return { stage: 'streaming', text: 'Стриминг транскрипция...', icon: '📝', color: '#3b82f6' };
        }

        if (lastChunkCreated && now - lastChunkCreated < recent) {
            return { stage: 'chunk_creating', text: 'Создание чанка...', icon: '📦', color: '#6366f1' };
        }

        if (lastStreamingUpdate && now - lastStreamingUpdate > 10000) {
            return { stage: 'waiting', text: 'Ожидание аудио...', icon: '⏸', color: '#9ca3af' };
        }

        return { stage: 'recording', text: 'Идёт запись аудио...', icon: '🎙', color: '#ef4444' };
    }, [isFinalizing, finalizingMessage, hybridTranscription.enabled, isHybridProcessing, isLLMProcessing, lastChunkCreated, lastChunkTranscribed, lastSpeakersUpdate, lastStreamingUpdate, streamingIsConfirmed]);

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.35rem 0.65rem',
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.18)',
                borderRadius: '9999px',
                fontSize: '0.85rem',
                fontWeight: 500,
                color: 'white',
                minWidth: '200px',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                transition: 'all 0.3s ease',
            }}
        >
            <span
                style={{
                    fontSize: '1rem',
                    animation: currentStatus.stage === 'streaming' || currentStatus.stage === 'transcribing' ? 'pulse 2s ease-in-out infinite' : 'none',
                }}
            >
                {currentStatus.icon}
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>{currentStatus.text}</span>
            <div
                style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: currentStatus.color,
                    boxShadow: `0 0 8px ${currentStatus.color}`,
                    animation: 'pulse 2s ease-in-out infinite',
                }}
            />
            <style>{`
                @keyframes pulse {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.6; transform: scale(0.95); }
                }
            `}</style>
        </div>
    );
};

export default SystemStatus;
