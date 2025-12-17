import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import ModelManager from './components/ModelManager';
import SessionTabs, { TabType } from './components/SessionTabs';
import SummaryView from './components/SummaryView';
import { SettingsPage as SettingsModal } from './components/SettingsPage';
import HelpModal from './components/HelpModal';
import AudioMeterSidebar from './components/AudioMeterSidebar';
import WaveformDisplay from './components/WaveformDisplay';
import SpeakersTab from './components/modules/SpeakersTab';
import SessionStats from './components/modules/SessionStats';
import { ModelState, AppSettings, OllamaModel, HybridTranscriptionSettings } from './types/models';
import { SessionSpeaker, VoicePrint } from './types/voiceprint';
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
    processingTime?: number; // Время обработки в миллисекундах
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
    if (speaker === 'mic' || speaker === 'Вы') {
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
    const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set()); // Мультиселект для batch export
    const [showBatchExportModal, setShowBatchExportModal] = useState(false);

    // Session Speakers (for VoicePrint integration)
    const [sessionSpeakers, setSessionSpeakers] = useState<SessionSpeaker[]>([]);

    // Global Voiceprints (saved speakers)
    const [voiceprints, setVoiceprints] = useState<VoicePrint[]>([]);
    const [voiceprintsLoading, setVoiceprintsLoading] = useState(false);

    // Speaker sample playback
    const [playingSpeakerId, setPlayingSpeakerId] = useState<number | null>(null);
    const currentAudioRef = useRef<HTMLAudioElement | null>(null);

    // Devices
    const [devices, setDevices] = useState<AudioDevice[]>([]);
    const [micDevice, setMicDevice] = useState<string>('');
    const [captureSystem, setCaptureSystem] = useState(true);
    const [vadMode, setVADMode] = useState<'auto' | 'compression' | 'per-region' | 'off'>('auto');
    const [vadMethod, setVADMethod] = useState<'auto' | 'energy' | 'silero'>('auto');
    const [screenCaptureKitAvailable, setScreenCaptureKitAvailable] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [echoCancel, setEchoCancel] = useState(0.4); // Эхоподавление 0-1
    const [useVoiceIsolation, setUseVoiceIsolation] = useState(false); // Voice Isolation (macOS 15+)
    const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');


    // Audio player
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [playingAudio, setPlayingAudio] = useState<string | null>(null); // URL текущего аудио
    const [isAudioPlaying, setIsAudioPlaying] = useState(false); // Реальное состояние воспроизведения (play/pause)
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
    const [showSessionStats, setShowSessionStats] = useState(true); // Показывать статистику в сайдбаре

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
    // Флаг подтверждения модели от backend (не из localStorage)
    const backendModelConfirmed = useRef(false);

    // Hybrid Transcription settings
    const [hybridTranscription, setHybridTranscription] = useState<HybridTranscriptionSettings>({
        enabled: false,
        secondaryModelId: '',
        confidenceThreshold: 0.7,
        contextWords: 3,
        useLLMForMerge: false,
        mode: 'parallel', // По умолчанию - пословное слияние (быстро)
    });

    // Drag & Drop state
    const [isDragging, setIsDragging] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [importProgress, setImportProgress] = useState<string | null>(null);

    // Search state
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Array<{
        id: string;
        startTime: string;
        status: string;
        totalDuration: number;
        chunksCount: number;
        title?: string;
        matchedText?: string;
        matchContext?: string;
    }> | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const transcriptionRef = useRef<HTMLDivElement | null>(null);
    const dialogueContainerRef = useRef<HTMLDivElement | null>(null);
    const segmentRefs = useRef<Map<number, HTMLDivElement>>(new Map());
    const [autoScrollToPlayback, setAutoScrollToPlayback] = useState(true);

    // Refs для доступа к актуальным значениям в callbacks
    const modelsRef = useRef(models);
    const activeModelIdRef = useRef(activeModelId);
    const languageRef = useRef(language);
    const isImportingRef = useRef(isImporting);

    // Обновляем refs при изменении состояния
    useEffect(() => { modelsRef.current = models; }, [models]);
    useEffect(() => { activeModelIdRef.current = activeModelId; }, [activeModelId]);
    useEffect(() => { languageRef.current = language; }, [language]);
    useEffect(() => { isImportingRef.current = isImporting; }, [isImporting]);

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
                    setVADMethod(settings.vadMethod || 'auto');
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
                    // UI настройки
                    if (settings.showSessionStats !== undefined) {
                        setShowSessionStats(settings.showSessionStats);
                    }
                    // Гибридная транскрипция
                    if (settings.hybridTranscription) {
                        setHybridTranscription(settings.hybridTranscription);
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
                    vadMethod,
                    captureSystem,
                    ollamaModel,
                    ollamaUrl,
                    theme,
                    // Сохраняем настройки диаризации
                    diarizationEnabled: savedDiarizationEnabled,
                    diarizationSegModelId: savedDiarizationSegModelId,
                    diarizationEmbModelId: savedDiarizationEmbModelId,
                    diarizationProvider: savedDiarizationProvider,
                    // UI настройки
                    showSessionStats,
                    // Гибридная транскрипция
                    hybridTranscription
                });
            } catch (err) {
                console.error('Failed to save settings:', err);
            }
        };
        saveSettings();
    }, [language, activeModelId, echoCancel, useVoiceIsolation, vadMode, vadMethod, captureSystem, ollamaModel, ollamaUrl, theme, settingsLoaded, savedDiarizationEnabled, savedDiarizationSegModelId, savedDiarizationEmbModelId, savedDiarizationProvider, showSessionStats, hybridTranscription]);

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

        const loadWaveform = async () => {
            try {
                // 1. Сначала пробуем загрузить из кеша
                const cacheResp = await fetch(`${API_BASE}/api/waveform/${targetId}`);
                if (cacheResp.ok && cacheResp.status !== 204) {
                    const cachedWaveform = await cacheResp.json();
                    if (!cancelled && cachedWaveform) {
                        console.log('[Waveform] Loaded from cache');
                        setWaveformData(cachedWaveform);
                        spectrogramSessionIdRef.current = targetId;
                        setSpectrogramStatus('ready');
                        return;
                    }
                }

                // 2. Кеша нет - вычисляем из аудио
                console.log('[Waveform] Computing from audio...');
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

                    // 3. Сохраняем в кеш (асинхронно, не блокируем UI)
                    fetch(`${API_BASE}/api/waveform/${targetId}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(waveform),
                    }).then(() => {
                        console.log('[Waveform] Saved to cache');
                    }).catch(err => {
                        console.warn('[Waveform] Failed to save cache:', err);
                    });
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

        loadWaveform();

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
                socket.send(JSON.stringify({ type: 'get_voiceprints' }));
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

                            // Обновляем список спикеров после транскрипции
                            // Запрашиваем всегда, т.к. диаризация может быть включена
                            if (msg.sessionId) {
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
                                backendModelConfirmed.current = true;
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
                            backendModelConfirmed.current = true;
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
                            // Обновляем прогресс импорта (если это был импорт)
                            if (isImportingRef.current) {
                                setImportProgress(msg.data || `Транскрипция: ${Math.round((msg.progress || 0) * 100)}%`);
                            }
                            break;

                        case 'full_transcription_completed':
                            setIsFullTranscribing(false);
                            setFullTranscriptionProgress(1);
                            setFullTranscriptionStatus(null);
                            setFullTranscriptionError(null);
                            // Сбрасываем состояние импорта (если это был импорт)
                            setIsImporting(false);
                            setImportProgress(null);
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
                            // Сбрасываем состояние импорта (если это был импорт)
                            setIsImporting(false);
                            setImportProgress(null);
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

                        // === Audio Import ===
                        case 'session_imported':
                            addLog(`Session imported: ${msg.sessionId}`);
                            // Запрашиваем обновлённый список сессий
                            wsRef.current?.send(JSON.stringify({ type: 'get_sessions' }));
                            break;

                        case 'import_transcription_started':
                            setImportProgress('Транскрипция...');
                            addLog('Import transcription started');
                            break;

                        case 'import_transcription_progress':
                            setImportProgress(`Транскрипция: ${Math.round((msg.progress || 0) * 100)}%`);
                            break;

                        case 'import_transcription_completed':
                            setIsImporting(false);
                            setImportProgress(null);
                            addLog('Import transcription completed');
                            // Обновляем список сессий и выбираем импортированную
                            wsRef.current?.send(JSON.stringify({ type: 'get_sessions' }));
                            if (msg.sessionId) {
                                // Автоматически выбираем импортированную сессию
                                setTimeout(() => {
                                    wsRef.current?.send(JSON.stringify({ type: 'get_session', sessionId: msg.sessionId }));
                                }, 500);
                            }
                            break;

                        case 'import_transcription_error':
                            setIsImporting(false);
                            setImportProgress(null);
                            addLog(`Import transcription error: ${msg.error}`);
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
                                s.localId === msg.localSpeakerId
                                    ? { ...s, displayName: msg.speakerName, isRecognized: msg.voiceprintId ? true : s.isRecognized }
                                    : s
                            ));
                            addLog(`Speaker renamed: ${msg.speakerName}`);
                            // Запрашиваем обновлённый список спикеров
                            if (msg.sessionId) {
                                wsRef.current?.send(JSON.stringify({ type: 'get_session_speakers', sessionId: msg.sessionId }));
                            }
                            break;

                        case 'session_renamed':
                            // Обновляем название сессии в selectedSession
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
                            addLog(`Session renamed: ${msg.data}`);
                            break;

                        case 'search_results':
                            setIsSearching(false);
                            setSearchResults(msg.searchResults || []);
                            break;

                        case 'voiceprint_saved':
                            addLog(`Voiceprint saved: ${msg.name} (${msg.voiceprintId?.substring(0, 8)}...)`);
                            // Обновляем список voiceprints после сохранения
                            socket.send(JSON.stringify({ type: 'get_voiceprints' }));
                            break;

                        // === Voiceprints Management ===
                        case 'voiceprints_list':
                            setVoiceprints(msg.voiceprints || []);
                            setVoiceprintsLoading(false);
                            addLog(`Voiceprints loaded: ${(msg.voiceprints || []).length}`);
                            break;

                        case 'voiceprint_updated':
                            // Обновляем voiceprint в локальном состоянии
                            setVoiceprints(prev => prev.map(vp =>
                                vp.id === msg.voiceprintId
                                    ? { ...vp, name: msg.name, updatedAt: new Date().toISOString() }
                                    : vp
                            ));
                            addLog(`Voiceprint updated: ${msg.name}`);
                            break;

                        case 'voiceprint_deleted':
                            // Удаляем voiceprint из локального состояния
                            setVoiceprints(prev => prev.filter(vp => vp.id !== msg.voiceprintId));
                            addLog(`Voiceprint deleted: ${msg.voiceprintId?.substring(0, 8)}...`);
                            break;
                    }
                } catch {
                    // Ignore JSON errors
                }
            };

            socket.onclose = () => {
                setStatus('Disconnected');
                setIsRecording(false);
                // Сбрасываем флаги при отключении для корректного переподключения
                backendModelConfirmed.current = false;
                diarizationAutoEnableAttempted.current = false;
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
        if (status !== 'Connected') return;
        // Ждём загрузки модели транскрипции - диаризация требует активную модель
        if (!activeModelId) return;
        // Ждём подтверждения от backend, что модель действительно загружена
        // (не просто из localStorage, а реально активна на backend)
        if (!backendModelConfirmed.current) return;

        // FluidAudio (coreml) не требует моделей - модели скачиваются автоматически
        if (savedDiarizationProvider === 'coreml') {
            diarizationAutoEnableAttempted.current = true;
            console.log('[Diarization] Auto-enabling FluidAudio (coreml)...');
            addLog('Auto-enabling FluidAudio diarization...');

            setDiarizationLoading(true);
            setDiarizationError(null);

            wsRef.current?.send(JSON.stringify({
                type: 'enable_diarization',
                segmentationModelPath: '',
                embeddingModelPath: '',
                diarizationProvider: 'coreml'
            }));
            return;
        }

        // Для Sherpa-ONNX нужны модели
        if (!savedDiarizationSegModelId || !savedDiarizationEmbModelId) return;
        if (models.length === 0) return;

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
    }, [settingsLoaded, savedDiarizationEnabled, savedDiarizationSegModelId, savedDiarizationEmbModelId, savedDiarizationProvider, models, status, activeModelId, addLog]);

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
                vadMethod,
                useNativeCapture: screenCaptureKitAvailable && captureSystem,
                useVoiceIsolation: screenCaptureKitAvailable && captureSystem && useVoiceIsolation,
                echoCancel: captureSystem && !useVoiceIsolation ? echoCancel : 0,
                // Настройки гибридной транскрипции
                hybridEnabled: hybridTranscription.enabled,
                hybridSecondaryModelId: hybridTranscription.secondaryModelId,
                hybridConfidenceThreshold: hybridTranscription.confidenceThreshold,
                hybridContextWords: hybridTranscription.contextWords,
                hybridUseLLMForMerge: hybridTranscription.useLLMForMerge,
                hybridMode: hybridTranscription.mode,
                hybridHotwords: hybridTranscription.hotwords,
                hybridOllamaModel: ollamaModel,
                hybridOllamaUrl: ollamaUrl,
            }));
            addLog('start_session sent to backend');
        }
    };

    const handleViewSession = (sessionId: string) => {
        wsRef.current?.send(JSON.stringify({ type: 'get_session', sessionId }));
        // Запрашиваем спикеров для сессии
        wsRef.current?.send(JSON.stringify({ type: 'get_session_speakers', sessionId }));
    };

    // Вычисляем статистику сессий
    const sessionStats = useMemo(() => {
        if (sessions.length === 0) {
            return { totalSessions: 0, totalDuration: 0, avgDuration: 0, totalChunks: 0 };
        }

        let totalDuration = 0;
        let totalChunks = 0;

        sessions.forEach(session => {
            // Длительность в секундах
            totalDuration += (session.totalDuration || 0) / 1000;
            // Количество чанков
            totalChunks += session.chunksCount || 0;
        });

        return {
            totalSessions: sessions.length,
            totalDuration,
            avgDuration: totalDuration / sessions.length,
            totalChunks
        };
    }, [sessions]);

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
            language: language,
            // Передаём настройки гибридной транскрипции
            hybridEnabled: hybridTranscription.enabled,
            hybridSecondaryModelId: hybridTranscription.secondaryModelId,
            hybridConfidenceThreshold: hybridTranscription.confidenceThreshold,
            hybridContextWords: hybridTranscription.contextWords,
            hybridUseLLMForMerge: hybridTranscription.useLLMForMerge,
            hybridMode: hybridTranscription.mode,
            hybridHotwords: hybridTranscription.hotwords,
            // Передаём модель Ollama для LLM
            hybridOllamaModel: ollamaModel,
            hybridOllamaUrl: ollamaUrl,
        }));
        addLog(`Retranscribing chunk with model: ${activeModel?.name || 'default'}, language: ${language}, hybrid: ${hybridTranscription.enabled ? `${hybridTranscription.mode} (LLM: ${ollamaModel})` : 'disabled'}`);
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

        setDiarizationLoading(true);
        setDiarizationError(null);

        // FluidAudio (coreml) не требует моделей - они скачиваются автоматически
        if (provider === 'coreml') {
            setSavedDiarizationEnabled(true);
            setSavedDiarizationSegModelId('');
            setSavedDiarizationEmbModelId('');
            setSavedDiarizationProvider('coreml');

            wsRef.current.send(JSON.stringify({
                type: 'enable_diarization',
                segmentationModelPath: '',
                embeddingModelPath: '',
                diarizationProvider: 'coreml'
            }));
            addLog('Enabling FluidAudio diarization...');
            return;
        }

        // Для Sherpa-ONNX нужны модели
        const segModel = models.find(m => m.id === segModelId);
        const embModel = models.find(m => m.id === embModelId);

        if (!segModel?.path || !embModel?.path) {
            setDiarizationError('Модели не найдены или не скачаны');
            setDiarizationLoading(false);
            return;
        }

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
            localSpeakerId: localId,
            speakerName: name,
            saveAsVoiceprint
        }));
        addLog(`Renaming speaker ${localId} to "${name}"${saveAsVoiceprint ? ' (saving voiceprint)' : ''}`);
    }, [selectedSession, addLog]);

    // Остановка воспроизведения аудио-сэмпла
    const handleStopSpeakerSample = useCallback(() => {
        if (currentAudioRef.current) {
            currentAudioRef.current.pause();
            currentAudioRef.current.currentTime = 0;
            currentAudioRef.current = null;
        }
        setPlayingSpeakerId(null);
    }, []);

    // Воспроизведение аудио-сэмпла спикера
    const handlePlaySpeakerSample = useCallback((localId: number) => {
        if (!selectedSession) return;
        
        // Останавливаем предыдущее воспроизведение
        handleStopSpeakerSample();
        
        // Формируем URL для аудио-сэмпла
        const sampleUrl = `${API_BASE}/api/speaker-sample/${selectedSession.id}/${localId}`;
        
        // Создаём аудио элемент и воспроизводим
        const audio = new Audio(sampleUrl);
        currentAudioRef.current = audio;
        setPlayingSpeakerId(localId);
        
        audio.onended = () => {
            setPlayingSpeakerId(null);
            currentAudioRef.current = null;
        };
        
        audio.onerror = () => {
            setPlayingSpeakerId(null);
            currentAudioRef.current = null;
            addLog(`Failed to play speaker sample`);
        };
        
        audio.play().catch(err => {
            console.error('Failed to play speaker sample:', err);
            addLog(`Failed to play speaker sample: ${err.message}`);
            setPlayingSpeakerId(null);
            currentAudioRef.current = null;
        });
        
        addLog(`Playing sample for speaker ${localId}`);
    }, [selectedSession, addLog, handleStopSpeakerSample]);

    // === Voiceprints Management ===
    
    // Обновить список voiceprints
    const refreshVoiceprints = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== RPC_READY_STATE.OPEN) return;
        setVoiceprintsLoading(true);
        wsRef.current.send(JSON.stringify({ type: 'get_voiceprints' }));
    }, []);

    // Переименовать voiceprint
    const handleRenameVoiceprint = useCallback((id: string, name: string) => {
        if (!wsRef.current || wsRef.current.readyState !== RPC_READY_STATE.OPEN) return;
        
        wsRef.current.send(JSON.stringify({
            type: 'update_voiceprint',
            voiceprintId: id,
            name: name
        }));
        addLog(`Renaming voiceprint to "${name}"`);
    }, [addLog]);

    // Удалить voiceprint
    const handleDeleteVoiceprint = useCallback((id: string) => {
        if (!wsRef.current || wsRef.current.readyState !== RPC_READY_STATE.OPEN) return;
        
        wsRef.current.send(JSON.stringify({
            type: 'delete_voiceprint',
            voiceprintId: id
        }));
        addLog(`Deleting voiceprint ${id.substring(0, 8)}...`);
    }, [addLog]);

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

    // Поиск сессий с debounce
    const handleSearch = useCallback((query: string) => {
        setSearchQuery(query);
        
        // Очищаем предыдущий таймаут
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        // Если запрос пустой, сбрасываем результаты
        if (!query.trim()) {
            setSearchResults(null);
            setIsSearching(false);
            return;
        }

        // Debounce: отправляем запрос через 300ms после последнего ввода
        setIsSearching(true);
        searchTimeoutRef.current = setTimeout(() => {
            wsRef.current?.send(JSON.stringify({
                type: 'search_sessions',
                searchQuery: query.trim()
            }));
        }, 300);
    }, []);

    // Очистка поиска
    const clearSearch = useCallback(() => {
        setSearchQuery('');
        setSearchResults(null);
        setIsSearching(false);
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }
    }, []);

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

    const playFullRecording = useCallback((sessionId: string) => {
        setPlaybackOffset(0);
        playbackOffsetRef.current = 0;
        if (waveformData?.duration) {
            setPlaybackDuration(waveformData.duration);
        }
        playAudio(`${API_BASE}/api/sessions/${sessionId}/full.mp3`);
    }, [waveformData?.duration]);

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
        setIsAudioPlaying(false);
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

    // Генерация SRT субтитров
    const generateSRT = useCallback((session: Session): string => {
        const sessionChunks = session.chunks || [];

        // Собираем диалог с timestamps
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

        if (dialogue.length === 0) {
            return '';
        }

        // Форматирование времени для SRT: HH:MM:SS,mmm
        const formatSRTTime = (ms: number): string => {
            const totalSeconds = Math.floor(ms / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const milliseconds = ms % 1000;
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`;
        };

        // Генерация SRT
        return dialogue.map((seg, index) => {
            const { name: speaker } = getSpeakerDisplayName(seg.speaker);
            const startTime = formatSRTTime(seg.start);
            const endTime = formatSRTTime(seg.end);
            return `${index + 1}\n${startTime} --> ${endTime}\n${speaker}: ${seg.text}`;
        }).join('\n\n');
    }, [getSpeakerDisplayName]);

    // Скачивание как SRT файл
    const handleDownloadSRT = useCallback(() => {
        if (!selectedSession) return;

        const srt = generateSRT(selectedSession);
        if (!srt) {
            addLog('Нет данных для экспорта в SRT');
            return;
        }

        const date = new Date(selectedSession.startTime);
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.toTimeString().slice(0, 5).replace(':', '-');
        const filename = `transcription_${dateStr}_${timeStr}.srt`;

        const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
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
    }, [selectedSession, generateSRT, addLog]);

    // Генерация WebVTT субтитров
    const generateVTT = useCallback((session: Session): string => {
        const sessionChunks = session.chunks || [];

        // Собираем диалог с timestamps
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

        if (dialogue.length === 0) {
            return '';
        }

        // Форматирование времени для VTT: HH:MM:SS.mmm
        const formatVTTTime = (ms: number): string => {
            const totalSeconds = Math.floor(ms / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const milliseconds = ms % 1000;
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
        };

        // Генерация VTT (начинается с WEBVTT заголовка)
        const header = 'WEBVTT\n\n';
        const cues = dialogue.map((seg, index) => {
            const { name: speaker } = getSpeakerDisplayName(seg.speaker);
            const startTime = formatVTTTime(seg.start);
            const endTime = formatVTTTime(seg.end);
            return `${index + 1}\n${startTime} --> ${endTime}\n<v ${speaker}>${seg.text}`;
        }).join('\n\n');

        return header + cues;
    }, [getSpeakerDisplayName]);

    // Скачивание как VTT файл
    const handleDownloadVTT = useCallback(() => {
        if (!selectedSession) return;

        const vtt = generateVTT(selectedSession);
        if (!vtt) {
            addLog('Нет данных для экспорта в VTT');
            return;
        }

        const date = new Date(selectedSession.startTime);
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.toTimeString().slice(0, 5).replace(':', '-');
        const filename = `transcription_${dateStr}_${timeStr}.vtt`;

        const blob = new Blob([vtt], { type: 'text/vtt;charset=utf-8' });
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
    }, [selectedSession, generateVTT, addLog]);

    // Генерация JSON для программной обработки
    const generateJSON = useCallback((session: Session): string => {
        const sessionChunks = session.chunks || [];

        // Собираем диалог с timestamps
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

        const exportData = {
            metadata: {
                sessionId: session.id,
                startTime: session.startTime,
                totalDuration: session.totalDuration,
                chunksCount: sessionChunks.length,
                exportedAt: new Date().toISOString(),
                version: '1.0'
            },
            segments: dialogue.map((seg, index) => {
                const { name: speaker } = getSpeakerDisplayName(seg.speaker);
                return {
                    index,
                    start: seg.start,
                    end: seg.end,
                    duration: seg.end - seg.start,
                    speaker: speaker,
                    speakerId: seg.speaker,
                    text: seg.text
                };
            }),
            summary: session.summary || null
        };

        return JSON.stringify(exportData, null, 2);
    }, [getSpeakerDisplayName]);

    // Скачивание как JSON файл
    const handleDownloadJSON = useCallback(() => {
        if (!selectedSession) return;

        const json = generateJSON(selectedSession);
        if (!json || json === '{"metadata":{},"segments":[],"summary":null}') {
            addLog('Нет данных для экспорта в JSON');
            return;
        }

        const date = new Date(selectedSession.startTime);
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.toTimeString().slice(0, 5).replace(':', '-');
        const filename = `transcription_${dateStr}_${timeStr}.json`;

        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
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
    }, [selectedSession, generateJSON, addLog]);

    // Генерация Markdown
    const generateMarkdown = useCallback((session: Session): string => {
        const sessionChunks = session.chunks || [];

        // Собираем диалог с timestamps
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

        if (dialogue.length === 0) {
            return '';
        }

        const formatTime = (ms: number): string => {
            const totalSeconds = Math.floor(ms / 1000);
            const mins = Math.floor(totalSeconds / 60);
            const secs = totalSeconds % 60;
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        };

        const header = `# Транскрипция\n\n**Дата:** ${formatDate(session.startTime)}  \n**Длительность:** ${formatDuration(session.totalDuration / 1000)}\n\n---\n\n`;

        const dialogueText = dialogue.map(seg => {
            const { name: speaker } = getSpeakerDisplayName(seg.speaker);
            const timeStr = formatTime(seg.start);
            return `**[${timeStr}] ${speaker}:**  \n${seg.text}\n`;
        }).join('\n');

        const summarySection = session.summary 
            ? `\n---\n\n## Краткое содержание\n\n${session.summary}\n`
            : '';

        return header + dialogueText + summarySection;
    }, [getSpeakerDisplayName]);

    // Скачивание как Markdown файл
    const handleDownloadMarkdown = useCallback(() => {
        if (!selectedSession) return;

        const md = generateMarkdown(selectedSession);
        if (!md) {
            addLog('Нет данных для экспорта в Markdown');
            return;
        }

        const date = new Date(selectedSession.startTime);
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.toTimeString().slice(0, 5).replace(':', '-');
        const filename = `transcription_${dateStr}_${timeStr}.md`;

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
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
    }, [selectedSession, generateMarkdown, addLog]);

    // === Drag & Drop Import ===
    const SUPPORTED_AUDIO_FORMATS = ['mp3', 'wav', 'm4a', 'ogg', 'flac'];

    const handleImportFile = useCallback(async (file: File) => {
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (!ext || !SUPPORTED_AUDIO_FORMATS.includes(ext)) {
            addLog(`Неподдерживаемый формат файла: ${ext}. Поддерживаются: ${SUPPORTED_AUDIO_FORMATS.join(', ')}`);
            return;
        }

        const formData = new FormData();
        formData.append('audio', file);
        formData.append('model', activeModelId || 'ggml-large-v3-turbo');
        formData.append('language', language);

        setIsImporting(true);
        setImportProgress('Загрузка файла...');
        addLog(`Импорт файла: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

        try {
            const response = await fetch(`${API_BASE}/api/import`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || `HTTP ${response.status}`);
            }

            const result = await response.json();
            if (result.success) {
                addLog(`Файл импортирован: ${result.title}, длительность: ${Math.round(result.duration)}с`);
                setImportProgress('Транскрипция запущена...');
                // WebSocket события обновят прогресс и завершат импорт
            } else {
                throw new Error(result.error || 'Неизвестная ошибка');
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            addLog(`Ошибка импорта: ${errorMsg}`);
            setIsImporting(false);
            setImportProgress(null);
        }
    }, [activeModelId, language, addLog]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Проверяем, что это файл, а не текст
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragging(true);
        }
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Проверяем, что мы действительно покинули область (а не вошли в дочерний элемент)
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = e.clientX;
        const y = e.clientY;
        if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
            setIsDragging(false);
        }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        const files = Array.from(e.dataTransfer.files);
        const audioFile = files.find(f => {
            const ext = f.name.split('.').pop()?.toLowerCase();
            return ext && SUPPORTED_AUDIO_FORMATS.includes(ext);
        });

        if (audioFile) {
            handleImportFile(audioFile);
        } else if (files.length > 0) {
            addLog(`Файл ${files[0].name} не является поддерживаемым аудио форматом`);
        }
    }, [handleImportFile, addLog]);

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

    // Состояние для модального окна справки по горячим клавишам
    const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
    
    // Состояние для полной справки (Help menu)
    const [showHelp, setShowHelp] = useState(false);
    const [helpInitialTab, setHelpInitialTab] = useState<'guide' | 'shortcuts' | 'about'>('guide');

    // Обработчики IPC событий из системного меню
    useEffect(() => {
        if (!ipcRenderer) return;

        const handlers: { [key: string]: () => void } = {
            'show-help': () => {
                setHelpInitialTab('guide');
                setShowHelp(true);
            },
            'show-shortcuts': () => {
                setHelpInitialTab('shortcuts');
                setShowHelp(true);
            },
            'show-about': () => {
                setHelpInitialTab('about');
                setShowHelp(true);
            },
            'open-settings': () => {
                if (!isRecording) setShowSettings(true);
            },
            'start-recording': () => {
                if (!isRecording && status === 'Connected') handleStartStop();
            },
            'stop-recording': () => {
                if (isRecording) handleStartStop();
            },
            'copy-transcription': () => {
                if (selectedSession) handleCopyToClipboard();
            },
            'export-transcription': () => {
                if (selectedSession) setShowShareMenu(true);
            },
            'retranscribe-session': () => {
                if (selectedSession && !isRecording) handleFullRetranscribe();
            },
            'generate-summary': () => {
                if (selectedSession && !isRecording) handleGenerateSummary();
            },
            'delete-session': () => {
                if (selectedSession && !isRecording) setShowDeleteConfirm(true);
            },
            'toggle-playback': () => {
                if (!isRecording && selectedSession) {
                    if (playingAudio && isAudioPlaying) {
                        // Пауза
                        audioRef.current?.pause();
                    } else if (playingAudio && !isAudioPlaying) {
                        // Продолжить воспроизведение
                        audioRef.current?.play();
                    } else {
                        // Начать воспроизведение
                        playFullRecording(selectedSession.id);
                    }
                }
            },
        };

        // Регистрируем обработчики
        Object.entries(handlers).forEach(([event, handler]) => {
            ipcRenderer.on(event, handler);
        });

        // Очистка при размонтировании
        return () => {
            Object.entries(handlers).forEach(([event, handler]) => {
                ipcRenderer.removeListener(event, handler);
            });
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isRecording, status, selectedSession, playingAudio, isAudioPlaying, handleStartStop, handleCopyToClipboard, handleFullRetranscribe, handleGenerateSummary, playFullRecording]);

    // Горячие клавиши
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Игнорируем если фокус в текстовом поле
            const target = e.target as HTMLElement;
            const activeElement = document.activeElement as HTMLElement;
            
            // Проверяем и target и activeElement (для случаев когда событие всплывает)
            const isInInput = 
                target.tagName === 'INPUT' || 
                target.tagName === 'TEXTAREA' || 
                target.isContentEditable ||
                activeElement?.tagName === 'INPUT' ||
                activeElement?.tagName === 'TEXTAREA' ||
                activeElement?.isContentEditable;
            
            if (isInInput) {
                // Но разрешаем Escape для закрытия модалок
                if (e.code !== 'Escape') {
                    return;
                }
            }

            // Cmd/Ctrl + модификаторы
            const isMod = e.metaKey || e.ctrlKey;

            // ? или Shift+/ - Показать справку по горячим клавишам
            if ((e.key === '?' || (e.shiftKey && e.code === 'Slash')) && !isMod) {
                e.preventDefault();
                setShowKeyboardHelp(prev => !prev);
                return;
            }

            // Space - Play/Pause (только если не записываем)
            if (e.code === 'Space' && !isRecording && selectedSession) {
                e.preventDefault();
                if (playingAudio && isAudioPlaying) {
                    // Пауза - не сбрасываем playingAudio, только ставим на паузу
                    audioRef.current?.pause();
                } else if (playingAudio && !isAudioPlaying) {
                    // Продолжить воспроизведение с текущей позиции
                    audioRef.current?.play();
                } else {
                    // Начать воспроизведение
                    playFullRecording(selectedSession.id);
                }
                return;
            }

            // R - Start/Stop Recording
            if (e.code === 'KeyR' && !isMod) {
                e.preventDefault();
                handleStartStop();
                return;
            }

            // Cmd/Ctrl + F - Focus on search
            if (isMod && e.code === 'KeyF') {
                e.preventDefault();
                const searchInput = document.querySelector('input[placeholder*="Поиск"]') as HTMLInputElement;
                if (searchInput) {
                    searchInput.focus();
                    searchInput.select();
                }
                return;
            }

            // Cmd/Ctrl + 1-9 - Quick access to sessions
            if (isMod && e.code.match(/^Digit[1-9]$/)) {
                e.preventDefault();
                const index = parseInt(e.code.replace('Digit', ''), 10) - 1;
                if (sessions[index]) {
                    handleViewSession(sessions[index].id);
                }
                return;
            }

            // Arrow Up/Down - Navigate sessions (when not playing)
            if (!playingAudio && sessions.length > 0) {
                if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
                    e.preventDefault();
                    const currentIndex = selectedSession 
                        ? sessions.findIndex(s => s.id === selectedSession.id)
                        : -1;
                    
                    let newIndex: number;
                    if (e.code === 'ArrowUp') {
                        newIndex = currentIndex <= 0 ? sessions.length - 1 : currentIndex - 1;
                    } else {
                        newIndex = currentIndex >= sessions.length - 1 ? 0 : currentIndex + 1;
                    }
                    
                    if (sessions[newIndex]) {
                        handleViewSession(sessions[newIndex].id);
                    }
                    return;
                }
            }

            // Cmd/Ctrl + C - Copy transcription (когда нет выделения)
            if (isMod && e.code === 'KeyC' && !window.getSelection()?.toString() && selectedSession) {
                // Не перехватываем стандартное копирование если есть выделение
                return;
            }

            // Cmd/Ctrl + S - Download as txt
            if (isMod && e.code === 'KeyS' && selectedSession) {
                e.preventDefault();
                handleDownloadFile();
                return;
            }

            // Cmd/Ctrl + E - Export menu toggle
            if (isMod && e.code === 'KeyE' && selectedSession) {
                e.preventDefault();
                setShowShareMenu(prev => !prev);
                return;
            }

            // Escape - Close menus/modals
            if (e.code === 'Escape') {
                if (showKeyboardHelp) {
                    setShowKeyboardHelp(false);
                    return;
                }
                if (showShareMenu) {
                    setShowShareMenu(false);
                }
                if (showModelManager) {
                    setShowModelManager(false);
                }
                return;
            }

            // Arrow Left/Right - Seek (when playing)
            if (playingAudio && audioRef.current) {
                if (e.code === 'ArrowLeft') {
                    e.preventDefault();
                    audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 5);
                    return;
                }
                if (e.code === 'ArrowRight') {
                    e.preventDefault();
                    audioRef.current.currentTime = Math.min(
                        audioRef.current.duration || 0,
                        audioRef.current.currentTime + 5
                    );
                    return;
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isRecording, selectedSession, playingAudio, showShareMenu, showModelManager, showKeyboardHelp, sessions, handleStartStop, handleDownloadFile, handleViewSession]);

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

    // Вычисляем текущий сегмент по времени воспроизведения
    const currentTimeMs = playbackTime * 1000; // секунды -> миллисекунды
    const currentSegmentIndex = useMemo(() => {
        if (!isAudioPlaying || allDialogue.length === 0) return -1;
        
        // Ищем сегмент, в который попадает текущее время
        for (let i = 0; i < allDialogue.length; i++) {
            const seg = allDialogue[i];
            if (currentTimeMs >= seg.start && currentTimeMs < seg.end) {
                return i;
            }
            // Если между сегментами - показываем предыдущий
            if (i < allDialogue.length - 1 && currentTimeMs >= seg.end && currentTimeMs < allDialogue[i + 1].start) {
                return i;
            }
        }
        // Если после последнего сегмента
        if (allDialogue.length > 0 && currentTimeMs >= allDialogue[allDialogue.length - 1].start) {
            return allDialogue.length - 1;
        }
        return -1;
    }, [currentTimeMs, isAudioPlaying, allDialogue]);

    // Автоскролл к текущему сегменту при воспроизведении
    useEffect(() => {
        if (!isAudioPlaying || !autoScrollToPlayback || currentSegmentIndex < 0) return;
        
        const segmentEl = segmentRefs.current.get(currentSegmentIndex);
        if (segmentEl && transcriptionRef.current) {
            const container = transcriptionRef.current;
            const segmentRect = segmentEl.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            
            // Скроллим только если сегмент вне видимой области
            const isVisible = segmentRect.top >= containerRect.top && segmentRect.bottom <= containerRect.bottom;
            if (!isVisible) {
                segmentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }, [currentSegmentIndex, isAudioPlaying, autoScrollToPlayback]);

    // Сохраняем ref для сегмента
    const setSegmentRef = useCallback((idx: number, el: HTMLDivElement | null) => {
        if (el) {
            segmentRefs.current.set(idx, el);
        } else {
            segmentRefs.current.delete(idx);
        }
    }, []);

    // Обработчик клика по сегменту для перемотки
    const handleSegmentClick = useCallback((segmentStart: number) => {
        const el = audioRef.current;
        if (!el) return;
        const timeInSeconds = segmentStart / 1000;
        el.currentTime = timeInSeconds;
        setPlaybackTime(timeInSeconds);
    }, []);

    return (
        <div 
            className="app-frame" 
            style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--app-bg)', color: 'var(--text-primary)', position: 'relative' }}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* Global Drag Overlay */}
            {isDragging && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(139, 92, 246, 0.15)',
                    backdropFilter: 'blur(4px)',
                    zIndex: 9999,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                }}>
                    <div style={{
                        background: 'var(--surface)',
                        borderRadius: 'var(--radius-xl)',
                        padding: '3rem 4rem',
                        border: '3px dashed var(--primary)',
                        textAlign: 'center',
                        boxShadow: 'var(--shadow-glass)',
                    }}>
                        <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>📥</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            Отпустите для импорта
                        </div>
                        <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                            MP3, WAV, M4A, OGG, FLAC
                        </div>
                    </div>
                </div>
            )}

            {/* Hidden audio element */}
            <audio
                ref={audioRef}
                crossOrigin="anonymous"
                onEnded={handleAudioEnded}
                onPlay={() => setIsAudioPlaying(true)}
                onPause={() => setIsAudioPlaying(false)}
                onTimeUpdate={(e) => {
                    const t = (e.target as HTMLAudioElement).currentTime;
                    lastPlaybackTimeRef.current = t;
                    setPlaybackTime(t);
                }}
                onLoadedMetadata={(e) => setPlaybackDuration((e.target as HTMLAudioElement).duration)}
                style={{ display: 'none' }}
            />

            {/* Main content wrapper - contains sidebars and content */}
            <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

            {/* Left Sidebar - Sessions List - Liquid Glass Style */}
            <aside
                className="glass-surface-elevated"
                style={{
                    position: 'relative', // For recording overlay positioning
                    width: '260px',
                    minWidth: '260px',
                    flexShrink: 0,
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
                        <button
                            className="btn-icon btn-icon-sm"
                            onClick={() => setShowSessionStats(!showSessionStats)}
                            title="Статистика"
                            style={{
                                width: '32px',
                                height: '32px',
                                background: showSessionStats ? 'var(--primary-alpha)' : undefined,
                            }}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="20" x2="18" y2="10"/>
                                <line x1="12" y1="20" x2="12" y2="4"/>
                                <line x1="6" y1="20" x2="6" y2="14"/>
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Search Field */}
                <div style={{ padding: '0 1rem 0.75rem' }}>
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="var(--text-muted)"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{
                                position: 'absolute',
                                left: '0.75rem',
                                pointerEvents: 'none',
                                opacity: 0.6,
                            }}
                        >
                            <circle cx="11" cy="11" r="8"/>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                        <input
                            type="text"
                            placeholder="Поиск записей..."
                            value={searchQuery}
                            onChange={(e) => handleSearch(e.target.value)}
                            style={{
                                width: '100%',
                                padding: '0.5rem 2rem 0.5rem 2.25rem',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--glass-border-subtle)',
                                background: 'var(--surface-alpha)',
                                color: 'var(--text-primary)',
                                fontSize: '0.85rem',
                                outline: 'none',
                                transition: 'border-color 0.2s, box-shadow 0.2s',
                            }}
                            onFocus={(e) => {
                                e.target.style.borderColor = 'var(--primary)';
                                e.target.style.boxShadow = '0 0 0 2px var(--primary-alpha)';
                            }}
                            onBlur={(e) => {
                                e.target.style.borderColor = 'var(--glass-border-subtle)';
                                e.target.style.boxShadow = 'none';
                            }}
                        />
                        {searchQuery && (
                            <button
                                onClick={clearSearch}
                                style={{
                                    position: 'absolute',
                                    right: '0.5rem',
                                    padding: '0.25rem',
                                    background: 'transparent',
                                    border: 'none',
                                    cursor: 'pointer',
                                    color: 'var(--text-muted)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    borderRadius: '50%',
                                }}
                                title="Очистить поиск"
                            >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18"/>
                                    <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        )}
                    </div>
                    {searchQuery && (
                        <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {isSearching ? 'Поиск...' : searchResults ? `Найдено: ${searchResults.length}` : ''}
                        </div>
                    )}
                </div>

                {/* Stats Panel */}
                {showSessionStats && sessions.length > 0 && !searchQuery && (
                    <div
                        style={{
                            padding: '0.75rem 1rem',
                            borderBottom: '1px solid var(--glass-border-subtle)',
                            background: 'var(--surface-alpha)',
                        }}
                    >
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--primary)' }}>
                                    {sessionStats.totalSessions}
                                </div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Записей
                                </div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--success)' }}>
                                    {formatDurationUtil(sessionStats.totalDuration)}
                                </div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Всего
                                </div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--warning)' }}>
                                    {formatDurationUtil(sessionStats.avgDuration)}
                                </div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Средняя
                                </div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--info)' }}>
                                    {sessionStats.totalChunks}
                                </div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Чанков
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Batch Export Panel - показывается когда выбрано несколько сессий */}
                {selectedSessionIds.size > 0 && (
                    <div
                        style={{
                            padding: '0.75rem 1rem',
                            borderBottom: '1px solid var(--glass-border-subtle)',
                            background: 'rgba(139, 92, 246, 0.1)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '0.5rem',
                        }}
                    >
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                            <span style={{ fontWeight: 600 }}>{selectedSessionIds.size}</span>
                            <span style={{ color: 'var(--text-muted)', marginLeft: '4px' }}>
                                {selectedSessionIds.size === 1 ? 'запись' : selectedSessionIds.size < 5 ? 'записи' : 'записей'}
                            </span>
                        </div>
                        <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                                onClick={() => setShowBatchExportModal(true)}
                                style={{
                                    padding: '4px 10px',
                                    fontSize: '0.75rem',
                                    background: 'var(--primary)',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontWeight: 500,
                                }}
                            >
                                📦 Экспорт
                            </button>
                            <button
                                onClick={() => setSelectedSessionIds(new Set())}
                                style={{
                                    padding: '4px 8px',
                                    fontSize: '0.75rem',
                                    background: 'transparent',
                                    color: 'var(--text-muted)',
                                    border: '1px solid var(--border)',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                }}
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                )}

                {/* Sessions List with Grouping */}
                <div
                    className="scroll-soft-edges"
                    style={{ flex: 1, overflowY: 'auto', paddingBottom: '1rem' }}
                >
                    {/* Показываем результаты поиска если есть запрос */}
                    {searchQuery && searchResults !== null ? (
                        searchResults.length === 0 ? (
                            <div style={{
                                padding: '2rem 1rem',
                                color: 'var(--text-muted)',
                                textAlign: 'center',
                                fontSize: '0.9rem',
                            }}>
                                Ничего не найдено
                            </div>
                        ) : (
                            <div>
                                {searchResults.map((s) => {
                                    const isSelected = selectedSession?.id === s.id;
                                    const durationSec = s.totalDuration / 1000;

                                    return (
                                        <div
                                            key={s.id}
                                            className={`session-item ${isSelected ? 'selected' : ''}`}
                                            onClick={() => {
                                                handleViewSession(s.id);
                                                clearSearch();
                                            }}
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

                                            {/* Match Context - показываем где найдено */}
                                            {s.matchContext && (
                                                <div style={{
                                                    fontSize: '0.8rem',
                                                    color: 'var(--text-secondary)',
                                                    marginBottom: '0.35rem',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                    fontStyle: 'italic',
                                                    background: 'rgba(139, 92, 246, 0.1)',
                                                    padding: '0.25rem 0.5rem',
                                                    borderRadius: '4px',
                                                }}>
                                                    "{s.matchContext}"
                                                </div>
                                            )}

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
                        )
                    ) : sessions.length === 0 ? (
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

                                    const isMultiSelected = selectedSessionIds.has(s.id);

                                    return (
                                        <div
                                            key={s.id}
                                            className={`session-item ${isSelected ? 'selected' : ''} ${isMultiSelected ? 'multi-selected' : ''}`}
                                            onClick={(e) => {
                                                if (e.metaKey || e.ctrlKey) {
                                                    // Мультиселект: ⌘+click или Ctrl+click
                                                    e.preventDefault();
                                                    setSelectedSessionIds(prev => {
                                                        const newSet = new Set(prev);
                                                        if (newSet.has(s.id)) {
                                                            newSet.delete(s.id);
                                                        } else {
                                                            newSet.add(s.id);
                                                        }
                                                        return newSet;
                                                    });
                                                } else {
                                                    // Обычный клик: выбор сессии
                                                    handleViewSession(s.id);
                                                    // Сбрасываем мультиселект при обычном клике
                                                    setSelectedSessionIds(new Set());
                                                }
                                            }}
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
                        title="Начать запись (R)"
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
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
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
                    vadMethod={vadMethod}
                    setVADMethod={setVADMethod}
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
                    ollamaContextSize={8}
                    setOllamaContextSize={() => {}}
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
                    // Гибридная транскрипция
                    hybridTranscription={hybridTranscription}
                    onHybridTranscriptionChange={setHybridTranscription}
                    // Voiceprints (сохранённые голоса)
                    voiceprints={voiceprints}
                    voiceprintsLoading={voiceprintsLoading}
                    onRenameVoiceprint={handleRenameVoiceprint}
                    onDeleteVoiceprint={handleDeleteVoiceprint}
                    onRefreshVoiceprints={refreshVoiceprints}
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
                                            onClick={() => {
                                                if (playingAudio?.includes(selectedSession.id) && isAudioPlaying) {
                                                    // Пауза
                                                    audioRef.current?.pause();
                                                } else if (playingAudio?.includes(selectedSession.id) && !isAudioPlaying) {
                                                    // Продолжить воспроизведение
                                                    audioRef.current?.play();
                                                } else {
                                                    // Начать воспроизведение
                                                    playFullRecording(selectedSession.id);
                                                }
                                            }}
                                            title={playingAudio?.includes(selectedSession.id) && isAudioPlaying ? 'Пауза (Space)' : 'Слушать запись (Space)'}
                                            style={{
                                                width: '56px',
                                                height: '56px',
                                                padding: 0,
                                                background: playingAudio?.includes(selectedSession.id) && isAudioPlaying
                                                    ? 'linear-gradient(135deg, #f44336, #e91e63)'
                                                    : 'linear-gradient(135deg, #6c5ce7, #a29bfe)',
                                                color: '#fff',
                                                border: 'none',
                                                borderRadius: '50%',
                                                cursor: 'pointer',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                boxShadow: playingAudio?.includes(selectedSession.id) && isAudioPlaying
                                                    ? '0 4px 20px rgba(244, 67, 54, 0.4)'
                                                    : '0 4px 20px rgba(108, 92, 231, 0.4)',
                                                transition: 'all 0.3s ease',
                                                transform: 'scale(1)',
                                                flexShrink: 0
                                            }}
                                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; }}
                                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                                        >
                                            {playingAudio?.includes(selectedSession.id) && isAudioPlaying ? (
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
                                                    title="Экспорт (⌘E)"
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
                                                        <button onClick={handleDownloadSRT} style={{ width: '100%', padding: '0.6rem 1rem', background: 'none', border: 'none', color: 'var(--text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem' }}>
                                                            🎬 Скачать .srt (субтитры)
                                                        </button>
                                                        <button onClick={handleDownloadVTT} style={{ width: '100%', padding: '0.6rem 1rem', background: 'none', border: 'none', color: 'var(--text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem' }}>
                                                            🌐 Скачать .vtt (WebVTT)
                                                        </button>
                                                        <div style={{ borderTop: '1px solid var(--border)', margin: '0.3rem 0' }} />
                                                        <button onClick={handleDownloadJSON} style={{ width: '100%', padding: '0.6rem 1rem', background: 'none', border: 'none', color: 'var(--text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem' }}>
                                                            📊 Скачать .json (данные)
                                                        </button>
                                                        <button onClick={handleDownloadMarkdown} style={{ width: '100%', padding: '0.6rem 1rem', background: 'none', border: 'none', color: 'var(--text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem' }}>
                                                            📝 Скачать .md (Markdown)
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
                    <div 
                        ref={transcriptionRef} 
                        style={{ flex: 1, padding: '1rem 1.5rem', overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}
                        onScroll={() => {
                            // Отключаем автоскролл при ручной прокрутке во время воспроизведения
                            if (isAudioPlaying) setAutoScrollToPlayback(false);
                        }}
                    >
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

                                {/* Drop Zone for Audio Import */}
                                <div
                                    onDragOver={handleDragOver}
                                    onDragEnter={handleDragEnter}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    style={{
                                        marginTop: '1.5rem',
                                        padding: '1.25rem 2rem',
                                        border: `2px dashed ${isDragging ? 'var(--primary)' : 'var(--glass-border)'}`,
                                        borderRadius: 'var(--radius-xl)',
                                        background: isDragging ? 'rgba(139, 92, 246, 0.1)' : 'var(--surface)',
                                        textAlign: 'center',
                                        transition: 'all 0.2s ease',
                                        width: '100%',
                                        maxWidth: '420px',
                                        cursor: 'pointer',
                                        transform: isDragging ? 'scale(1.02)' : 'scale(1)',
                                    }}
                                >
                                    {isImporting ? (
                                        <>
                                            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.75rem' }}>
                                                {importProgress || 'Идет транскрибирование'}
                                            </div>
                                            <div style={{
                                                width: '100%',
                                                height: '4px',
                                                background: 'var(--glass-border)',
                                                borderRadius: '2px',
                                                overflow: 'hidden',
                                            }}>
                                                <div style={{
                                                    width: '30%',
                                                    height: '100%',
                                                    background: 'linear-gradient(90deg, var(--primary), var(--primary-dark))',
                                                    borderRadius: '2px',
                                                    animation: 'importProgress 1.5s ease-in-out infinite',
                                                }} />
                                            </div>
                                            <style>{`
                                                @keyframes importProgress {
                                                    0% { transform: translateX(-100%); }
                                                    100% { transform: translateX(400%); }
                                                }
                                            `}</style>
                                        </>
                                    ) : (
                                        <div style={{ 
                                            fontSize: '0.95rem', 
                                            color: isDragging ? 'var(--primary)' : 'var(--text-muted)',
                                            fontWeight: isDragging ? 600 : 400,
                                        }}>
                                            {isDragging ? 'Отпустите для импорта' : 'Перетащите сюда MP3, WAV, M4A, OGG или FLAC'}
                                        </div>
                                    )}
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
                                            <div 
                                                ref={dialogueContainerRef}
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
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                                    <h4 style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Диалог</h4>
                                                    {isAudioPlaying && (
                                                        <button
                                                            onClick={() => setAutoScrollToPlayback(!autoScrollToPlayback)}
                                                            style={{
                                                                padding: '4px 8px',
                                                                fontSize: '0.75rem',
                                                                backgroundColor: autoScrollToPlayback ? 'var(--primary)' : 'transparent',
                                                                color: autoScrollToPlayback ? 'white' : 'var(--text-muted)',
                                                                border: '1px solid var(--border)',
                                                                borderRadius: '4px',
                                                                cursor: 'pointer',
                                                                transition: 'all 0.2s'
                                                            }}
                                                            title={autoScrollToPlayback ? 'Автоскролл включён' : 'Автоскролл выключен'}
                                                        >
                                                            {autoScrollToPlayback ? '📍 Следить' : '📍 Не следить'}
                                                        </button>
                                                    )}
                                                </div>
                                                {allDialogue.map((seg, idx) => {
                                                    const { name: speakerName, color: speakerColor } = getSpeakerDisplayName(seg.speaker);
                                                    const totalMs = seg.start;
                                                    const mins = Math.floor(totalMs / 60000);
                                                    const secs = Math.floor((totalMs % 60000) / 1000);
                                                    const ms = Math.floor((totalMs % 1000) / 100); // десятые доли секунды
                                                    const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;
                                                    const isCurrentSegment = idx === currentSegmentIndex;

                                                    // Книжный формат: [00:05.4] Вы: Текст реплики
                                                    return (
                                                        <div 
                                                            key={idx} 
                                                            ref={(el) => setSegmentRef(idx, el)}
                                                            onClick={() => handleSegmentClick(seg.start)}
                                                            style={{
                                                                marginBottom: '0.5rem',
                                                                paddingLeft: '0.5rem',
                                                                paddingRight: '0.5rem',
                                                                paddingTop: '0.25rem',
                                                                paddingBottom: '0.25rem',
                                                                borderLeft: `3px solid ${isCurrentSegment ? 'var(--primary)' : speakerColor}`,
                                                                backgroundColor: isCurrentSegment ? 'rgba(138, 43, 226, 0.15)' : 'transparent',
                                                                borderRadius: isCurrentSegment ? '0 4px 4px 0' : '0',
                                                                transition: 'all 0.2s ease',
                                                                cursor: 'pointer',
                                                                position: 'relative'
                                                            }}
                                                        >
                                                            {/* Индикатор текущего сегмента */}
                                                            {isCurrentSegment && (
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
                                                            <span style={{
                                                                color: isCurrentSegment ? 'var(--primary)' : 'var(--text-muted)',
                                                                fontSize: '0.8rem',
                                                                fontFamily: 'monospace',
                                                                fontWeight: isCurrentSegment ? 'bold' : 'normal'
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
                                                            <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>
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
                                                            {chunk.processingTime && chunk.processingTime > 0 && (
                                                                <span style={{ marginLeft: '0.3rem', color: '#9c27b0', fontSize: '0.75rem' }} title="Real-Time Factor (скорость обработки)">
                                                                    {((chunk.duration / 1000000000) / (chunk.processingTime / 1000)).toFixed(1)}x
                                                                </span>
                                                            )}
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
                                        onPlaySample={handlePlaySpeakerSample}
                                        onStopSample={handleStopSpeakerSample}
                                        playingSpeakerId={playingSpeakerId}
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

                                {/* Tab: Stats */}
                                {activeTab === 'stats' && displaySession && (
                                    <SessionStats
                                        dialogue={allDialogue}
                                        totalDuration={displaySession.totalDuration / 1000000}
                                    />
                                )}
                            </>
                        )}
                    </div>
                </main>
            </div>
            {/* End of Main Content div */}

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
            </div>
            {/* End of main content wrapper */}

            {/* Console - на всю ширину внизу */}
            <footer style={{
                height: consoleExpanded ? '150px' : '32px',
                borderTop: '1px solid #333',
                backgroundColor: '#0a0a14',
                transition: 'height 0.2s ease-out',
                overflow: 'hidden',
                flexShrink: 0
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

            {/* Batch Export Modal */}
            {showBatchExportModal && (
                <BatchExportModal
                    sessionIds={Array.from(selectedSessionIds)}
                    onClose={() => setShowBatchExportModal(false)}
                    onExportComplete={() => {
                        setShowBatchExportModal(false);
                        setSelectedSessionIds(new Set());
                    }}
                />
            )}

            {/* Help Modal (from system menu) */}
            <HelpModal
                isOpen={showHelp}
                onClose={() => setShowHelp(false)}
                initialTab={helpInitialTab}
                appVersion="1.35.0"
            />

            {/* Keyboard Shortcuts Help Modal */}
            {showKeyboardHelp && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.6)',
                        backdropFilter: 'blur(8px)',
                        WebkitBackdropFilter: 'blur(8px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                    }}
                    onClick={() => setShowKeyboardHelp(false)}
                >
                    <div
                        style={{
                            background: 'var(--surface-strong)',
                            borderRadius: '16px',
                            border: '1px solid var(--border)',
                            padding: '24px',
                            maxWidth: '500px',
                            width: '90%',
                            maxHeight: '80vh',
                            overflowY: 'auto',
                            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.4)',
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                            <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 600 }}>⌨️ Горячие клавиши</h2>
                            <button
                                onClick={() => setShowKeyboardHelp(false)}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--text-muted)',
                                    fontSize: '1.5rem',
                                    cursor: 'pointer',
                                    padding: '4px 8px',
                                    lineHeight: 1,
                                }}
                            >
                                ×
                            </button>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            {/* Навигация */}
                            <div>
                                <h3 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 500 }}>
                                    Навигация
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    <KeyboardShortcut keys={['↑', '↓']} description="Переключение между записями" />
                                    <KeyboardShortcut keys={['⌘', '1-9']} description="Быстрый доступ к записи по номеру" />
                                    <KeyboardShortcut keys={['⌘', 'F']} description="Фокус на поиске" />
                                </div>
                            </div>

                            {/* Воспроизведение */}
                            <div>
                                <h3 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 500 }}>
                                    Воспроизведение
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    <KeyboardShortcut keys={['Space']} description="Воспроизведение / Пауза" />
                                    <KeyboardShortcut keys={['←']} description="Перемотка назад на 5 сек" />
                                    <KeyboardShortcut keys={['→']} description="Перемотка вперёд на 5 сек" />
                                </div>
                            </div>

                            {/* Запись */}
                            <div>
                                <h3 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 500 }}>
                                    Запись
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    <KeyboardShortcut keys={['R']} description="Начать / Остановить запись" />
                                </div>
                            </div>

                            {/* Экспорт */}
                            <div>
                                <h3 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 500 }}>
                                    Экспорт
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    <KeyboardShortcut keys={['⌘', 'S']} description="Скачать как TXT" />
                                    <KeyboardShortcut keys={['⌘', 'E']} description="Меню экспорта" />
                                </div>
                            </div>

                            {/* Общие */}
                            <div>
                                <h3 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 500 }}>
                                    Общие
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    <KeyboardShortcut keys={['?']} description="Показать эту справку" />
                                    <KeyboardShortcut keys={['Esc']} description="Закрыть модальные окна" />
                                </div>
                            </div>
                        </div>

                        <div style={{ 
                            marginTop: '20px', 
                            paddingTop: '16px', 
                            borderTop: '1px solid var(--border)',
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            textAlign: 'center',
                        }}>
                            Нажмите <kbd style={{ 
                                padding: '2px 6px', 
                                background: 'var(--glass-bg)', 
                                borderRadius: '4px',
                                border: '1px solid var(--border)',
                            }}>Esc</kbd> или кликните вне окна для закрытия
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Компонент для отображения горячей клавиши
const KeyboardShortcut: React.FC<{ keys: string[]; description: string }> = ({ keys, description }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{description}</span>
        <div style={{ display: 'flex', gap: '4px' }}>
            {keys.map((key, idx) => (
                <kbd
                    key={idx}
                    style={{
                        padding: '3px 8px',
                        background: 'var(--glass-bg)',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        fontSize: '0.8rem',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                        minWidth: '24px',
                        textAlign: 'center',
                    }}
                >
                    {key}
                </kbd>
            ))}
        </div>
    </div>
);

// Компонент модального окна batch export
const BatchExportModal: React.FC<{
    sessionIds: string[];
    onClose: () => void;
    onExportComplete: () => void;
}> = ({ sessionIds, onClose, onExportComplete }) => {
    const [format, setFormat] = useState<'txt' | 'srt' | 'vtt' | 'json' | 'md'>('txt');
    const [isExporting, setIsExporting] = useState(false);

    const handleExport = async () => {
        setIsExporting(true);
        try {
            const response = await fetch(`http://localhost:${process.env.AIWISPER_HTTP_PORT || 18080}/api/export/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionIds, format }),
            });

            if (!response.ok) {
                throw new Error('Export failed');
            }

            // Скачиваем ZIP файл
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `aiwisper-export-${new Date().toISOString().split('T')[0]}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);

            onExportComplete();
        } catch (error) {
            console.error('Batch export failed:', error);
            alert('Ошибка экспорта. Попробуйте ещё раз.');
        } finally {
            setIsExporting(false);
        }
    };

    const formats = [
        { id: 'txt', label: 'Текст (.txt)', icon: '📝' },
        { id: 'srt', label: 'Субтитры (.srt)', icon: '🎬' },
        { id: 'vtt', label: 'WebVTT (.vtt)', icon: '🌐' },
        { id: 'json', label: 'JSON (.json)', icon: '📊' },
        { id: 'md', label: 'Markdown (.md)', icon: '📄' },
    ] as const;

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.6)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 10000,
            }}
            onClick={onClose}
        >
            <div
                style={{
                    background: 'var(--surface-strong)',
                    borderRadius: '16px',
                    border: '1px solid var(--border)',
                    padding: '24px',
                    maxWidth: '400px',
                    width: '90%',
                    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.4)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 600 }}>📦 Экспорт записей</h2>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-muted)',
                            fontSize: '1.5rem',
                            cursor: 'pointer',
                            padding: '4px 8px',
                            lineHeight: 1,
                        }}
                    >
                        ×
                    </button>
                </div>

                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                    Выбрано записей: <strong>{sessionIds.length}</strong>
                </p>

                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                        Формат экспорта:
                    </label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {formats.map((f) => (
                            <label
                                key={f.id}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '10px',
                                    padding: '10px 12px',
                                    background: format === f.id ? 'rgba(139, 92, 246, 0.15)' : 'var(--glass-bg)',
                                    borderRadius: '8px',
                                    border: format === f.id ? '1px solid var(--primary)' : '1px solid transparent',
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease',
                                }}
                            >
                                <input
                                    type="radio"
                                    name="format"
                                    value={f.id}
                                    checked={format === f.id}
                                    onChange={() => setFormat(f.id)}
                                    style={{ accentColor: 'var(--primary)' }}
                                />
                                <span style={{ fontSize: '1.1rem' }}>{f.icon}</span>
                                <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{f.label}</span>
                            </label>
                        ))}
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    <button
                        onClick={onClose}
                        style={{
                            padding: '10px 20px',
                            background: 'transparent',
                            border: '1px solid var(--border)',
                            borderRadius: '8px',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            fontSize: '0.9rem',
                        }}
                    >
                        Отмена
                    </button>
                    <button
                        onClick={handleExport}
                        disabled={isExporting}
                        style={{
                            padding: '10px 20px',
                            background: 'var(--primary)',
                            border: 'none',
                            borderRadius: '8px',
                            color: 'white',
                            cursor: isExporting ? 'wait' : 'pointer',
                            fontSize: '0.9rem',
                            fontWeight: 500,
                            opacity: isExporting ? 0.7 : 1,
                        }}
                    >
                        {isExporting ? '⏳ Экспорт...' : '📥 Скачать ZIP'}
                    </button>
                </div>

                <p style={{ 
                    fontSize: '0.75rem', 
                    color: 'var(--text-muted)', 
                    marginTop: '16px',
                    textAlign: 'center',
                }}>
                    💡 Совет: используйте ⌘+Click для выбора нескольких записей
                </p>
            </div>
        </div>
    );
};

export default App;
