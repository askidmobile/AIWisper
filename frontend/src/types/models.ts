// Типы для менеджера моделей

export type ModelType = 'ggml' | 'faster-whisper';

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
    size: string;
    sizeBytes: number;
    description: string;
    languages: string[];
    wer?: string;
    speed: string;
    recommended?: boolean;
    downloadUrl?: string;
    huggingfaceRepo?: string;
    requiresPython?: boolean; // Модель скачивается автоматически через faster-whisper
}

export interface ModelState extends ModelInfo {
    status: ModelStatus;
    progress?: number;  // 0-100
    error?: string;
    path?: string;
    downloaded?: boolean;
}

export interface AppSettings {
    language: 'ru' | 'en' | 'auto';
    modelId: string;
    echoCancel: number;
    useVoiceIsolation: boolean;
    captureSystem: boolean;
    theme?: 'light' | 'dark';
    // Ollama settings for summary
    ollamaModel: string;  // e.g., 'llama3.2', 'qwen2.5', 'mistral'
    ollamaUrl: string;    // e.g., 'http://localhost:11434'
}

// Модель Ollama для summary
export interface OllamaModel {
    name: string;
    size: number;
    isCloud: boolean;
    family: string;
    parameters: string;
}
