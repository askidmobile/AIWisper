/**
 * Provider types and configurations
 * 
 * Mirrors Rust types from src-tauri/src/providers/types.rs
 */

// ============================================================================
// Provider Identifiers
// ============================================================================

/** Speech-to-Text provider identifiers */
export type STTProviderId = 'local' | 'openai' | 'deepgram' | 'assemblyai' | 'groq';

/** LLM provider identifiers */
export type LLMProviderId = 'ollama' | 'openai' | 'openrouter';

// ============================================================================
// STT Provider Configurations
// ============================================================================

/** Local STT provider configuration */
export interface LocalSTTConfig {
  /** Model ID (e.g., "ggml-large-v3-turbo") */
  modelId: string;
  /** Language code ("ru", "en", "auto") */
  language: string;
  /** Enable hybrid transcription */
  hybridEnabled: boolean;
  /** Secondary model ID for hybrid mode */
  hybridSecondaryModelId: string;
}

/** OpenAI Whisper API configuration */
export interface OpenAISTTConfig {
  /** Provider enabled */
  enabled: boolean;
  /** API key is set (key itself stored in keychain) */
  apiKeySet: boolean;
  /** Model name (default: "whisper-1") */
  model: string;
  /** Language hint (optional, auto-detect if not set) */
  language?: string;
  /** Response format (json, text, srt, vtt, verbose_json) */
  responseFormat?: string;
  /** Temperature (0-1) */
  temperature?: number;
}

/** Deepgram Nova-2 configuration */
export interface DeepgramConfig {
  /** Provider enabled */
  enabled: boolean;
  /** API key is set */
  apiKeySet: boolean;
  /** Model name (nova-2, nova, enhanced, base) */
  model: string;
  /** Language code */
  language?: string;
  /** Add punctuation */
  punctuate: boolean;
  /** Enable diarization */
  diarize: boolean;
  /** Smart formatting */
  smartFormat: boolean;
}

/** AssemblyAI configuration */
export interface AssemblyAIConfig {
  /** Provider enabled */
  enabled: boolean;
  /** API key is set */
  apiKeySet: boolean;
  /** Model type (default, best) */
  model: string;
  /** Language code */
  language?: string;
  /** Enable speaker labels (diarization) */
  speakerLabels: boolean;
  /** Auto chapters */
  autoChapters: boolean;
  /** Entity detection */
  entityDetection: boolean;
}

/** Groq Whisper configuration */
export interface GroqSTTConfig {
  /** Provider enabled */
  enabled: boolean;
  /** API key is set */
  apiKeySet: boolean;
  /** Model name (whisper-large-v3) */
  model: string;
  /** Language code */
  language?: string;
}

// ============================================================================
// LLM Provider Configurations
// ============================================================================

/** Ollama configuration (local LLM) */
export interface OllamaConfig {
  /** Provider enabled */
  enabled: boolean;
  /** Ollama server URL */
  url: string;
  /** Model name (llama3.2, qwen2.5, etc.) */
  model: string;
  /** Context size in thousands of tokens */
  contextSize: number;
}

/** OpenAI LLM configuration */
export interface OpenAILLMConfig {
  /** Provider enabled */
  enabled: boolean;
  /** API key is set */
  apiKeySet: boolean;
  /** Model name (gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo) */
  model: string;
  /** Temperature (0-2) */
  temperature?: number;
  /** Max tokens */
  maxTokens?: number;
}

/** OpenRouter configuration */
export interface OpenRouterConfig {
  /** Provider enabled */
  enabled: boolean;
  /** API key is set */
  apiKeySet: boolean;
  /** Model name (anthropic/claude-3.5-sonnet, openai/gpt-4o, etc.) */
  model: string;
  /** Temperature */
  temperature?: number;
  /** Max tokens */
  maxTokens?: number;
}

// ============================================================================
// Aggregated Provider Settings
// ============================================================================

/** STT providers settings */
export interface STTProvidersSettings {
  /** Active provider */
  activeProvider: STTProviderId;
  /** Fallback provider when cloud fails */
  fallbackProvider?: STTProviderId;
  /** Local provider config */
  local: LocalSTTConfig;
  /** OpenAI config */
  openai?: OpenAISTTConfig;
  /** Deepgram config */
  deepgram?: DeepgramConfig;
  /** AssemblyAI config */
  assemblyai?: AssemblyAIConfig;
  /** Groq config */
  groq?: GroqSTTConfig;
}

/** LLM providers settings */
export interface LLMProvidersSettings {
  /** Active provider */
  activeProvider: LLMProviderId;
  /** Fallback provider when cloud fails */
  fallbackProvider?: LLMProviderId;
  /** Ollama config */
  ollama: OllamaConfig;
  /** OpenAI config */
  openai?: OpenAILLMConfig;
  /** OpenRouter config */
  openrouter?: OpenRouterConfig;
}

// ============================================================================
// API Response Types
// ============================================================================

/** Provider status information */
export interface ProviderStatus {
  /** Provider ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Provider type (stt or llm) */
  type: 'stt' | 'llm';
  /** Is cloud provider */
  isCloud: boolean;
  /** API key is configured */
  isConfigured: boolean;
  /** Provider is available (passed health check) */
  isAvailable: boolean;
  /** Last error message */
  lastError?: string;
}

/** Connection test result */
export interface ConnectionTestResult {
  /** Test successful */
  success: boolean;
  /** Latency in milliseconds */
  latencyMs?: number;
  /** Error message */
  error?: string;
  /** Available models (for LLM providers) */
  models?: string[];
}

/** Provider model information */
export interface ProviderModel {
  /** Model ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Context length (for LLM) */
  contextLength?: number;
}

// ============================================================================
// Default Values
// ============================================================================

export const DEFAULT_LOCAL_STT_CONFIG: LocalSTTConfig = {
  modelId: 'ggml-large-v3-turbo',
  language: 'ru',
  hybridEnabled: false,
  hybridSecondaryModelId: '',
};

export const DEFAULT_OPENAI_STT_CONFIG: OpenAISTTConfig = {
  enabled: false,
  apiKeySet: false,
  model: 'gpt-4o-transcribe',
  responseFormat: 'verbose_json',
  temperature: 0.0,
};

export const DEFAULT_DEEPGRAM_CONFIG: DeepgramConfig = {
  enabled: false,
  apiKeySet: false,
  model: 'nova-2',
  punctuate: true,
  diarize: false,
  smartFormat: false,
};

export const DEFAULT_GROQ_STT_CONFIG: GroqSTTConfig = {
  enabled: false,
  apiKeySet: false,
  model: 'whisper-large-v3',
};

export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  enabled: true,
  url: 'http://localhost:11434',
  model: 'llama3.2',
  contextSize: 8,
};

export const DEFAULT_OPENAI_LLM_CONFIG: OpenAILLMConfig = {
  enabled: false,
  apiKeySet: false,
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 1000,
};

export const DEFAULT_OPENROUTER_CONFIG: OpenRouterConfig = {
  enabled: false,
  apiKeySet: false,
  model: 'anthropic/claude-3.5-sonnet',
  temperature: 0.7,
  maxTokens: 1000,
};

// ============================================================================
// Provider Metadata
// ============================================================================

export interface ProviderMeta {
  id: string;
  name: string;
  description: string;
  isCloud: boolean;
  requiresApiKey: boolean;
  website?: string;
  docsUrl?: string;
}

export const STT_PROVIDERS: Record<STTProviderId, ProviderMeta> = {
  local: {
    id: 'local',
    name: 'Локальные модели',
    description: 'Whisper, GigaAM, Parakeet — работает офлайн',
    isCloud: false,
    requiresApiKey: false,
  },
  openai: {
    id: 'openai',
    name: 'OpenAI Whisper',
    description: 'Whisper API от OpenAI — высокое качество',
    isCloud: true,
    requiresApiKey: true,
    website: 'https://openai.com',
    docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text',
  },
  deepgram: {
    id: 'deepgram',
    name: 'Deepgram Nova-2',
    description: 'Быстрая транскрибация с диаризацией',
    isCloud: true,
    requiresApiKey: true,
    website: 'https://deepgram.com',
    docsUrl: 'https://developers.deepgram.com/docs',
  },
  assemblyai: {
    id: 'assemblyai',
    name: 'AssemblyAI',
    description: 'Продвинутые функции: главы, сущности',
    isCloud: true,
    requiresApiKey: true,
    website: 'https://www.assemblyai.com',
    docsUrl: 'https://www.assemblyai.com/docs',
  },
  groq: {
    id: 'groq',
    name: 'Groq Whisper',
    description: 'Сверхбыстрая транскрибация на Groq LPU',
    isCloud: true,
    requiresApiKey: true,
    website: 'https://groq.com',
    docsUrl: 'https://console.groq.com/docs/speech-text',
  },
};

export const LLM_PROVIDERS: Record<LLMProviderId, ProviderMeta> = {
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    description: 'Локальные LLM — Llama, Qwen, Mistral',
    isCloud: false,
    requiresApiKey: false,
    website: 'https://ollama.ai',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI GPT',
    description: 'GPT-4o, GPT-4o-mini, GPT-4 Turbo',
    isCloud: true,
    requiresApiKey: true,
    website: 'https://openai.com',
    docsUrl: 'https://platform.openai.com/docs/guides/chat-completions',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Claude, GPT, Llama через единый API',
    isCloud: true,
    requiresApiKey: true,
    website: 'https://openrouter.ai',
    docsUrl: 'https://openrouter.ai/docs',
  },
};

// ============================================================================
// Available Models Lists
// ============================================================================

export const OPENAI_STT_MODELS = [
  { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe (лучшее качество)' },
  { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe (быстрая и дешёвая)' },
  { id: 'whisper-1', name: 'Whisper v2 Large (классическая)' },
];

export const DEEPGRAM_MODELS = [
  { id: 'nova-2', name: 'Nova-2 (рекомендуется)' },
  { id: 'nova', name: 'Nova' },
  { id: 'enhanced', name: 'Enhanced' },
  { id: 'base', name: 'Base' },
];

export const GROQ_STT_MODELS = [
  { id: 'whisper-large-v3', name: 'Whisper Large v3' },
  { id: 'whisper-large-v3-turbo', name: 'Whisper Large v3 Turbo (быстрее)' },
  { id: 'distil-whisper-large-v3-en', name: 'Distil Whisper Large v3 (только EN)' },
];

export const OPENAI_LLM_MODELS = [
  { id: 'gpt-4o', name: 'GPT-4o (самый умный)' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini (быстрый и дешёвый)' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
  { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
];

export const OPENROUTER_POPULAR_MODELS = [
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B' },
  { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large' },
  { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5' },
];
