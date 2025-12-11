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

export interface AppSettings {
    language: 'ru' | 'en' | 'auto';
    modelId: string;
    echoCancel: number;
    useVoiceIsolation: boolean;
    captureSystem: boolean;
    vadMode?: VADMode; // Режим VAD: auto, compression, per-region, off
    theme?: 'light' | 'dark';
    // Ollama settings for summary
    ollamaModel: string;  // e.g., 'llama3.2', 'qwen2.5', 'mistral'
    ollamaUrl: string;    // e.g., 'http://localhost:11434'
    // Diarization settings
    diarizationEnabled?: boolean;
    diarizationSegModelId?: string;
    diarizationEmbModelId?: string;
    diarizationProvider?: string;
}

// Модель Ollama для summary
export interface OllamaModel {
    name: string;
    size: number;
    isCloud: boolean;
    family: string;
    parameters: string;
}
