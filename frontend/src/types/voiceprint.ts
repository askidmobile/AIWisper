// Типы для системы голосовых отпечатков (VoicePrints)

export interface VoicePrint {
    id: string;
    name: string;
    embedding: number[];  // 256-мерный вектор
    createdAt: string;    // ISO date
    updatedAt: string;
    lastSeenAt: string;
    seenCount: number;
    samplePath?: string;
    source?: 'mic' | 'sys';
    notes?: string;
}

export interface SessionSpeaker {
    localId: number;        // ID в рамках сессии (-1 для "Вы", 0+ для собеседников)
    globalId?: string;      // UUID из VoicePrint (если распознан)
    displayName: string;    // "Вы", "Иван", "Собеседник 1"
    isRecognized: boolean;  // Был ли распознан из базы
    isMic: boolean;         // Это микрофон (всегда "Вы")
    segmentCount: number;   // Количество сегментов речи
    totalDuration: number;  // Общая длительность речи (сек)
    hasSample?: boolean;    // Есть ли аудио сэмпл для воспроизведения
}

export interface VoicePrintMatch {
    voiceprint: VoicePrint;
    similarity: number;     // 0-1
    confidence: 'high' | 'medium' | 'low' | 'none';
}

// Состояние для контекста
export interface VoicePrintState {
    voiceprints: VoicePrint[];
    sessionSpeakers: SessionSpeaker[];
    isLoading: boolean;
    error: string | null;
}
