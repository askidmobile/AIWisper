import { useState, useEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import ModelManager from './components/ModelManager';
import SessionTabs, { TabType } from './components/SessionTabs';
import SummaryView from './components/SummaryView';
import SettingsModal from './components/SettingsModal';
import AudioMeterSidebar from './components/AudioMeterSidebar';
import WaveformDisplay from './components/WaveformDisplay';
import SpeakersTab from './components/modules/SpeakersTab';
import { ModelState, AppSettings, OllamaModel } from './types/models';
import { SessionSpeaker } from './types/voiceprint';
import { WaveformData, computeWaveform } from './utils/waveform';
import { groupSessionsByTime, formatDuration as formatDurationUtil, formatDate as formatDateUtil, formatTime as formatTimeUtil } from './utils/groupSessions';
import { createGrpcSocket, RPC_READY_STATE, RpcSocketLike } from './utils/grpcStream';

const API_BASE = `http://localhost:${process.env.AIWISPER_HTTP_PORT || 18080}`;

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
    startMs?: number;
    endMs?: number;
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
    title?: string;
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
    title?: string;
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

// Цвета для разных спикеров
const SPEAKER_COLORS = ['#2196f3', '#e91e63', '#ff9800', '#9c27b0', '#00bcd4', '#8bc34a'];

// Определение имени и цвета спикера
const getSpeakerInfo = (speaker?: string): { name: string; color: string } => {
    if (speaker === 'mic') {
        return { name: 'Вы', color: '#4caf50' };
    } else if (speaker?.startsWith('Speaker ')) {
        // Speaker 0 -> Собеседник 1
        const speakerNum = parseInt(speaker.replace('Speaker ', ''), 10);
        return {
            name: `Собеседник ${speakerNum + 1}`,
            color: SPEAKER_COLORS[speakerNum % SPEAKER_COLORS.length]
        };
    } else if (speaker === 'sys') {
        return { name: 'Собеседник', color: '#2196f3' };
    } else {
        return { name: speaker || 'Собеседник', color: '#2196f3' };
    }
};

const extractSessionIdFromUrl = (url: string): string | null => {
    const match = url.match(/sessions\/([a-f0-9\-]{36})/i);
    return match ? match[1] : null;
};

// Приводим длительность к секундам, поддерживая миллисекунды (списки сессий) и наносекунды (детали сессии)
const normalizeDurationSeconds = (value?: number | string | null): number => {
    const normalizeNumber = (num: number) => {
        if (!Number.isFinite(num) || num <= 0) return 0;
        if (num > 1e11) return num / 1e9;  // наносекунды -> секунды
        if (num > 1e6) return num / 1e3;   // миллисекунды -> секунды
        return num;                        // уже секунды
    };

    if (typeof value === 'number') return normalizeNumber(value);

    if (typeof value === 'string') {
        const numeric = Number(value);
        if (!Number.isNaN(numeric)) return normalizeNumber(numeric);

        // Парсим строку формата go duration, например "1h2m3.5s"
        const regex = /(-?\d+(?:\.\d+)?)(ns|µs|us|ms|s|m|h)/g;
        let match: RegExpExecArray | null;
        let totalSeconds = 0;

        while ((match = regex.exec(value)) !== null) {
            const amount = Number(match[1]);
            const unit = match[2];
            if (Number.isNaN(amount)) continue;

            switch (unit) {
                case 'ns':
                    totalSeconds += amount / 1e9;
                    break;
                case 'µs':
                case 'us':
                    totalSeconds += amount / 1e6;
                    break;
                case 'ms':
                    totalSeconds += amount / 1e3;
                    break;
                case 's':
                    totalSeconds += amount;
                    break;
                case 'm':
                    totalSeconds += amount * 60;
                    break;
                case 'h':
                    totalSeconds += amount * 3600;
                    break;
                default:
                    break;
            }
        }

        return totalSeconds;
    }

    return 0;
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
    const wsRef = useRef<RpcSocketLike | null>(null);

    // Audio levels
    const [micLevel, setMicLevel] = useState(0);
    const [systemLevel, setSystemLevel] = useState(0);

    // Recording state
    const [isRecording, setIsRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const [currentSession, setCurrentSession] = useState<Session | null>(null);
    const recordingStartRef = useRef<number | null>(null);
    const [recordingWave, setRecordingWave] = useState<number[]>(Array(24).fill(0.3));
    const waveAnimationRef = useRef<number | null>(null);

    // Sessions list
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);

    // Session Speakers (for VoicePrint integration)
    const [sessionSpeakers, setSessionSpeakers] = useState<SessionSpeaker[]>([]);

    // Devices
    const [devices, setDevices] = useState<AudioDevice[]>([]);
    const [micDevice, setMicDevice] = useState<string>('');
    const [captureSystem, setCaptureSystem] = useState(true);
    const [vadMode, setVADMode] = useState<'auto' | 'compression' | 'per-region' | 'off'>('auto');
    const [screenCaptureKitAvailable, setScreenCaptureKitAvailable] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [echoCancel, setEchoCancel] = useState(0.4); // Эхоподавление 0-1
    const [useVoiceIsolation, setUseVoiceIsolation] = useState(false); // Voice Isolation (macOS 15+)
    const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');


    // Audio player
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [playingAudio, setPlayingAudio] = useState<string | null>(null);
    const [playbackTime, setPlaybackTime] = useState(0);
    const [playbackDuration, setPlaybackDuration] = useState(0);
    const [playbackOffset, setPlaybackOffset] = useState(0);
    const [playbackMicLevel, setPlaybackMicLevel] = useState(0);
    const [playbackSysLevel, setPlaybackSysLevel] = useState(0);
    const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
    const [spectrogramStatus, setSpectrogramStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [spectrogramError, setSpectrogramError] = useState<string | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserLeftRef = useRef<AnalyserNode | null>(null);
    const analyserRightRef = useRef<AnalyserNode | null>(null);
    const audioSourceConnectedRef = useRef<boolean>(false);
    const playbackRafRef = useRef<number | null>(null);
    const progressTickerRef = useRef<number | null>(null);
    const leftTimeDataRef = useRef<Float32Array | null>(null);
    const rightTimeDataRef = useRef<Float32Array | null>(null);
    const playbackLevelSlicesRef = useRef<{ mic: number[]; sys: number[]; sliceDuration: number; duration: number; sessionId?: string } | null>(null);
    const playbackOffsetRef = useRef(0);
    const lastPlaybackTimeRef = useRef(0);
    const spectrogramSessionIdRef = useRef<string | null>(null);

    // Share menu
    const [showShareMenu, setShowShareMenu] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);

    // Delete confirmation modal
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // Highlight chunk during and after retranscription
    const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);
    const [transcribingChunkId, setTranscribingChunkId] = useState<string | null>(null);

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

    // Full transcription state
    const [isFullTranscribing, setIsFullTranscribing] = useState(false);
    const [fullTranscriptionProgress, setFullTranscriptionProgress] = useState(0);
    const [fullTranscriptionStatus, setFullTranscriptionStatus] = useState<string | null>(null);
    const [fullTranscriptionError, setFullTranscriptionError] = useState<string | null>(null);
    const [isCancellingTranscription, setIsCancellingTranscription] = useState(false);

    // AI improvement state
    const [isImproving, setIsImproving] = useState(false);
    const [improveError, setImproveError] = useState<string | null>(null);
    
    // AI diarization state (разбивка по собеседникам через LLM)
    const [isDiarizing, setIsDiarizing] = useState(false);
    const [diarizeError, setDiarizeError] = useState<string | null>(null);

    // Diarization state
    const [diarizationEnabled, setDiarizationEnabled] = useState(false);
    const [diarizationProvider, setDiarizationProvider] = useState('');
    const [diarizationLoading, setDiarizationLoading] = useState(false);
    const [diarizationError, setDiarizationError] = useState<string | null>(null);
    // Сохранённые настройки диаризации (для авто-включения)
    const [savedDiarizationSegModelId, setSavedDiarizationSegModelId] = useState<string>('');
    const [savedDiarizationEmbModelId, setSavedDiarizationEmbModelId] = useState<string>('');
    const [savedDiarizationProvider, setSavedDiarizationProvider] = useState<string>('auto');
    const [savedDiarizationEnabled, setSavedDiarizationEnabled] = useState(false);
    const diarizationAutoEnableAttempted = useRef(false);

    const transcriptionRef = useRef<HTMLDivElement | null>(null);

    // Refs для доступа к актуальным значениям в callbacks
    const modelsRef = useRef(models);
    const activeModelIdRef = useRef(activeModelId);
    const languageRef = useRef(language);

    // Обновляем refs при изменении состояния
    useEffect(() => { modelsRef.current = models; }, [models]);
    useEffect(() => { activeModelIdRef.current = activeModelId; }, [activeModelId]);
    useEffect(() => { languageRef.current = language; }, [language]);

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
                    setUseVoiceIsolation(settings.useVoiceIsolation ?? false);
                    setVADMode(settings.vadMode || 'auto');
                    setCaptureSystem(settings.captureSystem ?? true);
                    setOllamaModel(settings.ollamaModel || 'llama3.2');
                    setOllamaUrl(settings.ollamaUrl || 'http://localhost:11434');
                    setTheme((settings as any).theme || 'dark');
                    // Загружаем настройки диаризации
                    if (settings.diarizationEnabled !== undefined) {
                        setSavedDiarizationEnabled(settings.diarizationEnabled);
                    }
                    if (settings.diarizationSegModelId) {
                        setSavedDiarizationSegModelId(settings.diarizationSegModelId);
                    }
                    if (settings.diarizationEmbModelId) {
                        setSavedDiarizationEmbModelId(settings.diarizationEmbModelId);
                    }
                    if (settings.diarizationProvider) {
                        setSavedDiarizationProvider(settings.diarizationProvider);
                    }
                    addLog('Settings loaded');
                    if (settings.diarizationEnabled) {
                        addLog(`Diarization settings: enabled=${settings.diarizationEnabled}, seg=${settings.diarizationSegModelId}, emb=${settings.diarizationEmbModelId}`);
                    }
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
                    vadMode,
                    captureSystem,
                    ollamaModel,
                    ollamaUrl,
                    theme,
                    // Сохраняем настройки диаризации
                    diarizationEnabled: savedDiarizationEnabled,
                    diarizationSegModelId: savedDiarizationSegModelId,
                    diarizationEmbModelId: savedDiarizationEmbModelId,
                    diarizationProvider: savedDiarizationProvider
                });
            } catch (err) {
                console.error('Failed to save settings:', err);
            }
        };
        saveSettings();
    }, [language, activeModelId, echoCancel, useVoiceIsolation, vadMode, captureSystem, ollamaModel, ollamaUrl, theme, settingsLoaded, savedDiarizationEnabled, savedDiarizationSegModelId, savedDiarizationEmbModelId, savedDiarizationProvider]);

    // Применяем тему к корню документа
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        document.body.setAttribute('data-theme', theme);
    }, [theme]);

    const spectrogramTargetSessionId = selectedSession?.id || (playingAudio ? extractSessionIdFromUrl(playingAudio) : null);

    useEffect(() => {
        const targetId = spectrogramTargetSessionId;
        if (!targetId) {
            spectrogramSessionIdRef.current = null;
            setWaveformData(null);
            setSpectrogramStatus('idle');
            setSpectrogramError(null);
            playbackLevelSlicesRef.current = null;
            return;
        }

        if (spectrogramSessionIdRef.current === targetId && waveformData) return;

        let cancelled = false;
        setSpectrogramStatus('loading');
        setSpectrogramError(null);

        const loadSpectrogram = async () => {
            try {
                const url = `${API_BASE}/api/sessions/${targetId}/full.mp3`;
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const arr = await resp.arrayBuffer();
                if (cancelled) return;

                const ctx = new AudioContext();
                const decoded = await ctx.decodeAudioData(arr);
                if (cancelled) {
                    ctx.close();
                    return;
                }

                const waveform = computeWaveform(decoded);
                ctx.close();
                if (!cancelled) {
                    setWaveformData(waveform);
                    spectrogramSessionIdRef.current = targetId;
                    setSpectrogramStatus('ready');
                }
            } catch (err) {
                if (cancelled) return;
                console.error('Failed to build waveform', err);
                setWaveformData(null);
                spectrogramSessionIdRef.current = null;
                setSpectrogramStatus('error');
                setSpectrogramError(err instanceof Error ? err.message : String(err));
            }
        };

        loadSpectrogram();

        return () => { cancelled = true; };
    }, [spectrogramTargetSessionId]);

    useEffect(() => {
        if (!waveformData) {
            playbackLevelSlicesRef.current = null;
            return;
        }
        // Use absolute RMS values for VU meter (not normalized peaks)
        const mic = waveformData.rmsAbsolute?.[0] || waveformData.peaks[0] || [];
        const sys = waveformData.rmsAbsolute?.[1] || waveformData.rmsAbsolute?.[0] || waveformData.peaks[1] || mic;
        playbackLevelSlicesRef.current = {
            mic,
            sys,
            sliceDuration: waveformData.sampleDuration,
            duration: waveformData.duration,
            sessionId: spectrogramSessionIdRef.current || undefined
        };
    }, [waveformData]);

    useEffect(() => {
        playbackOffsetRef.current = playbackOffset;
    }, [playbackOffset]);

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

    // Recording waveform animation
    useEffect(() => {
        if (!isRecording) {
            setRecordingWave(Array(24).fill(0.3));
            return;
        }

        const animate = () => {
            setRecordingWave(prev => prev.map((_, i) => {
                const base = 0.3 + Math.sin(Date.now() / 180 + i * 0.6) * 0.2;
                const random = Math.random() * 0.35;
                return Math.min(1, Math.max(0.15, base + random));
            }));
            waveAnimationRef.current = requestAnimationFrame(animate);
        };
        animate();

        return () => {
            if (waveAnimationRef.current) {
                cancelAnimationFrame(waveAnimationRef.current);
            }
        };
    }, [isRecording]);

    // gRPC (WebSocket-like) connection
    useEffect(() => {
        let reconnectTimeout: NodeJS.Timeout;

        const resolveGrpcAddress = async (): Promise<string | undefined> => {
            const envAddr = process.env.AIWISPER_GRPC_ADDR;
            if (envAddr && envAddr.trim().length > 0) {
                return envAddr;
            }
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { ipcRenderer } = require('electron');
                if (ipcRenderer?.invoke) {
                    const addr = await ipcRenderer.invoke('get-grpc-address');
                    if (addr && typeof addr === 'string' && addr.trim().length > 0) {
                        return addr as string;
                    }
                }
            } catch {
                // ignore and fallback
            }
            return undefined;
        };

        const connect = async () => {
            const addr = await resolveGrpcAddress();
            if (!addr) {
                console.error('gRPC address is not available');
                reconnectTimeout = setTimeout(connect, 3000);
                return;
            }

            const socket = createGrpcSocket(addr);

            socket.onopen = () => {
                setStatus('Connected');
                addLog(`Connected to backend (gRPC ${addr})`);
                socket.send(JSON.stringify({ type: 'get_devices' }));
                socket.send(JSON.stringify({ type: 'get_sessions' }));
                socket.send(JSON.stringify({ type: 'get_models' }));
                socket.send(JSON.stringify({ type: 'get_diarization_status' }));
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

                        case 'session_deleted':
                            // Удаляем сессию из списка
                            setSessions(prev => prev.filter(s => s.id !== msg.sessionId));
                            addLog(`Session deleted: ${msg.sessionId?.substring(0, 8)}...`);
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

                            // Сбрасываем индикатор транскрипции
                            setTranscribingChunkId(prev => prev === msg.chunk.id ? null : prev);

                            // Подсвечиваем перетранскрибированный чанк (мигание)
                            setHighlightedChunkId(msg.chunk.id);
                            setTimeout(() => setHighlightedChunkId(null), 2000);

                            // Обновляем список спикеров после транскрипции (если есть диаризация)
                            if (msg.sessionId && msg.chunk.dialogue?.some((d: { speaker?: string }) => d.speaker && d.speaker.startsWith('Собеседник'))) {
                                wsRef.current?.send(JSON.stringify({ type: 'get_session_speakers', sessionId: msg.sessionId }));
                            }
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
                            } else {
                                // Если backend не имеет активной модели, но у нас есть сохранённая - синхронизируем
                                const savedModelId = activeModelIdRef.current;
                                if (savedModelId) {
                                    const savedModel = (msg.models || []).find((m: ModelState) => m.id === savedModelId);
                                    // Проверяем, что модель скачана
                                    if (savedModel && savedModel.status === 'downloaded') {
                                        console.log('Syncing saved active model to backend:', savedModelId);
                                        socket.send(JSON.stringify({ type: 'set_active_model', modelId: savedModelId }));
                                    }
                                }
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

                        // === Full Transcription ===
                        case 'full_transcription_started':
                            setIsFullTranscribing(true);
                            setFullTranscriptionProgress(0);
                            setFullTranscriptionStatus('Начало полной транскрипции...');
                            setFullTranscriptionError(null);
                            addLog('Full transcription started');
                            break;

                        case 'full_transcription_progress':
                            setFullTranscriptionProgress(msg.progress || 0);
                            setFullTranscriptionStatus(msg.data || null);
                            break;

                        case 'full_transcription_completed':
                            setIsFullTranscribing(false);
                            setFullTranscriptionProgress(1);
                            setFullTranscriptionStatus(null);
                            setFullTranscriptionError(null);
                            // Обновляем сессию с новыми данными
                            if (msg.session) {
                                setSelectedSession(msg.session);
                                // Запрашиваем обновлённый список спикеров после ретранскрипции
                                wsRef.current?.send(JSON.stringify({ type: 'get_session_speakers', sessionId: msg.session.id }));
                            }
                            addLog('Full transcription completed');
                            break;

                        case 'full_transcription_error':
                            setIsFullTranscribing(false);
                            setFullTranscriptionProgress(0);
                            setFullTranscriptionStatus(null);
                            setFullTranscriptionError(msg.error || 'Unknown error');
                            addLog(`Full transcription error: ${msg.error}`);
                            break;

                        case 'full_transcription_cancelled':
                            setIsFullTranscribing(false);
                            setFullTranscriptionProgress(0);
                            setFullTranscriptionStatus(null);
                            setFullTranscriptionError(null);
                            setIsCancellingTranscription(false);
                            addLog('Full transcription cancelled');
                            break;

                        // === AI Improvement ===
                        case 'improve_started':
                            setIsImproving(true);
                            setImproveError(null);
                            addLog('AI improvement started');
                            break;

                        case 'improve_completed':
                            setIsImproving(false);
                            setImproveError(null);
                            if (msg.session) {
                                setSelectedSession(msg.session);
                            }
                            addLog('AI improvement completed');
                            break;

                        case 'improve_error':
                            setIsImproving(false);
                            setImproveError(msg.error || 'Unknown error');
                            addLog(`AI improvement error: ${msg.error}`);
                            break;

                        // === AI Diarization (через LLM) ===
                        case 'diarize_started':
                            setIsDiarizing(true);
                            setDiarizeError(null);
                            addLog('AI diarization started');
                            break;

                        case 'diarize_completed':
                            setIsDiarizing(false);
                            setDiarizeError(null);
                            if (msg.session) {
                                setSelectedSession(msg.session);
                            }
                            addLog('AI diarization completed');
                            break;

                        case 'diarize_error':
                            setIsDiarizing(false);
                            setDiarizeError(msg.error || 'Unknown error');
                            addLog(`AI diarization error: ${msg.error}`);
                            break;

                        // === Diarization ===
                        case 'diarization_enabled':
                            setDiarizationEnabled(true);
                            setDiarizationProvider(msg.diarizationProvider || 'cpu');
                            setDiarizationLoading(false);
                            setDiarizationError(null);
                            addLog(`Diarization enabled (${msg.diarizationProvider || 'cpu'})`);
                            break;

                        case 'diarization_disabled':
                            setDiarizationEnabled(false);
                            setDiarizationProvider('');
                            setDiarizationLoading(false);
                            addLog('Diarization disabled');
                            break;

                        case 'diarization_status':
                            setDiarizationEnabled(msg.diarizationEnabled || false);
                            setDiarizationProvider(msg.diarizationProvider || '');
                            break;

                        case 'diarization_error':
                            setDiarizationLoading(false);
                            setDiarizationError(msg.error || 'Unknown diarization error');
                            addLog(`Diarization error: ${msg.error}`);
                            break;

                        // === Session Speakers (VoicePrint) ===
                        case 'session_speakers':
                            setSessionSpeakers(msg.speakers || []);
                            addLog(`Session speakers loaded: ${(msg.speakers || []).length}`);
                            break;

                        case 'speaker_renamed':
                            // Обновляем имя спикера в локальном состоянии
                            setSessionSpeakers(prev => prev.map(s =>
                                s.localId === msg.localId
                                    ? { ...s, displayName: msg.newName, isRecognized: msg.savedAsVoiceprint || s.isRecognized }
                                    : s
                            ));
                            addLog(`Speaker renamed: ${msg.newName}`);
                            break;

                        case 'voiceprint_saved':
                            addLog(`Voiceprint saved: ${msg.name} (${msg.voiceprintId?.substring(0, 8)}...)`);
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
                console.error('gRPC stream error:', error, 'addr=', addr);
            };

            wsRef.current = socket;
        };

        connect();

        return () => {
            if (wsRef.current && wsRef.current.readyState === RPC_READY_STATE.OPEN) {
                wsRef.current.close();
            }
            clearTimeout(reconnectTimeout);
        };
    }, [addLog]);

    // Автоматическое включение диаризации при старте, если была включена ранее
    useEffect(() => {
        // Проверяем условия для авто-включения
        if (!settingsLoaded) return;
        if (!savedDiarizationEnabled) return;
        if (diarizationAutoEnableAttempted.current) return;
        if (!savedDiarizationSegModelId || !savedDiarizationEmbModelId) return;
        if (models.length === 0) return;
        if (status !== 'Connected') return;

        // Находим модели
        const segModel = models.find(m => m.id === savedDiarizationSegModelId);
        const embModel = models.find(m => m.id === savedDiarizationEmbModelId);

        if (!segModel || !embModel) {
            console.log('[Diarization] Auto-enable skipped: models not found in registry');
            return;
        }

        // Проверяем что модели скачаны
        const segReady = segModel.status === 'downloaded' || segModel.status === 'active';
        const embReady = embModel.status === 'downloaded' || embModel.status === 'active';

        if (!segReady || !embReady) {
            console.log('[Diarization] Auto-enable skipped: models not downloaded', { segStatus: segModel.status, embStatus: embModel.status });
            return;
        }

        if (!segModel.path || !embModel.path) {
            console.log('[Diarization] Auto-enable skipped: model paths missing');
            return;
        }

        // Отмечаем что попытка была
        diarizationAutoEnableAttempted.current = true;

        console.log('[Diarization] Auto-enabling with saved settings:', {
            segModelId: savedDiarizationSegModelId,
            embModelId: savedDiarizationEmbModelId,
            provider: savedDiarizationProvider
        });
        addLog(`Auto-enabling diarization (${savedDiarizationProvider})...`);

        setDiarizationLoading(true);
        setDiarizationError(null);

        wsRef.current?.send(JSON.stringify({
            type: 'enable_diarization',
            segmentationModelPath: segModel.path,
            embeddingModelPath: embModel.path,
            diarizationProvider: savedDiarizationProvider
        }));
    }, [settingsLoaded, savedDiarizationEnabled, savedDiarizationSegModelId, savedDiarizationEmbModelId, savedDiarizationProvider, models, status, addLog]);

    const handleStartStop = () => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== RPC_READY_STATE.OPEN) {
            addLog('gRPC channel not connected');
            return;
        }

        if (isRecording) {
            setIsStopping(true); // Показываем индикатор остановки
            ws.send(JSON.stringify({ type: 'stop_session' }));
        } else {
            // Очищаем выбранную сессию и закрываем share menu при начале новой записи
            setSelectedSession(null);
            setSessionSpeakers([]);  // Очищаем спикеров при начале новой записи
            setShowShareMenu(false);
            setActiveTab('dialogue'); // Сбрасываем на вкладку диалога

            // Получаем активную модель
            const activeModel = models.find(m => m.id === activeModelId);
            const modelId = activeModel?.id || activeModelId;

            console.log('handleStartStop: activeModelId=', activeModelId, 'activeModel=', activeModel, 'models=', models);
            addLog(`Starting recording with model: ${modelId}`);

            // Проверяем статус модели - должен быть 'downloaded' или 'active'
            const isModelReady = activeModel?.status === 'downloaded' || activeModel?.status === 'active';
            if (!isModelReady && activeModelId) {
                addLog(`Модель не скачана (status: ${activeModel?.status}). Откройте менеджер моделей для скачивания.`);
                setShowModelManager(true);
                return;
            }

            if (!modelId) {
                addLog('Модель не выбрана. Выберите модель в настройках.');
                setShowModelManager(true);
                return;
            }

            ws.send(JSON.stringify({
                type: 'start_session',
                language,
                model: modelId,
                micDevice,
                captureSystem,
                vadMode,
                useNativeCapture: screenCaptureKitAvailable && captureSystem,
                useVoiceIsolation: screenCaptureKitAvailable && captureSystem && useVoiceIsolation,
                echoCancel: captureSystem && !useVoiceIsolation ? echoCancel : 0
            }));
            addLog('start_session sent to backend');
        }
    };

    const handleViewSession = (sessionId: string) => {
        wsRef.current?.send(JSON.stringify({ type: 'get_session', sessionId }));
        // Запрашиваем спикеров для сессии
        wsRef.current?.send(JSON.stringify({ type: 'get_session_speakers', sessionId }));
    };

    const handleRetranscribe = (chunkId: string) => {
        if (!selectedSession) return;

        // Получаем активную модель
        const activeModel = models.find(m => m.id === activeModelId);
        const modelId = activeModel?.id || activeModelId;

        // Сразу обновляем UI: очищаем ошибку и ставим статус transcribing
        setSelectedSession(prev => {
            if (!prev) return prev;
            const chunks = prev.chunks.map(c =>
                c.id === chunkId
                    ? { ...c, status: 'transcribing' as const, error: undefined, transcription: '', micText: '', sysText: '', dialogue: [] }
                    : c
            );
            return { ...prev, chunks };
        });

        // Подсвечиваем чанк во время транскрипции
        setTranscribingChunkId(chunkId);

        wsRef.current?.send(JSON.stringify({
            type: 'retranscribe_chunk',
            sessionId: selectedSession.id,
            data: chunkId,
            model: modelId,
            language: language
        }));
        addLog(`Retranscribing chunk with model: ${activeModel?.name || 'default'}, language: ${language}`);
    };

    // Улучшение транскрипции с помощью AI
    const handleImproveTranscription = useCallback(() => {
        if (!selectedSession) return;
        if (!wsRef.current || wsRef.current.readyState !== RPC_READY_STATE.OPEN) {
            addLog('gRPC channel not connected');
            return;
        }

        setIsImproving(true);
        setImproveError(null);

        wsRef.current.send(JSON.stringify({
            type: 'improve_transcription',
            sessionId: selectedSession.id,
            ollamaModel: ollamaModel,
            ollamaUrl: ollamaUrl
        }));
        addLog(`Improving transcription with AI model: ${ollamaModel}`);
    }, [selectedSession, ollamaModel, ollamaUrl, addLog]);

    // Диаризация всего текста с помощью AI (разбивка по собеседникам)
    const handleDiarizeWithLLM = useCallback(() => {
        if (!selectedSession) return;
        if (!wsRef.current || wsRef.current.readyState !== RPC_READY_STATE.OPEN) {
            addLog('gRPC channel not connected');
            return;
        }

        setIsDiarizing(true);
        setDiarizeError(null);

        wsRef.current.send(JSON.stringify({
            type: 'diarize_with_llm',
            sessionId: selectedSession.id,
            ollamaModel: ollamaModel,
            ollamaUrl: ollamaUrl
        }));
        addLog(`Diarizing text with AI model: ${ollamaModel}`);
    }, [selectedSession, ollamaModel, ollamaUrl, addLog]);

    // Загрузка списка моделей Ollama
    const loadOllamaModels = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== RPC_READY_STATE.OPEN) return;

        setOllamaModelsLoading(true);
        setOllamaError(null);
        wsRef.current.send(JSON.stringify({
            type: 'get_ollama_models',
            ollamaUrl: ollamaUrl
        }));
    }, [ollamaUrl]);

    // Diarization functions
    const handleEnableDiarization = useCallback((segModelId: string, embModelId: string, provider: string) => {
        if (!wsRef.current || wsRef.current.readyState !== RPC_READY_STATE.OPEN) return;

        // Найти пути к моделям
        const segModel = models.find(m => m.id === segModelId);
        const embModel = models.find(m => m.id === embModelId);

        if (!segModel?.path || !embModel?.path) {
            setDiarizationError('Модели не найдены или не скачаны');
            return;
        }

        setDiarizationLoading(true);
        setDiarizationError(null);

        // Сохраняем настройки для авто-включения при перезапуске
        setSavedDiarizationEnabled(true);
        setSavedDiarizationSegModelId(segModelId);
        setSavedDiarizationEmbModelId(embModelId);
        setSavedDiarizationProvider(provider);

        wsRef.current.send(JSON.stringify({
            type: 'enable_diarization',
            segmentationModelPath: segModel.path,
            embeddingModelPath: embModel.path,
            diarizationProvider: provider
        }));
        addLog(`Enabling diarization (${provider})...`);
    }, [models, addLog]);

    const handleDisableDiarization = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== RPC_READY_STATE.OPEN) return;

        setDiarizationLoading(true);
        // Сохраняем что диаризация выключена (но сохраняем модели для удобства)
        setSavedDiarizationEnabled(false);
        wsRef.current.send(JSON.stringify({ type: 'disable_diarization' }));
        addLog('Disabling diarization...');
    }, [addLog]);

    // Переименование спикера в сессии
    const handleRenameSpeaker = useCallback((localId: number, name: string, saveAsVoiceprint: boolean) => {
        if (!selectedSession) return;
        if (!wsRef.current || wsRef.current.readyState !== RPC_READY_STATE.OPEN) return;

        wsRef.current.send(JSON.stringify({
            type: 'rename_session_speaker',
            sessionId: selectedSession.id,
            localId,
            newName: name,
            saveAsVoiceprint
        }));
        addLog(`Renaming speaker ${localId} to "${name}"${saveAsVoiceprint ? ' (saving voiceprint)' : ''}`);
    }, [selectedSession, addLog]);

    // Функция для получения отображаемого имени спикера с учётом кастомных имён
    // Приоритет: sessionSpeakers (кастомные имена) > дефолтные имена из getSpeakerInfo
    const getSpeakerDisplayName = useCallback((speaker?: string): { name: string; color: string } => {
        if (!speaker) return { name: 'Собеседник', color: '#2196f3' };

        // Проверяем кастомные имена из sessionSpeakers
        if (sessionSpeakers.length > 0) {
            const found = sessionSpeakers.find(s => {
                if (speaker === 'mic' || speaker === 'Вы') {
                    return s.isMic;
                }
                if (speaker === 'sys' || speaker === 'Собеседник') {
                    return !s.isMic && s.localId === 0;
                }
                if (speaker.startsWith('Speaker ')) {
                    const num = parseInt(speaker.replace('Speaker ', ''), 10);
                    return !s.isMic && s.localId === num;
                }
                if (speaker.startsWith('Собеседник ')) {
                    const num = parseInt(speaker.replace('Собеседник ', ''), 10);
                    return !s.isMic && s.localId === (num - 1);
                }
                // Прямое совпадение по displayName (для уже переименованных)
                return s.displayName === speaker;
            });

            if (found) {
                const colorIdx = found.isMic ? -1 : found.localId;
                const color = found.isMic 
                    ? '#4caf50' 
                    : SPEAKER_COLORS[Math.abs(colorIdx) % SPEAKER_COLORS.length];
                return { name: found.displayName, color };
            }
        }

        // Дефолтная логика (fallback к getSpeakerInfo)
        return getSpeakerInfo(speaker);
    }, [sessionSpeakers]);

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

    // Полная ретранскрипция файла
    const handleFullRetranscribe = useCallback(() => {
        if (!selectedSession) return;

        // Получаем активную модель
        const activeModel = models.find(m => m.id === activeModelId);
        const modelId = activeModel?.id || activeModelId;

        // Проверяем статус модели - должен быть 'downloaded' или 'active'
        const isModelReady = activeModel?.status === 'downloaded' || activeModel?.status === 'active';
        if (!isModelReady && activeModelId) {
            addLog(`Модель не скачана (status: ${activeModel?.status}). Откройте менеджер моделей для скачивания.`);
            setShowModelManager(true);
            return;
        }

        if (!modelId) {
            addLog('Модель не выбрана. Выберите модель в настройках.');
            setShowModelManager(true);
            return;
        }

        setFullTranscriptionError(null);
        wsRef.current?.send(JSON.stringify({
            type: 'retranscribe_full',
            sessionId: selectedSession.id,
            model: modelId,
            language: language,
            diarizationEnabled: diarizationEnabled  // Передаём текущее состояние диаризации
        }));
        addLog(`Starting full retranscription with model: ${activeModel?.name || 'default'}${diarizationEnabled ? ' (with diarization)' : ''}`);
    }, [selectedSession, models, activeModelId, language, addLog]);

    // Отмена полной ретранскрипции (с debounce)
    const handleCancelFullTranscription = useCallback(() => {
        if (!selectedSession || isCancellingTranscription) return;

        setIsCancellingTranscription(true);
        wsRef.current?.send(JSON.stringify({
            type: 'cancel_full_transcription',
            sessionId: selectedSession.id
        }));
        addLog('Cancelling full transcription...');

        // Сбрасываем флаг через 2 секунды
        setTimeout(() => setIsCancellingTranscription(false), 2000);
    }, [selectedSession, isCancellingTranscription, addLog]);

    // Удаление сессии
    const handleDeleteSession = useCallback(() => {
        if (!selectedSession) return;

        wsRef.current?.send(JSON.stringify({
            type: 'delete_session',
            sessionId: selectedSession.id
        }));
        addLog(`Удалена сессия: ${selectedSession.title || selectedSession.id}`);
        setSelectedSession(null);
        setSessionSpeakers([]);  // Очищаем спикеров при удалении сессии
        setShowDeleteConfirm(false);
    }, [selectedSession, addLog]);

    // Обновление списка сессий
    const refreshSessions = useCallback(() => {
        wsRef.current?.send(JSON.stringify({ type: 'get_sessions' }));
        addLog('Обновление списка сессий...');
    }, [addLog]);

    // Воспроизведение аудио
    const playAudio = (url: string) => {
        const audioEl = audioRef.current;
        if (!audioEl) return;

        // Останавливаем предыдущий цикл анализа, если он был запущен
        if (playbackRafRef.current !== null) {
            cancelAnimationFrame(playbackRafRef.current);
            playbackRafRef.current = null;
        }

        const resetPlaybackLevels = () => {
            setPlaybackMicLevel(0);
            setPlaybackSysLevel(0);
            if (playbackRafRef.current !== null) {
                cancelAnimationFrame(playbackRafRef.current);
                playbackRafRef.current = null;
            }
        };

        if (playingAudio === url) {
            audioEl.pause();
            audioEl.currentTime = 0;
            setPlayingAudio(null);
            setPlaybackTime(0);
            lastPlaybackTimeRef.current = 0;
            setPlaybackOffset(0);
            playbackOffsetRef.current = 0;
            resetPlaybackLevels();
            return;
        }

        audioEl.src = url;
        setPlaybackTime(0);
        lastPlaybackTimeRef.current = 0;

        if (!audioContextRef.current) {
            audioContextRef.current = new AudioContext();
        }

        if (audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume();
        }

        // Строим граф только один раз для элемента audio
        if (!audioSourceConnectedRef.current && audioContextRef.current) {
            const source = audioContextRef.current.createMediaElementSource(audioEl);
            const splitter = audioContextRef.current.createChannelSplitter(2);

            analyserLeftRef.current = audioContextRef.current.createAnalyser();
            analyserRightRef.current = audioContextRef.current.createAnalyser();
            // Optimized for instant VU meter response:
            // - fftSize 128: minimum practical size (~2.7ms at 48kHz)
            // - smoothing 0: no smoothing for instant response (like backend)
            analyserLeftRef.current.fftSize = 128;
            analyserRightRef.current.fftSize = 128;
            analyserLeftRef.current.smoothingTimeConstant = 0;
            analyserRightRef.current.smoothingTimeConstant = 0;

            // Выделяем буферы под временную область, чтобы не создавать их на каждом кадре
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
        }

        const calculateRMS = (data: Float32Array) => {
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                const sample = data[i];
                sum += sample * sample;
            }
            return Math.sqrt(sum / data.length);
        };

        // Convert RMS to VU meter level using dB scale
        // Maps -50dB to 0dB range onto 0-100% for natural loudness perception
        const rmsToVuLevel = (rms: number): number => {
            if (rms <= 0) return 0;
            // Convert to dB (dBFS - decibels relative to full scale)
            const db = 20 * Math.log10(rms);
            // Map dB range to 0-100%: -50dB = 0%, 0dB = 100%
            // -50dB is a good threshold - catches speech but ignores very quiet noise
            const minDb = -50;
            const maxDb = 0;
            const percent = ((db - minDb) / (maxDb - minDb)) * 100;
            return Math.max(0, Math.min(100, percent));
        };

        const analyzeAudio = () => {
            const leftAnalyser = analyserLeftRef.current;
            const rightAnalyser = analyserRightRef.current;
            const el = audioRef.current;

            if (!el || el.paused || el.ended) {
                resetPlaybackLevels();
                return;
            }

            const currentPlaybackTime = el.currentTime;
            if (Math.abs(currentPlaybackTime - lastPlaybackTimeRef.current) > 0.02) {
                lastPlaybackTimeRef.current = currentPlaybackTime;
                setPlaybackTime(currentPlaybackTime);
            }

            // Always use real-time audio analysis for accurate VU meters
            if (leftAnalyser && rightAnalyser) {
                // Ensure buffers are allocated
                if (!leftTimeDataRef.current || leftTimeDataRef.current.length !== leftAnalyser.fftSize) {
                    leftTimeDataRef.current = new Float32Array(leftAnalyser.fftSize);
                }
                if (!rightTimeDataRef.current || rightTimeDataRef.current.length !== rightAnalyser.fftSize) {
                    rightTimeDataRef.current = new Float32Array(rightAnalyser.fftSize);
                }

                // Get current audio samples
                leftAnalyser.getFloatTimeDomainData(leftTimeDataRef.current as Float32Array<ArrayBuffer>);
                rightAnalyser.getFloatTimeDomainData(rightTimeDataRef.current as Float32Array<ArrayBuffer>);

                // Calculate RMS from time domain data
                const micRms = calculateRMS(leftTimeDataRef.current);
                const sysRms = calculateRMS(rightTimeDataRef.current);

                // Convert to VU level using dB scale
                const micLevel = rmsToVuLevel(micRms);
                const sysLevel = rmsToVuLevel(sysRms);

                // Use flushSync to force immediate React re-render from requestAnimationFrame
                // Without this, React 18 batches updates and VU meters don't animate smoothly
                flushSync(() => {
                    setPlaybackMicLevel(micLevel);
                    setPlaybackSysLevel(sysLevel);
                });
            }

            playbackRafRef.current = requestAnimationFrame(analyzeAudio);
        };

        audioEl.play()
            .then(() => {
                setPlayingAudio(url);
                playbackRafRef.current = requestAnimationFrame(analyzeAudio);
            })
            .catch((err) => {
                console.error('Failed to play audio:', err);
                resetPlaybackLevels();
                setPlayingAudio(null);
            });
    };

    const getChunkOffsetSec = (session: Session | null, chunkIndex: number) => {
        if (!session) return 0;
        const chunk = session.chunks.find(c => c.index === chunkIndex);
        if (chunk?.startMs !== undefined) return chunk.startMs / 1000;

        return session.chunks
            .filter(c => c.index < chunkIndex)
            .reduce((sum, c) => sum + (c.duration || 0) / 1000000000, 0);
    };

    const playFullRecording = (sessionId: string) => {
        setPlaybackOffset(0);
        playbackOffsetRef.current = 0;
        if (waveformData?.duration) {
            setPlaybackDuration(waveformData.duration);
        }
        playAudio(`${API_BASE}/api/sessions/${sessionId}/full.mp3`);
    };

    const playChunk = (sessionId: string, chunkIndex: number) => {
        const session = (selectedSession && selectedSession.id === sessionId)
            ? selectedSession
            : (currentSession && currentSession.id === sessionId)
                ? currentSession
                : selectedSession;

        const offsetSec = getChunkOffsetSec(session || null, chunkIndex);
        setPlaybackOffset(offsetSec);
        playbackOffsetRef.current = offsetSec;

        const chunk = session?.chunks.find(c => c.index === chunkIndex);
        if (chunk?.duration) {
            setPlaybackDuration(chunk.duration / 1000000000);
        }

        // Используем новый API для воспроизведения конкретного чанка
        playAudio(`${API_BASE}/api/sessions/${sessionId}/chunk/${chunkIndex}.mp3`);
    };

    const handleAudioEnded = () => {
        setPlayingAudio(null);
        setPlaybackMicLevel(0);
        setPlaybackSysLevel(0);
        lastPlaybackTimeRef.current = 0;
        setPlaybackOffset(0);
        playbackOffsetRef.current = 0;
        if (playbackRafRef.current !== null) {
            cancelAnimationFrame(playbackRafRef.current);
            playbackRafRef.current = null;
        }
    };

    // Генерация полного текста транскрипции
    const generateFullText = useCallback((session: Session): string => {
        const sessionChunks = session.chunks || [];

        // Собираем диалог
        // ВАЖНО: Backend уже применяет chunk.StartMs к timestamps сегментов
        // Поэтому НЕ добавляем chunkOffset здесь - timestamps уже глобальные
        const dialogue: TranscriptSegment[] = sessionChunks
            .filter(c => c.status === 'completed')
            .sort((a, b) => a.index - b.index)
            .flatMap((c) => {
                if (c.dialogue && c.dialogue.length > 0) {
                    return c.dialogue.map(seg => ({
                        ...seg,
                        start: seg.start,
                        end: seg.end
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
                const { name: speaker } = getSpeakerDisplayName(seg.speaker);
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
    }, [getSpeakerDisplayName]);

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
            // Используем requestAnimationFrame + небольшую задержку чтобы DOM успел обновиться
            requestAnimationFrame(() => {
                setTimeout(() => {
                    if (transcriptionRef.current) {
                        transcriptionRef.current.scrollTo({
                            top: transcriptionRef.current.scrollHeight + 1000, // +1000 для гарантии
                            behavior: 'smooth'
                        });
                    }
                }, 50);
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

    const displaySession = selectedSession || currentSession;
    const chunks = displaySession?.chunks || [];
    const sessionDurationSeconds = normalizeDurationSeconds(displaySession?.totalDuration);
    const timelineDuration = waveformData?.duration
        || playbackDuration
        || sessionDurationSeconds;

    useEffect(() => {
        if (sessionDurationSeconds > 0) {
            setPlaybackDuration(prev =>
                prev && prev > 0
                    ? prev
                    : sessionDurationSeconds
            );
        }
    }, [sessionDurationSeconds]);

    // Высокочастотное обновление позиции проигрывания, чтобы индикатор двигался плавно на длинных записях
    useEffect(() => {
        if (!playingAudio) return;

        const tick = () => {
            const el = audioRef.current;
            if (el && !Number.isNaN(el.currentTime)) {
                const t = el.currentTime;
                if (Math.abs(t - lastPlaybackTimeRef.current) > 0.01) {
                    lastPlaybackTimeRef.current = t;
                    setPlaybackTime(t);
                }
            }
            progressTickerRef.current = requestAnimationFrame(tick);
        };

        progressTickerRef.current = requestAnimationFrame(tick);
        return () => {
            if (progressTickerRef.current !== null) {
                cancelAnimationFrame(progressTickerRef.current);
                progressTickerRef.current = null;
            }
        };
    }, [playingAudio]);

    // Собираем полный диалог из всех чанков
    // ВАЖНО: Backend уже применяет chunk.StartMs к timestamps сегментов (transcription.go:390-397)
    // Поэтому НЕ добавляем chunkOffset здесь - timestamps уже глобальные
    const allDialogue: TranscriptSegment[] = chunks
        .filter(c => c.status === 'completed')
        .flatMap((c) => {
            // Если есть диалог с сегментами - timestamps уже глобальные
            if (c.dialogue && c.dialogue.length > 0) {
                return c.dialogue.map(seg => ({
                    ...seg,
                    start: seg.start,
                    end: seg.end
                }));
            }
            return [];
        })
        // ВАЖНО: Сортируем по времени начала для правильного порядка диалога
        // Mic и Sys сегменты могут идти вперемешку по времени, нужно упорядочить
        .sort((a, b) => a.start - b.start);

    return (
        <div className="app-frame" style={{ display: 'flex', height: '100vh', background: 'var(--app-bg)', color: 'var(--text-primary)' }}>
            {/* Hidden audio element */}
            <audio
                ref={audioRef}
                crossOrigin="anonymous"
                onEnded={handleAudioEnded}
                onTimeUpdate={(e) => {
                    const t = (e.target as HTMLAudioElement).currentTime;
                    lastPlaybackTimeRef.current = t;
                    setPlaybackTime(t);
                }}
                onLoadedMetadata={(e) => setPlaybackDuration((e.target as HTMLAudioElement).duration)}
                style={{ display: 'none' }}
            />

            {/* Left Sidebar - Sessions List - Liquid Glass Style */}
            <aside
                className="glass-surface-elevated"
                style={{
                    position: 'relative', // For recording overlay positioning
                    width: '300px',
                    margin: 'var(--spacing-inset)',
                    marginRight: 0,
                    borderRadius: 'var(--radius-xl)',
                    background: 'var(--sidebar-bg)',
                    backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    border: '1px solid var(--glass-border)',
                    boxShadow: 'var(--shadow-glass)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}
            >
                {/* Sidebar Header */}
                <div style={{
                    padding: '1rem 1.25rem',
                    paddingTop: '0.5rem', // Reduced - traffic light offset is on parent
                    marginTop: '28px', // macOS traffic lights offset
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                }}>
                    <h2 style={{
                        margin: 0,
                        fontSize: '1.2rem',
                        fontWeight: 'var(--font-weight-bold)',
                        letterSpacing: '-0.02em',
                        color: 'var(--text-primary)',
                    }}>
                        Все записи
                    </h2>
                    <div style={{ display: 'flex', gap: '0.25rem' }}>
                        <button
                            className="btn-icon btn-icon-sm"
                            onClick={refreshSessions}
                            title="Обновить список"
                            style={{ width: '32px', height: '32px' }}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M23 4v6h-6"/>
                                <path d="M1 20v-6h6"/>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                            </svg>
                        </button>
                        <button
                            className="btn-icon btn-icon-sm"
                            onClick={openDataFolder}
                            title="Открыть папку с записями"
                            style={{ width: '32px', height: '32px' }}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Sessions List with Grouping */}
                <div
                    className="scroll-soft-edges"
                    style={{ flex: 1, overflowY: 'auto', paddingBottom: '1rem' }}
                >
                    {sessions.length === 0 ? (
                        <div style={{
                            padding: '2rem 1rem',
                            color: 'var(--text-muted)',
                            textAlign: 'center',
                            fontSize: '0.9rem',
                        }}>
                            Нет записей
                        </div>
                    ) : (
                        groupSessionsByTime(sessions).map((group) => (
                            <div key={group.label}>
                                {/* Group Header */}
                                <div className="group-header">{group.label}</div>

                                {/* Sessions in Group */}
                                {group.sessions.map((s) => {
                                    const isSelected = selectedSession?.id === s.id;
                                    const durationSec = s.totalDuration / 1000;

                                    return (
                                        <div
                                            key={s.id}
                                            className={`session-item ${isSelected ? 'selected' : ''}`}
                                            onClick={() => handleViewSession(s.id)}
                                        >
                                            {/* Title */}
                                            <div style={{
                                                fontSize: '0.95rem',
                                                fontWeight: 'var(--font-weight-semibold)',
                                                color: 'var(--text-primary)',
                                                marginBottom: '0.35rem',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            }}>
                                                {s.title || `Запись ${formatDateUtil(s.startTime)}`}
                                            </div>

                                            {/* Meta Info */}
                                            <div style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.5rem',
                                                fontSize: '0.8rem',
                                                color: 'var(--text-muted)',
                                            }}>
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
                                                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                                                    <line x1="16" y1="2" x2="16" y2="6"/>
                                                    <line x1="8" y1="2" x2="8" y2="6"/>
                                                    <line x1="3" y1="10" x2="21" y2="10"/>
                                                </svg>
                                                <span>{formatDateUtil(s.startTime)}, {formatTimeUtil(s.startTime)}</span>
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
                                                    <circle cx="12" cy="12" r="10"/>
                                                    <polyline points="12 6 12 12 16 14"/>
                                                </svg>
                                                <span>{formatDurationUtil(durationSec)}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </div>

                {/* New Recording Button at Bottom - всегда показывает "Новая запись", затемнена при записи */}
                <div style={{
                    padding: '0.75rem 1rem',
                    borderTop: '1px solid var(--glass-border-subtle)',
                }}>
                    <button
                        className="btn-capsule"
                        onClick={handleStartStop}
                        disabled={status !== 'Connected' || isStopping || isRecording}
                        style={{
                            width: '100%',
                            justifyContent: 'center',
                            padding: '0.6rem 1rem',
                            gap: '0.4rem',
                            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                            border: 'none',
                            color: 'white',
                            boxShadow: isRecording ? 'none' : 'var(--shadow-glow-primary)',
                            opacity: isRecording ? 0.4 : 1,
                            cursor: isRecording ? 'not-allowed' : 'pointer',
                            transition: 'opacity 0.2s ease, box-shadow 0.2s ease',
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="12" y1="5" x2="12" y2="19"/>
                            <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        Новая запись
                    </button>
                </div>

                {/* Recording Lock Overlay - полное покрытие sidebar с размытием */}
                {isRecording && (
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            background: 'rgba(0, 0, 0, 0.3)',
                            backdropFilter: 'blur(4px) saturate(0.8)',
                            WebkitBackdropFilter: 'blur(4px) saturate(0.8)',
                            borderRadius: 'var(--radius-xl)',
                            zIndex: 10,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.75rem',
                            cursor: 'not-allowed',
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.6rem',
                                padding: '0.75rem 1.5rem',
                                background: 'rgba(239, 68, 68, 0.15)',
                                backdropFilter: 'blur(12px)',
                                WebkitBackdropFilter: 'blur(12px)',
                                borderRadius: 'var(--radius-capsule)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                            }}
                        >
                            <div
                                style={{
                                    width: '10px',
                                    height: '10px',
                                    borderRadius: '50%',
                                    background: '#ef4444',
                                    boxShadow: '0 0 12px rgba(239, 68, 68, 0.8)',
                                    animation: 'pulse 1s infinite',
                                }}
                            />
                            <span style={{
                                fontSize: '0.95rem',
                                fontWeight: 600,
                                color: '#ef4444',
                            }}>
                                Идёт запись
                            </span>
                        </div>
                        <span style={{
                            fontSize: '0.8rem',
                            color: 'rgba(255, 255, 255, 0.6)',
                        }}>
                            Остановите для выбора другой записи
                        </span>
                    </div>
                )}
            </aside>

            {/* Main Content */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                {/* Header - Minimal Liquid Glass Style */}
                <header
                    style={{
                        padding: '0.75rem 1.5rem',
                        paddingLeft: '88px', // Traffic lights offset
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: 'transparent',
                        WebkitAppRegion: 'drag',
                        userSelect: 'none',
                        minHeight: '52px',
                    } as React.CSSProperties}
                >
                    {/* Left: Connection Status Indicator */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <div
                            style={{
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                background: status === 'Connected' ? 'var(--success)' : 'var(--danger)',
                                boxShadow: status === 'Connected'
                                    ? '0 0 12px var(--success)'
                                    : '0 0 12px var(--danger)',
                                transition: 'all var(--duration-normal) var(--transition-smooth)',
                            }}
                        />
                    </div>

                    {/* Recording Indicator Bar - растягивается между статусом и настройками */}
                    {isRecording && (
                        <div
                            className="animate-scale-in"
                            style={{
                                flex: 1,
                                margin: '0 1rem',
                                padding: '0.5rem 1.5rem',
                                borderRadius: 'var(--radius-capsule)',
                                background: 'rgba(239, 68, 68, 0.1)',
                                backdropFilter: 'blur(12px)',
                                WebkitBackdropFilter: 'blur(12px)',
                                border: '1px solid rgba(239, 68, 68, 0.2)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '1rem',
                                WebkitAppRegion: 'no-drag',
                            } as React.CSSProperties}
                        >
                            {/* Pulsing Record Indicator */}
                            <div style={{ position: 'relative', width: '10px', height: '10px' }}>
                                <div
                                    style={{
                                        position: 'absolute',
                                        inset: 0,
                                        borderRadius: '50%',
                                        background: '#ef4444',
                                        animation: 'recordPulseRing 1.5s infinite',
                                    }}
                                />
                                <div
                                    style={{
                                        position: 'absolute',
                                        inset: '1px',
                                        borderRadius: '50%',
                                        background: '#ef4444',
                                        boxShadow: '0 0 8px rgba(239, 68, 68, 0.8)',
                                    }}
                                />
                            </div>

                            {/* REC label */}
                            <span
                                style={{
                                    fontSize: '0.75rem',
                                    fontWeight: 700,
                                    color: '#ef4444',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.08em',
                                }}
                            >
                                REC
                            </span>

                            {/* Waveform Visualization - расширенная */}
                            <div
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '2.5px',
                                    height: '24px',
                                    flex: 1,
                                    maxWidth: '400px',
                                    justifyContent: 'center',
                                }}
                            >
                                {recordingWave.map((height, i) => (
                                    <div
                                        key={i}
                                        style={{
                                            width: '3px',
                                            height: `${height * 100}%`,
                                            minHeight: '4px',
                                            background: `linear-gradient(to top, rgba(239, 68, 68, 0.4), rgba(239, 68, 68, ${0.3 + height * 0.7}))`,
                                            borderRadius: '2px',
                                            transition: 'height 0.08s ease-out',
                                        }}
                                    />
                                ))}
                            </div>

                            {/* Timer */}
                            <span
                                style={{
                                    fontFamily: 'SF Mono, Menlo, Monaco, monospace',
                                    fontSize: '0.95rem',
                                    fontWeight: 600,
                                    color: 'var(--text-primary)',
                                    minWidth: '52px',
                                    letterSpacing: '0.02em',
                                }}
                            >
                                {formatDuration(recordingDuration)}
                            </span>

                            {/* Stop Button inline */}
                            <button
                                onClick={handleStartStop}
                                disabled={isStopping}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem',
                                    padding: '0.35rem 0.75rem',
                                    background: 'rgba(239, 68, 68, 0.9)',
                                    border: 'none',
                                    borderRadius: '9999px',
                                    color: 'white',
                                    fontSize: '0.8rem',
                                    fontWeight: 600,
                                    cursor: isStopping ? 'wait' : 'pointer',
                                    transition: 'all 0.15s ease',
                                    opacity: isStopping ? 0.7 : 1,
                                }}
                                onMouseEnter={(e) => !isStopping && (e.currentTarget.style.background = 'rgba(220, 38, 38, 1)')}
                                onMouseLeave={(e) => !isStopping && (e.currentTarget.style.background = 'rgba(239, 68, 68, 0.9)')}
                            >
                                {isStopping ? (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}>
                                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                                    </svg>
                                ) : (
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                        <rect x="6" y="6" width="12" height="12" rx="2" />
                                    </svg>
                                )}
                                {isStopping ? 'Сохранение' : 'Стоп'}
                            </button>
                        </div>
                    )}
                    
                    {/* CSS animation for recording pulse */}
                    <style>{`
                        @keyframes recordPulseRing {
                            0%, 100% { transform: scale(1); opacity: 1; }
                            50% { transform: scale(2); opacity: 0; }
                        }
                    `}</style>

                    {/* Right: Settings only (disabled during recording) */}
                    <div
                        style={{
                            display: 'flex',
                            gap: '0.5rem',
                            alignItems: 'center',
                            WebkitAppRegion: 'no-drag',
                        } as React.CSSProperties}
                    >
                        <button
                            className="btn-icon"
                            onClick={() => !isRecording && setShowSettings(true)}
                            title={isRecording ? "Остановите запись для доступа к настройкам" : "Настройки"}
                            disabled={isRecording}
                            style={{ 
                                width: '36px', 
                                height: '36px',
                                opacity: isRecording ? 0.4 : 1,
                                cursor: isRecording ? 'not-allowed' : 'pointer',
                                transition: 'opacity 0.2s ease',
                            }}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="3"/>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                            </svg>
                        </button>
                    </div>
                </header>

                {/* Settings Modal */}
                <SettingsModal
                    isOpen={showSettings}
                    onClose={() => setShowSettings(false)}
                    devices={devices}
                    micDevice={micDevice}
                    setMicDevice={setMicDevice}
                    captureSystem={captureSystem}
                    setCaptureSystem={setCaptureSystem}
                    vadMode={vadMode}
                    setVADMode={setVADMode}
                    screenCaptureKitAvailable={screenCaptureKitAvailable}
                    useVoiceIsolation={useVoiceIsolation}
                    setUseVoiceIsolation={setUseVoiceIsolation}
                    echoCancel={echoCancel}
                    setEchoCancel={setEchoCancel}
                    language={language}
                    setLanguage={setLanguage}
                    theme={theme}
                    setTheme={setTheme}
                    ollamaModel={ollamaModel}
                    setOllamaModel={setOllamaModel}
                    ollamaModels={ollamaModels}
                    ollamaModelsLoading={ollamaModelsLoading}
                    ollamaError={ollamaError}
                    loadOllamaModels={loadOllamaModels}
                    onShowModelManager={() => setShowModelManager(true)}
                    activeModelId={activeModelId}
                    models={models}
                    // Diarization
                    diarizationStatus={{ enabled: diarizationEnabled, provider: diarizationProvider }}
                    diarizationLoading={diarizationLoading}
                    diarizationError={diarizationError}
                    segmentationModels={models.filter(m => m.engine === 'diarization' && m.diarizationType === 'segmentation')}
                    embeddingModels={models.filter(m => m.engine === 'diarization' && m.diarizationType === 'embedding')}
                    onEnableDiarization={handleEnableDiarization}
                    onDisableDiarization={handleDisableDiarization}
                />

                {/* Transcription Area */}
                <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
                    {/* Sticky Header: Session info + Tabs */}
                    {(selectedSession || isRecording) && (
                        <div style={{
                            flexShrink: 0,
                            backgroundColor: 'var(--app-bg)',
                            borderBottom: '1px solid var(--border)',
                            padding: '0 1.5rem'
                        }}>
                            {selectedSession && !isRecording && (
                                <div style={{
                                    marginBottom: '1rem',
                                    padding: '1rem 1.25rem',
                                    background: 'linear-gradient(135deg, rgba(108, 92, 231, 0.08) 0%, rgba(162, 155, 254, 0.04) 100%)',
                                    borderRadius: '16px',
                                    border: '1px solid rgba(108, 92, 231, 0.2)'
                                }}>
                                    {/* Main row: Play button, Title, Action buttons */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
                                        {/* Big Play Button */}
                                        <button
                                            onClick={() => playFullRecording(selectedSession.id)}
                                            title={playingAudio?.includes(selectedSession.id) ? 'Остановить' : 'Слушать запись'}
                                            style={{
                                                width: '56px',
                                                height: '56px',
                                                padding: 0,
                                                background: playingAudio?.includes(selectedSession.id)
                                                    ? 'linear-gradient(135deg, #f44336, #e91e63)'
                                                    : 'linear-gradient(135deg, #6c5ce7, #a29bfe)',
                                                color: '#fff',
                                                border: 'none',
                                                borderRadius: '50%',
                                                cursor: 'pointer',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                boxShadow: playingAudio?.includes(selectedSession.id)
                                                    ? '0 4px 20px rgba(244, 67, 54, 0.4)'
                                                    : '0 4px 20px rgba(108, 92, 231, 0.4)',
                                                transition: 'all 0.3s ease',
                                                transform: 'scale(1)',
                                                flexShrink: 0
                                            }}
                                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; }}
                                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                                        >
                                            {playingAudio?.includes(selectedSession.id) ? (
                                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                                    <rect x="6" y="5" width="4" height="14" rx="1" />
                                                    <rect x="14" y="5" width="4" height="14" rx="1" />
                                                </svg>
                                            ) : (
                                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                                    <path d="M8 5v14l11-7z" />
                                                </svg>
                                            )}
                                        </button>

                                        {/* Title and Info */}
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '1.1rem', marginBottom: '0.2rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {selectedSession.title || 'Запись'}
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', fontSize: '0.8rem', flexWrap: 'wrap' }}>
                                                <span>{formatDate(selectedSession.startTime)}</span>
                                                <span>•</span>
                                                <span>{formatDuration(selectedSession.totalDuration / 1000000000)}</span>
                                                {selectedSession.chunks.length > 0 && selectedSession.chunks[0].isStereo && (
                                                    <>
                                                        <span>•</span>
                                                        <span style={{
                                                            fontSize: '0.7rem',
                                                            color: 'var(--success)',
                                                            backgroundColor: 'rgba(0, 184, 148, 0.12)',
                                                            padding: '2px 6px',
                                                            borderRadius: '999px'
                                                        }}>
                                                            Стерео
                                                        </span>
                                                    </>
                                                )}
                                            </div>
                                        </div>

                                        {/* Action Buttons - Right Side */}
                                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexShrink: 0 }}>
                                            {/* Export Button */}
                                            <div style={{ position: 'relative' }} data-share-menu>
                                                <button
                                                    onClick={() => setShowShareMenu(!showShareMenu)}
                                                    title="Экспорт"
                                                    style={{
                                                        width: '36px',
                                                        height: '36px',
                                                        padding: 0,
                                                        backgroundColor: copySuccess ? 'rgba(76, 175, 80, 0.2)' : 'var(--surface-strong)',
                                                        color: copySuccess ? '#4caf50' : 'var(--text-muted)',
                                                        border: '1px solid var(--border)',
                                                        borderRadius: '8px',
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        transition: 'all 0.2s ease'
                                                    }}
                                                >
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                        <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
                                                    </svg>
                                                </button>
                                                {showShareMenu && (
                                                    <div style={{
                                                        position: 'absolute',
                                                        top: '100%',
                                                        right: 0,
                                                        marginTop: '4px',
                                                        backgroundColor: 'var(--surface)',
                                                        border: '1px solid var(--border)',
                                                        borderRadius: '8px',
                                                        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                                                        zIndex: 100,
                                                        minWidth: '160px',
                                                        overflow: 'hidden'
                                                    }}>
                                                        <button onClick={handleCopyToClipboard} style={{ width: '100%', padding: '0.6rem 1rem', background: 'none', border: 'none', color: 'var(--text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem' }}>
                                                            📋 Копировать текст
                                                        </button>
                                                        <button onClick={handleDownloadFile} style={{ width: '100%', padding: '0.6rem 1rem', background: 'none', border: 'none', color: 'var(--text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem' }}>
                                                            📄 Скачать .txt
                                                        </button>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Retranscribe Button */}
                                            <button
                                                onClick={handleFullRetranscribe}
                                                disabled={isFullTranscribing}
                                                title="Распознать заново"
                                                style={{
                                                    width: '36px',
                                                    height: '36px',
                                                    padding: 0,
                                                    backgroundColor: isFullTranscribing ? 'rgba(156, 39, 176, 0.2)' : 'var(--surface-strong)',
                                                    color: isFullTranscribing ? '#9c27b0' : 'var(--text-muted)',
                                                    border: '1px solid var(--border)',
                                                    borderRadius: '8px',
                                                    cursor: isFullTranscribing ? 'not-allowed' : 'pointer',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    transition: 'all 0.2s ease',
                                                    animation: isFullTranscribing ? 'pulse 1.5s ease-in-out infinite' : 'none'
                                                }}
                                            >
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <path d="M23 4v6h-6" />
                                                    <path d="M1 20v-6h6" />
                                                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                                </svg>
                                            </button>

                                            {/* AI Improve Button */}
                                            <button
                                                onClick={handleImproveTranscription}
                                                disabled={isImproving || isDiarizing || isFullTranscribing || allDialogue.length === 0}
                                                title="Улучшить с AI"
                                                style={{
                                                    width: '36px',
                                                    height: '36px',
                                                    padding: 0,
                                                    backgroundColor: isImproving ? 'rgba(156, 39, 176, 0.2)' : 'var(--surface-strong)',
                                                    color: isImproving ? '#9c27b0' : (allDialogue.length === 0 ? 'var(--text-muted)' : 'var(--text-muted)'),
                                                    border: '1px solid var(--border)',
                                                    borderRadius: '8px',
                                                    cursor: isImproving || isDiarizing || allDialogue.length === 0 ? 'not-allowed' : 'pointer',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    transition: 'all 0.2s ease',
                                                    animation: isImproving ? 'pulse 1.5s ease-in-out infinite' : 'none',
                                                    opacity: allDialogue.length === 0 ? 0.5 : 1
                                                }}
                                            >
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                                                    <path d="M2 17l10 5 10-5" />
                                                    <path d="M2 12l10 5 10-5" />
                                                </svg>
                                            </button>

                                            {/* AI Diarize Button - разбивка по собеседникам */}
                                            <button
                                                onClick={handleDiarizeWithLLM}
                                                disabled={isDiarizing || isImproving || isFullTranscribing || allDialogue.length === 0}
                                                title="Разбить по собеседникам (AI)"
                                                style={{
                                                    width: '36px',
                                                    height: '36px',
                                                    padding: 0,
                                                    backgroundColor: isDiarizing ? 'rgba(33, 150, 243, 0.2)' : 'var(--surface-strong)',
                                                    color: isDiarizing ? '#2196f3' : (allDialogue.length === 0 ? 'var(--text-muted)' : 'var(--text-muted)'),
                                                    border: '1px solid var(--border)',
                                                    borderRadius: '8px',
                                                    cursor: isDiarizing || isImproving || allDialogue.length === 0 ? 'not-allowed' : 'pointer',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    transition: 'all 0.2s ease',
                                                    animation: isDiarizing ? 'pulse 1.5s ease-in-out infinite' : 'none',
                                                    opacity: allDialogue.length === 0 ? 0.5 : 1
                                                }}
                                            >
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                                    <circle cx="9" cy="7" r="4" />
                                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                                                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                                                </svg>
                                            </button>

                                            {/* Delete Button */}
                                            <button
                                                onClick={() => setShowDeleteConfirm(true)}
                                                title="Удалить запись"
                                                style={{
                                                    width: '36px',
                                                    height: '36px',
                                                    padding: 0,
                                                    backgroundColor: 'var(--surface-strong)',
                                                    color: 'var(--text-muted)',
                                                    border: '1px solid var(--border)',
                                                    borderRadius: '8px',
                                                    cursor: 'pointer',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    transition: 'all 0.2s ease'
                                                }}
                                            >
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                                                </svg>
                                            </button>

                                            {/* Close Button */}
                                            <button
                                                onClick={() => { setSelectedSession(null); setSessionSpeakers([]); setShowShareMenu(false); setActiveTab('dialogue'); }}
                                                title="Закрыть"
                                                style={{
                                                    width: '36px',
                                                    height: '36px',
                                                    padding: 0,
                                                    backgroundColor: 'var(--surface-strong)',
                                                    color: 'var(--text-muted)',
                                                    border: '1px solid var(--border)',
                                                    borderRadius: '8px',
                                                    cursor: 'pointer',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    transition: 'all 0.2s ease'
                                                }}
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>

                                    {/* Delete Confirmation Modal */}
                                    {showDeleteConfirm && (
                                        <div style={{
                                            position: 'fixed',
                                            inset: 0,
                                            backgroundColor: 'rgba(0, 0, 0, 0.6)',
                                            backdropFilter: 'blur(4px)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            zIndex: 1000
                                        }}>
                                            <div style={{
                                                backgroundColor: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                borderRadius: '12px',
                                                padding: '1.5rem',
                                                maxWidth: '400px',
                                                width: '90%',
                                                boxShadow: '0 20px 60px rgba(0,0,0,0.4)'
                                            }}>
                                                <h3 style={{ margin: '0 0 1rem', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
                                                    Удалить запись?
                                                </h3>
                                                <p style={{ margin: '0 0 1.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                                    Запись "{selectedSession?.title || 'Без названия'}" будет удалена безвозвратно.
                                                </p>
                                                <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                                                    <button
                                                        onClick={() => setShowDeleteConfirm(false)}
                                                        style={{
                                                            padding: '0.6rem 1.2rem',
                                                            backgroundColor: 'var(--surface-strong)',
                                                            color: 'var(--text-primary)',
                                                            border: '1px solid var(--border)',
                                                            borderRadius: '8px',
                                                            cursor: 'pointer',
                                                            fontSize: '0.9rem'
                                                        }}
                                                    >
                                                        Отмена
                                                    </button>
                                                    <button
                                                        onClick={handleDeleteSession}
                                                        style={{
                                                            padding: '0.6rem 1.2rem',
                                                            backgroundColor: '#dc2626',
                                                            color: 'white',
                                                            border: 'none',
                                                            borderRadius: '8px',
                                                            cursor: 'pointer',
                                                            fontSize: '0.9rem'
                                                        }}
                                                    >
                                                        Удалить
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Waveform Display */}
                                    <WaveformDisplay
                                        currentTime={playbackTime}
                                        playbackOffset={playbackOffset}
                                        totalDuration={timelineDuration}
                                        isPlaying={!!playingAudio?.includes(selectedSession.id)}
                                        waveformData={waveformData}
                                        loading={spectrogramStatus === 'loading'}
                                        error={spectrogramStatus === 'error' ? (spectrogramError || 'Не удалось загрузить аудио') : null}
                                        channelLabels={['Mic', 'Sys']}
                                        onSeek={(absoluteTime) => {
                                            const el = audioRef.current;
                                            if (!el) return;

                                            const duration = el.duration || playbackDuration || 0;
                                            const relative = absoluteTime - playbackOffsetRef.current;
                                            const needsFullPlayback = relative < 0 || relative > duration;

                                            if (needsFullPlayback && selectedSession) {
                                                const applySeek = () => {
                                                    if (audioRef.current) {
                                                        const safeTime = Math.max(0, Math.min(audioRef.current.duration || 0, absoluteTime));
                                                        audioRef.current.currentTime = safeTime;
                                                        setPlaybackTime(safeTime);
                                                    }
                                                    audioRef.current?.removeEventListener('loadedmetadata', applySeek);
                                                };

                                                audioRef.current?.addEventListener('loadedmetadata', applySeek);
                                                playFullRecording(selectedSession.id);
                                                return;
                                            }

                                            const clamped = Math.max(0, Math.min(duration, relative));
                                            el.currentTime = clamped;
                                            setPlaybackTime(clamped);
                                        }}
                                    />
                                </div>
                            )}

                            {/* Прогресс-бар полной ретранскрипции */}
                            {isFullTranscribing && (
                                <div style={{
                                    marginBottom: '1rem',
                                    padding: '0.75rem',
                                    backgroundColor: 'rgba(156, 39, 176, 0.1)',
                                    borderRadius: '6px',
                                    border: '1px solid #9c27b0'
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                        <span style={{ animation: 'pulse 1s infinite' }}>🔄</span>
                                        <span style={{ color: '#9c27b0', fontWeight: 'bold' }}>Полная ретранскрипция</span>
                                        <span style={{ color: '#888', fontSize: '0.85rem' }}>
                                            {Math.round(fullTranscriptionProgress * 100)}%
                                        </span>
                                        <div style={{ flex: 1 }}></div>
                                        <button
                                            onClick={handleCancelFullTranscription}
                                            title={isCancellingTranscription ? "Отмена..." : "Отменить ретранскрипцию"}
                                            disabled={isCancellingTranscription}
                                            style={{
                                                padding: '0.25rem 0.5rem',
                                                backgroundColor: isCancellingTranscription ? 'rgba(244, 67, 54, 0.1)' : 'transparent',
                                                color: isCancellingTranscription ? '#888' : '#f44336',
                                                border: '1px solid',
                                                borderColor: isCancellingTranscription ? '#666' : '#f44336',
                                                borderRadius: '4px',
                                                cursor: isCancellingTranscription ? 'wait' : 'pointer',
                                                fontSize: '0.75rem',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.25rem',
                                                opacity: isCancellingTranscription ? 0.7 : 1
                                            }}
                                        >
                                            {isCancellingTranscription ? (
                                                <div style={{
                                                    width: '12px',
                                                    height: '12px',
                                                    border: '2px solid #888',
                                                    borderTopColor: 'transparent',
                                                    borderRadius: '50%',
                                                    animation: 'spin 1s linear infinite'
                                                }}></div>
                                            ) : (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <line x1="18" y1="6" x2="6" y2="18" />
                                                    <line x1="6" y1="6" x2="18" y2="18" />
                                                </svg>
                                            )}
                                            {isCancellingTranscription ? 'Отмена...' : 'Отмена'}
                                        </button>
                                    </div>
                                    <div style={{
                                        height: '6px',
                                        backgroundColor: 'var(--surface-strong)',
                                        borderRadius: '3px',
                                        overflow: 'hidden',
                                        marginBottom: '0.3rem'
                                    }}>
                                        <div style={{
                                            width: `${fullTranscriptionProgress * 100}%`,
                                            height: '100%',
                                            backgroundColor: '#9c27b0',
                                            transition: 'width 0.3s ease'
                                        }}></div>
                                    </div>
                                    {fullTranscriptionStatus && (
                                        <div style={{ fontSize: '0.8rem', color: '#888' }}>
                                            {fullTranscriptionStatus}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Ошибка полной ретранскрипции */}
                            {fullTranscriptionError && !isFullTranscribing && (
                                <div style={{
                                    marginBottom: '1rem',
                                    padding: '0.75rem',
                                    backgroundColor: 'rgba(244, 67, 54, 0.1)',
                                    borderRadius: '6px',
                                    border: '1px solid rgba(244, 67, 54, 0.3)',
                                    color: '#f44336',
                                    fontSize: '0.85rem'
                                }}>
                                    ❌ Ошибка: {fullTranscriptionError}
                                </div>
                            )}

                            {/* Индикатор AI улучшения */}
                            {isImproving && (
                                <div style={{
                                    marginBottom: '1rem',
                                    padding: '0.75rem',
                                    backgroundColor: 'rgba(156, 39, 176, 0.1)',
                                    borderRadius: '6px',
                                    border: '1px solid #9c27b0',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.75rem'
                                }}>
                                    <div style={{
                                        width: '20px',
                                        height: '20px',
                                        border: '2px solid #9c27b0',
                                        borderTopColor: 'transparent',
                                        borderRadius: '50%',
                                        animation: 'spin 1s linear infinite'
                                    }}></div>
                                    <span style={{ color: '#9c27b0', fontSize: '0.9rem' }}>
                                        Улучшение транскрипции с помощью AI...
                                    </span>
                                </div>
                            )}

                            {/* Ошибка AI улучшения */}
                            {improveError && !isImproving && (
                                <div style={{
                                    marginBottom: '1rem',
                                    padding: '0.75rem',
                                    backgroundColor: 'rgba(244, 67, 54, 0.1)',
                                    borderRadius: '6px',
                                    border: '1px solid rgba(244, 67, 54, 0.3)',
                                    color: '#f44336',
                                    fontSize: '0.85rem'
                                }}>
                                    ❌ Ошибка AI: {improveError}
                                </div>
                            )}

                            {/* Индикатор AI диаризации */}
                            {isDiarizing && (
                                <div style={{
                                    marginBottom: '1rem',
                                    padding: '0.75rem',
                                    backgroundColor: 'rgba(33, 150, 243, 0.1)',
                                    borderRadius: '6px',
                                    border: '1px solid #2196f3',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.75rem'
                                }}>
                                    <div style={{
                                        width: '20px',
                                        height: '20px',
                                        border: '2px solid #2196f3',
                                        borderTopColor: 'transparent',
                                        borderRadius: '50%',
                                        animation: 'spin 1s linear infinite'
                                    }}></div>
                                    <span style={{ color: '#2196f3', fontSize: '0.9rem' }}>
                                        Разбивка по собеседникам с помощью AI...
                                    </span>
                                </div>
                            )}

                            {/* Ошибка AI диаризации */}
                            {diarizeError && !isDiarizing && (
                                <div style={{
                                    marginBottom: '1rem',
                                    padding: '0.75rem',
                                    backgroundColor: 'rgba(244, 67, 54, 0.1)',
                                    borderRadius: '6px',
                                    border: '1px solid rgba(244, 67, 54, 0.3)',
                                    color: '#f44336',
                                    fontSize: '0.85rem'
                                }}>
                                    ❌ Ошибка диаризации: {diarizeError}
                                </div>
                            )}

                            {/* Session Tabs - скрываем во время записи */}
                            {displaySession && chunks.length > 0 && !isRecording && (
                                <SessionTabs
                                    activeTab={activeTab}
                                    onTabChange={setActiveTab}
                                    hasSummary={!!displaySession.summary}
                                    isGeneratingSummary={isGeneratingSummary}
                                    isRecording={isRecording}
                                    speakersCount={sessionSpeakers.length}
                                />
                            )}
                        </div>
                    )}

                    {/* Scrollable Content Area */}
                    <div ref={transcriptionRef} style={{ flex: 1, padding: '1rem 1.5rem', overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}>
                        {chunks.length === 0 && !isRecording && !selectedSession ? (
                            /* Welcome Screen - Modern Onboarding */
                            <div style={{ 
                                display: 'flex', 
                                flexDirection: 'column', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                height: '100%',
                                padding: '2rem',
                                textAlign: 'center',
                            }}>
                                {/* Hero Section */}
                                <div style={{
                                    marginBottom: '2.5rem',
                                }}>
                                    {/* App Icon / Logo */}
                                    <div style={{
                                        width: '80px',
                                        height: '80px',
                                        borderRadius: '24px',
                                        background: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        margin: '0 auto 1.5rem',
                                        boxShadow: 'var(--shadow-glow-primary)',
                                    }}>
                                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                                            <line x1="12" y1="19" x2="12" y2="23"/>
                                            <line x1="8" y1="23" x2="16" y2="23"/>
                                        </svg>
                                    </div>
                                    
                                    <h1 style={{
                                        fontSize: '1.75rem',
                                        fontWeight: 700,
                                        color: 'var(--text-primary)',
                                        margin: '0 0 0.5rem',
                                        letterSpacing: '-0.02em',
                                    }}>
                                        Добро пожаловать в AIWisper
                                    </h1>
                                    <p style={{
                                        fontSize: '1rem',
                                        color: 'var(--text-secondary)',
                                        margin: 0,
                                        maxWidth: '400px',
                                    }}>
                                        Интеллектуальная транскрипция с распознаванием говорящих
                                    </p>
                                </div>

                                {/* Quick Start Guide */}
                                <div style={{
                                    background: 'var(--surface)',
                                    borderRadius: 'var(--radius-xl)',
                                    padding: '1.5rem',
                                    width: '100%',
                                    maxWidth: '420px',
                                    border: '1px solid var(--glass-border-subtle)',
                                }}>
                                    <h3 style={{
                                        fontSize: '0.9rem',
                                        fontWeight: 600,
                                        color: 'var(--text-secondary)',
                                        margin: '0 0 1rem',
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.05em',
                                    }}>
                                        Быстрый старт
                                    </h3>

                                    {/* Step 1 */}
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: '1rem',
                                        marginBottom: '1rem',
                                        textAlign: 'left',
                                    }}>
                                        <div style={{
                                            width: '28px',
                                            height: '28px',
                                            borderRadius: '50%',
                                            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                                            color: 'white',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontSize: '0.85rem',
                                            fontWeight: 700,
                                            flexShrink: 0,
                                        }}>1</div>
                                        <div>
                                            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                                                Нажмите «Новая запись»
                                            </div>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                                Кнопка в левой панели запустит запись микрофона и системного звука
                                            </div>
                                        </div>
                                    </div>

                                    {/* Step 2 */}
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: '1rem',
                                        marginBottom: '1rem',
                                        textAlign: 'left',
                                    }}>
                                        <div style={{
                                            width: '28px',
                                            height: '28px',
                                            borderRadius: '50%',
                                            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                                            color: 'white',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontSize: '0.85rem',
                                            fontWeight: 700,
                                            flexShrink: 0,
                                        }}>2</div>
                                        <div>
                                            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                                                Говорите или проиграйте аудио
                                            </div>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                                AI автоматически разделит речь по говорящим
                                            </div>
                                        </div>
                                    </div>

                                    {/* Step 3 */}
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: '1rem',
                                        textAlign: 'left',
                                    }}>
                                        <div style={{
                                            width: '28px',
                                            height: '28px',
                                            borderRadius: '50%',
                                            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                                            color: 'white',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontSize: '0.85rem',
                                            fontWeight: 700,
                                            flexShrink: 0,
                                        }}>3</div>
                                        <div>
                                            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                                                Остановите и получите текст
                                            </div>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                                Транскрипция с таймкодами и диаризацией готова к экспорту
                                            </div>
                                        </div>
                                    </div>
                                </div>


                            </div>
                        ) : chunks.length === 0 && isRecording ? (
                            <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '3rem' }}>
                                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔴</div>
                                <div>Идёт запись... Транскрипция появится после остановки</div>
                            </div>
                        ) : chunks.length === 0 && selectedSession ? (
                            <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '3rem' }}>
                                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📭</div>
                                <div>Эта запись не содержит транскрипции</div>
                                <div style={{ fontSize: '0.85rem', marginTop: '0.5rem', opacity: 0.7 }}>
                                    Возможно, запись была прервана до создания чанков
                                </div>
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
                                                backgroundColor: 'var(--surface)',
                                                borderRadius: '8px',
                                                lineHeight: '1.9',
                                                fontSize: '0.95rem'
                                            }}>
                                                <h4 style={{ margin: '0 0 1rem 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Диалог</h4>
                                                {allDialogue.map((seg, idx) => {
                                                    const { name: speakerName, color: speakerColor } = getSpeakerDisplayName(seg.speaker);
                                                    const totalMs = seg.start;
                                                    const mins = Math.floor(totalMs / 60000);
                                                    const secs = Math.floor((totalMs % 60000) / 1000);
                                                    const ms = Math.floor((totalMs % 1000) / 100); // десятые доли секунды
                                                    const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;

                                                    // Книжный формат: [00:05.4] Вы: Текст реплики
                                                    return (
                                                        <div key={idx} style={{
                                                            marginBottom: '0.5rem',
                                                            paddingLeft: '0.5rem',
                                                            borderLeft: `3px solid ${speakerColor}`
                                                        }}>
                                                            <span style={{
                                                                color: 'var(--text-muted)',
                                                                fontSize: '0.8rem',
                                                                fontFamily: 'monospace'
                                                            }}>
                                                                [{timeStr}]
                                                            </span>
                                                            {' '}
                                                            <span style={{
                                                                color: speakerColor,
                                                                fontWeight: 'bold'
                                                            }}>
                                                                {speakerName}:
                                                            </span>
                                                            {' '}
                                                            <span style={{ color: 'var(--text-primary)' }}>
                                                                {seg.text}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ) : (
                                            // Fallback: показываем чанки по отдельности
                                            <div style={{
                                                marginBottom: '1.5rem',
                                                padding: '1rem',
                                                backgroundColor: 'var(--surface)',
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
                                                                            <span style={{ color: 'var(--text-primary)' }}>{chunk.micText}</span>
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
                                                                            <span style={{ color: 'var(--text-primary)' }}>{chunk.sysText}</span>
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
                                                `${API_BASE}/api/sessions/${displaySession.id}/chunk/${chunk.index}.mp3` : '';
                                            const isPlaying = playingAudio === chunkAudioUrl;
                                            const isHighlighted = highlightedChunkId === chunk.id;
                                            const isTranscribing = transcribingChunkId === chunk.id || chunk.status === 'transcribing';

                                            return (
                                                <div key={chunk.id} style={{
                                                    padding: '0.6rem 0.8rem',
                                                    marginBottom: '0.4rem',
                                                    backgroundColor: isTranscribing ? '#2a2a1a' : isHighlighted ? '#1a3a2a' : '#12121f',
                                                    borderRadius: '4px',
                                                    borderLeft: `3px solid ${chunk.status === 'completed' ? '#4caf50' : chunk.status === 'failed' ? '#f44336' : '#ff9800'}`,
                                                    transition: 'background-color 0.3s ease',
                                                    animation: isTranscribing ? 'transcribing-pulse 1s ease-in-out infinite' : isHighlighted ? 'highlight-pulse 0.5s ease-in-out 2' : 'none'
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
                                                    {/* Диалог с таймстемпами - книжный формат */}
                                                    {chunk.dialogue && chunk.dialogue.length > 0 ? (
                                                        <div style={{ marginTop: '0.4rem', lineHeight: '1.7' }}>
                                                            {chunk.dialogue.map((seg, idx) => {
                                                                const { name: speakerName, color: speakerColor } = getSpeakerDisplayName(seg.speaker);
                                                                const totalMs = seg.start;
                                                                const mins = Math.floor(totalMs / 60000);
                                                                const secs = Math.floor((totalMs % 60000) / 1000);
                                                                const ms = Math.floor((totalMs % 1000) / 100);
                                                                const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;

                                                                // Книжный формат: [00:05.4] Вы: Текст
                                                                return (
                                                                    <div key={idx} style={{
                                                                        marginBottom: '0.3rem',
                                                                        paddingLeft: '0.4rem',
                                                                        borderLeft: `2px solid ${speakerColor}`
                                                                    }}>
                                                                        <span style={{
                                                                            color: '#666',
                                                                            fontSize: '0.7rem',
                                                                            fontFamily: 'monospace'
                                                                        }}>
                                                                            [{timeStr}]
                                                                        </span>
                                                                        {' '}
                                                                        <span style={{
                                                                            color: speakerColor,
                                                                            fontSize: '0.8rem',
                                                                            fontWeight: 'bold'
                                                                        }}>
                                                                            {speakerName}:
                                                                        </span>
                                                                        {' '}
                                                                        <span style={{ color: '#ccc' }}>
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
                                                    {isTranscribing && (
                                                        <div style={{ marginTop: '0.4rem', color: '#ff9800', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                            <span style={{ animation: 'pulse 1s infinite' }}>⏳</span> Распознаётся...
                                                        </div>
                                                    )}
                                                    {chunk.error && (
                                                        <div style={{ marginTop: '0.4rem', color: '#f44336', fontSize: '0.8rem' }}>Ошибка: {chunk.error}</div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                {/* Tab: Speakers */}
                                {activeTab === 'speakers' && displaySession && (
                                    <SpeakersTab
                                        sessionId={displaySession.id}
                                        speakers={sessionSpeakers}
                                        onRename={handleRenameSpeaker}
                                    />
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
                                        ollamaModel={ollamaModel}
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
                @keyframes transcribing-pulse {
                    0%, 100% { background-color: #2a2a1a; }
                    50% { background-color: #3a3a2a; }
                }
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
            `}</style>

            {/* Right Sidebar - Audio Meters */}
            <AudioMeterSidebar
                micLevel={playingAudio ? playbackMicLevel : micLevel}
                sysLevel={playingAudio ? playbackSysLevel : systemLevel}
                isActive={isRecording || !!playingAudio}
            />

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
