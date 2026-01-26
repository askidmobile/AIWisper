# Архитектура захвата системного звука

Дата: 2025-12-15

## Обзор

Модуль `system_audio` в crate `aiwisper-audio` предоставляет кросс-платформенный захват системного звука (loopback) для записи всех звуков воспроизводимых системой.

## Структура модуля

```
rust/crates/aiwisper-audio/src/
├── lib.rs                  # Экспорт публичного API
├── capture.rs              # Захват микрофона (cpal)
├── system_audio/
│   ├── mod.rs             # Trait SystemAudioCapture, типы, фабрика
│   ├── macos.rs           # macOS: Swift бинарники
│   ├── windows.rs         # Windows: WASAPI Loopback
│   └── linux.rs           # Linux: PipeWire/PulseAudio monitor
```

## Платформенная реализация

### macOS (13+)

**Переиспользует существующую реализацию из Go backend:**

1. **Core Audio Process Tap** (macOS 14.2+)
   - Бинарник: `backend/audio/coreaudio/.build/release/coreaudio-tap`
   - НЕ требует разрешения Screen Recording
   - Работает в shared mode (не блокирует другие приложения)
   - Меньше overhead

2. **ScreenCaptureKit** (macOS 13+)
   - Бинарник: `backend/audio/screencapture/.build/release/screencapture-audio`
   - Требует разрешения Screen Recording
   - Режимы: `system`, `mic`, `both`
   - На macOS 15+ поддерживает Voice Isolation

**Бинарный протокол Swift → Rust:**
```
[маркер 1 байт][размер 4 байта little-endian][float32 samples]
Маркеры: 'M' (0x4D) = микрофон, 'S' (0x53) = системный звук
```

### Windows (Vista+)

**WASAPI Loopback Capture:**
- Использует cpal с WASAPI backend
- Захват с default output device в режиме loopback
- Не требует дополнительного софта

### Linux

**PipeWire или PulseAudio:**
- Использует cpal для доступа к monitor sources
- Автоматическое определение PipeWire vs PulseAudio
- Monitor sources экспонируют системный звук

## API

```rust
use aiwisper_audio::{
    create_system_capture,
    SystemCaptureConfig,
    SystemCaptureMethod,
    AudioChannel,
    ChannelData,
};

// Создание захвата
let config = SystemCaptureConfig {
    method: SystemCaptureMethod::CoreAudioTap,
    sample_rate: 24000,
    capture_microphone: false,
};

let mut capture = create_system_capture(config)?;

// Запуск
capture.start()?;

// Получение данных
let receiver = capture.get_receiver();
while let Ok(data) = receiver.recv() {
    match data.channel {
        AudioChannel::System => { /* системный звук */ }
        AudioChannel::Microphone => { /* микрофон */ }
    }
    process_samples(&data.samples);
}

// Остановка
capture.stop()?;
```

## Иерархия методов захвата (macOS)

```
┌─────────────────────────────────────────────────────────┐
│ Core Audio Process Tap (macOS 14.2+)                    │
│ - Лучший выбор: не требует Screen Recording             │
│ - Меньше конфликтов с другими приложениями              │
├─────────────────────────────────────────────────────────┤
│ ScreenCaptureKit (macOS 13+)                            │
│ - Требует Screen Recording permission                   │
│ - Поддержка Voice Isolation (macOS 15+)                 │
├─────────────────────────────────────────────────────────┤
│ BlackHole/Loopback (legacy)                             │
│ - Требует установки стороннего софта                    │
└─────────────────────────────────────────────────────────┘
```

## Сборка Swift бинарников

```bash
# Core Audio tap
cd backend/audio/coreaudio
swift build -c release

# ScreenCaptureKit
cd backend/audio/screencapture
swift build -c release
```

## Интеграция с Tauri

При сборке Tauri приложения, Swift бинарники должны быть скопированы в resources:

```toml
# tauri.conf.json
{
  "bundle": {
    "resources": [
      "../backend/audio/coreaudio/.build/release/coreaudio-tap",
      "../backend/audio/screencapture/.build/release/screencapture-audio"
    ]
  }
}
```

## TODO

- [ ] Добавить тесты для каждой платформы
- [ ] Улучшить Windows WASAPI реализацию (использовать wasapi-rs для полного loopback)
- [ ] Добавить выбор конкретного monitor source на Linux
- [ ] Интегрировать с существующим AudioCapture для unified API
