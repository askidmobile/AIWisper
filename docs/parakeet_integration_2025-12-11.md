# Интеграция NVIDIA Parakeet TDT v3 в AIWisper

**Дата:** 2025-12-11  
**Статус:** ✅ Завершено

## Обзор

Интегрирована модель NVIDIA Parakeet TDT 0.6B v3 для высококачественной транскрипции речи через FluidAudio CoreML. Модель поддерживает 25 европейских языков с WER 1.93% на LibriSpeech.

## Архитектура

```
┌─────────────────┐    stdin     ┌──────────────────────┐
│  Go Backend     │ ──────────▶ │  Swift CLI           │
│                 │   (float32)  │  transcription-fluid │
│ FluidASREngine  │              │                      │
│                 │ ◀────────── │  AsrManager          │
└─────────────────┘    stdout    │  (FluidAudio)        │
                       (JSON)    └──────────────────────┘
```

### Subprocess Pattern

Используется проверенный subprocess-паттерн из FluidDiarizer:
- ✅ **Без memory leaks** - процесс завершается после каждой транскрипции
- ✅ **Параллельные вызовы** - каждый subprocess изолирован
- ✅ **Apple Neural Engine** - максимальная производительность на M-серии

## Созданные файлы

### Swift CLI

1. **`/backend/audio/transcription/Package.swift`**
   - Swift Package Manager конфигурация
   - Зависимость: FluidAudio 0.7.9+

2. **`/backend/audio/transcription/Sources/main.swift`**
   - CLI для транскрипции через FluidAudio
   - Поддержка stdin (float32 samples) и файлов
   - Кастомный кэш моделей через `--model-cache-dir`
   - Группировка токенов в сегменты по паузам (500ms threshold)

3. **`/backend/audio/transcription/build.sh`**
   - Скрипт сборки release binary
   - Размер binary: ~2 MB

### Go Integration

4. **`/backend/ai/transcription_fluid.go`**
   - `FluidASREngine` - реализация `TranscriptionEngine`
   - Subprocess управление
   - Бинарная передача float32 через stdin
   - Парсинг JSON результатов
   - Поддержка параллельных вызовов (без mutex на subprocess)

5. **`/backend/ai/transcription_fluid_test.go`**
   - Unit тесты для FluidASREngine
   - Проверка интерфейса TranscriptionEngine
   - Тест транскрипции на синусоиде

### Registry & Engine Manager

6. **`/backend/ai/engine.go`**
   - Добавлен `EngineTypeFluidASR = "fluid-asr"`

7. **`/backend/models/registry.go`**
   - Добавлен `ModelTypeCoreML` для CoreML моделей
   - Добавлен `EngineTypeFluidASR`
   - Модель `parakeet-tdt-v3` в Registry:
     - 25 европейских языков
     - WER 1.93%
     - ~640 MB
     - ~110x RTF на M4 Pro
     - Recommended: true

8. **`/backend/ai/engine_manager.go`**
   - Case для `EngineTypeFluidASR`
   - Передача `ModelCacheDir` в FluidASREngine

9. **`/backend/models/manager.go`**
   - `IsModelDownloaded()` для CoreML моделей
   - CoreML модели всегда "доступны" (скачиваются автоматически FluidAudio)

## Использование

### Сборка transcription-fluid

```bash
cd backend/audio/transcription
./build.sh
```

Binary создаётся в `.build/release/transcription-fluid` (~2 MB).

### Использование в Go

```go
import "aiwisper/ai"
import "aiwisper/models"

// Создание движка
engine, err := ai.NewFluidASREngine(ai.FluidASRConfig{
    ModelCacheDir: "/path/to/models", // Опционально
})
if err != nil {
    log.Fatal(err)
}
defer engine.Close()

// Транскрипция
samples := []float32{ /* 16kHz mono audio */ }
text, err := engine.Transcribe(samples, false)
if err != nil {
    log.Fatal(err)
}
fmt.Println(text)

// С сегментами и timestamps
segments, err := engine.TranscribeWithSegments(samples)
for _, seg := range segments {
    fmt.Printf("%d-%d: %s\n", seg.Start, seg.End, seg.Text)
}
```

### Через EngineManager

```go
// Установка активной модели
err := engineManager.SetActiveModel("parakeet-tdt-v3")
if err != nil {
    log.Fatal(err)
}

// Транскрипция через активный движок
text, err := engineManager.Transcribe(samples, false)
```

## Кэширование моделей

### По умолчанию

FluidAudio кэширует модели в `~/.cache/fluidaudio/Models/`.

### Кастомный путь

Передайте `ModelCacheDir` в конфигурацию:

```go
engine, err := ai.NewFluidASREngine(ai.FluidASRConfig{
    ModelCacheDir: modelsManager.GetModelsDir(),
})
```

CLI получит флаг `--model-cache-dir` автоматически.

## Производительность

### Первый запуск

- **Время:** ~35 секунд
- **Причина:** Загрузка моделей Parakeet v3 (~640 MB) с HuggingFace
- **Кэш:** Модели сохраняются локально

### Последующие запуски

- **RTFx:** ~110x на M4 Pro (1 минута аудио ≈ 0.5s обработки)
- **Платформа:** Apple Neural Engine (ANE)
- **Энергоэффективность:** Низкое потребление

## Поддерживаемые языки (25)

Parakeet TDT v3 поддерживает:

- **Западноевропейские:** en, de, fr, es, it, pt, nl
- **Восточноевропейские:** ru, uk, pl, cs, sk, hr, sl, bg, ro, hu
- **Северные:** fi, sv, da, no, is
- **Балтийские:** lt, lv, et
- **Греческий:** el

## Тестирование

```bash
cd backend
go test -v ./ai -run TestFluidASREngine
```

**Результаты:**
- ✅ TestFluidASREngineCreation - создание движка
- ✅ TestFluidASREngineTranscribe - транскрипция синусоиды
- ✅ TestFluidASREngineInterface - проверка интерфейса

## Преимущества

1. **Высокое качество:** WER 1.93% (лучше чем Whisper Large v3)
2. **Без memory leaks:** Subprocess изолирован
3. **Параллельность:** Множественные одновременные транскрипции
4. **Apple Neural Engine:** Эффективное использование ANE на M-серии
5. **Автоматическая загрузка:** FluidAudio скачивает модели при первом использовании
6. **25 языков:** Широкая языковая поддержка

## Ограничения

1. **Только macOS:** CoreML и ANE доступны только на Apple платформах
2. **Первый запуск медленный:** Загрузка ~640 MB моделей
3. **Нет word-level timestamps:** Parakeet возвращает token timings, группируются в сегменты по паузам
4. **Язык не возвращается:** API не предоставляет определённый язык (автоопределение внутри модели)

## Следующие шаги

- [ ] Интеграция в frontend для выбора модели
- [ ] Оптимизация сегментации (настройка pause threshold)
- [ ] Добавление метрик производительности в UI
- [ ] Тестирование на реальных аудио файлах
- [ ] Документация для пользователей

## Ссылки

- [FluidAudio GitHub](https://github.com/FluidInference/FluidAudio)
- [Parakeet TDT v3 HuggingFace](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml)
- [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
