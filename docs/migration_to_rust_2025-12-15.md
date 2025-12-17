# План миграции AIWisper на Rust

**Дата:** 2025-12-15  
**Статус:** В разработке  
**Версия:** 1.0

---

## 1. Обзор

### 1.1 Цель

Создать кроссплатформенную версию AIWisper полностью на Rust, устранив текущие проблемы:
- Memory leaks в sherpa-onnx/ONNX Runtime
- Зависимость от Swift/CoreML (только macOS)
- Сложность поддержки 4 языков (Go/TypeScript/Swift/C++)
- Большой размер приложения (Electron ~120MB)

### 1.2 Текущая архитектура (Legacy)

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Electron)                      │
│  React + TypeScript + gRPC-JS                                    │
└─────────────────────────────────────────────────────────────────┘
                              │ gRPC / WebSocket
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND (Go)                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────────┐│
│  │ Whisper     │ │   GigaAM    │ │   FluidAudio (Swift)        ││
│  │ (CGo/C++)   │ │   (ONNX)    │ │   subprocess                ││
│  └─────────────┘ └─────────────┘ └─────────────────────────────┘│
│  ┌─────────────┐ ┌─────────────────────────────────────────────┐│
│  │ Silero VAD  │ │ Sherpa-onnx Diarization (MEMORY LEAK!)      ││
│  │   (ONNX)    │ │ (CGo → C++)                                  ││
│  └─────────────┘ └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 Целевая архитектура (Rust)

```
┌─────────────────────────────────────────────────────────────────┐
│                      TAURI 2.0 APPLICATION                       │
├─────────────────────────────────────────────────────────────────┤
│                     Frontend (WebView)                           │
│  React (существующий) или Leptos/Dioxus (Rust) — Phase 3        │
└─────────────────────────────────────────────────────────────────┘
                              │ Tauri IPC (zero-copy)
┌─────────────────────────────────────────────────────────────────┐
│                         RUST BACKEND                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Audio Pipeline                         │   │
│  │  cpal (capture) → VAD → streaming buffer → resampling     │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    ML Inference Layer                     │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐ │   │
│  │  │ whisper-rs  │ │    ort      │ │    candle/burn      │ │   │
│  │  │  (Whisper)  │ │  (GigaAM)   │ │   (Pure Rust ML)    │ │   │
│  │  └─────────────┘ └─────────────┘ └─────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Worker Pool (Memory Isolation)               │   │
│  │  Каждый worker = отдельный процесс для изоляции утечек    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Ключевые проблемы и их решения

### 2.1 Memory Leak в ONNX Runtime / sherpa-onnx

**Проблема:**  
sherpa-onnx (и sherpa-rs как FFI wrapper) течёт по памяти при множественных вызовах inference. Это баг в самом ONNX Runtime C++, особенно в CoreML Execution Provider.

**Решения:**

| Подход | Описание | Платформы | Сложность |
|--------|----------|-----------|-----------|
| **Worker Process Isolation** | Выносим ML inference в отдельные процессы, периодически перезапускаем | Все | Средняя |
| **whisper-rs вместо sherpa** | whisper.cpp имеет лучший memory management | Все | Низкая |
| **Pure Rust ML (candle/burn)** | Полный контроль памяти, но меньше моделей | Все | Высокая |
| **Session Reuse** | Переиспользовать ONNX сессии, не создавать новые | Все | Низкая |

**Выбранная стратегия:**
1. **Whisper** — использовать `whisper-rs` (стабильный)
2. **GigaAM** — использовать `ort` с session reuse + memory monitoring
3. **VAD** — использовать `webrtc-vad` (pure Rust) или `silero через ort`
4. **Diarization** — Worker Process Isolation (критично!)

### 2.2 Кроссплатформенность

**Проблема:**  
FluidAudio работает только на macOS (CoreML), sherpa-onnx течёт везде.

**Решение:**  
Модульная архитектура с platform-specific backends:

```rust
pub trait TranscriptionEngine: Send + Sync {
    fn transcribe(&self, samples: &[f32]) -> Result<TranscriptionResult>;
    fn name(&self) -> &str;
}

// Platform-specific implementations
#[cfg(target_os = "macos")]
mod macos {
    pub struct WhisperCoreML { ... }  // Metal/CoreML acceleration
}

#[cfg(target_os = "windows")]
mod windows {
    pub struct WhisperDirectML { ... }  // DirectML acceleration
}

#[cfg(target_os = "linux")]
mod linux {
    pub struct WhisperCUDA { ... }  // CUDA if available, CPU fallback
}
```

### 2.3 Диаризация без Memory Leaks

**Проблема:**  
Pyannote/WeSpeaker через sherpa-onnx течёт критично.

**Решение — Worker Process Model:**

```rust
// Главный процесс
pub struct DiarizationService {
    worker_handle: Option<Child>,
    ipc_channel: UnixStream,
    memory_threshold: usize,  // Перезапуск при превышении
}

impl DiarizationService {
    pub async fn diarize(&mut self, audio: &[f32]) -> Result<Vec<SpeakerSegment>> {
        // Проверяем память worker'а
        if self.worker_memory() > self.memory_threshold {
            self.restart_worker().await?;
        }
        
        // Отправляем аудио в worker process
        self.send_to_worker(audio).await?;
        self.receive_from_worker().await
    }
    
    async fn restart_worker(&mut self) -> Result<()> {
        if let Some(mut handle) = self.worker_handle.take() {
            handle.kill()?;
        }
        self.worker_handle = Some(self.spawn_worker()?);
        Ok(())
    }
}
```

---

## 3. Фазы миграции

### Phase 1: Инфраструктура (2-3 недели) ✅ ЗАВЕРШЕНО

**Цель:** Создать базовую структуру проекта и Tauri приложение

**Задачи:**
- [x] Создать документ миграции
- [x] Создать структуру `rust/` директории
- [x] Настроить Cargo workspace
- [x] Создать Tauri 2.0 приложение
- [x] Tauri конфигурация (tauri.conf.json, capabilities)
- [x] Интегрировать существующий React UI в rust/ui/
- [x] Создать Tauri API bindings (rust/ui/src/lib/tauri.ts)
- [ ] Настроить CI/CD для Rust

**Структура директорий:**
```
rust/
├── Cargo.toml                 # Workspace root
├── tauri.conf.json           # Tauri configuration
├── src-tauri/                 # Tauri backend
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs           # Entry point
│   │   ├── lib.rs            # Library exports
│   │   ├── commands/         # Tauri commands (IPC)
│   │   ├── audio/            # Audio capture & processing
│   │   ├── ml/               # ML engines
│   │   ├── workers/          # Worker process management
│   │   └── state/            # Application state
│   └── build.rs              # Build script
├── crates/                    # Shared crates
│   ├── aiwisper-audio/       # Audio processing
│   ├── aiwisper-ml/          # ML inference
│   ├── aiwisper-types/       # Shared types
│   └── aiwisper-worker/      # Worker process binary
└── ui/                        # Frontend (копия из frontend/)
    ├── package.json
    ├── src/
    └── ...
```

### Phase 2: Core ML Pipeline (4-6 недель) - В ПРОЦЕССЕ

**Цель:** Перенести ML inference на Rust

**Задачи:**
- [x] Интегрировать `whisper-rs` для Whisper транскрипции
- [x] Интегрировать `ort` для GigaAM (aiwisper-ml/src/gigaam.rs)
- [x] Создать Worker Process для изоляции memory leaks
- [ ] Реализовать VAD (webrtc-vad или silero)
- [ ] Интегрировать sherpa-rs для диаризации в worker
- [ ] Портировать Hybrid Transcription логику
- [ ] Тесты производительности и памяти

**Зависимости:**
```toml
[dependencies]
# Audio
cpal = "0.15"                    # Cross-platform audio I/O
rubato = "0.14"                  # High-quality resampling
symphonia = "0.5"                # Audio decoding

# ML Inference
whisper-rs = "0.13"              # Whisper.cpp bindings
ort = { version = "1.19", features = ["cuda", "coreml", "directml"] }

# VAD options
webrtc-vad = "0.4"               # Pure Rust VAD
# OR silero via ort

# Async
tokio = { version = "1", features = ["full"] }

# IPC for workers
interprocess = "2"               # Cross-platform IPC
```

### Phase 3: UI Migration (опционально, 2-4 недели)

**Цель:** Опционально перенести UI на Rust (Leptos/Dioxus)

**Задачи:**
- [ ] Оценить Leptos vs Dioxus
- [ ] Портировать компоненты
- [ ] Удалить зависимость от Node.js/npm

**Примечание:** Можно оставить React UI через Tauri WebView — это работает отлично.

---

## 4. Детальный план модулей

### 4.1 Audio Module (`aiwisper-audio`)

```rust
// crates/aiwisper-audio/src/lib.rs

pub mod capture;      // Audio capture (cpal)
pub mod resampling;   // Resampling to 16kHz (rubato)
pub mod vad;          // Voice Activity Detection
pub mod buffer;       // Ring buffer for streaming

// Public API
pub struct AudioCapture {
    device: cpal::Device,
    stream: Option<cpal::Stream>,
    buffer: Arc<RwLock<RingBuffer>>,
}

impl AudioCapture {
    pub fn new(device_name: Option<&str>) -> Result<Self>;
    pub fn start(&mut self) -> Result<()>;
    pub fn stop(&mut self);
    pub fn get_samples(&self, duration_ms: u32) -> Vec<f32>;
}

pub struct VoiceActivityDetector {
    // webrtc-vad или silero
}

impl VoiceActivityDetector {
    pub fn is_speech(&self, samples: &[f32]) -> bool;
    pub fn detect_segments(&self, samples: &[f32]) -> Vec<SpeechSegment>;
}
```

### 4.2 ML Module (`aiwisper-ml`)

```rust
// crates/aiwisper-ml/src/lib.rs

pub mod whisper;      // Whisper transcription
pub mod gigaam;       // GigaAM transcription  
pub mod hybrid;       // Hybrid transcription (voting)
pub mod diarization;  // Speaker diarization

// Traits
pub trait TranscriptionEngine: Send + Sync {
    fn transcribe(&self, samples: &[f32]) -> Result<TranscriptionResult>;
    fn transcribe_with_segments(&self, samples: &[f32]) -> Result<Vec<TranscriptSegment>>;
    fn name(&self) -> &str;
    fn supported_languages(&self) -> &[&str];
}

pub trait DiarizationEngine: Send + Sync {
    fn diarize(&self, samples: &[f32]) -> Result<Vec<SpeakerSegment>>;
}

// Implementations
pub struct WhisperEngine {
    ctx: whisper_rs::WhisperContext,
    language: String,
    hotwords: Vec<String>,
}

pub struct GigaAmEngine {
    session: ort::Session,
    // ...
}

pub struct HybridTranscriber {
    primary: Box<dyn TranscriptionEngine>,
    secondary: Box<dyn TranscriptionEngine>,
    voting_config: VotingConfig,
}
```

### 4.3 Worker Module (`aiwisper-worker`)

```rust
// crates/aiwisper-worker/src/main.rs
// Отдельный бинарник для изоляции memory leaks

use std::io::{stdin, stdout, BufRead, Write};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
enum WorkerCommand {
    Diarize { samples: Vec<f32> },
    TranscribeSherpa { samples: Vec<f32>, model: String },
    Shutdown,
}

#[derive(Serialize)]
enum WorkerResponse {
    Diarization(Vec<SpeakerSegment>),
    Transcription(TranscriptionResult),
    Error(String),
}

fn main() {
    // Инициализация моделей один раз
    let diarizer = init_diarizer();
    
    // Цикл обработки команд
    for line in stdin().lock().lines() {
        let cmd: WorkerCommand = serde_json::from_str(&line?)?;
        
        let response = match cmd {
            WorkerCommand::Diarize { samples } => {
                match diarizer.diarize(&samples) {
                    Ok(segments) => WorkerResponse::Diarization(segments),
                    Err(e) => WorkerResponse::Error(e.to_string()),
                }
            }
            WorkerCommand::Shutdown => break,
            // ...
        };
        
        println!("{}", serde_json::to_string(&response)?);
        stdout().flush()?;
    }
}
```

### 4.4 Tauri Commands

```rust
// src-tauri/src/commands/mod.rs

use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn start_recording(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.lock().await.start()?;
    Ok(())
}

#[tauri::command]
pub async fn stop_recording(state: State<'_, AppState>) -> Result<TranscriptionResult, String> {
    let samples = state.audio.lock().await.stop_and_get_samples()?;
    let result = state.transcriber.lock().await.transcribe(&samples)?;
    Ok(result)
}

#[tauri::command]
pub async fn get_transcript_stream(
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Result<(), String> {
    // Streaming через Tauri events
    let rx = state.transcript_channel.subscribe();
    
    tokio::spawn(async move {
        while let Ok(segment) = rx.recv().await {
            window.emit("transcript-segment", segment).ok();
        }
    });
    
    Ok(())
}
```

---

## 5. Сравнение зависимостей

### Legacy (Go + Swift + Node.js)

| Компонент | Технология | Размер | Memory Issues |
|-----------|------------|--------|---------------|
| Whisper | whisper.cpp (CGo) | ~50MB | Минимальные |
| GigaAM | onnxruntime_go | ~200MB | Средние |
| Parakeet | FluidAudio (Swift) | ~100MB | Нет (subprocess) |
| Diarization | sherpa-onnx (CGo) | ~150MB | **КРИТИЧНЫЕ** |
| VAD | onnxruntime_go | ~20MB | Средние |
| Frontend | Electron | ~120MB | Высокие (Chromium) |
| **TOTAL** | | **~640MB** | |

### Target (Rust + Tauri)

| Компонент | Технология | Размер | Memory Issues |
|-----------|------------|--------|---------------|
| Whisper | whisper-rs | ~50MB | Минимальные |
| GigaAM | ort | ~200MB | Средние (session reuse) |
| Parakeet | sherpa-rs или ort | ~100MB | Worker isolation |
| Diarization | Worker process | ~150MB | **ИЗОЛИРОВАНЫ** |
| VAD | webrtc-vad (pure Rust) | ~1MB | Нет |
| Frontend | Tauri WebView | ~3MB | Минимальные |
| **TOTAL** | | **~504MB** (runtime) | |

**Размер бинарника:**
- Legacy (Electron): ~150MB
- Target (Tauri): ~15-20MB

---

## 6. Риски и митигация

### Высокие риски

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Memory leaks в ort/sherpa-rs | Высокая | Worker Process Isolation |
| whisper-rs нестабилен | Низкая | Хорошо протестирован, активно поддерживается |
| Потеря функциональности | Средняя | Поэтапная миграция с тестированием |

### Средние риски

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Регрессия производительности | Средняя | Бенчмарки на каждом этапе |
| Сложности с cross-compilation | Средняя | CI/CD на всех платформах |
| Конфликт whisper-rs + ort | Низкая | Разделение в отдельные crates |

---

## 7. Метрики успеха

### Memory
- [ ] Нет роста памяти >10MB за час работы
- [ ] Worker restart не чаще 1 раза в 30 минут
- [ ] Peak memory < 1GB при активной работе

### Performance
- [ ] Транскрипция RTF > 10x (10 секунд аудио за 1 секунду)
- [ ] Latency < 500ms для streaming режима
- [ ] Cold start < 3 секунды

### Quality
- [ ] WER не хуже legacy версии
- [ ] Диаризация accuracy не хуже legacy

### Size
- [ ] Размер приложения < 50MB
- [ ] Размер установщика < 30MB

---

## 8. Timeline

```
Week 1-2:   [Phase 1] Инфраструктура, Tauri setup
Week 3-4:   [Phase 2] Audio module, whisper-rs интеграция
Week 5-6:   [Phase 2] GigaAM, VAD, Worker Process
Week 7-8:   [Phase 2] Hybrid transcription, тестирование
Week 9-10:  [Testing] Интеграционное тестирование, баг-фиксы
Week 11-12: [Release] Beta release, сбор фидбека
```

---

## 9. Ссылки

### Документация
- [Tauri 2.0](https://v2.tauri.app/)
- [whisper-rs](https://docs.rs/whisper-rs)
- [ort (ONNX Runtime)](https://ort.pyke.io/)
- [cpal](https://docs.rs/cpal)

### Исследования Memory Leaks
- [sherpa-onnx #1939](https://github.com/k2-fsa/sherpa-onnx/issues/1939)
- [onnxruntime #14455](https://github.com/microsoft/onnxruntime/issues/14455)

### Альтернативные ML Frameworks
- [candle](https://github.com/huggingface/candle)
- [burn](https://github.com/tracel-ai/burn)
- [tract](https://github.com/sonos/tract)
