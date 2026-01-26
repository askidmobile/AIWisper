// Типы для менеджера моделей

export type ModelType = 'ggml' | 'onnx' | 'coreml';
export type EngineType = 'whisper' | 'gigaam' | 'fluid-asr' | 'speaker' | 'diarization';
export type DiarizationModelType = 'segmentation' | 'embedding';

export type ModelStatus =
    | 'not_downloaded'
    | 'downloading'
    | 'downloaded'
    | 'active'
    | 'error';

export interface ModelInfo {
    id: string;
    name: string;
    type: ModelType;
    engine?: EngineType;
    size: string;
    sizeBytes: number;
    description: string;
    languages: string[];
    wer?: string;
    speed: string;
    recommended?: boolean;
    downloadUrl?: string;
    huggingfaceRepo?: string;
    requiresPython?: boolean;
    // Поля для диаризации
    diarizationType?: DiarizationModelType;
    isArchive?: boolean;
    // Поля для RNNT моделей
    isRnnt?: boolean;
    decoderUrl?: string;
    jointUrl?: string;
}

export interface ModelState extends ModelInfo {
    status: ModelStatus;
    progress?: number;  // 0-100
    error?: string;
    path?: string;
    downloaded?: boolean;
}

// Статус диаризации
export interface DiarizationStatus {
    enabled: boolean;
    provider: string; // 'cpu' | 'coreml' | 'cuda' | ''
    segmentationModelId?: string;
    embeddingModelId?: string;
}

export type VADMode = 'auto' | 'compression' | 'per-region' | 'off';
export type VADMethod = 'auto' | 'energy' | 'silero';

export interface AppSettings {
    language: 'ru' | 'en' | 'auto';
    modelId: string;
    echoCancel: number;
    useVoiceIsolation: boolean;
    captureSystem: boolean;
    vadMode?: VADMode; // Режим VAD: auto, compression, per-region, off
    vadMethod?: VADMethod; // Метод детекции речи: auto, energy, silero
    theme?: 'light' | 'dark';
    // Ollama settings for summary
    ollamaModel: string;  // e.g., 'llama3.2', 'qwen2.5', 'mistral'
    ollamaUrl: string;    // e.g., 'http://localhost:11434'
    // Diarization settings
    diarizationEnabled?: boolean;
    diarizationSegModelId?: string;
    diarizationEmbModelId?: string;
    diarizationProvider?: string;
    // UI settings
    showSessionStats?: boolean; // Показывать статистику записей в сайдбаре
    // Гибридная транскрипция (двухпроходное распознавание)
    hybridTranscription?: HybridTranscriptionSettings;
}

// Режим гибридной транскрипции
export type HybridMode = 'confidence' | 'full_compare' | 'parallel';

// Настройки гибридной транскрипции
export interface HybridTranscriptionSettings {
    enabled: boolean;                    // Включена ли гибридная транскрипция
    secondaryModelId: string;            // ID дополнительной модели для второго прохода
    confidenceThreshold: number;         // Порог уверенности (0.0 - 1.0), ниже которого слово перетранскрибируется
    contextWords: number;                // Количество слов контекста вокруг проблемного слова (1-5)
    useLLMForMerge: boolean;             // Использовать LLM для выбора лучшего варианта
    mode: HybridMode;                    // Режим: parallel (параллельный), confidence (по порогу) или full_compare (полное сравнение + LLM)
    hotwords?: string[];                 // Словарь подсказок (термины, имена собственные)
}

// Модель Ollama для summary
export interface OllamaModel {
    name: string;
    size: number;
    isCloud: boolean;
    family: string;
    parameters: string;
}
