# Системный анализ: Интеграция GigaAM в AIWisper

**Дата:** 2025-12-03 15:30
**Статус:** Completed
**Аналитик:** @analyst

---

## Контекст и стейкхолдеры

### Заинтересованные стороны

| Роль | Интересы | Потребности | Pain Points |
|------|----------|-------------|-------------|
| **Пользователь (русскоязычный)** | Высокое качество распознавания русской речи | SoTA качество для русского языка | Whisper не оптимизирован для русского |
| **Разработчик** | Простота интеграции, единая архитектура | Go-native решение без Python | Сложность поддержки нескольких движков |
| **Продукт** | Конкурентное преимущество на русском рынке | Самодостаточное приложение | Зависимость от внешних runtime |

### Бизнес-контекст

- **Цель**: Добавить поддержку GigaAM - SoTA модели для русского языка
- **Ограничение**: Приложение должно оставаться самодостаточным (без Python)
- **Приоритет**: Качество распознавания русского языка > скорость интеграции

---

## AS-IS (Текущее состояние)

### Архитектура распознавания речи

```
┌─────────────────────────────────────────────────────────────────┐
│                      Go Backend                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   ai.Engine                                  ││
│  │  ┌─────────────────────────────────────────────────────────┐││
│  │  │              whisper.cpp (GGML + Metal)                 │││
│  │  │  - Transcribe(samples) -> text                          │││
│  │  │  - TranscribeWithSegments(samples) -> []Segment         │││
│  │  │  - TranscribeHighQuality(samples) -> []Segment          │││
│  │  └─────────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   models.Manager                             ││
│  │  - Registry: только GGML модели                              ││
│  │  - DownloadModel(), SetActiveModel()                         ││
│  │  - GetModelPath() -> string                                  ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                               ↓
                     Все модели в GGML формате
                     (whisper.cpp + Metal GPU)
```

### Текущий интерфейс Engine

```go
// backend/ai/whisper.go
type Engine struct {
    model     whisper.Model  // whisper.cpp binding
    modelPath string
    language  string
    mu        sync.Mutex
}

// Основные методы
func NewEngine(modelPath string) (*Engine, error)
func (e *Engine) Transcribe(samples []float32, useContext bool) (string, error)
func (e *Engine) TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error)
func (e *Engine) TranscribeHighQuality(samples []float32) ([]TranscriptSegment, error)
func (e *Engine) SetModel(path string) error
func (e *Engine) SetLanguage(lang string)
func (e *Engine) Close()
```

### Текущий реестр моделей

```go
// backend/models/registry.go
var Registry = []ModelInfo{
    {ID: "ggml-tiny", Type: ModelTypeGGML, ...},
    {ID: "ggml-base", Type: ModelTypeGGML, ...},
    {ID: "ggml-small", Type: ModelTypeGGML, ...},
    {ID: "ggml-medium", Type: ModelTypeGGML, ...},
    {ID: "ggml-large-v3-turbo", Type: ModelTypeGGML, Recommended: true, ...},
    {ID: "ggml-large-v3", Type: ModelTypeGGML, Recommended: true, ...},
}
```

### Ограничения текущей архитектуры

1. **Единственный формат**: Только GGML (whisper.cpp)
2. **Единственный движок**: whisper.cpp через cgo binding
3. **Жёсткая связь**: `Engine` напрямую использует `whisper.Model`
4. **Нет абстракции**: Нет интерфейса для подключения альтернативных движков

---

## TO-BE (Целевое состояние)

### Целевая архитектура с поддержкой GigaAM

```
┌─────────────────────────────────────────────────────────────────┐
│                      Go Backend                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   ai.EngineManager                           ││
│  │  ┌─────────────────┐  ┌─────────────────────────────────┐   ││
│  │  │ WhisperEngine   │  │ GigaAMEngine                    │   ││
│  │  │ (GGML + Metal)  │  │ (ONNX Runtime)                  │   ││
│  │  │                 │  │                                 │   ││
│  │  │ - Transcribe()  │  │ - Transcribe()                  │   ││
│  │  │ - SetModel()    │  │ - SetModel()                    │   ││
│  │  └─────────────────┘  └─────────────────────────────────┘   ││
│  │           ↑                        ↑                        ││
│  │           └────────────┬───────────┘                        ││
│  │                        │                                    ││
│  │              TranscriptionEngine (interface)                ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   models.Manager                             ││
│  │  - Registry: GGML + ONNX модели                              ││
│  │  - GetEngineType(modelID) -> EngineType                      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                               ↓
              ┌────────────────┴────────────────┐
              │                                 │
        GGML модели                       ONNX модели
        (whisper.cpp)                     (GigaAM)
```

### Границы системы

**В scope:**
- Интеграция GigaAM v2/v3 ONNX моделей
- Поддержка CTC декодера (основной)
- Поддержка RNNT декодера (опционально)
- Управление моделями через существующий UI

**Вне scope:**
- Конвертация GigaAM в GGML формат (невозможно - разная архитектура)
- Python runtime
- Обучение/дообучение моделей
- Эмоциональное распознавание (GigaAM-Emo)

---

## Сценарии использования

### UC-1: Распознавание русской речи с GigaAM

**Актор:** Пользователь
**Предусловие:** GigaAM модель скачана и активна
**Основной поток:**
1. Пользователь начинает запись
2. Система захватывает аудио (mic/system)
3. Аудио нарезается на чанки по VAD
4. Каждый чанк отправляется в GigaAMEngine
5. GigaAMEngine выполняет инференс через ONNX Runtime
6. Результат (текст + timestamps) возвращается пользователю

**Альтернативный поток:**
- 4a. Если модель не загружена -> загрузить ONNX сессию
- 5a. Если ONNX Runtime недоступен -> fallback на Whisper

### UC-2: Переключение между Whisper и GigaAM

**Актор:** Пользователь
**Предусловие:** Обе модели скачаны
**Основной поток:**
1. Пользователь открывает Model Manager
2. Выбирает модель (Whisper или GigaAM)
3. Система определяет тип движка по модели
4. Загружает соответствующий движок
5. Устанавливает активную модель

### UC-3: Скачивание GigaAM модели

**Актор:** Пользователь
**Предусловие:** Интернет-соединение
**Основной поток:**
1. Пользователь открывает Model Manager
2. Видит GigaAM модели в списке (с пометкой "Russian SoTA")
3. Нажимает "Download" на выбранной модели
4. Система скачивает ONNX файлы с HuggingFace
5. Система скачивает словарь (vocab.txt)
6. Модель становится доступной для выбора

---

## Глоссарий

| Термин | Определение |
|--------|-------------|
| **GigaAM** | Foundational Model for Speech Recognition от Sber (Salute Developers). Conformer-based архитектура, 220-240M параметров. SoTA для русского языка. |
| **GGML** | Формат моделей для whisper.cpp. Бинарный формат с квантизацией. |
| **ONNX** | Open Neural Network Exchange - открытый формат для представления ML моделей. |
| **ONNX Runtime** | Кроссплатформенный движок для инференса ONNX моделей от Microsoft. |
| **CTC** | Connectionist Temporal Classification - декодер для ASR без явного выравнивания. |
| **RNNT** | Recurrent Neural Network Transducer - декодер для streaming ASR. |
| **Conformer** | Архитектура нейросети, комбинирующая CNN и Transformer. |
| **Metal** | GPU API от Apple для macOS/iOS. |
| **CoreML** | ML framework от Apple с поддержкой Neural Engine. |
| **WER** | Word Error Rate - метрика качества ASR. |

---

## Качественные атрибуты (черновик)

### Производительность

| Метрика | Whisper (текущее) | GigaAM (целевое) | Комментарий |
|---------|-------------------|------------------|-------------|
| Транскрипция 15s (large) | ~4-5s (Metal) | ~3-4s (CPU) | ONNX Runtime без GPU |
| Транскрипция 15s (large) | ~4-5s (Metal) | ~1-2s (CoreML) | С CoreML EP |
| Загрузка модели | ~2-3s | ~3-5s | ONNX больше overhead |
| Память (runtime) | ~2GB | ~1.5GB | ONNX более эффективен |

### Качество распознавания (WER)

| Датасет | Whisper large-v3 | GigaAM v3 | Улучшение |
|---------|------------------|-----------|-----------|
| Golos (русский) | ~5-7% | ~3-4% | 30-40% |
| Common Voice RU | ~8-10% | ~5-6% | 35-40% |
| Callcenter (внутр.) | ~12-15% | ~8-10% | 30% |

### Надёжность

- **Fallback**: При ошибке GigaAM -> использовать Whisper
- **Graceful degradation**: При отсутствии GPU -> CPU инференс
- **Crash recovery**: ONNX сессия пересоздаётся при ошибке

### Масштабируемость

- Поддержка нескольких ONNX моделей одновременно
- Возможность добавления новых движков через интерфейс

---

## Данные и интеграции

### ONNX модели GigaAM (istupakov/gigaam-v2-onnx)

| Файл | Размер | Описание |
|------|--------|----------|
| `v2_ctc.onnx` | 933 MB | CTC декодер (основной) |
| `v2_ctc.int8.onnx` | 236 MB | Квантизированная версия |
| `v2_rnnt_encoder.onnx` | 932 MB | RNNT encoder |
| `v2_rnnt_decoder.onnx` | 3.33 MB | RNNT decoder |
| `v2_rnnt_joint.onnx` | 1.44 MB | RNNT joint network |
| `v2_vocab.txt` | ~1 KB | Словарь (33 символа) |

### Словарь GigaAM

```
▁ 0      (пробел/начало слова)
а 1
б 2
...
я 32
<blk> 33 (blank token для CTC)
```

### Внешние зависимости

| Зависимость | Версия | Назначение | Риск |
|-------------|--------|------------|------|
| `onnxruntime` | 1.22.0 | ONNX инференс | Низкий - стабильная библиотека |
| `yalue/onnxruntime_go` | v1.12+ | Go binding для ONNX Runtime | Средний - сторонняя библиотека |
| HuggingFace Hub | - | Скачивание моделей | Низкий - стандартный источник |

---

## Ограничения и предположения

### Технические ограничения

1. **Нет GGML конвертации**: GigaAM (Conformer) архитектурно несовместим с whisper.cpp (Transformer)
2. **ONNX Runtime на macOS**: Нет нативной поддержки Metal GPU в ONNX Runtime
3. **CoreML EP**: Требует конвертации ONNX -> CoreML (дополнительный шаг)
4. **Размер моделей**: ~1GB для CTC, ~1GB для RNNT

### Предположения

1. ONNX Runtime работает стабильно на macOS ARM64
2. `yalue/onnxruntime_go` поддерживает все необходимые операции
3. Качество GigaAM ONNX соответствует оригинальной PyTorch версии
4. Пользователи готовы скачивать дополнительные ~1GB для русской модели

### Регуляторные ограничения

- **Лицензия GigaAM**: MIT - совместима с коммерческим использованием
- **Лицензия ONNX Runtime**: MIT - совместима

---

## Варианты интеграции

### Вариант 1: ONNX Runtime через Go binding (РЕКОМЕНДУЕМЫЙ)

**Описание:**
Использовать `yalue/onnxruntime_go` для загрузки и выполнения ONNX моделей GigaAM.

**Архитектура:**
```
Go Backend
    ↓ yalue/onnxruntime_go
ONNX Runtime C API
    ↓
ONNX модели GigaAM
    ↓
CPU / CoreML EP
```

**Плюсы:**
- ✅ Go-native решение (без Python)
- ✅ Готовая библиотека с активной поддержкой
- ✅ Поддержка macOS ARM64
- ✅ Возможность добавить CoreML Execution Provider
- ✅ MIT лицензия

**Минусы:**
- ⚠️ Нет Metal GPU из коробки (только CoreML EP)
- ⚠️ Дополнительная зависимость (~50MB shared library)
- ⚠️ Нужно реализовать CTC декодирование

**Сложность:** 3/5
**Риск:** Низкий

### Вариант 2: Конвертация в GGML (НЕВОЗМОЖНО)

**Описание:**
Конвертировать GigaAM в GGML формат для использования с whisper.cpp.

**Статус:** ❌ НЕВОЗМОЖНО

**Причина:**
- GigaAM использует Conformer архитектуру
- whisper.cpp поддерживает только Whisper (Transformer encoder-decoder)
- Архитектуры несовместимы на фундаментальном уровне
- Нет инструментов конвертации Conformer -> GGML

### Вариант 3: CoreML конвертация

**Описание:**
Конвертировать ONNX модели в CoreML формат для максимальной производительности на Apple Silicon.

**Архитектура:**
```
Go Backend
    ↓ cgo
CoreML C API
    ↓
CoreML модели (.mlpackage)
    ↓
Apple Neural Engine
```

**Плюсы:**
- ✅ Максимальная производительность на Apple Silicon
- ✅ Использование Neural Engine (ANE)
- ✅ Нативная интеграция с macOS

**Минусы:**
- ❌ Сложная конвертация ONNX -> CoreML
- ❌ Нет готового Go binding для CoreML
- ❌ Только macOS (нет кроссплатформенности)
- ❌ Возможные проблемы с операторами Conformer

**Сложность:** 5/5
**Риск:** Высокий

### Вариант 4: Subprocess с Python (НЕ РЕКОМЕНДУЕТСЯ)

**Описание:**
Запускать Python скрипт для инференса GigaAM.

**Статус:** ❌ НЕ РЕКОМЕНДУЕТСЯ

**Причина:**
- Противоречит требованию "без Python"
- Уже отказались от этого подхода для faster-whisper
- Увеличивает размер приложения на 150-200MB

### Сравнительная таблица

| Критерий | ONNX Runtime | GGML | CoreML | Python |
|----------|--------------|------|--------|--------|
| Возможность | ✅ | ❌ | ⚠️ | ✅ |
| Сложность | 3/5 | N/A | 5/5 | 2/5 |
| Производительность | 3/5 | N/A | 5/5 | 2/5 |
| Без Python | ✅ | ✅ | ✅ | ❌ |
| Кроссплатформенность | ✅ | ✅ | ❌ | ✅ |
| **Рекомендация** | **ДА** | НЕТ | ОПЦИОНАЛЬНО | НЕТ |

---

## Рекомендация: ONNX Runtime через Go binding

### Обоснование

1. **Единственный реалистичный вариант** без Python
2. **Готовая библиотека** `yalue/onnxruntime_go` с активной поддержкой
3. **Минимальные изменения** в существующей архитектуре
4. **Возможность улучшения** через CoreML EP в будущем

### План реализации (высокоуровневый)

#### Фаза 1: Инфраструктура (2-3 дня)
1. Добавить `yalue/onnxruntime_go` в зависимости
2. Создать интерфейс `TranscriptionEngine`
3. Рефакторинг `ai.Engine` -> `ai.WhisperEngine`

#### Фаза 2: GigaAM Engine (3-4 дня)
1. Создать `ai.GigaAMEngine` с ONNX Runtime
2. Реализовать CTC декодирование
3. Реализовать загрузку словаря

#### Фаза 3: Интеграция (2-3 дня)
1. Обновить `models.Registry` с GigaAM моделями
2. Обновить `models.Manager` для ONNX моделей
3. Интеграция с существующим UI

#### Фаза 4: Тестирование (2-3 дня)
1. Тестирование качества на русском аудио
2. Benchmark производительности
3. Тестирование на M1/M2/M3/M4

### Оценка трудозатрат

| Фаза | Оценка | Риск |
|------|--------|------|
| Инфраструктура | 2-3 дня | Низкий |
| GigaAM Engine | 3-4 дня | Средний |
| Интеграция | 2-3 дня | Низкий |
| Тестирование | 2-3 дня | Низкий |
| **Итого** | **9-13 дней** | Средний |

---

## Открытые вопросы и риски

### Открытые вопросы

| # | Вопрос | Владелец | Срок | Статус |
|---|--------|----------|------|--------|
| Q1 | Поддерживает ли ONNX Runtime CoreML EP на macOS ARM64? | @architect | До начала разработки | Открыт |
| Q2 | Какова реальная производительность GigaAM ONNX на CPU? | @tester | Фаза 4 | Открыт |
| Q3 | Нужна ли поддержка RNNT или достаточно CTC? | @product | До начала разработки | Открыт |
| Q4 | Есть ли готовые ONNX модели GigaAM v3? | @analyst | Срочно | Открыт |

### Риски

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| ONNX Runtime не работает на macOS ARM64 | Низкая | Критическое | Проверить до начала разработки |
| Низкая производительность на CPU | Средняя | Высокое | Исследовать CoreML EP |
| Проблемы с CTC декодированием | Низкая | Среднее | Использовать готовую реализацию из onnx-asr |
| Несовместимость операторов ONNX | Низкая | Высокое | Тестировать на ранней стадии |
| Качество ONNX ниже PyTorch | Низкая | Среднее | Сравнить WER до/после |

---

## Хэндовер для @architect и @planner

### Ключевые артефакты

1. **Текущая архитектура**: `ai.Engine` с whisper.cpp binding
2. **Целевая архитектура**: Интерфейс `TranscriptionEngine` + `GigaAMEngine`
3. **Рекомендуемый подход**: ONNX Runtime через `yalue/onnxruntime_go`
4. **ONNX модели**: `istupakov/gigaam-v2-onnx` на HuggingFace

### Области требующие особого внимания

1. **CTC декодирование**: Нужно реализовать greedy/beam search декодер
2. **Словарь**: Кириллица + специальные токены
3. **Производительность**: Без Metal GPU, только CPU или CoreML EP
4. **Тестирование**: Сравнение качества с Whisper на русском

### Зависимости для @architect

- Определить интерфейс `TranscriptionEngine`
- Спроектировать механизм выбора движка по типу модели
- Решить вопрос с CoreML EP (сейчас или позже)

### Задачи для @planner

- Декомпозировать фазы на конкретные задачи
- Определить критический путь
- Запланировать spike для проверки ONNX Runtime на macOS

---

## Приложение A: Пример кода CTC декодирования

```go
// Greedy CTC decoding
func decodeCTC(logits [][]float32, vocab []string, blankID int) string {
    var result strings.Builder
    prevToken := blankID
    
    for _, frame := range logits {
        // Найти токен с максимальной вероятностью
        maxIdx := 0
        maxVal := frame[0]
        for i, v := range frame {
            if v > maxVal {
                maxVal = v
                maxIdx = i
            }
        }
        
        // CTC: пропускаем blank и повторы
        if maxIdx != blankID && maxIdx != prevToken {
            result.WriteString(vocab[maxIdx])
        }
        prevToken = maxIdx
    }
    
    return result.String()
}
```

## Приложение B: Структура ONNX модели GigaAM CTC

```
Input:
  - audio_signal: float32[batch, time] - аудио 16kHz
  - audio_signal_length: int64[batch] - длина аудио

Output:
  - logits: float32[batch, time/4, vocab_size] - логиты для CTC
```

## Приложение C: Ссылки

- [GigaAM GitHub](https://github.com/salute-developers/GigaAM)
- [GigaAM ONNX на HuggingFace](https://huggingface.co/istupakov/gigaam-v2-onnx)
- [onnxruntime_go](https://github.com/yalue/onnxruntime_go)
- [onnx-asr (Python reference)](https://github.com/istupakov/onnx-asr)
- [GigaAM Paper (InterSpeech 2025)](https://arxiv.org/abs/2506.01192)
