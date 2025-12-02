import { useState, useEffect, useRef, useCallback } from 'react';
import ModelManager from './components/ModelManager';
import SessionTabs, { TabType } from './components/SessionTabs';
import SummaryView from './components/SummaryView';
import { ModelState, AppSettings, OllamaModel } from './types/models';

// Electron IPC
const electron = typeof window !== 'undefined' && (window as any).require ? (window as any).require('electron') : null;
const ipcRenderer = electron?.ipcRenderer;

interface AudioDevice {
    id: string;
    name: string;
    isInput: boolean;
    isOutput: boolean;
}

// Сегмент транскрипции с таймстемпами
interface TranscriptSegment {
    start: number;    // миллисекунды
    end: number;      // миллисекунды
    text: string;
    speaker: 'mic' | 'sys';
}

interface Chunk {
    id: string;
    sessionId: string;
    index: number;
    duration: number;
    status: 'pending' | 'transcribing' | 'completed' | 'failed';
    transcription?: string;
    micText?: string;      // Транскрипция микрофона (Вы)
    sysText?: string;      // Транскрипция системного звука (Собеседник)
    micSegments?: TranscriptSegment[];  // Сегменты микрофона
    sysSegments?: TranscriptSegment[];  // Сегменты системного звука
    dialogue?: TranscriptSegment[];     // Объединённый диалог
    createdAt: string;
    error?: string;
    filePath?: string;
    micFilePath?: string;  // Путь к файлу микрофона
    sysFilePath?: string;  // Путь к файлу системного звука
    isStereo?: boolean;    // Флаг стерео режима
}

interface Session {
    id: string;
    startTime: string;
    endTime?: string;
    status: 'recording' | 'completed' | 'failed';
    language: string;
    model: string;
    totalDuration: number;
    chunks: Chunk[];
    summary?: string;  // AI-generated summary
}

interface SessionInfo {
    id: string;
    startTime: string;
    status: string;
    totalDuration: number;
    chunksCount: number;
}

// Форматирование времени MM:SS
const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

// Форматирование даты
const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('ru-RU', { 
        day: '2-digit', 
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
};

// Electron IPC для открытия папки с записями
const openDataFolder = async () => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('open-data-folder');
        if (!result.success) {
            console.error('Failed to open data folder:', result.error);
        }
    } catch (err) {
        console.error('Failed to open data folder:', err);
    }
};

// Звуковой сигнал "пип" при начале записи (Web Audio API)
const playBeep = (frequency: number = 800, duration: number = 150, volume: number = 0.3) => {
    try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration / 1000);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + duration / 1000);
    } catch (err) {
        console.error('Failed to play beep:', err);
    }
};

function App() {
    const [logs, setLogs] = useState<string[]>([]);
    const [status, setStatus] = useState('Disconnected');
    const [language, setLanguage] = useState<'ru' | 'en' | 'auto'>('ru');
    const wsRef = useRef<WebSocket | null>(null);
    
    // Audio levels
    const [micLevel, setMicLevel] = useState(0);
    const [systemLevel, setSystemLevel] = useState(0);
    
    // Recording state
    const [isRecording, setIsRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const [currentSession, setCurrentSession] = useState<Session | null>(null);
    const recordingStartRef = useRef<number | null>(null);
    
    // Sessions list
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);

    // Devices
    const [devices, setDevices] = useState<AudioDevice[]>([]);
    const [micDevice, setMicDevice] = useState<string>('');
    const [captureSystem, setCaptureSystem] = useState(true);
    const [screenCaptureKitAvailable, setScreenCaptureKitAvailable] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [echoCancel, setEchoCancel] = useState(0.4); // Эхоподавление 0-1
    const [useVoiceIsolation, setUseVoiceIsolation] = useState(true); // Voice Isolation (macOS 15+)

    // Audio player
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [playingAudio, setPlayingAudio] = useState<string | null>(null);

    // Share menu
    const [showShareMenu, setShowShareMenu] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);

    // Highlight chunk after retranscription
    const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);
    
    // Track if new chunk was added (for auto-scroll during recording only)
    const [shouldAutoScroll, setShouldAutoScroll] = useState(false);

    // Model Manager
    const [showModelManager, setShowModelManager] = useState(false);
    const [models, setModels] = useState<ModelState[]>([]);
    const [activeModelId, setActiveModelId] = useState<string | null>(null);
    const [settingsLoaded, setSettingsLoaded] = useState(false);

    // Session Tabs & Summary
    const [activeTab, setActiveTab] = useState<TabType>('dialogue');
    const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
    const [summaryError, setSummaryError] = useState<string | null>(null);

    // Ollama settings
    const [ollamaModel, setOllamaModel] = useState('llama3.2');
    const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
    const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
    const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
    const [ollamaError, setOllamaError] = useState<string | null>(null);

    // UI state
    const [isStopping, setIsStopping] = useState(false); // Индикатор остановки записи
    const [consoleExpanded, setConsoleExpanded] = useState(false); // Сворачиваемая консоль

    const transcriptionRef = useRef<HTMLDivElement | null>(null);

    const addLog = useCallback((msg: string) => {
        const time = new Date().toLocaleTimeString();
        setLogs(prev => [`[${time}] ${msg}`, ...prev].slice(0, 100));
    }, []);

    // Загрузка настроек при старте
    useEffect(() => {
        const loadSettings = async () => {
            if (!ipcRenderer) return;
            try {
                const settings: AppSettings | null = await ipcRenderer.invoke('load-settings');
                if (settings) {
                    setLanguage(settings.language || 'ru');
                    setActiveModelId(settings.modelId || 'ggml-large-v3-turbo');
                    setEchoCancel(settings.echoCancel ?? 0.4);
                    setUseVoiceIsolation(settings.useVoiceIsolation ?? true);
                    setCaptureSystem(settings.captureSystem ?? true);
                    setOllamaModel(settings.ollamaModel || 'llama3.2');
                    setOllamaUrl(settings.ollamaUrl || 'http://localhost:11434');
                    addLog('Settings loaded');
                }
                setSettingsLoaded(true);
            } catch (err) {
                console.error('Failed to load settings:', err);
                setSettingsLoaded(true);
            }
        };
        loadSettings();
    }, [addLog]);

    // Сохранение настроек при изменении
    useEffect(() => {
        if (!settingsLoaded || !ipcRenderer) return;
        const saveSettings = async () => {
            try {
                await ipcRenderer.invoke('save-settings', {
                    language,
                    modelId: activeModelId,
                    echoCancel,
                    useVoiceIsolation,
                    captureSystem,
                    ollamaModel,
                    ollamaUrl
                });
            } catch (err) {
                console.error('Failed to save settings:', err);
            }
        };
        saveSettings();
    }, [language, activeModelId, echoCancel, useVoiceIsolation, captureSystem, ollamaModel, ollamaUrl, settingsLoaded]);

    // Таймер записи
    useEffect(() => {
        let interval: NodeJS.Timeout | null = null;
        
        if (isRecording) {
            recordingStartRef.current = Date.now();
            interval = setInterval(() => {
                if (recordingStartRef.current) {
                    setRecordingDuration(Math.floor((Date.now() - recordingStartRef.current) / 1000));
                }
            }, 1000);
        } else {
            setRecordingDuration(0);
            recordingStartRef.current = null;
        }
        
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [isRecording]);

    // WebSocket connection
    useEffect(() => {
        let reconnectTimeout: NodeJS.Timeout;

        const connect = () => {
            const socket = new WebSocket('ws://localhost:8080/ws');

            socket.onopen = () => {
                setStatus('Connected');
                addLog('Connected to backend');
                socket.send(JSON.stringify({ type: 'get_devices' }));
                socket.send(JSON.stringify({ type: 'get_sessions' }));
                socket.send(JSON.stringify({ type: 'get_models' }));
            };

            socket.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    
                    switch (msg.type) {
                        case 'devices':
                            setDevices(msg.devices || []);
                            setScreenCaptureKitAvailable(msg.screenCaptureKitAvailable || false);
                            if (msg.screenCaptureKitAvailable) {
                                setCaptureSystem(true);
                            }
                            break;

                        case 'sessions_list':
                            setSessions(msg.sessions || []);
                            break;

                        case 'session_started':
                            setCurrentSession(msg.session);
                            setIsRecording(true);
                            playBeep(800, 150, 0.3); // Звуковой сигнал начала записи
                            addLog(`Session started: ${msg.session.id.substring(0, 8)}...`);
                            break;

                        case 'session_stopped':
                            setIsRecording(false);
                            setIsStopping(false); // Сбрасываем индикатор остановки
                            setCurrentSession(null);
                            addLog('Session stopped');
                            // Обновляем список сессий и открываем последнюю
                            socket.send(JSON.stringify({ type: 'get_sessions' }));
                            // Открываем только что записанную сессию
                            if (msg.session) {
                                setSelectedSession(msg.session);
                            }
                            break;

                        case 'chunk_created':
                            addLog(`Chunk ${msg.chunk.index} created (${(msg.chunk.duration / 1000000000).toFixed(1)}s)`);
                            setCurrentSession(prev => {
                                if (!prev || prev.id !== msg.sessionId) return prev;
                                return { ...prev, chunks: [...prev.chunks, msg.chunk] };
                            });
                            // Автоскролл только при создании нового чанка во время записи
                            setShouldAutoScroll(true);
                            break;

                        case 'chunk_transcribed':
                            const text = msg.chunk.transcription || '';
                            addLog(`Chunk ${msg.chunk.index}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
                            
                            // Обновляем текущую сессию
                            setCurrentSession(prev => {
                                if (!prev || prev.id !== msg.sessionId) return prev;
                                const chunks = prev.chunks.map(c => c.id === msg.chunk.id ? msg.chunk : c);
                                return { ...prev, chunks };
                            });
                            
                            // Автоскролл при получении транскрипции во время записи
                            if (isRecording) {
                                setShouldAutoScroll(true);
                            }
                            
                            // Обновляем выбранную сессию и подсвечиваем чанк
                            setSelectedSession(prev => {
                                if (!prev || prev.id !== msg.sessionId) return prev;
                                const chunks = prev.chunks.map(c => c.id === msg.chunk.id ? msg.chunk : c);
                                return { ...prev, chunks };
                            });
                            
                            // Подсвечиваем перетранскрибированный чанк (мигание)
                            setHighlightedChunkId(msg.chunk.id);
                            setTimeout(() => setHighlightedChunkId(null), 2000);
                            break;

                        case 'session_details':
                            setSelectedSession(msg.session);
                            break;

                        case 'audio_level':
                            setMicLevel(Math.min((msg.micLevel || 0) * 500, 100));
                            setSystemLevel(Math.min((msg.systemLevel || 0) * 500, 100));
                            break;

                        case 'error':
                            addLog(`Error: ${msg.data}`);
                            break;

                        case 'status':
                            // Статус операций (например, установка faster-whisper)
                            addLog(`Status: ${msg.data}`);
                            break;

                        // === Model Management ===
                        case 'models_list':
                            setModels(msg.models || []);
                            // Найти активную модель
                            const active = (msg.models || []).find((m: ModelState) => m.status === 'active');
                            if (active) {
                                setActiveModelId(active.id);
                            }
                            break;

                        case 'model_progress':
                            setModels(prev => prev.map(m => 
                                m.id === msg.modelId 
                                    ? { ...m, status: msg.data as any, progress: msg.progress, error: msg.error }
                                    : m
                            ));
                            break;

                        case 'download_started':
                            addLog(`Downloading model: ${msg.modelId}`);
                            break;

                        case 'download_cancelled':
                            addLog(`Download cancelled: ${msg.modelId}`);
                            // Обновляем список моделей
                            socket.send(JSON.stringify({ type: 'get_models' }));
                            break;

                        case 'model_deleted':
                            addLog(`Model deleted: ${msg.modelId}`);
                            break;

                        case 'active_model_changed':
                            setActiveModelId(msg.modelId);
                            addLog(`Active model: ${msg.modelId}`);
                            break;

                        // === Summary Generation ===
                        case 'summary_started':
                            setIsGeneratingSummary(true);
                            setSummaryError(null);
                            addLog('Generating summary...');
                            break;

                        case 'summary_completed':
                            setIsGeneratingSummary(false);
                            setSummaryError(null);
                            // Обновляем summary в выбранной сессии
                            setSelectedSession(prev => {
                                if (!prev || prev.id !== msg.sessionId) return prev;
                                return { ...prev, summary: msg.summary };
                            });
                            addLog('Summary generated');
                            break;

                        case 'summary_error':
                            setIsGeneratingSummary(false);
                            setSummaryError(msg.error || 'Unknown error');
                            addLog(`Summary error: ${msg.error}`);
                            break;

                        // === Ollama Models ===
                        case 'ollama_models':
                            setOllamaModelsLoading(false);
                            if (msg.error) {
                                setOllamaError(msg.error);
                                setOllamaModels([]);
                            } else {
                                setOllamaError(null);
                                setOllamaModels(msg.ollamaModels || []);
                                // Если текущая модель не в списке, выбираем первую cloud или первую доступную
                                const modelNames = (msg.ollamaModels || []).map((m: OllamaModel) => m.name);
                                if (modelNames.length > 0 && !modelNames.includes(ollamaModel)) {
                                    const cloudModel = (msg.ollamaModels || []).find((m: OllamaModel) => m.isCloud);
                                    setOllamaModel(cloudModel?.name || modelNames[0]);
                                }
                            }
                            break;
                    }
                } catch {
                    // Ignore JSON errors
                }
            };

            socket.onclose = () => {
                setStatus('Disconnected');
                setIsRecording(false);
                addLog('Disconnected. Reconnecting in 3s...');
                wsRef.current = null;
                reconnectTimeout = setTimeout(connect, 3000);
            };

            socket.onerror = (error) => {
                console.error('WebSocket error:', error);
            };

            wsRef.current = socket;
        };

        connect();

        return () => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.close();
            }
            clearTimeout(reconnectTimeout);
        };
    }, [addLog]);

    const handleStartStop = () => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            addLog('WebSocket not connected');
            return;
        }

        if (isRecording) {
            setIsStopping(true); // Показываем индикатор остановки
            ws.send(JSON.stringify({ type: 'stop_session' }));
        } else {
            // Очищаем выбранную сессию и закрываем share menu при начале новой записи
            setSelectedSession(null);
            setShowShareMenu(false);
            setActiveTab('dialogue'); // Сбрасываем на вкладку диалога
            
            // Получаем путь к активной модели
            const activeModel = models.find(m => m.id === activeModelId);
            const modelPath = activeModel?.path || '';
            
            if (!modelPath && activeModelId) {
                addLog('Модель не скачана. Откройте менеджер моделей для скачивания.');
                setShowModelManager(true);
                return;
            }
            
            ws.send(JSON.stringify({
                type: 'start_session',
                language,
                model: modelPath,
                micDevice,
                captureSystem,
                useNativeCapture: screenCaptureKitAvailable && captureSystem,
                useVoiceIsolation: screenCaptureKitAvailable && captureSystem && useVoiceIsolation,
                echoCancel: captureSystem && !useVoiceIsolation ? echoCancel : 0
            }));
        }
    };

    const handleViewSession = (sessionId: string) => {
        wsRef.current?.send(JSON.stringify({ type: 'get_session', sessionId }));
    };

    const handleDeleteSession = (sessionId: string) => {
        if (confirm('Удалить эту запись?')) {
            wsRef.current?.send(JSON.stringify({ type: 'delete_session', sessionId }));
            setSessions(prev => prev.filter(s => s.id !== sessionId));
            if (selectedSession?.id === sessionId) {
                setSelectedSession(null);
            }
        }
    };

    const handleRetranscribe = (chunkId: string) => {
        if (!selectedSession) return;
        
        // Получаем путь к активной модели
        const activeModel = models.find(m => m.id === activeModelId);
        const modelPath = activeModel?.path || '';
        
        wsRef.current?.send(JSON.stringify({
            type: 'retranscribe_chunk',
            sessionId: selectedSession.id,
            data: chunkId,
            model: modelPath,
            language: language
        }));
        addLog(`Retranscribing chunk with model: ${activeModel?.name || 'default'}, language: ${language}`);
    };

    // Загрузка списка моделей Ollama
    const loadOllamaModels = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        
        setOllamaModelsLoading(true);
        setOllamaError(null);
        wsRef.current.send(JSON.stringify({
            type: 'get_ollama_models',
            ollamaUrl: ollamaUrl
        }));
    }, [ollamaUrl]);

    // Генерация summary
    const handleGenerateSummary = useCallback(() => {
        if (!selectedSession) return;
        
        wsRef.current?.send(JSON.stringify({
            type: 'generate_summary',
            sessionId: selectedSession.id,
            ollamaModel: ollamaModel,
            ollamaUrl: ollamaUrl
        }));
    }, [selectedSession, ollamaModel, ollamaUrl]);

    // Воспроизведение аудио
    const playAudio = (url: string) => {
        if (audioRef.current) {
            if (playingAudio === url) {
                audioRef.current.pause();
                audioRef.current.currentTime = 0;
                setPlayingAudio(null);
            } else {
                audioRef.current.src = url;
                audioRef.current.play();
                setPlayingAudio(url);
            }
        }
    };

    const playFullRecording = (sessionId: string) => {
        playAudio(`http://localhost:8080/api/sessions/${sessionId}/full.mp3`);
    };

    const playChunk = (sessionId: string, chunkIndex: number) => {
        // Используем новый API для воспроизведения конкретного чанка
        playAudio(`http://localhost:8080/api/sessions/${sessionId}/chunk/${chunkIndex}.mp3`);
    };

    const handleAudioEnded = () => {
        setPlayingAudio(null);
    };

    // Генерация полного текста транскрипции
    const generateFullText = useCallback((session: Session): string => {
        const sessionChunks = session.chunks || [];
        
        // Собираем диалог
        const dialogue: TranscriptSegment[] = sessionChunks
            .filter(c => c.status === 'completed')
            .sort((a, b) => a.index - b.index)
            .flatMap((c) => {
                if (c.dialogue && c.dialogue.length > 0) {
                    const chunkOffset = sessionChunks
                        .filter(prev => prev.index < c.index)
                        .reduce((sum, prev) => sum + (prev.duration / 1000000), 0);
                    
                    return c.dialogue.map(seg => ({
                        ...seg,
                        start: seg.start + chunkOffset,
                        end: seg.end + chunkOffset
                    }));
                }
                return [];
            });

        // Если есть диалог с сегментами
        if (dialogue.length > 0) {
            const header = `Транскрипция записи от ${formatDate(session.startTime)}\nДлительность: ${formatDuration(session.totalDuration / 1000)}\n${'='.repeat(50)}\n\n`;
            
            const dialogueText = dialogue.map(seg => {
                const startSec = Math.floor(seg.start / 1000);
                const mins = Math.floor(startSec / 60);
                const secs = startSec % 60;
                const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                const speaker = seg.speaker === 'mic' ? 'Вы' : 'Собеседник';
                return `[${timeStr}] ${speaker}: ${seg.text}`;
            }).join('\n\n');

            return header + dialogueText;
        }

        // Fallback: старый формат
        const fallbackText = sessionChunks
            .filter(c => c.status === 'completed' && (c.transcription || c.micText || c.sysText))
            .sort((a, b) => a.index - b.index)
            .map(c => {
                if (c.micText || c.sysText) {
                    const parts = [];
                    if (c.micText) parts.push(`Вы: ${c.micText}`);
                    if (c.sysText) parts.push(`Собеседник: ${c.sysText}`);
                    return parts.join('\n');
                }
                return c.transcription;
            })
            .join('\n\n');

        if (fallbackText) {
            return `Транскрипция записи от ${formatDate(session.startTime)}\nДлительность: ${formatDuration(session.totalDuration / 1000)}\n${'='.repeat(50)}\n\n${fallbackText}`;
        }

        return 'Нет транскрипции';
    }, []);

    // Копирование в буфер обмена
    const handleCopyToClipboard = useCallback(async () => {
        if (!selectedSession) return;
        
        const text = generateFullText(selectedSession);
        
        try {
            await navigator.clipboard.writeText(text);
            setCopySuccess(true);
            setShowShareMenu(false);
            addLog('Текст скопирован в буфер обмена');
            
            setTimeout(() => setCopySuccess(false), 2000);
        } catch (err) {
            addLog('Ошибка копирования в буфер');
            console.error('Copy failed:', err);
        }
    }, [selectedSession, generateFullText, addLog]);

    // Скачивание как файл
    const handleDownloadFile = useCallback(() => {
        if (!selectedSession) return;
        
        const text = generateFullText(selectedSession);
        const date = new Date(selectedSession.startTime);
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.toTimeString().slice(0, 5).replace(':', '-');
        const filename = `transcription_${dateStr}_${timeStr}.txt`;
        
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        setShowShareMenu(false);
        addLog(`Файл ${filename} скачан`);
    }, [selectedSession, generateFullText, addLog]);

    // Автоскролл только при создании новых чанков во время записи
    useEffect(() => {
        if (shouldAutoScroll && transcriptionRef.current) {
            transcriptionRef.current.scrollTo({
                top: transcriptionRef.current.scrollHeight,
                behavior: 'smooth'
            });
            setShouldAutoScroll(false);
        }
    }, [shouldAutoScroll]);

    // Закрытие share меню при клике вне его
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (showShareMenu && !target.closest('[data-share-menu]')) {
                setShowShareMenu(false);
            }
        };
        
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, [showShareMenu]);

    const inputDevices = devices.filter(d => d.isInput);
    const displaySession = selectedSession || currentSession;
    const chunks = displaySession?.chunks || [];

    // Собираем полный диалог из всех чанков
    const allDialogue: TranscriptSegment[] = chunks
        .filter(c => c.status === 'completed')
        .sort((a, b) => a.index - b.index)
        .flatMap((c) => {
            // Если есть диалог с сегментами
            if (c.dialogue && c.dialogue.length > 0) {
                // Добавляем offset на основе предыдущих чанков
                const chunkOffset = chunks
                    .filter(prev => prev.index < c.index)
                    .reduce((sum, prev) => sum + (prev.duration / 1000000), 0); // duration в наносекундах -> мс
                
                return c.dialogue.map(seg => ({
                    ...seg,
                    start: seg.start + chunkOffset,
                    end: seg.end + chunkOffset
                }));
            }
            return [];
        });

    return (
        <div style={{ display: 'flex', height: '100vh', backgroundColor: '#0d0d1a', color: '#fff' }}>
            {/* Hidden audio element */}
            <audio ref={audioRef} onEnded={handleAudioEnded} style={{ display: 'none' }} />
            
            {/* Left Sidebar - Sessions List */}
            <aside style={{ 
                width: '280px', 
                backgroundColor: '#12121f', 
                borderRight: '1px solid #333',
                display: 'flex',
                flexDirection: 'column'
            }}>
                <div style={{ padding: '1rem', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2 style={{ margin: 0, fontSize: '1rem', color: '#888' }}>📁 Записи</h2>
                    <button
                        onClick={openDataFolder}
                        title="Открыть папку с записями"
                        style={{
                            padding: '0.3rem 0.5rem',
                            fontSize: '0.75rem',
                            backgroundColor: '#333',
                            color: '#888',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer'
                        }}
                    >
                        📂
                    </button>
                </div>
                
                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {sessions.length === 0 ? (
                        <div style={{ padding: '1rem', color: '#666', textAlign: 'center' }}>
                            Нет записей
                        </div>
                    ) : (
                        sessions.map(s => {
                            const isSelected = selectedSession?.id === s.id;
                            const isPlayingThis = playingAudio?.includes(s.id);
                            const durationSec = s.totalDuration / 1000; // ms to sec
                            
                            return (
                                <div 
                                    key={s.id} 
                                    style={{ 
                                        padding: '0.75rem 1rem',
                                        borderBottom: '1px solid #1a1a2e',
                                        backgroundColor: isSelected ? '#1a1a3e' : 'transparent',
                                        cursor: 'pointer'
                                    }}
                                    onClick={() => handleViewSession(s.id)}
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                                        <span style={{ fontSize: '0.85rem', color: '#ccc' }}>
                                            {formatDate(s.startTime)}
                                        </span>
                                        <span style={{ fontSize: '0.75rem', color: '#888' }}>
                                            {formatDuration(durationSec)}
                                        </span>
                                    </div>
                                    
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <span style={{ fontSize: '0.75rem', color: '#666' }}>
                                            {s.chunksCount} чанков
                                        </span>
                                        
                                        <div style={{ display: 'flex', gap: '0.3rem' }}>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); playFullRecording(s.id); }}
                                                style={{
                                                    padding: '0.2rem 0.5rem',
                                                    fontSize: '0.7rem',
                                                    backgroundColor: isPlayingThis ? '#f44336' : '#2196f3',
                                                    color: 'white',
                                                    border: 'none',
                                                    borderRadius: '3px',
                                                    cursor: 'pointer'
                                                }}
                                            >
                                                {isPlayingThis ? '⏹' : '▶'}
                                            </button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                                                style={{
                                                    padding: '0.2rem 0.5rem',
                                                    fontSize: '0.7rem',
                                                    backgroundColor: '#333',
                                                    color: '#f44336',
                                                    border: 'none',
                                                    borderRadius: '3px',
                                                    cursor: 'pointer'
                                                }}
                                            >
                                                🗑
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </aside>

            {/* Main Content */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                {/* Header - draggable для перемещения окна */}
                <header style={{ 
                    padding: '0.75rem 1.5rem', 
                    paddingLeft: '80px', // Отступ для кнопок управления окном macOS
                    borderBottom: '1px solid #333',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '1rem',
                    WebkitAppRegion: 'drag', // Позволяет перетаскивать окно
                    userSelect: 'none'
                } as React.CSSProperties}>
                    <h1 style={{ margin: 0, fontSize: '1.2rem', background: 'linear-gradient(135deg, #6c5ce7, #a29bfe)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>AIWisper</h1>
                    
                    <div style={{ 
                        padding: '0.2rem 0.6rem', 
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        backgroundColor: status === 'Connected' ? '#1b3d1b' : '#3d1b1b',
                        color: status === 'Connected' ? '#4caf50' : '#f44336'
                    }}>
                        {status}
                    </div>

                    {/* Recording Duration */}
                    {isRecording && (
                        <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '0.5rem',
                            padding: '0.3rem 0.8rem',
                            backgroundColor: '#3d1b1b',
                            borderRadius: '4px'
                        }}>
                            <span style={{ 
                                width: '8px', 
                                height: '8px', 
                                borderRadius: '50%', 
                                backgroundColor: '#f44336',
                                animation: 'pulse 1s infinite'
                            }}></span>
                            <span style={{ fontFamily: 'monospace', fontSize: '1rem', color: '#f44336' }}>
                                {formatDuration(recordingDuration)}
                            </span>
                        </div>
                    )}
                    
                    <div style={{ flex: 1 }}></div>
                    
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                        <select 
                            value={language} 
                            onChange={e => setLanguage(e.target.value as any)} 
                            style={{ padding: '0.3rem', backgroundColor: '#1a1a2e', color: '#fff', border: '1px solid #333', borderRadius: '4px' }}
                        >
                            <option value="ru">Русский</option>
                            <option value="en">English</option>
                            <option value="auto">Auto</option>
                        </select>
                        
                        <button 
                            onClick={() => setShowSettings(!showSettings)} 
                            style={{ padding: '0.3rem 0.6rem', backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: '4px', cursor: 'pointer' }}
                        >
                            ⚙️
                        </button>
                        
                        <button
                            onClick={handleStartStop}
                            disabled={status !== 'Connected' || isStopping}
                            style={{
                                padding: '0.5rem 1.5rem',
                                backgroundColor: isStopping ? '#ff9800' : isRecording ? '#f44336' : '#6c5ce7',
                                color: 'white',
                                border: 'none',
                                borderRadius: '8px',
                                fontWeight: 'bold',
                                cursor: (status === 'Connected' && !isStopping) ? 'pointer' : 'not-allowed',
                                opacity: status === 'Connected' ? 1 : 0.5,
                                boxShadow: isRecording ? '0 0 20px rgba(244, 67, 54, 0.4)' : '0 4px 15px rgba(108, 92, 231, 0.3)',
                                transition: 'all 0.3s ease'
                            }}
                        >
                            {isStopping ? '⏳ Сохранение...' : isRecording ? '⏹ Стоп' : '● Запись'}
                        </button>
                    </div>
                </header>

                {/* Settings Panel */}
                {showSettings && (
                    <div style={{ padding: '0.75rem 1.5rem', backgroundColor: '#1a1a2e', borderBottom: '1px solid #333' }}>
                        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span>🎤</span>
                                <select 
                                    value={micDevice} 
                                    onChange={e => setMicDevice(e.target.value)} 
                                    style={{ padding: '0.3rem', backgroundColor: '#12121f', color: '#fff', border: '1px solid #333', borderRadius: '4px' }}
                                >
                                    <option value="">Default</option>
                                    {inputDevices.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                                </select>
                            </div>
                            
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                                <input type="checkbox" checked={captureSystem} onChange={e => setCaptureSystem(e.target.checked)} />
                                <span>🔊 System Audio</span>
                                {captureSystem && screenCaptureKitAvailable && (
                                    <span style={{ fontSize: '0.7rem', color: '#4caf50', backgroundColor: '#1b3d1b', padding: '2px 6px', borderRadius: '3px' }}>
                                        Native
                                    </span>
                                )}
                            </label>

                            {/* Voice Isolation - встроенное эхоподавление macOS */}
                            {captureSystem && screenCaptureKitAvailable && (
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }} title="ВАЖНО: Разделение микрофона и системного звука для раздельной транскрибации (Вы/Собеседник). Использует встроенное эхоподавление и шумоподавление macOS (требует macOS 15+)">
                                    <input type="checkbox" checked={useVoiceIsolation} onChange={e => setUseVoiceIsolation(e.target.checked)} />
                                    <span style={{ fontSize: '0.85rem' }}>Voice Isolation</span>
                                    <span style={{ fontSize: '0.65rem', color: '#2196f3', backgroundColor: '#1a2a4e', padding: '2px 5px', borderRadius: '3px' }}>
                                        macOS 15+
                                    </span>
                                    <span style={{ fontSize: '0.65rem', color: '#4caf50', backgroundColor: '#1b3d1b', padding: '2px 5px', borderRadius: '3px', marginLeft: '0.2rem' }}>
                                        Раздельные каналы
                                    </span>
                                </label>
                            )}
                            
                            {/* Предупреждение если Voice Isolation недоступен */}
                            {captureSystem && !screenCaptureKitAvailable && (
                                <div style={{ 
                                    fontSize: '0.75rem', 
                                    color: '#ff9800', 
                                    backgroundColor: 'rgba(255, 152, 0, 0.1)', 
                                    padding: '4px 8px', 
                                    borderRadius: '4px',
                                    border: '1px solid rgba(255, 152, 0, 0.3)'
                                }}>
                                    ⚠️ Voice Isolation недоступен - транскрипция будет в моно режиме
                                </div>
                            )}
                            
                            {/* Кнопка выбора модели */}
                            <button
                                onClick={() => setShowModelManager(true)}
                                style={{
                                    padding: '0.3rem 0.6rem',
                                    backgroundColor: '#12121f',
                                    color: '#fff',
                                    border: '1px solid #333',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.3rem'
                                }}
                            >
                                <span>🤖</span>
                                <span>{models.find(m => m.id === activeModelId)?.name || 'Выбрать модель'}</span>
                                <span style={{ color: '#888', fontSize: '0.8rem' }}>▼</span>
                            </button>

                            {/* Эхоподавление (только если Voice Isolation выключен) */}
                            {captureSystem && !useVoiceIsolation && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <span style={{ fontSize: '0.8rem', color: '#888' }}>Echo:</span>
                                    <input 
                                        type="range" 
                                        min="0" 
                                        max="100" 
                                        value={echoCancel * 100}
                                        onChange={e => setEchoCancel(Number(e.target.value) / 100)}
                                        style={{ width: '80px', accentColor: '#2196f3' }}
                                        title={`Эхоподавление: ${Math.round(echoCancel * 100)}%`}
                                    />
                                    <span style={{ fontSize: '0.7rem', color: '#666', minWidth: '30px' }}>
                                        {Math.round(echoCancel * 100)}%
                                    </span>
                                </div>
                            )}
                        </div>
                        
                        {/* Ollama Settings for Summary */}
                        <div style={{ 
                            marginTop: '0.75rem', 
                            paddingTop: '0.75rem', 
                            borderTop: '1px solid #333',
                            display: 'flex', 
                            gap: '1rem', 
                            alignItems: 'center', 
                            flexWrap: 'wrap' 
                        }}>
                            <span style={{ fontSize: '0.85rem', color: '#888' }}>📋 Summary (Ollama):</span>
                            
                            {/* Выбор модели из списка */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{ fontSize: '0.8rem', color: '#666' }}>Модель:</span>
                                <select
                                    value={ollamaModel}
                                    onChange={e => setOllamaModel(e.target.value)}
                                    onFocus={loadOllamaModels}
                                    style={{ 
                                        padding: '0.3rem 0.5rem', 
                                        backgroundColor: '#12121f', 
                                        color: '#fff', 
                                        border: '1px solid #333', 
                                        borderRadius: '4px',
                                        minWidth: '180px',
                                        fontSize: '0.85rem',
                                        cursor: 'pointer'
                                    }}
                                    title="Выберите модель Ollama для генерации summary"
                                >
                                    {ollamaModelsLoading ? (
                                        <option value="">Загрузка...</option>
                                    ) : ollamaModels.length === 0 ? (
                                        <option value={ollamaModel}>{ollamaModel}</option>
                                    ) : (
                                        <>
                                            {ollamaModels.map(m => (
                                                <option key={m.name} value={m.name}>
                                                    {m.isCloud ? '☁️ ' : '💻 '}
                                                    {m.name}
                                                    {m.parameters ? ` (${m.parameters})` : ''}
                                                </option>
                                            ))}
                                        </>
                                    )}
                                </select>
                                <button
                                    onClick={loadOllamaModels}
                                    disabled={ollamaModelsLoading}
                                    style={{
                                        padding: '0.3rem 0.5rem',
                                        backgroundColor: '#333',
                                        color: '#888',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: ollamaModelsLoading ? 'wait' : 'pointer',
                                        fontSize: '0.8rem'
                                    }}
                                    title="Обновить список моделей"
                                >
                                    {ollamaModelsLoading ? '⏳' : '🔄'}
                                </button>
                            </div>
                            
                            {/* Ошибка Ollama */}
                            {ollamaError && (
                                <span style={{ 
                                    fontSize: '0.75rem', 
                                    color: '#f44336',
                                    backgroundColor: 'rgba(244, 67, 54, 0.1)',
                                    padding: '2px 6px',
                                    borderRadius: '3px'
                                }}>
                                    ⚠️ {ollamaError}
                                </span>
                            )}
                            
                            <a 
                                href="https://ollama.ai" 
                                target="_blank" 
                                rel="noopener noreferrer"
                                style={{ 
                                    fontSize: '0.75rem', 
                                    color: '#2196f3', 
                                    textDecoration: 'none' 
                                }}
                            >
                                Установить Ollama →
                            </a>
                        </div>
                    </div>
                )}

                {/* Audio Level Indicators */}
                <div style={{ padding: '0.5rem 1.5rem', backgroundColor: '#0d0d1a' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
                        <span style={{ fontSize: '0.75rem', color: '#888', minWidth: '70px' }}>🎤 Mic</span>
                        <div style={{ flex: 1, height: '8px', backgroundColor: '#1a1a2e', borderRadius: '4px', overflow: 'hidden' }}>
                            <div style={{ width: `${micLevel}%`, height: '100%', backgroundColor: '#4caf50', transition: 'width 0.05s' }}></div>
                        </div>
                    </div>
                    {captureSystem && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '0.75rem', color: '#888', minWidth: '70px' }}>🔊 System</span>
                            <div style={{ flex: 1, height: '8px', backgroundColor: '#1a1a2e', borderRadius: '4px', overflow: 'hidden' }}>
                                <div style={{ width: `${systemLevel}%`, height: '100%', backgroundColor: '#2196f3', transition: 'width 0.05s' }}></div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Transcription Area */}
                <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {/* Sticky Header: Session info + Tabs */}
                    {(selectedSession || isRecording) && (
                        <div style={{ 
                            flexShrink: 0,
                            backgroundColor: '#0d0d1a',
                            borderBottom: '1px solid #333',
                            padding: '0 1.5rem'
                        }}>
                    {selectedSession && !isRecording && (
                        <div style={{ 
                            marginBottom: '1rem', 
                            padding: '0.75rem', 
                            backgroundColor: '#1a1a2e', 
                            borderRadius: '6px', 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '1rem' 
                        }}>
                            <span style={{ color: '#888' }}>📄</span>
                            <span>{formatDate(selectedSession.startTime)}</span>
                            <span style={{ color: '#666' }}>•</span>
                            <span style={{ color: '#888' }}>{formatDuration(selectedSession.totalDuration / 1000)}</span>
                            
                            {/* Индикатор режима стерео/моно */}
                            {selectedSession.chunks.length > 0 && selectedSession.chunks[0].isStereo && (
                                <>
                                    <span style={{ color: '#666' }}>•</span>
                                    <span style={{ 
                                        fontSize: '0.7rem', 
                                        color: '#4caf50', 
                                        backgroundColor: '#1b3d1b', 
                                        padding: '2px 6px', 
                                        borderRadius: '3px' 
                                    }}>
                                        Стерео (раздельные каналы)
                                    </span>
                                </>
                            )}
                            
                            <button 
                                onClick={() => playFullRecording(selectedSession.id)} 
                                style={{ 
                                    padding: '0.3rem 0.8rem', 
                                    backgroundColor: playingAudio?.includes(selectedSession.id) ? '#f44336' : '#2196f3',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer'
                                }}
                            >
                                {playingAudio?.includes(selectedSession.id) ? '⏹ Стоп' : '▶ Слушать'}
                            </button>
                            
                            {/* Share button with dropdown */}
                            <div style={{ position: 'relative' }} data-share-menu>
                                <button 
                                    onClick={() => setShowShareMenu(!showShareMenu)} 
                                    style={{ 
                                        padding: '0.3rem 0.8rem', 
                                        backgroundColor: copySuccess ? '#4caf50' : '#6c5ce7',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.3rem'
                                    }}
                                >
                                    {copySuccess ? '✓ Скопировано' : '📤 Поделиться'}
                                </button>
                                
                                {showShareMenu && (
                                    <div style={{
                                        position: 'absolute',
                                        top: '100%',
                                        left: 0,
                                        marginTop: '0.3rem',
                                        backgroundColor: '#1a1a2e',
                                        border: '1px solid #333',
                                        borderRadius: '6px',
                                        overflow: 'hidden',
                                        zIndex: 100,
                                        minWidth: '180px',
                                        boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
                                    }}>
                                        <button
                                            onClick={handleCopyToClipboard}
                                            style={{
                                                width: '100%',
                                                padding: '0.6rem 1rem',
                                                backgroundColor: 'transparent',
                                                border: 'none',
                                                color: '#fff',
                                                cursor: 'pointer',
                                                textAlign: 'left',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.5rem'
                                            }}
                                            onMouseEnter={e => e.currentTarget.style.backgroundColor = '#2a2a4e'}
                                            onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                                        >
                                            📋 Копировать текст
                                        </button>
                                        <button
                                            onClick={handleDownloadFile}
                                            style={{
                                                width: '100%',
                                                padding: '0.6rem 1rem',
                                                backgroundColor: 'transparent',
                                                border: 'none',
                                                borderTop: '1px solid #333',
                                                color: '#fff',
                                                cursor: 'pointer',
                                                textAlign: 'left',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.5rem'
                                            }}
                                            onMouseEnter={e => e.currentTarget.style.backgroundColor = '#2a2a4e'}
                                            onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                                        >
                                            💾 Скачать файл .txt
                                        </button>
                                    </div>
                                )}
                            </div>
                            
                            <div style={{ flex: 1 }}></div>
                            
                            <button 
                                onClick={() => { setSelectedSession(null); setShowShareMenu(false); setActiveTab('dialogue'); }} 
                                style={{ padding: '0.3rem 0.6rem', backgroundColor: '#333', border: 'none', borderRadius: '4px', color: '#888', cursor: 'pointer' }}
                            >
                                ✕
                            </button>
                        </div>
                    )}

                    {/* Session Tabs - показываем только если есть сессия */}
                    {displaySession && chunks.length > 0 && (
                        <SessionTabs
                            activeTab={activeTab}
                            onTabChange={setActiveTab}
                            hasSummary={!!displaySession.summary}
                            isGeneratingSummary={isGeneratingSummary}
                            isRecording={isRecording}
                        />
                    )}
                        </div>
                    )}

                    {/* Scrollable Content Area */}
                    <div ref={transcriptionRef} style={{ flex: 1, padding: '1rem 1.5rem', overflowY: 'auto' }}>
                    {chunks.length === 0 && !isRecording && !selectedSession ? (
                        <div style={{ color: '#666', textAlign: 'center', marginTop: '3rem' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🎙</div>
                            <div>Нажмите «Запись» чтобы начать</div>
                        </div>
                    ) : chunks.length === 0 && isRecording ? (
                        <div style={{ color: '#666', textAlign: 'center', marginTop: '3rem' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔴</div>
                            <div>Идёт запись... Транскрипция появится после остановки</div>
                        </div>
                    ) : (
                        <>
                            {/* Tab: Dialogue */}
                            {activeTab === 'dialogue' && (
                                <>
                                    {/* Full dialogue with timestamps */}
                                    {allDialogue.length > 0 ? (
                                <div style={{ 
                                    marginBottom: '1.5rem', 
                                    padding: '1rem', 
                                    backgroundColor: '#1a1a2e', 
                                    borderRadius: '8px', 
                                    lineHeight: '1.8',
                                    fontSize: '0.95rem'
                                }}>
                                    <h4 style={{ margin: '0 0 1rem 0', color: '#888', fontSize: '0.9rem' }}>Диалог</h4>
                                    {allDialogue.map((seg, idx) => {
                                        const isMic = seg.speaker === 'mic';
                                        const totalMs = seg.start;
                                        const mins = Math.floor(totalMs / 60000);
                                        const secs = Math.floor((totalMs % 60000) / 1000);
                                        const ms = Math.floor((totalMs % 1000) / 100); // десятые доли секунды
                                        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;
                                        
                                        return (
                                            <div key={idx} style={{ 
                                                marginBottom: '0.6rem',
                                                borderLeft: isMic ? '3px solid #4caf50' : '3px solid #2196f3',
                                                paddingLeft: '0.75rem',
                                                backgroundColor: isMic ? 'rgba(76, 175, 80, 0.05)' : 'rgba(33, 150, 243, 0.05)',
                                                padding: '0.4rem 0.75rem',
                                                borderRadius: '0 4px 4px 0'
                                            }}>
                                                <div style={{ marginBottom: '0.2rem' }}>
                                                    <span style={{ 
                                                        color: '#555', 
                                                        fontSize: '0.75rem',
                                                        marginRight: '0.5rem',
                                                        fontFamily: 'monospace'
                                                    }}>
                                                        {timeStr}
                                                    </span>
                                                    <span style={{ 
                                                        color: isMic ? '#4caf50' : '#2196f3',
                                                        fontSize: '0.8rem',
                                                        fontWeight: 'bold'
                                                    }}>
                                                        {isMic ? 'Вы' : 'Собеседник'}
                                                    </span>
                                                </div>
                                                <div style={{ color: '#ddd' }}>
                                                    {seg.text}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                // Fallback: показываем чанки по отдельности
                                <div style={{ 
                                    marginBottom: '1.5rem', 
                                    padding: '1rem', 
                                    backgroundColor: '#1a1a2e', 
                                    borderRadius: '8px', 
                                    lineHeight: '1.8',
                                    fontSize: '0.95rem'
                                }}>
                                    {chunks
                                        .filter(c => c.status === 'completed')
                                        .sort((a, b) => a.index - b.index)
                                        .map((chunk) => {
                                            // Если есть разделение на mic/sys
                                            if (chunk.micText || chunk.sysText) {
                                                return (
                                                    <div key={chunk.id} style={{ marginBottom: '1rem' }}>
                                                        {chunk.micText && (
                                                            <div style={{ 
                                                                marginBottom: '0.5rem',
                                                                borderLeft: '3px solid #4caf50',
                                                                paddingLeft: '0.75rem',
                                                                backgroundColor: 'rgba(76, 175, 80, 0.05)',
                                                                padding: '0.4rem 0.75rem',
                                                                borderRadius: '0 4px 4px 0'
                                                            }}>
                                                                <span style={{ color: '#4caf50', fontWeight: 'bold', fontSize: '0.85rem' }}>Вы: </span>
                                                                <span style={{ color: '#ddd' }}>{chunk.micText}</span>
                                                            </div>
                                                        )}
                                                        {chunk.sysText && (
                                                            <div style={{ 
                                                                borderLeft: '3px solid #2196f3',
                                                                paddingLeft: '0.75rem',
                                                                backgroundColor: 'rgba(33, 150, 243, 0.05)',
                                                                padding: '0.4rem 0.75rem',
                                                                borderRadius: '0 4px 4px 0'
                                                            }}>
                                                                <span style={{ color: '#2196f3', fontWeight: 'bold', fontSize: '0.85rem' }}>Собеседник: </span>
                                                                <span style={{ color: '#ddd' }}>{chunk.sysText}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            }
                                            // Моно режим - просто текст
                                            if (chunk.transcription) {
                                                return (
                                                    <div key={chunk.id} style={{ 
                                                        marginBottom: '0.8rem',
                                                        padding: '0.5rem 0.75rem',
                                                        backgroundColor: 'rgba(255, 255, 255, 0.03)',
                                                        borderRadius: '4px',
                                                        color: '#ccc'
                                                    }}>
                                                        {chunk.transcription}
                                                    </div>
                                                );
                                            }
                                            return null;
                                        })}
                                    {chunks.filter(c => c.status === 'completed').length === 0 && (
                                        <div style={{ color: '#666', textAlign: 'center', padding: '2rem' }}>
                                            Транскрипция обрабатывается...
                                        </div>
                                    )}
                                </div>
                            )}
                                </>
                            )}

                            {/* Tab: Chunks */}
                            {activeTab === 'chunks' && (
                            <div style={{ fontSize: '0.85rem' }}>
                                <h4 style={{ margin: '0 0 0.75rem 0', color: '#888' }}>Чанки ({chunks.length})</h4>
                                {chunks.map(chunk => {
                                    // Аудио чанков извлекается через chunk API
                                    const chunkAudioUrl = displaySession ? 
                                        `http://localhost:8080/api/sessions/${displaySession.id}/chunk/${chunk.index}.mp3` : '';
                                    const isPlaying = playingAudio === chunkAudioUrl;
                                    const isHighlighted = highlightedChunkId === chunk.id;
                                    
                                    return (
                                        <div key={chunk.id} style={{ 
                                            padding: '0.6rem 0.8rem', 
                                            marginBottom: '0.4rem', 
                                            backgroundColor: isHighlighted ? '#1a3a2a' : '#12121f', 
                                            borderRadius: '4px',
                                            borderLeft: `3px solid ${chunk.status === 'completed' ? '#4caf50' : chunk.status === 'failed' ? '#f44336' : '#ff9800'}`,
                                            transition: 'background-color 0.3s ease',
                                            animation: isHighlighted ? 'highlight-pulse 0.5s ease-in-out 2' : 'none'
                                        }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                                                <span style={{ color: '#888' }}>
                                                    #{chunk.index} • {(chunk.duration / 1000000000).toFixed(1)}s • 
                                                    <span style={{ 
                                                        marginLeft: '0.3rem',
                                                        color: chunk.status === 'completed' ? '#4caf50' : chunk.status === 'failed' ? '#f44336' : '#ff9800'
                                                    }}>
                                                        {chunk.status === 'completed' ? '✓' : chunk.status === 'failed' ? '✗' : '⏳'}
                                                    </span>
                                                </span>
                                                <div style={{ display: 'flex', gap: '0.3rem' }}>
                                                    {displaySession && (
                                                        <button 
                                                            onClick={() => playChunk(displaySession.id, chunk.index)}
                                                            style={{ 
                                                                padding: '0.15rem 0.4rem', 
                                                                fontSize: '0.7rem',
                                                                backgroundColor: isPlaying ? '#f44336' : '#2196f3',
                                                                color: 'white',
                                                                border: 'none',
                                                                borderRadius: '3px',
                                                                cursor: 'pointer'
                                                            }}
                                                        >
                                                            {isPlaying ? '⏹' : '▶'}
                                                        </button>
                                                    )}
                                                    {selectedSession && (chunk.status === 'completed' || chunk.status === 'transcribing' || chunk.status === 'failed') && (
                                                        <button 
                                                            onClick={() => handleRetranscribe(chunk.id)} 
                                                            title="Повторить транскрипцию"
                                                            style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem', backgroundColor: '#333', border: 'none', borderRadius: '3px', color: '#888', cursor: 'pointer' }}
                                                        >
                                                            🔄
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                            {/* Диалог с таймстемпами */}
                                            {chunk.dialogue && chunk.dialogue.length > 0 ? (
                                                <div style={{ marginTop: '0.4rem', lineHeight: '1.6' }}>
                                                    {chunk.dialogue.map((seg, idx) => {
                                                        const isMic = seg.speaker === 'mic';
                                                        const totalMs = seg.start;
                                                        const mins = Math.floor(totalMs / 60000);
                                                        const secs = Math.floor((totalMs % 60000) / 1000);
                                                        const ms = Math.floor((totalMs % 1000) / 100);
                                                        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;
                                                        
                                                        return (
                                                            <div key={idx} style={{ 
                                                                marginBottom: '0.4rem',
                                                                borderLeft: isMic ? '2px solid #4caf50' : '2px solid #2196f3',
                                                                paddingLeft: '0.5rem'
                                                            }}>
                                                                <span style={{ 
                                                                    color: '#666', 
                                                                    fontSize: '0.7rem',
                                                                    marginRight: '0.5rem',
                                                                    fontFamily: 'monospace'
                                                                }}>
                                                                    {timeStr}
                                                                </span>
                                                                <span style={{ 
                                                                    color: isMic ? '#4caf50' : '#2196f3',
                                                                    fontSize: '0.8rem',
                                                                    fontWeight: 'bold'
                                                                }}>
                                                                    {isMic ? 'Вы' : 'Собеседник'}:
                                                                </span>
                                                                <span style={{ color: '#ccc', marginLeft: '0.3rem' }}>
                                                                    {seg.text}
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : (chunk.micText || chunk.sysText) ? (
                                                // Fallback: старый формат без сегментов
                                                <div style={{ marginTop: '0.4rem', lineHeight: '1.5' }}>
                                                    {chunk.micText && (
                                                        <div style={{ color: '#4caf50', marginBottom: '0.3rem' }}>
                                                            <span style={{ color: '#888', fontSize: '0.8rem' }}>Вы: </span>
                                                            {chunk.micText}
                                                        </div>
                                                    )}
                                                    {chunk.sysText && (
                                                        <div style={{ color: '#2196f3' }}>
                                                            <span style={{ color: '#888', fontSize: '0.8rem' }}>Собеседник: </span>
                                                            {chunk.sysText}
                                                        </div>
                                                    )}
                                                </div>
                                            ) : chunk.transcription && (
                                                <div style={{ marginTop: '0.4rem', color: '#ccc', lineHeight: '1.5' }}>{chunk.transcription}</div>
                                            )}
                                            {chunk.error && (
                                                <div style={{ marginTop: '0.4rem', color: '#f44336', fontSize: '0.8rem' }}>Ошибка: {chunk.error}</div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            )}

                            {/* Tab: Summary */}
                            {activeTab === 'summary' && displaySession && (
                                <SummaryView
                                    summary={displaySession.summary || null}
                                    isGenerating={isGeneratingSummary}
                                    error={summaryError}
                                    onGenerate={handleGenerateSummary}
                                    hasTranscription={chunks.some(c => c.status === 'completed' && (c.transcription || c.micText || c.sysText || c.dialogue?.length))}
                                    sessionDate={displaySession.startTime}
                                />
                            )}
                        </>
                    )}
                    </div>
                </main>

                {/* Console - сворачиваемая */}
                <footer style={{ 
                    height: consoleExpanded ? '150px' : '32px', 
                    borderTop: '1px solid #333', 
                    backgroundColor: '#0a0a14',
                    transition: 'height 0.2s ease-out',
                    overflow: 'hidden'
                }}>
                    <div 
                        onClick={() => setConsoleExpanded(!consoleExpanded)}
                        style={{ 
                            padding: '0.3rem 1rem', 
                            backgroundColor: '#12121f', 
                            fontSize: '0.75rem', 
                            color: '#666',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            userSelect: 'none'
                        }}
                    >
                        <span>
                            {consoleExpanded ? '▼' : '▶'} Console
                            {!consoleExpanded && logs.length > 0 && (
                                <span style={{ marginLeft: '0.5rem', color: '#444' }}>
                                    — {logs[0]?.substring(0, 50)}{logs[0]?.length > 50 ? '...' : ''}
                                </span>
                            )}
                        </span>
                        <span style={{ fontSize: '0.65rem', color: '#444' }}>{logs.length} записей</span>
                    </div>
                    {consoleExpanded && (
                        <div style={{ padding: '0.5rem 1rem', overflowY: 'auto', height: 'calc(100% - 28px)', fontSize: '0.7rem', fontFamily: 'monospace' }}>
                            {logs.map((log, i) => <div key={i} style={{ color: '#555' }}>{log}</div>)}
                        </div>
                    )}
                </footer>
            </div>

            {/* CSS for pulse animation */}
            <style>{`
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
                @keyframes highlight-pulse {
                    0% { background-color: #12121f; }
                    50% { background-color: #2a4a3a; }
                    100% { background-color: #1a3a2a; }
                }
            `}</style>

            {/* Model Manager Modal */}
            {showModelManager && (
                <ModelManager
                    models={models}
                    activeModelId={activeModelId}
                    onDownload={(modelId) => {
                        wsRef.current?.send(JSON.stringify({ type: 'download_model', modelId }));
                    }}
                    onCancelDownload={(modelId) => {
                        wsRef.current?.send(JSON.stringify({ type: 'cancel_download', modelId }));
                    }}
                    onDelete={(modelId) => {
                        if (confirm('Удалить эту модель?')) {
                            wsRef.current?.send(JSON.stringify({ type: 'delete_model', modelId }));
                        }
                    }}
                    onSetActive={(modelId) => {
                        wsRef.current?.send(JSON.stringify({ type: 'set_active_model', modelId }));
                    }}
                    onClose={() => setShowModelManager(false)}
                />
            )}
        </div>
    );
}

export default App;
