# Код-ревью Rust-части AIWisper

**Дата:** 27 декабря 2025  
**Версия:** 2.0.19  
**Ревьюер:** AI Code Reviewer  

---

## Содержание

1. [Обзор архитектуры](#обзор-архитектуры)
2. [Критические проблемы](#критические-проблемы)
3. [Проблемы высокого приоритета](#проблемы-высокого-приоритета)
4. [Проблемы среднего приоритета](#проблемы-среднего-приоритета)
5. [Проблемы низкого приоритета](#проблемы-низкого-приоритета)
6. [Положительные аспекты](#положительные-аспекты)
7. [Рекомендации по исправлению](#рекомендации-по-исправлению)
8. [Безопасность](#безопасность)
9. [Производительность](#производительность)

---

## Обзор архитектуры

### Структура workspace

```
rust/
├── Cargo.toml              # Workspace root
├── src-tauri/              # Tauri приложение
│   └── src/
│       ├── lib.rs          # Точка входа Tauri
│       ├── state/          # Управление состоянием
│       │   ├── mod.rs      # ~2000 строк
│       │   └── recording.rs # ~1500 строк
│       └── providers/      # STT/LLM провайдеры
└── crates/
    ├── aiwisper-audio/     # Захват аудио, MP3, VAD
    ├── aiwisper-ml/        # ML движки (Whisper, GigaAM)
    ├── aiwisper-types/     # Общие типы
    └── aiwisper-worker/    # Worker процесс
```

### Зависимости workspace

- **Async runtime:** tokio 1.x
- **ML:** whisper-rs 0.15, ort 2.0.0-rc.9
- **Audio:** cpal 0.15, rubato 0.14
- **Serialization:** serde 1.x, serde_json 1.x

---

## Критические проблемы

### 1. DFT вместо FFT — O(n²) сложность

**Файл:** `rust/crates/aiwisper-ml/src/gigaam.rs:821-843`  
**Серьёзность:** 🔴 КРИТИЧЕСКАЯ  
**Влияние:** Производительность, CPU usage

```rust
// ПРОБЛЕМА: Наивная реализация DFT с O(n²) сложностью
fn compute_power_spectrum(samples: &[f32]) -> Vec<f32> {
    let n = samples.len();
    let n_fft = n / 2 + 1;

    // Simple DFT implementation (for correctness)
    // In production, use rustfft for performance  <-- Комментарий указывает на проблему!
    let mut power = vec![0.0f32; n_fft];

    for k in 0..n_fft {           // O(n)
        let mut real = 0.0f32;
        let mut imag = 0.0f32;

        for (t, &sample) in samples.iter().enumerate() {  // O(n) внутри O(n) = O(n²)
            let angle = -2.0 * std::f32::consts::PI * (k * t) as f32 / n as f32;
            real += sample * angle.cos();
            imag += sample * angle.sin();
        }

        power[k] = real * real + imag * imag;
    }

    power
}
```

**Исправление:**
```rust
use rustfft::{FftPlanner, num_complex::Complex};

fn compute_power_spectrum(samples: &[f32]) -> Vec<f32> {
    let n = samples.len();
    let n_fft = n / 2 + 1;
    
    // Подготовка входных данных
    let mut buffer: Vec<Complex<f32>> = samples
        .iter()
        .map(|&s| Complex::new(s, 0.0))
        .collect();
    
    // FFT с O(n log n) сложностью
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n);
    fft.process(&mut buffer);
    
    // Вычисление power spectrum
    buffer[..n_fft]
        .iter()
        .map(|c| c.norm_sqr())
        .collect()
}
```

**Добавить в Cargo.toml:**
```toml
rustfft = "6.2"
```

---

### 2. Несоответствие версий ndarray

**Файлы:**  
- `rust/Cargo.toml:49` — `ndarray = "0.16"`
- `rust/crates/aiwisper-ml/Cargo.toml:12` — `ndarray = "0.15"`

**Серьёзность:** 🔴 КРИТИЧЕСКАЯ  
**Влияние:** Несовместимость типов, ошибки компиляции при обновлении

```toml
# rust/Cargo.toml (workspace)
[workspace.dependencies]
ndarray = "0.16"

# rust/crates/aiwisper-ml/Cargo.toml
[dependencies]
ndarray = "0.15"  # ❌ Не использует workspace версию!
```

**Исправление:**
```toml
# rust/crates/aiwisper-ml/Cargo.toml
[dependencies]
ndarray = { workspace = true }  # ✅ Использует workspace версию
```

---

## Проблемы высокого приоритета

### 3. `unwrap()` на `Mutex::lock()` — потенциальная паника

**Файлы и строки:**
- `rust/crates/aiwisper-ml/src/gigaam.rs:108`
- `rust/crates/aiwisper-ml/src/vad.rs:151, 154, 167, 168, 195`
- `rust/crates/aiwisper-audio/src/capture.rs:165, 171, 176`
- `rust/crates/aiwisper-ml/src/diarization.rs:267, 289`

**Серьёзность:** 🟠 ВЫСОКАЯ  
**Влияние:** Паника при poisoned mutex, крах приложения

```rust
// ПРОБЛЕМА: unwrap() на Mutex::lock() может паниковать
let mut session_guard = self.session.lock().unwrap();

// В capture.rs:
let mut buffer = self.buffer.lock().unwrap();
self.buffer.lock().unwrap().clone()
self.buffer.lock().unwrap().clear();
```

**Исправление с parking_lot (рекомендуется):**
```rust
// parking_lot::Mutex не возвращает Result, не может быть poisoned
use parking_lot::Mutex;

let session_guard = self.session.lock();  // Никогда не паникует
```

**Исправление с std::sync::Mutex:**
```rust
// Вариант 1: Игнорировать poisoning (если данные всё равно валидны)
let session_guard = self.session.lock().unwrap_or_else(|poisoned| {
    tracing::warn!("Mutex was poisoned, recovering");
    poisoned.into_inner()
});

// Вариант 2: Возвращать ошибку
let session_guard = self.session.lock()
    .map_err(|_| anyhow::anyhow!("Mutex poisoned"))?;
```

---

### 4. Гигантская функция recording_thread (~750 строк)

**Файл:** `rust/src-tauri/src/state/recording.rs:345-900+`  
**Серьёзность:** 🟠 ВЫСОКАЯ  
**Влияние:** Поддерживаемость, тестируемость, читаемость

```rust
fn recording_thread(
    session_id: String,
    _mp3_path: PathBuf,
    data_dir: PathBuf,
    device_id: Option<String>,
    capture_system: bool,
    stop_flag: Arc<AtomicBool>,
    mic_muted: Arc<AtomicBool>,
    sys_muted: Arc<AtomicBool>,
    app_handle: tauri::AppHandle,
    transcription_config: TranscriptionConfig,
) -> RecordingResult {
    // ~750 строк кода в одной функции!
}
```

**Рекомендуемая декомпозиция:**
```rust
// Разбить на логические модули:

struct RecordingContext {
    session_id: String,
    data_dir: PathBuf,
    stop_flag: Arc<AtomicBool>,
    mic_muted: Arc<AtomicBool>,
    sys_muted: Arc<AtomicBool>,
    app_handle: tauri::AppHandle,
    transcription_config: TranscriptionConfig,
}

impl RecordingContext {
    fn setup_captures(&self, device_id: Option<String>, capture_system: bool) 
        -> Result<(AudioCapture, Option<Box<dyn SystemAudioCapture>>)>;
    
    fn process_audio_frame(&mut self, mic_samples: &[f32], sys_samples: &[f32]) 
        -> Result<()>;
    
    fn handle_chunk_event(&mut self, event: ChunkEvent) -> Result<ChunkMeta>;
    
    fn emit_audio_level(&self, mic_level: f32, sys_level: f32, elapsed: f64);
    
    fn finalize(&mut self) -> RecordingResult;
}

fn recording_thread(ctx: RecordingContext) -> RecordingResult {
    let (mic_capture, sys_capture) = ctx.setup_captures()?;
    
    loop {
        if ctx.should_stop() { break; }
        
        let (mic_samples, sys_samples) = ctx.read_audio_samples()?;
        ctx.process_audio_frame(&mic_samples, &sys_samples)?;
        
        while let Some(event) = ctx.try_recv_chunk() {
            ctx.handle_chunk_event(event)?;
        }
        
        ctx.emit_audio_level(mic_level, sys_level, elapsed);
    }
    
    ctx.finalize()
}
```

---

### 5. Статические переменные в цикле записи

**Файл:** `rust/src-tauri/src/state/recording.rs:607-608`  
**Серьёзность:** 🟠 ВЫСОКАЯ  
**Влияние:** Race conditions при параллельных записях, некорректное поведение

```rust
// ПРОБЛЕМА: static переменные внутри функции
// При параллельных записях будут конфликты!
static LAST_MIC_MUTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LAST_SYS_MUTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

let last_mic = LAST_MIC_MUTED.swap(is_mic_muted, Ordering::Relaxed);
let last_sys = LAST_SYS_MUTED.swap(is_sys_muted, Ordering::Relaxed);
```

**Исправление:**
```rust
// Использовать локальные переменные
let mut last_mic_muted = false;
let mut last_sys_muted = false;

// В цикле:
if last_mic_muted != is_mic_muted || last_sys_muted != is_sys_muted {
    tracing::info!("🔇 Mute state changed: mic_muted={}, sys_muted={}", is_mic_muted, is_sys_muted);
    last_mic_muted = is_mic_muted;
    last_sys_muted = is_sys_muted;
}
```

---

### 6. Дублирование кода calculate_rms

**Файлы:**
- `rust/crates/aiwisper-audio/src/lib.rs` (экспортируется)
- `rust/src-tauri/src/state/recording.rs:548-551, 807-808` (inline реализация)

**Серьёзность:** 🟠 ВЫСОКАЯ  
**Влияние:** Несогласованность, сложность поддержки

```rust
// В recording.rs (дублирование):
let rms: f32 = (data.samples.iter().map(|s| s * s).sum::<f32>()
    / data.samples.len() as f32)
    .sqrt();
sys_level = (rms * 300.0).min(100.0);

// И ещё раз:
let rms: f32 = (recent.iter().map(|s| s * s).sum::<f32>() / recent.len() as f32).sqrt();
```

**Исправление:**
```rust
// Использовать функцию из aiwisper_audio
use aiwisper_audio::calculate_rms;

let rms = calculate_rms(&data.samples);
let level = (rms * 300.0).min(100.0);
```

---

## Проблемы среднего приоритета

### 7. Хардкод абсолютных путей

**Файл:** `rust/crates/aiwisper-ml/src/diarization.rs:148-149`  
**Серьёзность:** 🟡 СРЕДНЯЯ  
**Влияние:** Не работает на других машинах

```rust
let candidates = vec![
    // ...
    // ❌ Хардкод абсолютных путей!
    Some(PathBuf::from("/Users/askid/Projects/AIWisper/rust/src-tauri/resources/diarization-fluid")),
    Some(PathBuf::from("/Users/askid/Projects/AIWisper/backend/audio/diarization/.build/release/diarization-fluid")),
];
```

**Исправление:**
```rust
fn find_binary() -> Result<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    
    // Получаем корень проекта через переменную окружения или cargo
    let project_root = std::env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(|| exe_dir.as_ref().map(|d| d.join("../../..")));

    let candidates = vec![
        // Packaged app
        exe_dir.as_ref().map(|d| d.join("diarization-fluid")),
        exe_dir.as_ref().map(|d| d.join("../Resources/diarization-fluid")),
        exe_dir.as_ref().map(|d| d.join("resources/diarization-fluid")),
        // Development (относительные пути)
        project_root.as_ref().map(|d| d.join("rust/src-tauri/resources/diarization-fluid")),
        project_root.as_ref().map(|d| d.join("backend/audio/diarization/.build/release/diarization-fluid")),
    ];
    
    // ...
}
```

---

### 8. Множество `#[allow(dead_code)]`

**Файлы:** 20 мест в кодовой базе  
**Серьёзность:** 🟡 СРЕДНЯЯ  
**Влияние:** Мёртвый код, увеличение размера бинарника

```rust
// Примеры:
#[allow(dead_code)]
struct GoSessionMeta { ... }

#[allow(dead_code)]
struct GoChunkMeta { ... }
```

**Рекомендации:**
1. Удалить действительно неиспользуемый код
2. Для структур десериализации использовать `#[serde(deny_unknown_fields)]`
3. Для полей, нужных только для JSON: `#[serde(skip_serializing)]`

---

### 9. Блокирующие операции в async контексте

**Файл:** `rust/src-tauri/src/state/mod.rs`  
**Серьёзность:** 🟡 СРЕДНЯЯ  
**Влияние:** Блокировка tokio runtime

```rust
// Потенциальная проблема: std::fs в async функции
async fn some_function() {
    // ❌ Блокирующий вызов в async контексте
    let content = std::fs::read_to_string(&path)?;
}
```

**Исправление:**
```rust
async fn some_function() {
    // ✅ Использовать tokio::fs
    let content = tokio::fs::read_to_string(&path).await?;
    
    // Или spawn_blocking для CPU-bound операций
    let result = tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&path)
    }).await??;
}
```

---

### 10. Отсутствие workspace lints

**Файл:** `rust/Cargo.toml`  
**Серьёзность:** 🟡 СРЕДНЯЯ  
**Влияние:** Несогласованность стиля, пропущенные предупреждения

**Добавить в workspace Cargo.toml:**
```toml
[workspace.lints.rust]
unsafe_code = "warn"
missing_docs = "warn"

[workspace.lints.clippy]
all = "warn"
pedantic = "warn"
nursery = "warn"
unwrap_used = "warn"
expect_used = "warn"
panic = "warn"
```

---

## Проблемы низкого приоритета

### 11. Неиспользуемые импорты

**Файл:** `rust/src-tauri/src/state/mod.rs:11-12, 22-23`

```rust
#[allow(unused_imports)]
use aiwisper_audio::{are_channels_similar, is_silent, AudioCapture};

#[allow(unused_imports)]
use uuid::Uuid;
```

**Исправление:** Удалить неиспользуемые импорты или использовать их.

---

### 12. Magic numbers без констант

**Файл:** `rust/src-tauri/src/state/recording.rs`

```rust
// Magic numbers разбросаны по коду
sys_level = (rms * 300.0).min(100.0);  // Почему 300.0?
const SYS_EMPTY_WARNING_THRESHOLD: u32 = 40; // 2 секунды (40 * 50ms)
std::thread::sleep(std::time::Duration::from_millis(50));
```

**Исправление:**
```rust
/// Множитель для конвертации RMS в уровень 0-100
const RMS_TO_LEVEL_MULTIPLIER: f32 = 300.0;
/// Максимальный уровень аудио
const MAX_AUDIO_LEVEL: f32 = 100.0;
/// Интервал опроса аудио в миллисекундах
const AUDIO_POLL_INTERVAL_MS: u64 = 50;
/// Порог предупреждения о пустом системном аудио (итерации)
const SYS_EMPTY_WARNING_THRESHOLD: u32 = 40;
```

---

## Положительные аспекты

### ✅ Хорошая организация workspace
- Чёткое разделение на crates по функциональности
- Централизованные зависимости в workspace

### ✅ Правильные абстракции
- Trait `TranscriptionEngine` для разных движков
- Trait `DiarizationEngine` для диаризации

### ✅ Управление памятью
- Sliding window buffer для аудио
- Segmented MP3 writer для длительных записей
- Drain механизм для освобождения памяти после транскрипции

### ✅ Хорошее логирование
- Использование tracing с уровнями
- Информативные сообщения об ошибках

### ✅ Обработка ошибок
- Использование anyhow и thiserror
- Result-based API

### ✅ Оптимизация release профиля
```toml
[profile.release]
lto = true
codegen-units = 1
opt-level = 3
strip = true
```

---

## Рекомендации по исправлению

### Приоритет 1 (Критические — исправить немедленно)

| # | Проблема | Файл | Действие |
|---|----------|------|----------|
| 1 | DFT O(n²) | gigaam.rs:821-843 | Заменить на rustfft |
| 2 | ndarray версия | aiwisper-ml/Cargo.toml | Использовать workspace = true |

### Приоритет 2 (Высокие — исправить в ближайшем спринте)

| # | Проблема | Файл | Действие |
|---|----------|------|----------|
| 3 | unwrap() на Mutex | 10+ файлов | Перейти на parking_lot |
| 4 | Гигантская функция | recording.rs | Декомпозиция на модули |
| 5 | Static в функции | recording.rs:607-608 | Локальные переменные |
| 6 | Дублирование RMS | recording.rs | Использовать aiwisper_audio |

### Приоритет 3 (Средние — запланировать)

| # | Проблема | Файл | Действие |
|---|----------|------|----------|
| 7 | Хардкод путей | diarization.rs | Относительные пути |
| 8 | dead_code | 20 мест | Удалить или использовать |
| 9 | Blocking в async | state/mod.rs | tokio::fs |
| 10 | Нет workspace lints | Cargo.toml | Добавить lints |

---

## Безопасность

### Обнаруженные риски

1. **Низкий риск:** `unwrap()` на API ключах
   ```rust
   // rust/src-tauri/src/providers/stt/openai.rs:245
   let api_key = self.api_key.read().clone().unwrap();
   ```
   Может паниковать если ключ не установлен.

2. **Низкий риск:** Хардкод путей может раскрыть структуру проекта

### Рекомендации по безопасности

1. Добавить валидацию входных данных для аудио
2. Использовать `secrecy` crate для API ключей
3. Добавить rate limiting для API вызовов

---

## Производительность

### Критические оптимизации

1. **FFT вместо DFT** — ускорение в ~100x для типичных размеров окна
2. **Избежать клонирования** в hot path:
   ```rust
   // Вместо:
   new_mic_samples_raw.clone()
   // Использовать:
   &new_mic_samples_raw
   ```

### Рекомендуемые оптимизации

1. Использовать `SmallVec` для небольших буферов
2. Предаллоцировать буферы известного размера
3. Использовать SIMD для аудио обработки (через `packed_simd` или `std::simd`)

---

## Заключение

Кодовая база AIWisper имеет хорошую архитектуру и организацию, но содержит несколько критических проблем производительности и поддерживаемости, которые требуют немедленного внимания:

1. **DFT → FFT** — критическое улучшение производительности
2. **Версия ndarray** — потенциальные проблемы совместимости
3. **Рефакторинг recording_thread** — улучшение поддерживаемости

Рекомендуется создать отдельные задачи для каждой категории проблем и планомерно их устранять.
