# План интеграции GigaAM в AIWisper

**Дата:** 2025-12-03 12:53
**Статус:** Draft
**Версия:** 1.0
**Основан на:** `docs/analysis_gigaam_integration_2025-12-03.md`

---

## 1. PRD (Product Requirements Document)

### 1.1 Цель

Интегрировать GigaAM (SoTA модель для русского языка от Sber) в AIWisper через ONNX Runtime, обеспечив:
- Высококачественное распознавание русской речи (WER ~3-4% vs ~5-7% у Whisper)
- Go-native решение без Python зависимостей
- Бесшовное переключение между Whisper и GigaAM движками

### 1.2 Контекст

**Проблема:** Whisper не оптимизирован для русского языка. GigaAM показывает на 30-40% лучшее качество на русских датасетах.

**Решение:** Добавить поддержку GigaAM через ONNX Runtime с абстракцией движков через интерфейс `TranscriptionEngine`.

**Ограничения:**
- Без Python (требование проекта)
- macOS ARM64 (Apple Silicon) - основная платформа
- ONNX Runtime без нативной поддержки Metal GPU

### 1.3 Пользователи

| Пользователь | Потребность | Критерий успеха |
|--------------|-------------|-----------------|
| Русскоязычный пользователь | Высокое качество распознавания русской речи | WER < 5% на разговорной речи |
| Мультиязычный пользователь | Возможность выбора движка | Переключение без перезапуска |
| Разработчик | Расширяемая архитектура | Добавление нового движка < 1 дня |

### 1.4 Функциональные требования

| ID | Требование | Приоритет | Источник |
|----|------------|-----------|----------|
| FR-01 | Система должна поддерживать загрузку ONNX моделей GigaAM | Must | Анализ |
| FR-02 | Система должна выполнять инференс через ONNX Runtime | Must | Анализ |
| FR-03 | Система должна реализовать CTC декодирование для GigaAM | Must | Анализ |
| FR-04 | Система должна возвращать текст с timestamps (сегменты) | Must | Текущий API |
| FR-05 | Пользователь должен иметь возможность скачать GigaAM модели через UI | Must | UC-3 |
| FR-06 | Пользователь должен иметь возможность переключаться между Whisper и GigaAM | Must | UC-2 |
| FR-07 | Система должна автоматически определять тип движка по модели | Should | Архитектура |
| FR-08 | Система должна поддерживать квантизированные модели (int8) | Should | Оптимизация |
| FR-09 | Система должна загружать словарь (vocab.txt) для GigaAM | Must | CTC декодер |
| FR-10 | Система должна поддерживать fallback на Whisper при ошибке GigaAM | Could | Надёжность |

### 1.5 Нефункциональные требования

| ID | Требование | Метрика | Целевое значение |
|----|------------|---------|------------------|
| NFR-01 | Производительность инференса | Время на 15s аудио | < 5s (CPU) |
| NFR-02 | Потребление памяти | RAM при загруженной модели | < 2GB |
| NFR-03 | Время загрузки модели | Cold start | < 5s |
| NFR-04 | Качество распознавания | WER на русском | < 5% |
| NFR-05 | Размер зависимостей | ONNX Runtime shared lib | < 100MB |
| NFR-06 | Совместимость | macOS версии | 12.0+ (Monterey) |
| NFR-07 | Стабильность | Crash rate | < 0.1% |

### 1.6 Ограничения

1. **Технические:**
   - Нет Metal GPU в ONNX Runtime (только CPU или CoreML EP)
   - GigaAM не конвертируется в GGML (разная архитектура)
   - Нет word-level timestamps в CTC (только segment-level)

2. **Ресурсные:**
   - Размер модели ~1GB (CTC) или ~236MB (int8)
   - Требуется скачивание дополнительных файлов (vocab.txt)

3. **Лицензионные:**
   - GigaAM: MIT (совместимо)
   - ONNX Runtime: MIT (совместимо)

### 1.7 Метрики успеха

| Метрика | Baseline (Whisper) | Target (GigaAM) | Способ измерения |
|---------|-------------------|-----------------|------------------|
| WER на русском | 5-7% | 3-5% | Тест на Golos dataset |
| Время инференса 15s | 4-5s (Metal) | < 5s (CPU) | Benchmark |
| Удовлетворённость | N/A | > 80% | Опрос пользователей |

---

## 2. Декомпозиция задач

### Фаза 0: Spike (Проверка концепции)

| ID | Задача | Описание | Входы | Выходы | Зависимости | Оценка | DoD |
|----|--------|----------|-------|--------|-------------|--------|-----|
| SPIKE-01 | Проверка ONNX Runtime на macOS ARM64 | Установить `yalue/onnxruntime_go`, загрузить тестовую модель, выполнить инференс | - | Работающий PoC | - | 4h | ONNX модель загружается и выполняет инференс |
| SPIKE-02 | Проверка GigaAM ONNX модели | Скачать `v2_ctc.onnx`, проверить структуру входов/выходов | SPIKE-01 | Документация API модели | SPIKE-01 | 2h | Известны точные имена и размерности тензоров |
| SPIKE-03 | Прототип CTC декодирования | Реализовать greedy CTC декодер, проверить на тестовом аудио | SPIKE-02 | Работающий декодер | SPIKE-02 | 4h | Декодер выдаёт читаемый русский текст |

**Критерий выхода из Spike:** Успешная транскрипция тестового русского аудио с качеством, сопоставимым с Python референсом.

**Риск-гейт:** Если SPIKE-01 не проходит → проект останавливается, ищем альтернативы.

---

### Фаза 1: Инфраструктура (Рефакторинг)

| ID | Задача | Описание | Входы | Выходы | Зависимости | Оценка | DoD |
|----|--------|----------|-------|--------|-------------|--------|-----|
| INFRA-01 | Создать интерфейс TranscriptionEngine | Определить контракт для всех движков транскрипции | Текущий `ai.Engine` | `ai/engine.go` с интерфейсом | - | 2h | Интерфейс определён, компилируется |
| INFRA-02 | Рефакторинг Engine → WhisperEngine | Переименовать и адаптировать текущий Engine под интерфейс | INFRA-01 | `ai/whisper_engine.go` | INFRA-01 | 3h | Все тесты проходят, API не изменился |
| INFRA-03 | Создать EngineManager | Фабрика для создания движков по типу модели | INFRA-01, INFRA-02 | `ai/manager.go` | INFRA-02 | 3h | Manager создаёт WhisperEngine |
| INFRA-04 | Добавить ModelType ONNX | Расширить registry для поддержки ONNX моделей | - | Обновлённый `models/registry.go` | - | 1h | Новый тип модели в registry |
| INFRA-05 | Обновить Manager для ONNX | Логика скачивания ONNX моделей (несколько файлов) | INFRA-04 | Обновлённый `models/manager.go` | INFRA-04 | 3h | Скачивание .onnx + vocab.txt работает |

**Интерфейс TranscriptionEngine (INFRA-01):**

```go
// ai/engine.go
package ai

// TranscriptionEngine интерфейс для движков транскрипции
type TranscriptionEngine interface {
    // Transcribe выполняет транскрипцию аудио
    Transcribe(samples []float32) (string, error)
    
    // TranscribeWithSegments возвращает сегменты с timestamps
    TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error)
    
    // SetLanguage устанавливает язык (если поддерживается)
    SetLanguage(lang string)
    
    // SetModel переключает модель
    SetModel(path string) error
    
    // Close освобождает ресурсы
    Close()
    
    // EngineType возвращает тип движка
    EngineType() EngineType
}

type EngineType string

const (
    EngineTypeWhisper EngineType = "whisper"
    EngineTypeGigaAM  EngineType = "gigaam"
)
```

---

### Фаза 2: GigaAM Engine

| ID | Задача | Описание | Входы | Выходы | Зависимости | Оценка | DoD |
|----|--------|----------|-------|--------|-------------|--------|-----|
| GIGA-01 | Добавить зависимость onnxruntime_go | `go get github.com/yalue/onnxruntime_go` | - | Обновлённый go.mod | SPIKE-01 | 0.5h | Зависимость добавлена, компилируется |
| GIGA-02 | Создать структуру GigaAMEngine | Базовая структура с полями для ONNX сессии | GIGA-01 | `ai/gigaam_engine.go` | GIGA-01 | 2h | Структура определена |
| GIGA-03 | Реализовать загрузку ONNX модели | NewGigaAMEngine с инициализацией сессии | GIGA-02 | Работающий конструктор | GIGA-02 | 3h | Модель загружается без ошибок |
| GIGA-04 | Реализовать загрузку словаря | Парсинг vocab.txt в map[int]string | GIGA-02 | Функция loadVocab | GIGA-02 | 1h | Словарь загружается корректно |
| GIGA-05 | Реализовать препроцессинг аудио | Нормализация, ресемплинг если нужно | GIGA-03 | Функция preprocessAudio | GIGA-03 | 2h | Аудио готово для инференса |
| GIGA-06 | Реализовать инференс | Вызов ONNX Runtime с входными тензорами | GIGA-03, GIGA-05 | Функция runInference | GIGA-05 | 4h | Получаем logits на выходе |
| GIGA-07 | Реализовать CTC декодирование | Greedy декодер с collapse повторов | GIGA-04, GIGA-06 | Функция decodeCTC | GIGA-06 | 3h | Текст декодируется корректно |
| GIGA-08 | Реализовать Transcribe() | Полный pipeline: preprocess → inference → decode | GIGA-05, GIGA-06, GIGA-07 | Метод Transcribe | GIGA-07 | 2h | Возвращает текст |
| GIGA-09 | Реализовать TranscribeWithSegments() | Добавить timestamps на основе frame rate | GIGA-08 | Метод TranscribeWithSegments | GIGA-08 | 3h | Возвращает сегменты с timestamps |
| GIGA-10 | Реализовать SetModel() | Переключение между моделями GigaAM | GIGA-03 | Метод SetModel | GIGA-03 | 2h | Модель переключается |
| GIGA-11 | Реализовать Close() | Освобождение ONNX сессии | GIGA-02 | Метод Close | GIGA-02 | 0.5h | Ресурсы освобождаются |

**Структура GigaAMEngine (GIGA-02):**

```go
// ai/gigaam_engine.go
package ai

import (
    ort "github.com/yalue/onnxruntime_go"
)

type GigaAMEngine struct {
    session   *ort.AdvancedSession
    vocab     []string        // Словарь токенов
    blankID   int             // ID blank токена для CTC
    modelPath string
    vocabPath string
    mu        sync.Mutex
}

// Константы для GigaAM
const (
    gigaamSampleRate = 16000
    gigaamFrameShift = 40 // ms, для расчёта timestamps
)
```

---

### Фаза 3: Интеграция

| ID | Задача | Описание | Входы | Выходы | Зависимости | Оценка | DoD |
|----|--------|----------|-------|--------|-------------|--------|-----|
| INT-01 | Добавить GigaAM модели в Registry | Определить ModelInfo для GigaAM v2 CTC и int8 | INFRA-04 | Обновлённый registry | INFRA-04 | 1h | Модели в списке |
| INT-02 | Обновить EngineManager | Создание GigaAMEngine для ONNX моделей | INFRA-03, GIGA-* | Обновлённый manager | GIGA-11 | 2h | Manager создаёт правильный движок |
| INT-03 | Интеграция с session.Manager | Использование TranscriptionEngine вместо Engine | INT-02 | Обновлённый session/manager.go | INT-02 | 3h | Сессии работают с обоими движками |
| INT-04 | Обновить API endpoints | Поддержка выбора движка в API | INT-03 | Обновлённый main.go | INT-03 | 2h | API работает |
| INT-05 | Обновить UI ModelManager | Отображение GigaAM моделей с пометкой "Russian SoTA" | INT-01 | Обновлённый ModelManager.tsx | INT-01 | 2h | UI показывает GigaAM модели |
| INT-06 | Добавить индикатор движка в UI | Показывать какой движок активен | INT-04 | Обновлённый UI | INT-04 | 1h | Пользователь видит активный движок |

**Обновление Registry (INT-01):**

```go
// models/registry.go - добавить
{
    ID:          "gigaam-v2-ctc",
    Name:        "GigaAM v2 CTC",
    Type:        ModelTypeONNX,
    Size:        "933 MB",
    SizeBytes:   978_321_408,
    Description: "SoTA для русского языка (Sber)",
    Languages:   []string{"ru"},
    WER:         "3.4%",
    Speed:       "~3x",
    Recommended: true,
    DownloadURL: "https://huggingface.co/istupakov/gigaam-v2-onnx/resolve/main/v2_ctc.onnx",
    VocabURL:    "https://huggingface.co/istupakov/gigaam-v2-onnx/resolve/main/v2_vocab.txt",
},
{
    ID:          "gigaam-v2-ctc-int8",
    Name:        "GigaAM v2 CTC (int8)",
    Type:        ModelTypeONNX,
    Size:        "236 MB",
    SizeBytes:   247_463_936,
    Description: "Квантизированная версия, быстрее",
    Languages:   []string{"ru"},
    WER:         "3.6%",
    Speed:       "~5x",
    Recommended: true,
    DownloadURL: "https://huggingface.co/istupakov/gigaam-v2-onnx/resolve/main/v2_ctc.int8.onnx",
    VocabURL:    "https://huggingface.co/istupakov/gigaam-v2-onnx/resolve/main/v2_vocab.txt",
},
```

---

### Фаза 4: Тестирование и оптимизация

| ID | Задача | Описание | Входы | Выходы | Зависимости | Оценка | DoD |
|----|--------|----------|-------|--------|-------------|--------|-----|
| TEST-01 | Unit тесты GigaAMEngine | Тесты для каждого метода | GIGA-* | `ai/gigaam_engine_test.go` | GIGA-11 | 4h | Coverage > 80% |
| TEST-02 | Integration тесты | Тесты полного pipeline | INT-* | `integration_test.go` | INT-06 | 4h | E2E тесты проходят |
| TEST-03 | Benchmark производительности | Сравнение Whisper vs GigaAM | TEST-02 | Отчёт benchmark | TEST-02 | 3h | Метрики задокументированы |
| TEST-04 | Тестирование качества (WER) | Оценка на русском датасете | TEST-02 | Отчёт WER | TEST-02 | 4h | WER < 5% |
| TEST-05 | Тестирование на M1/M2/M3/M4 | Проверка на разных чипах | TEST-02 | Матрица совместимости | TEST-02 | 4h | Работает на всех чипах |
| TEST-06 | Stress тестирование | Длительная работа, утечки памяти | TEST-02 | Отчёт стабильности | TEST-02 | 3h | Нет утечек памяти |
| OPT-01 | Оптимизация препроцессинга | Профилирование и оптимизация | TEST-03 | Оптимизированный код | TEST-03 | 4h | Улучшение > 10% |
| OPT-02 | Исследование CoreML EP | Проверка возможности использования CoreML | TEST-03 | Отчёт/PoC | TEST-03 | 8h | Решение о CoreML EP |

---

## 3. Риск-реестр

| ID | Риск | Вероятность | Влияние | Оценка | Митигация | Владелец |
|----|------|-------------|---------|--------|-----------|----------|
| R-01 | ONNX Runtime не работает на macOS ARM64 | 10% | Критическое | Высокий | Spike SPIKE-01 до начала основной работы | @developer |
| R-02 | Низкая производительность на CPU | 40% | Высокое | Высокий | Использовать int8 модель; исследовать CoreML EP | @developer |
| R-03 | Проблемы с CTC декодированием | 20% | Среднее | Средний | Использовать референс из onnx-asr | @developer |
| R-04 | Несовместимость операторов ONNX | 15% | Высокое | Средний | Проверить на SPIKE-02; обновить ONNX Runtime | @developer |
| R-05 | Качество ONNX ниже PyTorch | 20% | Среднее | Средний | Сравнить WER; использовать оригинальные веса | @tester |
| R-06 | Утечки памяти в ONNX Runtime | 25% | Среднее | Средний | Stress тестирование; правильное освобождение ресурсов | @developer |
| R-07 | Сложность интеграции с существующим кодом | 30% | Среднее | Средний | Чёткий интерфейс; инкрементальный рефакторинг | @developer |
| R-08 | Отсутствие word-level timestamps | 60% | Низкое | Низкий | Документировать ограничение; использовать segment-level | @developer |

---

## 4. Definition of Done

### Общие критерии

- [ ] Код проходит все unit тесты
- [ ] Код проходит все integration тесты
- [ ] Код прошёл code review
- [ ] Документация обновлена
- [ ] Нет критических багов
- [ ] Производительность соответствует NFR

### Критерии для каждой фазы

**Фаза 0 (Spike):**
- [ ] ONNX Runtime загружает модель на macOS ARM64
- [ ] Инференс выполняется без ошибок
- [ ] CTC декодер выдаёт читаемый русский текст
- [ ] Качество сопоставимо с Python референсом

**Фаза 1 (Инфраструктура):**
- [ ] Интерфейс TranscriptionEngine определён
- [ ] WhisperEngine реализует интерфейс
- [ ] EngineManager создаёт движки
- [ ] Все существующие тесты проходят
- [ ] API обратно совместим

**Фаза 2 (GigaAM Engine):**
- [ ] GigaAMEngine реализует TranscriptionEngine
- [ ] Загрузка ONNX модели работает
- [ ] CTC декодирование работает
- [ ] Transcribe() возвращает текст
- [ ] TranscribeWithSegments() возвращает сегменты с timestamps
- [ ] Unit тесты покрывают > 80% кода

**Фаза 3 (Интеграция):**
- [ ] GigaAM модели в Registry
- [ ] Скачивание моделей работает
- [ ] Переключение между движками работает
- [ ] UI показывает GigaAM модели
- [ ] E2E тесты проходят

**Фаза 4 (Тестирование):**
- [ ] WER < 5% на русском датасете
- [ ] Производительность < 5s на 15s аудио
- [ ] Нет утечек памяти
- [ ] Работает на M1/M2/M3/M4
- [ ] Документация benchmark

---

## 5. Дорожная карта

### Критический путь

```
SPIKE-01 → SPIKE-02 → SPIKE-03 → [RISK GATE]
                                      ↓
                                 INFRA-01 → INFRA-02 → INFRA-03
                                      ↓           ↓
                                 GIGA-01 → GIGA-02 → GIGA-03 → GIGA-05 → GIGA-06 → GIGA-07 → GIGA-08 → GIGA-09
                                                ↓
                                           GIGA-04 ─────────────────────────────────────────────────────┘
                                                                                                        ↓
                                                                                                   INT-02 → INT-03 → INT-04
                                                                                                        ↓
                                                                                                   TEST-01 → TEST-02 → TEST-03 → TEST-04
```

### Параллельные потоки

**Поток 1 (Основной):** SPIKE → INFRA → GIGA → INT → TEST
**Поток 2 (Параллельный):** INFRA-04, INFRA-05 (можно делать параллельно с GIGA-*)
**Поток 3 (Параллельный):** INT-01, INT-05 (можно делать параллельно с GIGA-*)

### Этапы и сроки

| Этап | Задачи | Длительность | Зависимости |
|------|--------|--------------|-------------|
| **Этап 1: Spike** | SPIKE-01, SPIKE-02, SPIKE-03 | 1-2 дня | - |
| **Этап 2: Инфраструктура** | INFRA-01 → INFRA-05 | 2-3 дня | Этап 1 |
| **Этап 3: GigaAM Engine** | GIGA-01 → GIGA-11 | 3-4 дня | Этап 2 |
| **Этап 4: Интеграция** | INT-01 → INT-06 | 2-3 дня | Этап 3 |
| **Этап 5: Тестирование** | TEST-01 → TEST-06, OPT-* | 3-4 дня | Этап 4 |

**Общая оценка:** 11-16 рабочих дней (2-3 недели)

### Milestones

| Milestone | Дата (относительная) | Критерий |
|-----------|---------------------|----------|
| M1: Spike Complete | День 2 | ONNX Runtime работает, CTC декодирует |
| M2: Infrastructure Ready | День 5 | Интерфейс готов, WhisperEngine работает |
| M3: GigaAM MVP | День 9 | GigaAMEngine транскрибирует аудио |
| M4: Integration Complete | День 12 | Полная интеграция, UI работает |
| M5: Release Ready | День 16 | Все тесты пройдены, документация готова |

---

## 6. Приложения

### A. Структура файлов после реализации

```
backend/
├── ai/
│   ├── engine.go           # Интерфейс TranscriptionEngine (NEW)
│   ├── whisper_engine.go   # WhisperEngine (RENAMED from whisper.go)
│   ├── gigaam_engine.go    # GigaAMEngine (NEW)
│   ├── manager.go          # EngineManager (NEW)
│   ├── ctc_decoder.go      # CTC декодер (NEW)
│   └── binding/            # whisper.cpp binding (UNCHANGED)
├── models/
│   ├── registry.go         # Обновлённый с ONNX моделями
│   ├── manager.go          # Обновлённый для ONNX
│   └── downloader.go       # Обновлённый для множественных файлов
```

### B. API модели GigaAM ONNX

```
Input:
  - audio_signal: float32[batch, time] - аудио 16kHz
  - audio_signal_length: int64[batch] - длина аудио в samples

Output:
  - logits: float32[batch, time/4, vocab_size] - логиты для CTC
  
Vocab size: 34 (33 символа + blank)
Frame shift: 40ms (для расчёта timestamps)
```

### C. Словарь GigaAM

```
▁ 0      (пробел/начало слова)
а 1
б 2
в 3
...
я 32
<blk> 33 (blank token для CTC)
```

### D. Ссылки

- [GigaAM GitHub](https://github.com/salute-developers/GigaAM)
- [GigaAM ONNX на HuggingFace](https://huggingface.co/istupakov/gigaam-v2-onnx)
- [onnxruntime_go](https://github.com/yalue/onnxruntime_go)
- [onnx-asr (Python reference)](https://github.com/istupakov/onnx-asr)
- [ONNX Runtime](https://onnxruntime.ai/)

---

## 7. История изменений

| Версия | Дата | Автор | Изменения |
|--------|------|-------|-----------|
| 1.0 | 2025-12-03 | @planner | Первоначальная версия |
