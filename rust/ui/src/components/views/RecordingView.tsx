import React, { useEffect, useState } from 'react';
import { useSessionContext } from '../../context/SessionContext';
import { useBackendContext } from '../../context/BackendContext';
import { LiveChunksView } from '../chunks/LiveChunksView';

export const RecordingView: React.FC = () => {
    const { currentSession } = useSessionContext();
    const { subscribe, sendMessage } = useBackendContext();
    const chunks = currentSession?.chunks || [];

    const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);
    const [transcribingChunkId, setTranscribingChunkId] = useState<string | null>(null);

    useEffect(() => {
        if (!currentSession) return;

        const handleCreated = (msg: any) => {
            if (msg.sessionId !== currentSession.id) return;
            setHighlightedChunkId(msg.chunk.id);
            setTimeout(() => setHighlightedChunkId(null), 1200);
        };
        const handleTranscribed = (msg: any) => {
            if (msg.sessionId !== currentSession.id) return;
            setTranscribingChunkId(prev => (prev === msg.chunk.id ? null : prev));
            setHighlightedChunkId(msg.chunk.id);
            setTimeout(() => setHighlightedChunkId(null), 2000);
        };

        const unsubCreated = subscribe('chunk_created', handleCreated);
        const unsubTranscribed = subscribe('chunk_transcribed', handleTranscribed);

        return () => {
            unsubCreated?.();
            unsubTranscribed?.();
        };
    }, [currentSession, subscribe]);

    if (!currentSession) {
        return (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '3rem' }}>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔴</div>
                <div>Инициализация записи...</div>
            </div>
        );
    }

    // Если нет чанков, показываем ожидание первого чанка
    if (chunks.length === 0) {
        return (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '3rem' }}>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🎙️</div>
                <div>Идёт запись... Ожидание первого фрагмента</div>
                <div style={{ fontSize: '0.85rem', marginTop: '0.5rem', opacity: 0.7 }}>
                    Транскрипция появится автоматически
                </div>
            </div>
        );
    }

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <LiveChunksView
                chunks={chunks}
                sessionId={currentSession.id}
                transcribingChunkId={transcribingChunkId}
                highlightedChunkId={highlightedChunkId}
                onPlayChunk={(url) => {
                    sendMessage({ type: 'play_audio_url', url });
                }}
            />
        </div>
    );
};

export default RecordingView;
