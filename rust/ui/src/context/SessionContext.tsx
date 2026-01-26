import React, { createContext, useContext, useEffect, useState } from 'react';
import { useBackendContext } from './BackendContext';
import { Session, SessionInfo } from '../types/session';

interface SessionContextType {
    sessions: SessionInfo[];
    currentSession: Session | null;
    selectedSession: Session | null;
    isRecording: boolean;
    isStopping: boolean;
    isFinalizing: boolean;
    finalizingMessage: string | null;
    micLevel: number;
    sysLevel: number;

    // Pending background transcription (after stop)
    pendingTranscriptionChunks: Set<string>;
    isProcessingFinalChunks: boolean;

    // Full retranscription state
    isFullTranscribing: boolean;
    fullTranscriptionProgress: number; // 0-1
    fullTranscriptionStatus: string | null;
    fullTranscriptionError: string | null;
    fullTranscriptionSessionId: string | null;

    // Actions
    startSession: (config: any) => void;
    stopSession: () => void;
    deleteSession: (id: string) => void;
    selectSession: (id: string) => void;
    generateSummary: (sessionId: string, model: string, url: string, contextSize?: number) => void;
    improveTranscription: (sessionId: string, model: string, url: string) => void;
    cancelFullTranscription: () => void;
    toggleChunkExclude: (sessionId: string, chunkId: string) => void;

    // Setters
    setSelectedSession: (session: Session | null) => void;
}

const SessionContext = createContext<SessionContextType | null>(null);

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { sendMessage, subscribe, isConnected } = useBackendContext();
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [currentSession, setCurrentSession] = useState<Session | null>(null);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [isStopping, setIsStopping] = useState(false);
    const [isFinalizing, setIsFinalizing] = useState(false);
    const [finalizingMessage, setFinalizingMessage] = useState<string | null>(null);
    const [micLevel, setMicLevel] = useState(0);
    const [sysLevel, setSysLevel] = useState(0);

    // Pending background transcription tracking
    const [pendingTranscriptionChunks, setPendingTranscriptionChunks] = useState<Set<string>>(new Set());
    const isProcessingFinalChunks = pendingTranscriptionChunks.size > 0;

    // Full retranscription state
    const [isFullTranscribing, setIsFullTranscribing] = useState(false);
    const [fullTranscriptionProgress, setFullTranscriptionProgress] = useState(0);
    const [fullTranscriptionStatus, setFullTranscriptionStatus] = useState<string | null>(null);
    const [fullTranscriptionError, setFullTranscriptionError] = useState<string | null>(null);
    const [fullTranscriptionSessionId, setFullTranscriptionSessionId] = useState<string | null>(null);

    // Initial fetch
    useEffect(() => {
        if (isConnected) {
            sendMessage({ type: 'get_sessions' });
        }
    }, [isConnected, sendMessage]);

    // WebSocket Handlers
    useEffect(() => {
        // Track last stopped session ID to auto-select it when list updates
        let lastStoppedSessionId: string | null = null;

        const unsubList = subscribe('sessions_list', (msg: any) => {
            const newSessions = msg.sessions || [];
            console.log('[SessionContext] 📋 sessions_list received:', newSessions.length, 'sessions');
            
            setSessions(newSessions);
            
            // ✅ Если это обновление после завершения записи, автоматически выбираем последнюю сессию
            if (lastStoppedSessionId && newSessions.length > 0) {
                // Проверяем что сессия есть в списке
                const sessionExists = newSessions.some((s: any) => s.id === lastStoppedSessionId);
                console.log('[SessionContext] 🎯 Looking for stopped session:', lastStoppedSessionId, 'exists:', sessionExists);
                
                if (sessionExists) {
                    console.log('[SessionContext] 🎯 Auto-selecting last stopped session');
                    sendMessage({ type: 'get_session', sessionId: lastStoppedSessionId });
                    lastStoppedSessionId = null; // Сбрасываем флаг
                } else {
                    console.log('[SessionContext] ⚠️ Session not in list yet, will retry on next sessions_list');
                    // НЕ сбрасываем lastStoppedSessionId - подождём следующего обновления
                }
            }
        });

        const unsubStarted = subscribe('session_started', (msg: any) => {
            console.log('[SessionContext] ✅ session_started:', msg.session?.id);
            console.log('[SessionContext] 📝 Setting currentSession:', msg.session ? 'session object received' : 'NO SESSION OBJECT');
            console.log('[SessionContext] 📝 Session details:', JSON.stringify(msg.session, null, 2));
            setCurrentSession(msg.session);
            setIsRecording(true);
            setPendingTranscriptionChunks(new Set()); // Clear pending on new session
            lastStoppedSessionId = null; // Сбрасываем на случай если была установлена
            // Optional: Beep sound logic moved to UI component or hook
        });

        // Обработчик события финализации (склейка MP3 сегментов)
        const unsubFinalizing = subscribe('session_finalizing', (msg: any) => {
            console.log('[SessionContext] ⏳ session_finalizing:', msg);
            setIsFinalizing(true);
            setFinalizingMessage(msg.message || 'Сохранение записи...');
        });

        const unsubStopped = subscribe('session_stopped', (msg: any) => {
            setIsRecording(false);
            setIsStopping(false);
            setIsFinalizing(false);
            setFinalizingMessage(null);
            
            // ✅ ИСПРАВЛЕНИЕ: Принудительно сбрасываем pending чанки при остановке сессии
            // Это предотвращает "зависание" уведомления о завершении транскрипции
            setPendingTranscriptionChunks(prev => {
                if (prev.size > 0) {
                    console.log('[SessionContext] 🧹 Clearing', prev.size, 'pending transcription chunks on session_stopped');
                }
                return new Set();
            });
            
            // ✅ ВАЖНО: Сохраняем currentSession в selectedSession ПЕРЕД обнулением,
            // чтобы последующие chunk_transcribed могли обновить её
            setCurrentSession(prev => {
                const stoppedSessionId = prev?.id || msg.sessionId;
                lastStoppedSessionId = stoppedSessionId;
                console.log('[SessionContext] ✅ session_stopped:', stoppedSessionId);
                
                if (msg.session) {
                    // Если есть session в сообщении - используем его
                    console.log('[SessionContext] 📝 Got full session in stopped event, using it directly');
                    setSelectedSession(msg.session);
                    lastStoppedSessionId = null;
                } else if (prev) {
                    // ✅ Переносим текущую сессию с чанками в selectedSession
                    // чтобы chunk_transcribed мог обновить её после остановки
                    console.log('[SessionContext] 📝 Transferring currentSession to selectedSession with', prev.chunks.length, 'chunks');
                    setSelectedSession(prev);
                }
                
                return null; // Обнуляем currentSession
            });
        });

        // ✅ Обработчик завершения записи - гарантированно приходит ПОСЛЕ добавления сессии в память
        const unsubRecordingCompleted = subscribe('recording_completed', (msg: any) => {
            console.log('[SessionContext] 🎉 recording_completed:', msg.sessionId);
            const completedSessionId = msg.sessionId;
            
            if (completedSessionId) {
                // Сначала запрашиваем обновлённый список сессий
                console.log('[SessionContext] 📡 Requesting updated sessions list...');
                sendMessage({ type: 'get_sessions' });
                
                // Затем запрашиваем детали сессии для отображения
                console.log('[SessionContext] 📡 Requesting session details for:', completedSessionId);
                sendMessage({ type: 'get_session', sessionId: completedSessionId });
            }
        });

        const unsubDetails = subscribe('session_details', (msg: any) => {
            // ✅ Мержим данные с бэкенда с уже имеющимися транскрипциями
            // чтобы не потерять результаты chunk_transcribed, которые пришли раньше
            console.log('[SessionContext] session_details received:', { 
                hasSession: !!msg.session, 
                sessionId: msg.session?.id,
                hasSummary: !!msg.session?.summary,
                summaryLength: msg.session?.summary?.length || 0,
                summaryPreview: msg.session?.summary?.substring(0, 100)
            });
            setSelectedSession(prev => {
                if (!msg.session) return prev;
                if (!prev || prev.id !== msg.session.id) {
                    // Новая сессия - просто устанавливаем
                    return msg.session;
                }
                
                // Мержим чанки: берём данные с бэкенда, но сохраняем транскрипции из локального состояния
                const mergedChunks = msg.session.chunks.map((backendChunk: any) => {
                    const localChunk = prev.chunks.find(c => c.id === backendChunk.id);
                    // Если локальный чанк имеет транскрипцию, а бэкенд - нет, сохраняем локальную
                    if (localChunk && localChunk.transcription && !backendChunk.transcription) {
                        console.log('[SessionContext] 📝 Preserving local transcription for chunk', localChunk.index);
                        return localChunk;
                    }
                    // Если бэкенд чанк "completed" - используем его
                    if (backendChunk.status === 'completed') {
                        return backendChunk;
                    }
                    // Если локальный чанк completed - сохраняем его
                    if (localChunk?.status === 'completed') {
                        return localChunk;
                    }
                    return backendChunk;
                });
                
                return {
                    ...msg.session,
                    chunks: mergedChunks
                };
            });
        });

        const unsubChunkCreated = subscribe('chunk_created', (msg: any) => {
            setCurrentSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                // Check if chunk already exists (deduplication)
                const chunkExists = prev.chunks.some(c => c.id === msg.chunk.id);
                if (chunkExists) return prev;
                const updated = { ...prev, chunks: [...prev.chunks, msg.chunk] };
                console.log('[SessionContext] ✅ chunk_created: index', msg.chunk.index, 'total:', updated.chunks.length);
                return updated;
            });
            // Update selected if same
            setSelectedSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                const chunkExists = prev.chunks.some(c => c.id === msg.chunk.id);
                if (chunkExists) return prev;
                return { ...prev, chunks: [...prev.chunks, msg.chunk] };
            });
        });

        const unsubChunkTranscribed = subscribe('chunk_transcribed', (msg: any) => {
            console.log('[SessionContext] ✅ chunk_transcribed: index', msg.chunk.index, 'chunkId:', msg.chunk.id, 'sessionId:', msg.sessionId, 'text:', msg.chunk.transcription?.substring(0, 50));
            
            const updateChunks = (s: Session | null, sessionType: string) => {
                if (!s) {
                    // Не логируем для currentSession после остановки - это нормально
                    return s;
                }
                if (s.id !== msg.sessionId) {
                    return s;
                }
                const updated = {
                    ...s,
                    chunks: s.chunks.map(c => {
                        if (c.id === msg.chunk.id) {
                            console.log('[SessionContext] 🔄 Updating chunk', c.index, 'in', sessionType, 'from status', c.status, 'to', msg.chunk.status);
                            return msg.chunk;
                        }
                        return c;
                    })
                };
                return updated;
            };
            
            setCurrentSession(prev => {
                const result = updateChunks(prev, 'currentSession');
                if (result && result !== prev) {
                    console.log('[SessionContext] 📝 currentSession updated, chunks:', result.chunks.length);
                }
                return result;
            });
            
            setSelectedSession(prev => {
                const result = updateChunks(prev, 'selectedSession');
                if (result && result !== prev) {
                    console.log('[SessionContext] 📝 selectedSession updated with transcription, chunks:', result.chunks.length);
                }
                return result;
            });
            
            // Удаляем из pending transcriptions
            setPendingTranscriptionChunks(prev => {
                const next = new Set(prev);
                next.delete(msg.chunk.id);
                return next;
            });
        });

        // Обработчик начала фоновой транскрипции (финальный чанк после stop)
        const unsubChunkTranscribing = subscribe('chunk_transcribing', (msg: any) => {
            setPendingTranscriptionChunks(prev => new Set(prev).add(msg.chunkId));
        });

        // ✅ Обработчик ошибки транскрипции чанка
        // Удаляем из pending чтобы не застревало уведомление о завершении
        const unsubChunkError = subscribe('chunk_error', (msg: any) => {
            console.log('[SessionContext] ❌ chunk_error:', msg.chunkId, msg.error);
            setPendingTranscriptionChunks(prev => {
                const next = new Set(prev);
                next.delete(msg.chunkId);
                return next;
            });
            // Обновляем статус чанка в сессии
            const updateChunkError = (session: Session | null) => {
                if (!session || session.id !== msg.sessionId) return session;
                return {
                    ...session,
                    chunks: session.chunks.map(c => 
                        c.id === msg.chunkId 
                            ? { ...c, status: 'error' as const, error: msg.error }
                            : c
                    )
                };
            };
            setCurrentSession(updateChunkError);
            setSelectedSession(updateChunkError);
        });

        const unsubAudioLevel = subscribe('audio_level', (msg: any) => {
            // Backend sends level already scaled 0-100
            setMicLevel(Math.min(msg.micLevel || 0, 100));
            setSysLevel(Math.min(msg.sysLevel || msg.systemLevel || 0, 100));
        });

        const unsubSummary = subscribe('summary_completed', (msg: any) => {
            console.log('[SessionContext] summary_completed received:', {
                sessionId: msg.sessionId,
                hasSummary: !!msg.summary,
                summaryLength: msg.summary?.length || 0
            });
            
            if (msg.summary && msg.sessionId) {
                // Summary received directly from command return value
                setSelectedSession(prev => {
                    if (!prev || prev.id !== msg.sessionId) return prev;
                    console.log('[SessionContext] Updating session with summary:', msg.summary.length, 'chars');
                    return { ...prev, summary: msg.summary };
                });
            } else if (msg.sessionId) {
                // Fallback: if summary is empty (legacy event), fetch the session
                console.log('[SessionContext] Summary empty in event, fetching session data...');
                sendMessage({ type: 'get_session', sessionId: msg.sessionId });
            }
        });

        const unsubImprove = subscribe('improve_completed', (msg: any) => {
            if (msg.session) setSelectedSession(msg.session);
        });

        const unsubRenamed = subscribe('session_renamed', (msg: any) => {
            // Обновляем название в selectedSession
            setSelectedSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                return { ...prev, title: msg.data };
            });
            // Также обновляем в списке сессий
            setSessions(prev => prev.map(s =>
                s.id === msg.sessionId
                    ? { ...s, title: msg.data }
                    : s
            ));
        });

        // Обработчик обновления названия сессии (новый API)
        const unsubTitleUpdated = subscribe('session_title_updated', (msg: any) => {
            // Обновляем название в selectedSession
            setSelectedSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                return { ...prev, title: msg.title };
            });
            // Также обновляем в списке сессий
            setSessions(prev => prev.map(s =>
                s.id === msg.sessionId
                    ? { ...s, title: msg.title }
                    : s
            ));
        });
        
        // Обработчик обновления тегов сессии
        const unsubTagsUpdated = subscribe('session_tags_updated', (msg: any) => {
            // Обновляем теги в selectedSession
            setSelectedSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                return { ...prev, tags: msg.tags };
            });
            // Также обновляем в списке сессий
            setSessions(prev => prev.map(s =>
                s.id === msg.sessionId
                    ? { ...s, tags: msg.tags }
                    : s
            ));
        });

        // Обработчик toggle exclude для чанков
        const unsubChunkExcludeToggled = subscribe('chunk_exclude_toggled', (msg: any) => {
            console.log('[SessionContext] chunk_exclude_toggled:', msg.chunkId, 'excluded:', msg.excluded);
            // Обновляем excluded в selectedSession
            setSelectedSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                return {
                    ...prev,
                    chunks: prev.chunks.map(c =>
                        c.id === msg.chunkId
                            ? { ...c, excluded: msg.excluded }
                            : c
                    )
                };
            });
            // Также обновляем в currentSession если активна запись
            setCurrentSession(prev => {
                if (!prev || prev.id !== msg.sessionId) return prev;
                return {
                    ...prev,
                    chunks: prev.chunks.map(c =>
                        c.id === msg.chunkId
                            ? { ...c, excluded: msg.excluded }
                            : c
                    )
                };
            });
        });

        // Full transcription events
        const unsubFullStarted = subscribe('full_transcription_started', (msg: any) => {
            setIsFullTranscribing(true);
            setFullTranscriptionProgress(0);
            setFullTranscriptionStatus('Начало полной транскрипции...');
            setFullTranscriptionError(null);
            setFullTranscriptionSessionId(msg.sessionId || null);
        });

        const unsubFullProgress = subscribe('full_transcription_progress', (msg: any) => {
            setFullTranscriptionProgress(msg.progress || 0);
            setFullTranscriptionStatus(msg.data || null);
        });

        const unsubFullCompleted = subscribe('full_transcription_completed', (msg: any) => {
            setIsFullTranscribing(false);
            setFullTranscriptionProgress(1);
            setFullTranscriptionStatus(null);
            setFullTranscriptionError(null);
            setFullTranscriptionSessionId(null);
            // Обновляем сессию с новыми данными
            if (msg.session) {
                setSelectedSession(msg.session);
            }
        });

        const unsubFullError = subscribe('full_transcription_error', (msg: any) => {
            setIsFullTranscribing(false);
            setFullTranscriptionProgress(0);
            setFullTranscriptionStatus(null);
            setFullTranscriptionError(msg.error || 'Неизвестная ошибка');
            setFullTranscriptionSessionId(null);
        });

        const unsubFullCancelled = subscribe('full_transcription_cancelled', () => {
            setIsFullTranscribing(false);
            setFullTranscriptionProgress(0);
            setFullTranscriptionStatus(null);
            setFullTranscriptionError(null);
            setFullTranscriptionSessionId(null);
        });

        return () => {
            unsubList(); unsubStarted(); unsubStopped(); unsubFinalizing(); unsubRecordingCompleted(); unsubDetails();
            unsubChunkCreated(); unsubChunkTranscribed(); unsubChunkTranscribing(); unsubChunkError();
            unsubAudioLevel(); unsubSummary(); unsubImprove(); unsubRenamed();
            unsubTitleUpdated(); unsubTagsUpdated(); unsubChunkExcludeToggled();
            unsubFullStarted(); unsubFullProgress(); unsubFullCompleted();
            unsubFullError(); unsubFullCancelled();
        };
    }, [subscribe, sendMessage]);

    const startSession = async (config: any) => {
        // Request microphone permission first (triggers macOS permission dialog)
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Stop the stream immediately - we just needed to trigger permission
            stream.getTracks().forEach(track => track.stop());
            console.log('[SessionContext] Microphone permission granted');
        } catch (err) {
            console.error('[SessionContext] Microphone permission denied:', err);
            // Continue anyway - backend will handle the error if permission is not granted
        }
        
        sendMessage({ type: 'start_session', ...config });
    };

    const stopSession = () => {
        // Prevent multiple calls
        if (isStopping || !isRecording) {
            console.log('[SessionContext] stopSession: already stopping or not recording');
            return;
        }
        console.log('[SessionContext] stopSession: stopping recording');
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

    const generateSummary = (sessionId: string, model: string, url: string, contextSize?: number) => {
        sendMessage({ 
            type: 'generate_summary', 
            sessionId, 
            ollamaModel: model, 
            ollamaUrl: url,
            ollamaContextSize: contextSize || 8 // default 8k
        });
    };

    const improveTranscription = (sessionId: string, model: string, url: string) => {
        sendMessage({ type: 'improve_transcription', sessionId, ollamaModel: model, ollamaUrl: url });
    };

    const cancelFullTranscription = () => {
        sendMessage({ type: 'cancel_full_transcription' });
    };

    const toggleChunkExclude = (sessionId: string, chunkId: string) => {
        sendMessage({ type: 'toggle_chunk_exclude', sessionId, chunkId });
    };

    return (
        <SessionContext.Provider value={{
            sessions, currentSession, selectedSession, isRecording, isStopping,
            isFinalizing, finalizingMessage,
            micLevel, sysLevel,
            // Pending background transcription state
            pendingTranscriptionChunks, isProcessingFinalChunks,
            // Full retranscription state
            isFullTranscribing, fullTranscriptionProgress, fullTranscriptionStatus,
            fullTranscriptionError, fullTranscriptionSessionId,
            // Actions
            startSession, stopSession, deleteSession, selectSession,
            generateSummary, improveTranscription, cancelFullTranscription,
            toggleChunkExclude,
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
