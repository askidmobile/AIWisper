export interface TranscriptWord {
    start: number;
    end: number;
    text: string;
    p: number;
    speaker?: string;
}

export interface TranscriptSegment {
    start: number;
    end: number;
    text: string;
    words?: TranscriptWord[];
    speaker?: string;
}

export interface Chunk {
    id: string;
    index: number;
    startMs: number;
    endMs: number;
    duration: number;
    transcription: string; // Полный текст
    micText?: string;      // Текст с микрофона
    sysText?: string;      // Текст системы
    dialogue?: TranscriptSegment[]; // Диалог
    micSegments?: TranscriptSegment[];
    sysSegments?: TranscriptSegment[];
    isStereo: boolean;
    status: 'pending' | 'transcribing' | 'completed' | 'error';
    error?: string;
    micFilePath?: string;
    sysFilePath?: string;
    filePath?: string;
}

export interface WaveformData {
    peaks: number[][];
    rms: number[][];
    rmsAbsolute: number[][];
    sampleDuration: number;
    duration: number;
    sampleCount: number;
    channelCount: number;
}

export interface Session {
    id: string;
    startTime: string; // ISO string
    endTime?: string;  // ISO string
    status: 'active' | 'completed' | 'recording' | 'failed';
    chunks: Chunk[];
    dataDir: string;
    totalDuration: number;
    title?: string;
    summary?: string;
    language?: string;
    model?: string;
    sampleCount?: number;
    waveform?: WaveformData; // Cached waveform data
}

export interface SessionInfo {
    id: string;
    startTime: string;
    status: string;
    totalDuration: number;
    chunksCount: number;
    title?: string;
}
