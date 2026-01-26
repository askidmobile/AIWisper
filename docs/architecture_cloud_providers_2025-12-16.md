# Архитектура: Облачные провайдеры для AIWisper

**Дата:** 2025-12-16
**Статус:** ✅ Phase 4 Complete (Frontend UI)
**Архитектор:** @architect
**На основе анализа:** Требования пользователя, текущая структура useSettings.ts, state/mod.rs

---

## Статус реализации

| Фаза | Статус | Описание |
|------|--------|----------|
| Phase 1: Infrastructure | ✅ | Архитектура, зависимости, модули, Tauri commands |
| Phase 2: STT Providers | ✅ | LocalSTT, OpenAI, Deepgram, Groq |
| Phase 3: LLM Providers | ✅ | Ollama, OpenAI, OpenRouter |
| Phase 4: Frontend UI | ✅ | TypeScript типы, useProviders hook, ProvidersSettings компонент |

### Созданные артефакты

**Backend (Rust):**
- `src/providers/mod.rs` — экспорты модуля
- `src/providers/types.rs` — типы и конфиги (507 строк)
- `src/providers/traits.rs` — STTProvider, LLMProvider traits (306 строк)
- `src/providers/keystore.rs` — macOS Keychain storage (~200 строк)
- `src/providers/registry.rs` — ProviderRegistry (~400 строк)
- `src/providers/stt/local.rs` — обёртка над локальным ML engine
- `src/providers/stt/openai.rs` — OpenAI Whisper API
- `src/providers/stt/deepgram.rs` — Deepgram Nova-2
- `src/providers/stt/groq.rs` — Groq Whisper
- `src/providers/llm/ollama.rs` — локальный Ollama LLM
- `src/providers/llm/openai.rs` — OpenAI GPT
- `src/providers/llm/openrouter.rs` — OpenRouter aggregator
- `src/commands/providers.rs` — 9 Tauri commands

**Frontend (TypeScript/React):**
- `src/types/providers.ts` — TypeScript типы (~350 строк)
- `src/hooks/useProviders.ts` — React hook (~320 строк)
- `src/components/modules/ProvidersSettings.tsx` — UI компонент (~600 строк)
- `src/components/SettingsModal.tsx` — интеграция провайдеров

**Тесты:** 25 tests (24 passed, 1 ignored — keystore требует keychain access)

---

## 1. Обзор

Добавление поддержки облачных провайдеров для:
- **Speech-to-Text (STT):** OpenAI Whisper API, Deepgram, AssemblyAI, Groq
- **LLM (для сводки):** OpenAI, OpenRouter (+ существующий Ollama)

### Принципы проектирования:
1. **Provider Pattern** — единый интерфейс для всех провайдеров
2. **Разделение ответственности** — STT и LLM провайдеры независимы
3. **Fallback Chain** — облако недоступно → локальная модель
4. **Secure Storage** — API ключи в Tauri Secure Store / Keychain
5. **Lazy Initialization** — провайдеры инициализируются по требованию

---

## 2. ADR (Architecture Decision Record)

### Ключевые решения

| Решение | Альтернативы | Обоснование | Последствия |
|---------|--------------|-------------|-------------|
| Раздельные типы для STT и LLM провайдеров | Единый generic Provider | Разные API контракты, разные настройки | Больше типов, но чётче |
| API ключи в Tauri Secure Store | localStorage, config.json | Безопасность, OS-level encryption | Зависимость от Tauri плагина |
| Fallback chain (cloud → local) | Только один провайдер | Надёжность, graceful degradation | Сложнее логика |
| Provider registry pattern | Hardcoded switch | Легко добавлять новых провайдеров | Немного больше boilerplate |
| Конфигурация провайдера как JSON-объект | Отдельные поля для каждого | Расширяемость, разные настройки для разных провайдеров | Нужна валидация |

---

## 3. Архитектурные диаграммы

### 3.1 Container Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Frontend (rust/ui - React + Vite)                   │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         SettingsModal                                 │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐   │  │
│  │  │ STT Provider    │  │ LLM Provider    │  │ API Keys Manager    │   │  │
│  │  │ Settings        │  │ Settings        │  │ (masked UI)         │   │  │
│  │  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘   │  │
│  └───────────┼────────────────────┼──────────────────────┼──────────────┘  │
│              │                    │                      │                  │
│              │ invoke             │ invoke               │ invoke           │
│              ▼                    ▼                      ▼                  │
└──────────────┼────────────────────┼──────────────────────┼──────────────────┘
               │                    │                      │
               ▼                    ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Tauri Backend (Rust)                                 │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      Commands Layer                                     │ │
│  │  save_provider_settings | get_provider_settings | set_api_key          │ │
│  │  test_provider_connection | transcribe_with_provider                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                              │                                               │
│  ┌───────────────────────────┴───────────────────────────────────────────┐  │
│  │                      Provider Manager                                  │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │ STT Provider Registry                                           │  │  │
│  │  │  ├── LocalProvider (Whisper/GigaAM/Parakeet)                   │  │  │
│  │  │  ├── OpenAISTTProvider                                          │  │  │
│  │  │  ├── DeepgramProvider                                           │  │  │
│  │  │  ├── AssemblyAIProvider                                         │  │  │
│  │  │  └── GroqSTTProvider                                            │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │ LLM Provider Registry                                           │  │  │
│  │  │  ├── OllamaProvider (existing)                                  │  │  │
│  │  │  ├── OpenAILLMProvider                                          │  │  │
│  │  │  └── OpenRouterProvider                                         │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              │                                               │
│  ┌───────────────────────────┴───────────────────────────────────────────┐  │
│  │                      Secure Key Store                                  │  │
│  │  tauri-plugin-store / keyring-rs (macOS Keychain)                     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         External APIs                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ OpenAI API  │  │ Deepgram    │  │ AssemblyAI  │  │ OpenRouter/Groq     │  │
│  │ (STT + LLM) │  │ (STT)       │  │ (STT)       │  │                     │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Sequence Diagram: Транскрипция с Fallback

```
User              UI              Backend          CloudProvider    LocalEngine
  │                │                │                    │               │
  │──Start Record─▶│                │                    │               │
  │                │──start_recording(provider=openai)──▶│               │
  │                │                │                    │               │
  │     [Audio chunk ready]         │                    │               │
  │                │                │                    │               │
  │                │                │──transcribe(audio)▶│               │
  │                │                │                    │               │
  │                │                │◀────[Error 429]────│               │
  │                │                │                    │               │
  │                │                │      [Fallback to local]           │
  │                │                │──transcribe(audio)────────────────▶│
  │                │                │◀────────result─────────────────────│
  │                │◀──chunk_transcribed(fallback=true)──│               │
  │◀───UI Update───│                │                    │               │
```

### 3.3 Component Diagram: Provider Traits

```
                    ┌─────────────────────────────────┐
                    │     trait STTProvider           │
                    ├─────────────────────────────────┤
                    │ + id() -> &str                  │
                    │ + name() -> &str                │
                    │ + is_cloud() -> bool            │
                    │ + transcribe(&[f32], opts)      │
                    │   -> Result<TranscriptResult>   │
                    │ + validate_config() -> bool     │
                    │ + get_supported_languages()     │
                    │   -> Vec<String>                │
                    └─────────────────────────────────┘
                                   △
                                   │ implements
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────┴───────┐         ┌────────┴────────┐        ┌────────┴────────┐
│LocalSTTProvider│         │OpenAISTTProvider│        │DeepgramProvider │
├───────────────┤         ├─────────────────┤        ├─────────────────┤
│ engine: Engine│         │ api_key: String │        │ api_key: String │
│ model_id: Str │         │ model: String   │        │ model: String   │
│               │         │ (whisper-1)     │        │ (nova-2)        │
└───────────────┘         └─────────────────┘        └─────────────────┘


                    ┌─────────────────────────────────┐
                    │     trait LLMProvider           │
                    ├─────────────────────────────────┤
                    │ + id() -> &str                  │
                    │ + name() -> &str                │
                    │ + is_cloud() -> bool            │
                    │ + generate(prompt, opts)        │
                    │   -> Result<String>             │
                    │ + stream_generate(prompt, opts) │
                    │   -> Stream<String>             │
                    │ + list_models() -> Vec<Model>   │
                    └─────────────────────────────────┘
                                   △
                                   │ implements
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────┴───────┐         ┌────────┴────────┐        ┌────────┴────────┐
│ OllamaProvider│         │OpenAILLMProvider│        │OpenRouterProvider│
├───────────────┤         ├─────────────────┤        ├──────────────────┤
│ url: String   │         │ api_key: String │        │ api_key: String  │
│ model: String │         │ model: String   │        │ model: String    │
└───────────────┘         └─────────────────┘        └──────────────────┘
```

---

## 4. Типы данных

### 4.1 TypeScript (Frontend - rust/ui/src/types/)

```typescript
// providers.ts

// ============================================================================
// Базовые типы
// ============================================================================

/** Идентификаторы STT провайдеров */
export type STTProviderId = 
  | 'local'       // Локальные модели (Whisper/GigaAM/Parakeet)
  | 'openai'      // OpenAI Whisper API
  | 'deepgram'    // Deepgram Nova-2
  | 'assemblyai'  // AssemblyAI
  | 'groq';       // Groq (Whisper)

/** Идентификаторы LLM провайдеров */
export type LLMProviderId = 
  | 'ollama'      // Локальный Ollama
  | 'openai'      // OpenAI GPT
  | 'openrouter'; // OpenRouter (Claude, GPT, Llama, etc.)

// ============================================================================
// Конфигурации провайдеров
// ============================================================================

/** Базовая конфигурация облачного провайдера */
export interface CloudProviderConfig {
  enabled: boolean;
  apiKeySet: boolean;  // API ключ установлен (сам ключ не возвращается!)
}

/** Конфигурация локального STT провайдера */
export interface LocalSTTConfig {
  modelId: string;
  language: 'ru' | 'en' | 'auto';
  // Гибридная транскрипция
  hybridEnabled?: boolean;
  hybridSecondaryModelId?: string;
}

/** Конфигурация OpenAI STT */
export interface OpenAISTTConfig extends CloudProviderConfig {
  model: 'whisper-1';
  language?: string;           // Опционально, auto если не указан
  responseFormat?: 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json';
  temperature?: number;        // 0-1, default 0
}

/** Конфигурация Deepgram */
export interface DeepgramConfig extends CloudProviderConfig {
  model: 'nova-2' | 'nova' | 'enhanced' | 'base';
  language?: string;
  punctuate?: boolean;         // Добавлять пунктуацию
  diarize?: boolean;           // Диаризация спикеров
  smartFormat?: boolean;       // Умное форматирование
}

/** Конфигурация AssemblyAI */
export interface AssemblyAIConfig extends CloudProviderConfig {
  model: 'default' | 'best';
  language?: string;
  speakerLabels?: boolean;     // Диаризация
  autoChapters?: boolean;      // Авто-главы
  entityDetection?: boolean;   // Определение сущностей
}

/** Конфигурация Groq STT */
export interface GroqSTTConfig extends CloudProviderConfig {
  model: 'whisper-large-v3';
  language?: string;
}

/** Конфигурация Ollama (существующая, расширенная) */
export interface OllamaConfig {
  enabled: boolean;
  url: string;                 // default: http://localhost:11434
  model: string;               // e.g., llama3.2, qwen2.5
  contextSize: number;         // в тысячах токенов
}

/** Конфигурация OpenAI LLM */
export interface OpenAILLMConfig extends CloudProviderConfig {
  model: 'gpt-4o' | 'gpt-4o-mini' | 'gpt-4-turbo' | 'gpt-3.5-turbo';
  temperature?: number;        // 0-2, default 0.7
  maxTokens?: number;          // default 1000
}

/** Конфигурация OpenRouter */
export interface OpenRouterConfig extends CloudProviderConfig {
  model: string;               // e.g., anthropic/claude-3.5-sonnet, openai/gpt-4o
  temperature?: number;
  maxTokens?: number;
}

// ============================================================================
// Агрегированные настройки провайдеров
// ============================================================================

/** Настройки STT провайдеров */
export interface STTProvidersSettings {
  /** Активный провайдер */
  activeProvider: STTProviderId;
  
  /** Fallback провайдер при ошибке облачного */
  fallbackProvider?: STTProviderId;
  
  /** Конфигурации провайдеров */
  local: LocalSTTConfig;
  openai?: OpenAISTTConfig;
  deepgram?: DeepgramConfig;
  assemblyai?: AssemblyAIConfig;
  groq?: GroqSTTConfig;
}

/** Настройки LLM провайдеров */
export interface LLMProvidersSettings {
  /** Активный провайдер */
  activeProvider: LLMProviderId;
  
  /** Fallback провайдер при ошибке облачного */
  fallbackProvider?: LLMProviderId;
  
  /** Конфигурации провайдеров */
  ollama: OllamaConfig;
  openai?: OpenAILLMConfig;
  openrouter?: OpenRouterConfig;
}

// ============================================================================
// Обновлённый AppSettings
// ============================================================================

export interface AppSettings {
  // Аудио настройки (без изменений)
  micDevice: string;
  captureSystem: boolean;
  useVoiceIsolation: boolean;
  echoCancel: number;
  
  // VAD настройки (без изменений)
  vadMode: 'auto' | 'compression' | 'per-region' | 'off';
  vadMethod: 'auto' | 'energy' | 'silero';
  pauseThreshold: number;
  
  // Streaming настройки (без изменений)
  enableStreaming: boolean;
  streamingChunkSeconds: number;
  streamingConfirmationThreshold: number;
  
  // Тема и UI (без изменений)
  theme: 'light' | 'dark' | 'system';
  showSessionStats: boolean;
  
  // Диаризация (без изменений)
  diarizationEnabled: boolean;
  diarizationSegModelId: string;
  diarizationEmbModelId: string;
  diarizationProvider: string;
  
  // ============ НОВОЕ ============
  
  /** Настройки STT провайдеров */
  sttProviders: STTProvidersSettings;
  
  /** Настройки LLM провайдеров */
  llmProviders: LLMProvidersSettings;
  
  // ============ DEPRECATED (для обратной совместимости) ============
  /** @deprecated Используйте sttProviders.local.language */
  language?: 'ru' | 'en' | 'auto';
  /** @deprecated Используйте sttProviders.local.modelId */
  modelId?: string | null;
  /** @deprecated Используйте llmProviders.ollama */
  ollamaModel?: string;
  ollamaUrl?: string;
  ollamaContextSize?: number;
  /** @deprecated Используйте sttProviders.local.hybridEnabled */
  hybridTranscription?: HybridTranscriptionSettings;
}

// ============================================================================
// API Response Types
// ============================================================================

/** Статус провайдера */
export interface ProviderStatus {
  id: string;
  name: string;
  type: 'stt' | 'llm';
  isCloud: boolean;
  isConfigured: boolean;  // API ключ установлен
  isAvailable: boolean;   // Провайдер доступен (прошёл health check)
  lastError?: string;
}

/** Результат тестирования соединения */
export interface ConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
  models?: string[];  // Доступные модели (для LLM)
}

/** Информация о модели провайдера */
export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
  contextLength?: number;  // Для LLM
  pricing?: {
    inputPerMillion: number;
    outputPerMillion: number;
  };
}
```

### 4.2 Rust Structs (Backend - rust/src-tauri/src/)

```rust
// providers/types.rs

use serde::{Deserialize, Serialize};

// ============================================================================
// Идентификаторы провайдеров
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum STTProviderId {
    Local,
    OpenAI,
    Deepgram,
    AssemblyAI,
    Groq,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum LLMProviderId {
    Ollama,
    OpenAI,
    OpenRouter,
}

// ============================================================================
// Конфигурации STT провайдеров
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSTTConfig {
    pub model_id: String,
    pub language: String,  // "ru", "en", "auto"
    #[serde(default)]
    pub hybrid_enabled: bool,
    #[serde(default)]
    pub hybrid_secondary_model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAISTTConfig {
    pub enabled: bool,
    #[serde(default)]
    pub api_key_set: bool,  // Не храним сам ключ в config!
    #[serde(default = "default_whisper_model")]
    pub model: String,
    pub language: Option<String>,
    #[serde(default)]
    pub response_format: Option<String>,
    pub temperature: Option<f32>,
}

fn default_whisper_model() -> String { "whisper-1".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepgramConfig {
    pub enabled: bool,
    #[serde(default)]
    pub api_key_set: bool,
    #[serde(default = "default_deepgram_model")]
    pub model: String,
    pub language: Option<String>,
    #[serde(default = "default_true")]
    pub punctuate: bool,
    #[serde(default)]
    pub diarize: bool,
    #[serde(default)]
    pub smart_format: bool,
}

fn default_deepgram_model() -> String { "nova-2".to_string() }
fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssemblyAIConfig {
    pub enabled: bool,
    #[serde(default)]
    pub api_key_set: bool,
    #[serde(default = "default_assemblyai_model")]
    pub model: String,
    pub language: Option<String>,
    #[serde(default)]
    pub speaker_labels: bool,
    #[serde(default)]
    pub auto_chapters: bool,
    #[serde(default)]
    pub entity_detection: bool,
}

fn default_assemblyai_model() -> String { "default".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroqSTTConfig {
    pub enabled: bool,
    #[serde(default)]
    pub api_key_set: bool,
    #[serde(default = "default_groq_model")]
    pub model: String,
    pub language: Option<String>,
}

fn default_groq_model() -> String { "whisper-large-v3".to_string() }

// ============================================================================
// Конфигурации LLM провайдеров
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_ollama_url")]
    pub url: String,
    #[serde(default = "default_ollama_model")]
    pub model: String,
    #[serde(default = "default_context_size")]
    pub context_size: u32,  // в тысячах токенов
}

fn default_ollama_url() -> String { "http://localhost:11434".to_string() }
fn default_ollama_model() -> String { "llama3.2".to_string() }
fn default_context_size() -> u32 { 8 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAILLMConfig {
    pub enabled: bool,
    #[serde(default)]
    pub api_key_set: bool,
    #[serde(default = "default_gpt_model")]
    pub model: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

fn default_gpt_model() -> String { "gpt-4o-mini".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterConfig {
    pub enabled: bool,
    #[serde(default)]
    pub api_key_set: bool,
    #[serde(default = "default_openrouter_model")]
    pub model: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

fn default_openrouter_model() -> String { "anthropic/claude-3.5-sonnet".to_string() }

// ============================================================================
// Агрегированные настройки
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct STTProvidersSettings {
    pub active_provider: STTProviderId,
    pub fallback_provider: Option<STTProviderId>,
    pub local: LocalSTTConfig,
    pub openai: Option<OpenAISTTConfig>,
    pub deepgram: Option<DeepgramConfig>,
    pub assemblyai: Option<AssemblyAIConfig>,
    pub groq: Option<GroqSTTConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LLMProvidersSettings {
    pub active_provider: LLMProviderId,
    pub fallback_provider: Option<LLMProviderId>,
    pub ollama: OllamaConfig,
    pub openai: Option<OpenAILLMConfig>,
    pub openrouter: Option<OpenRouterConfig>,
}

impl Default for STTProvidersSettings {
    fn default() -> Self {
        Self {
            active_provider: STTProviderId::Local,
            fallback_provider: None,
            local: LocalSTTConfig {
                model_id: "ggml-large-v3-turbo".to_string(),
                language: "ru".to_string(),
                hybrid_enabled: false,
                hybrid_secondary_model_id: String::new(),
            },
            openai: None,
            deepgram: None,
            assemblyai: None,
            groq: None,
        }
    }
}

impl Default for LLMProvidersSettings {
    fn default() -> Self {
        Self {
            active_provider: LLMProviderId::Ollama,
            fallback_provider: None,
            ollama: OllamaConfig::default(),
            openai: None,
            openrouter: None,
        }
    }
}

impl Default for OllamaConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            url: default_ollama_url(),
            model: default_ollama_model(),
            context_size: default_context_size(),
        }
    }
}
```

### 4.3 Provider Traits

```rust
// providers/traits.rs

use async_trait::async_trait;
use anyhow::Result;

/// Результат транскрипции
#[derive(Debug, Clone)]
pub struct TranscriptionResult {
    pub text: String,
    pub segments: Vec<TranscriptionSegment>,
    pub language: Option<String>,
    pub duration_ms: u64,
    pub provider_id: String,
}

#[derive(Debug, Clone)]
pub struct TranscriptionSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub speaker: Option<String>,
    pub confidence: Option<f32>,
}

/// Опции транскрипции
#[derive(Debug, Clone, Default)]
pub struct TranscriptionOptions {
    pub language: Option<String>,
    pub hotwords: Vec<String>,
    pub diarize: bool,
}

/// Trait для STT провайдеров
#[async_trait]
pub trait STTProvider: Send + Sync {
    /// Уникальный идентификатор провайдера
    fn id(&self) -> &str;
    
    /// Человекочитаемое имя
    fn name(&self) -> &str;
    
    /// Облачный ли провайдер
    fn is_cloud(&self) -> bool;
    
    /// Проверка валидности конфигурации
    fn is_configured(&self) -> bool;
    
    /// Поддерживаемые языки
    fn supported_languages(&self) -> Vec<String>;
    
    /// Транскрибировать аудио (samples: 16kHz mono f32)
    async fn transcribe(
        &self,
        samples: &[f32],
        options: TranscriptionOptions,
    ) -> Result<TranscriptionResult>;
    
    /// Health check
    async fn health_check(&self) -> Result<()>;
}

/// Результат генерации LLM
#[derive(Debug, Clone)]
pub struct GenerationResult {
    pub text: String,
    pub tokens_used: Option<u32>,
    pub finish_reason: Option<String>,
    pub provider_id: String,
}

/// Опции генерации
#[derive(Debug, Clone)]
pub struct GenerationOptions {
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub system_prompt: Option<String>,
}

impl Default for GenerationOptions {
    fn default() -> Self {
        Self {
            max_tokens: Some(1000),
            temperature: Some(0.7),
            system_prompt: None,
        }
    }
}

/// Trait для LLM провайдеров
#[async_trait]
pub trait LLMProvider: Send + Sync {
    /// Уникальный идентификатор провайдера
    fn id(&self) -> &str;
    
    /// Человекочитаемое имя
    fn name(&self) -> &str;
    
    /// Облачный ли провайдер
    fn is_cloud(&self) -> bool;
    
    /// Проверка валидности конфигурации
    fn is_configured(&self) -> bool;
    
    /// Генерация текста
    async fn generate(
        &self,
        prompt: &str,
        options: GenerationOptions,
    ) -> Result<GenerationResult>;
    
    /// Список доступных моделей
    async fn list_models(&self) -> Result<Vec<String>>;
    
    /// Health check
    async fn health_check(&self) -> Result<()>;
}
```

---

## 5. API Контракты (Tauri Commands)

### 5.1 Команды для управления провайдерами

```rust
// commands/providers.rs

/// Получить настройки STT провайдеров
#[tauri::command]
pub async fn get_stt_providers_settings(
    state: State<'_, AppState>,
) -> Result<STTProvidersSettings, String>;

/// Сохранить настройки STT провайдеров
#[tauri::command]
pub async fn set_stt_providers_settings(
    state: State<'_, AppState>,
    settings: STTProvidersSettings,
) -> Result<(), String>;

/// Получить настройки LLM провайдеров
#[tauri::command]
pub async fn get_llm_providers_settings(
    state: State<'_, AppState>,
) -> Result<LLMProvidersSettings, String>;

/// Сохранить настройки LLM провайдеров
#[tauri::command]
pub async fn set_llm_providers_settings(
    state: State<'_, AppState>,
    settings: LLMProvidersSettings,
) -> Result<(), String>;

/// Установить API ключ для провайдера (хранится в Secure Store)
#[tauri::command]
pub async fn set_provider_api_key(
    state: State<'_, AppState>,
    provider_type: String,  // "stt" | "llm"
    provider_id: String,    // "openai", "deepgram", etc.
    api_key: String,
) -> Result<(), String>;

/// Удалить API ключ провайдера
#[tauri::command]
pub async fn remove_provider_api_key(
    state: State<'_, AppState>,
    provider_type: String,
    provider_id: String,
) -> Result<(), String>;

/// Проверить подключение к провайдеру
#[tauri::command]
pub async fn test_provider_connection(
    state: State<'_, AppState>,
    provider_type: String,
    provider_id: String,
) -> Result<ConnectionTestResult, String>;

/// Получить статус всех провайдеров
#[tauri::command]
pub async fn get_providers_status(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderStatus>, String>;

/// Получить список моделей провайдера (для LLM)
#[tauri::command]
pub async fn get_provider_models(
    state: State<'_, AppState>,
    provider_type: String,
    provider_id: String,
) -> Result<Vec<ProviderModel>, String>;
```

### 5.2 Схема хранения API ключей

```rust
// Ключи хранятся в Tauri Secure Store с префиксом:
// "aiwisper.provider.{type}.{id}.api_key"
//
// Примеры:
// - "aiwisper.provider.stt.openai.api_key"
// - "aiwisper.provider.stt.deepgram.api_key"
// - "aiwisper.provider.llm.openai.api_key"
// - "aiwisper.provider.llm.openrouter.api_key"

// Используем keyring-rs для macOS Keychain:
use keyring::Entry;

const SERVICE_NAME: &str = "aiwisper";

pub fn store_api_key(provider_type: &str, provider_id: &str, api_key: &str) -> Result<()> {
    let username = format!("provider.{}.{}.api_key", provider_type, provider_id);
    let entry = Entry::new(SERVICE_NAME, &username)?;
    entry.set_password(api_key)?;
    Ok(())
}

pub fn get_api_key(provider_type: &str, provider_id: &str) -> Result<Option<String>> {
    let username = format!("provider.{}.{}.api_key", provider_type, provider_id);
    let entry = Entry::new(SERVICE_NAME, &username)?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_api_key(provider_type: &str, provider_id: &str) -> Result<()> {
    let username = format!("provider.{}.{}.api_key", provider_type, provider_id);
    let entry = Entry::new(SERVICE_NAME, &username)?;
    entry.delete_credential()?;
    Ok(())
}
```

---

## 6. UI Компоненты

### 6.1 Структура компонентов

```
rust/ui/src/components/
├── settings/
│   ├── ProviderSettings.tsx       # Основной контейнер настроек провайдеров
│   ├── STTProviderSettings.tsx    # Настройки STT провайдеров
│   ├── LLMProviderSettings.tsx    # Настройки LLM провайдеров
│   ├── ProviderCard.tsx           # Карточка отдельного провайдера
│   ├── ApiKeyInput.tsx            # Компонент ввода API ключа (с маскированием)
│   ├── ProviderSelector.tsx       # Выпадающий список выбора провайдера
│   └── ConnectionStatus.tsx       # Индикатор статуса соединения
```

### 6.2 Описание компонентов

#### ProviderSettings.tsx
```tsx
// Основной контейнер с табами: "Транскрипция" | "LLM (Сводка)"
// Содержит переключатель активного провайдера и настройки fallback
```

#### STTProviderSettings.tsx
```tsx
interface STTProviderSettingsProps {
  settings: STTProvidersSettings;
  onChange: (settings: STTProvidersSettings) => void;
  onTestConnection: (providerId: string) => Promise<ConnectionTestResult>;
}

// Содержит:
// 1. Выбор активного провайдера (dropdown)
// 2. Карточки для каждого провайдера с:
//    - Переключатель enabled
//    - Ввод API ключа (для облачных)
//    - Специфичные настройки (модель, язык, опции)
//    - Кнопка "Проверить соединение"
//    - Статус (настроен/не настроен/ошибка)
// 3. Настройка fallback провайдера
```

#### LLMProviderSettings.tsx
```tsx
interface LLMProviderSettingsProps {
  settings: LLMProvidersSettings;
  onChange: (settings: LLMProvidersSettings) => void;
  onTestConnection: (providerId: string) => Promise<ConnectionTestResult>;
}

// Аналогично STT, но с LLM-специфичными настройками:
// - temperature, max_tokens
// - Выбор модели из списка (для OpenAI/OpenRouter)
```

#### ApiKeyInput.tsx
```tsx
interface ApiKeyInputProps {
  value: string;  // Маскированное значение для отображения
  isSet: boolean; // API ключ установлен
  onChange: (key: string) => void;
  onClear: () => void;
  placeholder?: string;
}

// Особенности:
// - Показывает "••••••••" если ключ установлен
// - Поле ввода type="password"
// - Кнопка "Показать/Скрыть"
// - Кнопка "Удалить ключ"
// - Валидация формата (минимальная длина, префикс)
```

### 6.3 Макет UI

```
┌─────────────────────────────────────────────────────────────────┐
│ Настройки провайдеров                                       ✕  │
├─────────────────────────────────────────────────────────────────┤
│  [Транскрипция]  [LLM (Сводка)]                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Активный провайдер: [▼ Локальные модели (Whisper/GigaAM)    ] │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ◉ Локальные модели                          ✓ Активен   │   │
│  │                                                          │   │
│  │ Модель: [▼ Whisper Large V3 Turbo (рекомендуется)     ] │   │
│  │ Язык:   [▼ Русский                                    ] │   │
│  │                                                          │   │
│  │ ☐ Гибридная транскрипция                                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ○ OpenAI Whisper API                       $0.006/мин   │   │
│  │                                                          │   │
│  │ API Ключ: [sk-••••••••••••••••••••••••••] [Удалить]     │   │
│  │ Модель:   whisper-1                                      │   │
│  │                                                          │   │
│  │ [Проверить соединение]                    ⚪ Не настроен │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ○ Deepgram Nova-2                          $0.0043/мин  │   │
│  │                                                          │   │
│  │ API Ключ: [                              ] [Сохранить]   │   │
│  │ Модель:   [▼ nova-2                                   ] │   │
│  │ ☑ Пунктуация  ☐ Диаризация  ☐ Smart Format              │   │
│  │                                                          │   │
│  │ [Проверить соединение]                    ⚪ Не настроен │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Fallback при ошибке: [▼ Локальные модели                   ] │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                     [Готово]   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Миграция данных

### 7.1 Обратная совместимость

При загрузке настроек из существующего `config.json`:

```rust
// При загрузке старых настроек
fn migrate_legacy_settings(legacy: &LegacyUISettings) -> NewUISettings {
    NewUISettings {
        // ... сохраняем существующие поля ...
        
        stt_providers: STTProvidersSettings {
            active_provider: STTProviderId::Local,
            fallback_provider: None,
            local: LocalSTTConfig {
                model_id: legacy.model_id.clone().unwrap_or_default(),
                language: legacy.language.clone(),
                hybrid_enabled: legacy.hybrid_transcription.enabled,
                hybrid_secondary_model_id: legacy.hybrid_transcription.secondary_model_id.clone(),
            },
            openai: None,
            deepgram: None,
            assemblyai: None,
            groq: None,
        },
        
        llm_providers: LLMProvidersSettings {
            active_provider: LLMProviderId::Ollama,
            fallback_provider: None,
            ollama: OllamaConfig {
                enabled: true,
                url: legacy.ollama_url.clone(),
                model: legacy.ollama_model.clone(),
                context_size: legacy.ollama_context_size,
            },
            openai: None,
            openrouter: None,
        },
        
        // Deprecated поля для обратной совместимости
        language: Some(legacy.language.clone()),
        model_id: legacy.model_id.clone(),
        ollama_model: Some(legacy.ollama_model.clone()),
        ollama_url: Some(legacy.ollama_url.clone()),
        ollama_context_size: Some(legacy.ollama_context_size),
    }
}
```

---

## 8. Нефункциональные требования

### 8.1 Производительность

| Метрика | Целевое значение | Примечание |
|---------|------------------|------------|
| Latency API call (cloud STT) | < 3s для 30s аудио | Зависит от провайдера |
| Latency API call (cloud LLM) | < 5s для 1000 токенов | Зависит от модели |
| UI отклик при смене провайдера | < 100ms | Локальная операция |
| Health check timeout | 5s | Для определения доступности |

### 8.2 Надёжность

| Требование | Реализация |
|------------|------------|
| Fallback при ошибке облака | Автоматический переход на локальный провайдер |
| Retry policy | 3 попытки с exponential backoff для 5xx ошибок |
| Timeout handling | Timeout 60s для STT, 120s для LLM |
| Rate limiting | Respect provider rate limits, queue excess requests |

### 8.3 Безопасность

| Требование | Реализация |
|------------|------------|
| API ключи не в config.json | Хранение в OS Keychain (keyring-rs) |
| Ключи не передаются в UI | Только флаг `api_key_set: true/false` |
| Валидация ключей | Проверка формата перед сохранением |
| Secure transport | Только HTTPS для облачных API |

---

## 9. Архитектурные риски

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Rate limiting облачных API | High | Medium | Реализовать очередь с backoff, показывать предупреждение |
| Высокая стоимость при интенсивном использовании | Medium | Medium | Показывать estimated cost, настраиваемые лимиты |
| Изменения API провайдеров | Low | High | Абстракция через traits, версионирование API clients |
| Утечка API ключей | Low | Critical | Secure storage, code review, не логировать ключи |
| Недоступность провайдера | Medium | Medium | Fallback chain, health checks, UI индикаторы |

---

## 10. Рекомендации для реализации

### Для @planner

**Области для декомпозиции:**

1. **Phase 1: Infrastructure** (приоритет: высокий)
   - Provider traits и типы
   - Secure key storage (keyring-rs)
   - Миграция settings структуры

2. **Phase 2: STT Providers** (приоритет: высокий)
   - OpenAI Whisper API integration
   - Deepgram integration
   - Fallback logic

3. **Phase 3: LLM Providers** (приоритет: средний)
   - OpenAI LLM integration
   - OpenRouter integration
   - Обновление generate_summary

4. **Phase 4: UI** (приоритет: средний)
   - ProviderSettings компоненты
   - Интеграция в SettingsModal
   - Status indicators

5. **Phase 5: Polish** (приоритет: низкий)
   - AssemblyAI, Groq интеграция
   - Cost tracking
   - Advanced error handling

### Для @coder

**Зависимости (Cargo.toml):**
```toml
keyring = "3"  # Для secure storage
```

**Структура файлов:**
```
rust/src-tauri/src/
├── providers/
│   ├── mod.rs
│   ├── types.rs           # Типы провайдеров
│   ├── traits.rs          # STTProvider, LLMProvider traits
│   ├── registry.rs        # Провайдер registry
│   ├── keystore.rs        # Secure key storage
│   ├── stt/
│   │   ├── mod.rs
│   │   ├── local.rs       # LocalSTTProvider
│   │   ├── openai.rs      # OpenAISTTProvider
│   │   ├── deepgram.rs    # DeepgramProvider
│   │   ├── assemblyai.rs  # AssemblyAIProvider
│   │   └── groq.rs        # GroqSTTProvider
│   └── llm/
│       ├── mod.rs
│       ├── ollama.rs      # OllamaProvider (рефакторинг существующего)
│       ├── openai.rs      # OpenAILLMProvider
│       └── openrouter.rs  # OpenRouterProvider
├── commands/
│   ├── providers.rs       # Tauri commands для провайдеров
```

**Conventions:**
- Все API вызовы через `reqwest::Client` с настроенными timeouts
- Логирование всех API ошибок (без API ключей!)
- Использовать `thiserror` для typed errors

### Для @tester

**Ключевые сценарии:**

1. **Settings Migration**
   - Загрузка старого config.json → корректная миграция
   - Сохранение новых настроек → обратная совместимость

2. **API Key Management**
   - Сохранение ключа → появляется в Keychain
   - Удаление ключа → исчезает из Keychain
   - Ключи не попадают в config.json

3. **Provider Switching**
   - Смена провайдера → транскрипция использует нового
   - Облачный недоступен → fallback на локальный
   - Нет API ключа → корректная ошибка

4. **Transcription Flow**
   - OpenAI STT → успешная транскрипция
   - Deepgram → успешная транскрипция с пунктуацией
   - Rate limit → retry и fallback

5. **LLM Flow**
   - OpenAI → успешная генерация сводки
   - OpenRouter → успешная генерация
   - Ollama (существующий) → без регрессий

**NFR тесты:**
- Latency при переключении провайдеров
- Timeout handling (60s+ ожидание)
- Memory при множественных API вызовах

---

## 11. Приложение: Примеры API вызовов

### OpenAI Whisper API

```rust
// POST https://api.openai.com/v1/audio/transcriptions
// Content-Type: multipart/form-data

let client = reqwest::Client::new();
let response = client
    .post("https://api.openai.com/v1/audio/transcriptions")
    .header("Authorization", format!("Bearer {}", api_key))
    .multipart(
        Form::new()
            .text("model", "whisper-1")
            .text("language", "ru")
            .text("response_format", "verbose_json")
            .part("file", Part::bytes(wav_data).file_name("audio.wav"))
    )
    .send()
    .await?;
```

### Deepgram API

```rust
// POST https://api.deepgram.com/v1/listen
// Content-Type: audio/wav

let client = reqwest::Client::new();
let response = client
    .post("https://api.deepgram.com/v1/listen")
    .query(&[
        ("model", "nova-2"),
        ("language", "ru"),
        ("punctuate", "true"),
        ("diarize", "false"),
    ])
    .header("Authorization", format!("Token {}", api_key))
    .header("Content-Type", "audio/wav")
    .body(wav_data)
    .send()
    .await?;
```

### OpenRouter API

```rust
// POST https://openrouter.ai/api/v1/chat/completions
// Compatible with OpenAI API format

let client = reqwest::Client::new();
let response = client
    .post("https://openrouter.ai/api/v1/chat/completions")
    .header("Authorization", format!("Bearer {}", api_key))
    .header("HTTP-Referer", "https://aiwisper.app")
    .json(&json!({
        "model": "anthropic/claude-3.5-sonnet",
        "messages": [
            {"role": "system", "content": "..."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.7,
        "max_tokens": 1000
    }))
    .send()
    .await?;
```
