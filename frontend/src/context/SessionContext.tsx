import React, { createContext, useContext, useEffect, useState } from 'react';
import { useWebSocketContext } from './WebSocketContext';
import { Session, SessionInfo } from '../types/session';

interface SessionContextType {
    sessions: SessionInfo[];
    currentSession: Session | null;
    selectedSession: Session | null;
    isRecording: boolean;
    isStopping: boolean;
    micLevel: number;
    sysLevel: number;

    // Actions
    startSession: (config: any) => void;
    stopSession: () => void;
    deleteSession: (id: string) => void;
    selectSession: (id: string) => void;
    generateSummary: (sessionId: string, model: string, url: string) => void;
    improveTranscription: (sessionId: string, model: string, url: string) => void;

    // Setters
    setSelectedSession: (session: Session | null) => void;
}

const SessionContext = createContext<SessionContextType | null>(null);

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { sendMessage, subscribe, isConnected } = useWebSocketContext();
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [currentSession, setCurrentSession] = useState<Session | null>(null);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [isStopping, setIsStopping] = useState(false);
    const [micLevel, setMicLevel] = useState(0);
    const [sysLevel, setSysLevel] = useState(0);

    // Initial fetch
    useEffect(() => {
        if (isConnected) {
            sendMessage({ type: 'get_sessions' });
        }
    }, [isConnected, sendMessage]);

    // WebSocket Handlers
    useEffect(() => {
        const unsubList = subscribe('sessions_list', (msg) => setSessions(msg.sessions || []));

        const unsubStarted = subscribe('session_started', (msg) => {
            setCurrentSession(msg.session);
            setIsRecording(true);
            // Optional: Beep sound logic moved to UI component or hook
        });

        const unsubStopped = subscribe('session_stopped', (msg) => {
            setIsRecording(false);
            setIsStopping(false);
            setCurrentSession(null);
            sendMessage({ type: 'get_sessions' });
            if (msg.session) setSelectedSession(msg.session);
        });

        const unsubDetails = subscribe('session_details', (msg) => setSelectedSession(msg.session));

        const unsubChunkCreated = subscribe('chunk_created', (msg) => {
            setCurrentSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                return { ...prev, chunks: [...prev.chunks, msg.chunk] };
            });
            // Update selected if same
            setSelectedSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                return { ...prev, chunks: [...prev.chunks, msg.chunk] };
            });
        });

        const unsubChunkTranscribed = subscribe('chunk_transcribed', (msg) => {
            const updateChunks = (s: Session | null) => {
                if (!s || s.id !== msg.sessionId) return s;
                return {
                    ...s,
                    chunks: s.chunks.map(c => c.id === msg.chunk.id ? msg.chunk : c)
                };
            };
            setCurrentSession(prev => updateChunks(prev));
            setSelectedSession(prev => updateChunks(prev));
        });

        const unsubAudioLevel = subscribe('audio_level', (msg) => {
            setMicLevel(Math.min((msg.micLevel || 0) * 500, 100));
            setSysLevel(Math.min((msg.systemLevel || 0) * 500, 100));
        });

        const unsubSummary = subscribe('summary_completed', (msg) => {
            setSelectedSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                return { ...prev, summary: msg.summary };
            });
        });

        const unsubImprove = subscribe('improve_completed', (msg) => {
            if (msg.session) setSelectedSession(msg.session);
        });

        return () => {
            unsubList(); unsubStarted(); unsubStopped(); unsubDetails();
            unsubChunkCreated(); unsubChunkTranscribed(); unsubAudioLevel();
            unsubSummary(); unsubImprove();
        };
    }, [subscribe, sendMessage]);

    const startSession = (config: any) => {
        sendMessage({ type: 'start_session', ...config });
    };

    const stopSession = () => {
        setIsStopping(true);
        sendMessage({ type: 'stop_session' });
    };

    const deleteSession = (id: string) => {
        sendMessage({ type: 'delete_session', sessionId: id });
        if (selectedSession?.id === id) setSelectedSession(null);
        // Optimistic update
        setSessions(prev => prev.filter(s => s.id !== id));
    };

    // Add handler for session_deleted to ensure sync
    useEffect(() => {
        return subscribe('session_deleted', () => sendMessage({ type: 'get_sessions' }));
    }, [subscribe, sendMessage]);

    const selectSession = (id: string) => {
        sendMessage({ type: 'get_session', sessionId: id });
    };

    const generateSummary = (sessionId: string, model: string, url: string) => {
        sendMessage({ type: 'generate_summary', sessionId, ollamaModel: model, ollamaUrl: url });
    };

    const improveTranscription = (sessionId: string, model: string, url: string) => {
        sendMessage({ type: 'improve_transcription', sessionId, ollamaModel: model, ollamaUrl: url });
    };

    return (
        <SessionContext.Provider value={{
            sessions, currentSession, selectedSession, isRecording, isStopping,
            micLevel, sysLevel,
            startSession, stopSession, deleteSession, selectSession,
            generateSummary, improveTranscription,
            setSelectedSession
        }}>
            {children}
        </SessionContext.Provider>
    );
};

export const useSessionContext = () => {
    const context = useContext(SessionContext);
    if (!context) throw new Error('useSessionContext must be used within a SessionProvider');
    return context;
};
