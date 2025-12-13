# AIWisper

**AIWisper** — десктопное приложение для локальной транскрипции речи с диаризацией спикеров. Все данные обрабатываются на устройстве без отправки в облако.

![macOS](https://img.shields.io/badge/macOS-13+-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-1.40.17-orange)

## Возможности

- **Транскрипция речи** — Whisper (многоязычный) и GigaAM (русский)
- **Диаризация спикеров** — автоматическое определение кто говорит
- **Запись системного звука** — транскрибация звонков, видео, подкастов
- **Voice Isolation** — подавление фонового шума (macOS 15+)
- **Silero VAD** — нейросетевая детекция голосовой активности (97% точность)
- **AI-сводка** — генерация краткого содержания через Ollama
- **GPU ускорение** — Metal и CoreML на Apple Silicon
- **Полностью офлайн** — никакие данные не покидают устройство
- **Live Транскрипция** — real-time транскрипция речи во время записи с минимальной задержкой (<500ms)
- **Гибридная транскрипция** — двухпроходное распознавание (GigaAM + Whisper) с LLM-выбором лучшего результата
- **Статистика сессий** — детальные метрики: слова, спикеры, WPM, активность, качество распознавания
- **Batch Export** — экспорт нескольких сессий в ZIP архив (TXT, SRT, VTT, JSON, Markdown)
- **Горячие клавиши** — ↑/↓ навигация, ⌘+1-9 быстрый доступ, ⌘+F поиск, ? справка

## Системные требования

| Требование | Минимум | Рекомендуется |
|------------|---------|---------------|
| macOS | 13 Ventura | 15 Sequoia |
| RAM | 8 GB | 16 GB |
| Диск | 3 GB | 10 GB (для моделей) |
| Процессор | Intel/Apple Silicon | Apple Silicon |

## Установка

### Готовые релизы

Скачайте DMG из [Releases](https://github.com/askidmobile/AIWisper/releases):

```bash
# Для Apple Silicon
AIWisper-x.x.x-arm64.dmg

# Для Intel
AIWisper-x.x.x-x64.dmg
```

### Сборка из исходников

```bash
# Клонировать репозиторий
git clone https://github.com/askidmobile/AIWisper.git
cd AIWisper

# Установить зависимости frontend
cd frontend && npm install && cd ..

# Собрать backend и запустить в dev-режиме
cd frontend && npm run electron:dev
```

## Быстрый старт

1. **Запустите приложение** и дайте разрешение на микрофон
2. **Скачайте модель** в менеджере моделей (рекомендуется `large-v3-turbo`)
3. **Нажмите "Новая запись"** и начните говорить
4. **Остановите запись** — транскрипция появится автоматически

## Поддерживаемые модели

### Whisper (многоязычные)

| Модель | Размер | Качество | Скорость |
|--------|--------|----------|----------|
| `tiny` | 74 MB | Базовое | Очень быстро |
| `base` | 141 MB | Хорошее | Быстро |
| `small` | 465 MB | Отличное | Средне |
| `medium` | 1.4 GB | Высокое | Медленно |
| **`large-v3-turbo`** | 1.5 GB | **Высокое** | **Быстро** |
| `large-v3` | 2.9 GB | Максимальное | Очень медленно |

### GigaAM (русский язык, Sber)

| Модель | Размер | WER | Особенности |
|--------|--------|-----|-------------|
| **`gigaam-v3-ctc`** | 225 MB | 9.1% | Рекомендуется |
| `gigaam-v3-e2e-ctc` | 225 MB | 9.1% | С автопунктуацией |

## Диаризация спикеров

AIWisper автоматически определяет кто говорит в записи:

- **Режим диалога** — раздельные каналы "Вы" (микрофон) и "Собеседник" (системный звук)
- **FluidAudio** — нативный движок диаризации на Swift/CoreML
- **Sherpa-ONNX** — кроссплатформенный движок на C++/ONNX

### FluidAudio

Нативный движок диаризации для macOS на базе [FluidAudio](https://github.com/FluidInference/FluidAudio?tab=readme-ov-file), использующий Apple Neural Engine через CoreML:

| Компонент | Модель | Описание |
|-----------|--------|----------|
| Сегментация | `pyannote-segmentation-3.0` | Определение границ речи |
| Embedding | `wespeaker-voxceleb-resnet34` | Извлечение голосовых признаков |
| Кластеризация | Agglomerative Clustering | Группировка по спикерам |

**Преимущества:**
- Работает на Apple Neural Engine (ANE) — энергоэффективно
- Нативная интеграция с macOS
- Не требует ONNX Runtime
- Оптимизирован для Apple Silicon

## AI-функции (Ollama)

При установленном [Ollama](https://ollama.ai/) доступны:

- **Сводка** — краткое содержание записи
- **Улучшение текста** — коррекция ошибок транскрипции
- **AI-диаризация** — разбивка по собеседникам через LLM

```bash
# Установка Ollama
brew install ollama
ollama pull llama3.2
```

## Технологии

### Backend (Go)
- **whisper.cpp** — движок распознавания речи (CGO bindings)
- **GigaAM** — ONNX Runtime для русского языка
- **sherpa-onnx** — диаризация спикеров
- **gRPC + HTTP** — коммуникация с frontend

### Frontend (Electron + React)
- **Electron 39** — десктопная оболочка
- **React 19** — UI фреймворк
- **Vite 7** — сборка

### macOS Native (Swift)
- **ScreenCaptureKit** — захват системного звука (macOS 13+)
- **CoreAudio Process Tap** — альтернативный захват (macOS 14.2+)
- **Voice Isolation** — шумоподавление (macOS 15+)
- **FluidAudio** — нативная диаризация на CoreML
- **Metal** — GPU ускорение для whisper.cpp
- **CoreML** — Apple Neural Engine для диаризации и GigaAM

## Структура проекта

```
AIWisper/
├── backend/                 # Go backend
│   ├── ai/                  # Движки распознавания
│   │   ├── binding/         # CGO bindings для whisper.cpp
│   │   ├── whisper.go       # Whisper интерфейс
│   │   ├── gigaam.go        # GigaAM интерфейс
│   │   └── diarization*.go  # Диаризация
│   ├── audio/               # Захват аудио
│   │   ├── coreaudio/       # Swift: CoreAudio Tap
│   │   ├── screencapture/   # Swift: ScreenCaptureKit
│   │   └── diarization/     # Swift: FluidAudio
│   ├── internal/            # Внутренние сервисы
│   │   ├── api/             # gRPC сервер
│   │   └── service/         # Бизнес-логика
│   ├── session/             # Управление записями
│   └── models/              # Загрузка моделей
├── frontend/                # Electron + React
│   ├── electron/            # Main process
│   ├── src/                 # React приложение
│   │   ├── components/      # UI компоненты
│   │   └── App.tsx          # Главный компонент
│   └── package.json
├── scripts/                 # Скрипты сборки
└── docs/                    # Документация
```

## Разработка

### Требования для сборки

- **Go** 1.21+
- **Node.js** 18+
- **Xcode Command Line Tools** (для CGO и Swift)

### Команды

```bash
# Запуск в режиме разработки
cd frontend && npm run electron:dev

# Сборка backend отдельно
cd frontend && npm run backend:build

# Сборка DMG
cd frontend && npm run electron:build:dmg

# Сборка без упаковки (для отладки)
cd frontend && npm run electron:build:dir
```

### Переменные окружения

```bash
# Путь к данным (по умолчанию ~/Library/Application Support/aiwisper)
AIWISPER_DATA_DIR=/path/to/data

# Ollama URL (по умолчанию http://localhost:11434)
OLLAMA_URL=http://localhost:11434
```

## Хранение данных

```
~/Library/Application Support/aiwisper/
├── sessions/           # Записи
│   └── {uuid}/
│       ├── meta.json   # Метаданные
│       ├── full.mp3    # Аудио
│       └── chunks/     # Чанки + транскрипции
├── models/             # Скачанные модели
├── voiceprints/        # Голосовые профили
└── config.json         # Настройки
```

## Решение проблем

### Нет звука системы
1. Дайте разрешение "Запись экрана" в Настройки → Конфиденциальность
2. Перезапустите приложение

### Медленная транскрипция
1. Используйте модель `large-v3-turbo` вместо `large-v3`
2. Убедитесь что используется GPU (Metal)

### Ошибка загрузки модели
1. Проверьте свободное место на диске
2. Удалите частично скачанную модель из `~/Library/Application Support/aiwisper/models/`

### Backend не запускается
```bash
# Проверить логи
cat /tmp/aiwisper-backend.log

# Запустить вручную для отладки
./backend/aiwisper-backend -trace-log /dev/stdout
```

## Лицензия

MIT License. См. [LICENSE](LICENSE).

## Благодарности

- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — движок транскрипции
- [GigaAM](https://github.com/salute-developers/GigaAM) — русскоязычная модель от Sber
- [FluidAudio](https://github.com/FluidInference/FluidAudio?tab=readme-ov-file) — нативная диаризация для macOS
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — кроссплатформенная диаризация
- [pyannote.audio](https://github.com/pyannote/pyannote-audio) — модели сегментации
- [Electron](https://www.electronjs.org/) — десктопный фреймворк
