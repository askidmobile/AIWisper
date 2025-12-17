# Исследование: Интеграция внешних приложений с AIWisper

**Дата:** 2025-12-14  
**Статус:** Исследование / Концепция  
**Автор:** AI Assistant

## Содержание

1. [Цель исследования](#цель-исследования)
2. [Текущая архитектура](#текущая-архитектура)
3. [Варианты интеграции](#варианты-интеграции)
4. [Детальная архитектура рекомендуемого варианта](#детальная-архитектура-рекомендуемого-варианта)
5. [SDK и инструменты](#sdk-и-инструменты)
6. [Альтернатива: Backend как компонент](#альтернатива-backend-как-компонент)
7. [Технологии IPC](#технологии-ipc)
8. [Выводы и рекомендации](#выводы-и-рекомендации)

---

## Цель исследования

Разработать концепцию интеграции AIWisper с внешними приложениями для:

- **Управления записью** — внешнее приложение отправляет сигнал на старт/стоп записи
- **Realtime транскрипции** — получение распознанного текста в реальном времени во время записи
- **Доступа к сессиям** — чтение списка записей и их содержимого из других приложений
- **Переиспользования компонентов** — возможность использовать backend без Electron UI

---

## Текущая архитектура

### Схема взаимодействия

```
┌──────────────────────┐     запускает      ┌──────────────────────┐
│   Electron App       │────────────────────►│   Go Backend         │
│   (main.ts)          │                     │   (backend_bin)      │
└──────────────────────┘                     └──────────────────────┘
         │                                            │
         │ gRPC (unix socket)                         │
         ▼                                            │
┌──────────────────────┐                              │
│   React Frontend     │◄─────────────────────────────┘
│   (grpcStream.ts)    │     bidirectional streaming
└──────────────────────┘
```

### Ключевые компоненты Backend

| Компонент | Файл | Назначение |
|-----------|------|------------|
| Server | `internal/api/server.go` | HTTP/gRPC/WebSocket сервер |
| gRPC Service | `internal/api/grpc_service.go` | Bidirectional streaming с JSON-кодеком |
| Session Manager | `session/manager.go` | Управление сессиями записи |
| Audio Capture | `audio/capture.go` | Захват аудио с микрофона/системы |
| Transcription Service | `internal/service/transcription.go` | Транскрипция аудио |
| VoicePrint Store | `voiceprint/store.go` | Хранение голосовых отпечатков |

### Текущие endpoints

- **gRPC**: Unix socket `/tmp/aiwisper-grpc.sock` (macOS/Linux) или named pipe `\\.\pipe\aiwisper-grpc` (Windows)
- **HTTP**: порт 18080 для REST API (файлы, waveform, импорт)
- **WebSocket**: `/ws` endpoint для web-клиентов

### Проблема

Backend запускается как child process Electron приложения. Без запущенного Electron — нет доступа к backend.

---

## Варианты интеграции

### Вариант 1: Backend как системный сервис (Launch Agent/Daemon)

```
┌─────────────────────────────────────────────────────────────────┐
│                    macOS / Linux / Windows                       │
│                                                                  │
│  ┌──────────────────┐   ┌──────────────────┐                    │
│  │  launchd/systemd │   │  AIWisper Backend│ (всегда запущен)   │
│  │  (автостарт)     │──►│  как сервис      │                    │
│  └──────────────────┘   └────────┬─────────┘                    │
│                                  │                               │
│         ┌────────────────────────┼────────────────────────┐     │
│         │                        │                        │     │
│         ▼                        ▼                        ▼     │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────┐   │
│  │ AIWisper UI  │   │  VS Code     │   │  CLI / Alfred /   │   │
│  │ (Electron)   │   │  Extension   │   │  Raycast / SDK    │   │
│  └──────────────┘   └──────────────┘   └───────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Плюсы:**
- Backend всегда доступен, мгновенный отклик
- On-demand запуск через launchd socket activation
- Electron становится просто UI-клиентом

**Минусы:**
- Сложность установки и деплоя
- Два процесса в памяти
- Нужны системные права для установки сервиса

---

### Вариант 2: Backend как embeddable библиотека

```
┌────────────────────────────────────────────────────────────────┐
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │              AIWisper Core Library (Go)                  │  │
│   │                                                          │  │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐ │  │
│   │  │ Session  │ │  Audio   │ │ Transcrip│ │ VoicePrint  │ │  │
│   │  │ Manager  │ │ Capture  │ │ Pipeline │ │   Store     │ │  │
│   │  └──────────┘ └──────────┘ └──────────┘ └─────────────┘ │  │
│   └────────────────────────┬────────────────────────────────┘  │
│                            │                                    │
│       ┌────────────────────┼────────────────────────┐          │
│       ▼                    ▼                        ▼          │
│  ┌──────────┐       ┌──────────┐            ┌──────────────┐  │
│  │ C Bindings│      │  HTTP    │            │   Go gRPC    │  │
│  │ (FFI)    │       │  Server  │            │   Client     │  │
│  └────┬─────┘       └────┬─────┘            └──────────────┘  │
│       │                  │                                     │
│       ▼                  ▼                                     │
│  Python/Rust/       REST API /              Electron App       │
│  Swift/Node         WebSocket                                  │
└────────────────────────────────────────────────────────────────┘
```

**Плюсы:**
- Максимальная гибкость — можно встраивать куда угодно
- Один процесс для каждого приложения
- Нет зависимости от запущенного демона

**Минусы:**
- Сложность создания C-биндингов для Go
- Дублирование ресурсов (модели в памяти несколько раз)
- Большой объём работы

---

### Вариант 3: Гибридный — Backend с External API (рекомендуемый)

```
┌──────────────────────────────────────────────────────────────────────┐
│                        AIWisper System                                │
│                                                                       │
│   ┌───────────────────────────────────────────────────────────────┐  │
│   │                    AIWisper Backend                            │  │
│   │                                                                │  │
│   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐│  │
│   │  │  Internal   │  │  External   │  │    Integration Hub     ││  │
│   │  │  gRPC API   │  │  API Layer  │  │  (message routing,     ││  │
│   │  │(текущий)    │  │  (новый)    │  │   permissions, events) ││  │
│   │  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘│  │
│   │         │                │                     │               │  │
│   │         └────────────────┴─────────────────────┘               │  │
│   │                          │                                     │  │
│   │         ┌────────────────┼────────────────────────┐           │  │
│   │         ▼                ▼                        ▼           │  │
│   │  ┌──────────────┐ ┌──────────────┐ ┌─────────────────────┐   │  │
│   │  │Unix Socket   │ │ TCP Socket   │ │  Named Pipe (Win)   │   │  │
│   │  │/tmp/aiwisper │ │ localhost:   │ │  \\.\pipe\aiwisper  │   │  │
│   │  │-grpc.sock    │ │ 18081        │ │  -external          │   │  │
│   │  └──────────────┘ └──────────────┘ └─────────────────────┘   │  │
│   └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  Клиенты:                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │Electron  │  │VS Code   │  │CLI       │  │Alfred/   │  │Python  │ │
│  │App       │  │Extension │  │aiwisper  │  │Raycast   │  │SDK     │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

**Идея**: Backend может запускаться:
1. **Electron-ом** (как сейчас) — для обычных пользователей
2. **Как standalone daemon** — для интеграций (`--daemon`)
3. **По требованию через launchd** — автоматический запуск при подключении

---

## Детальная архитектура рекомендуемого варианта

### Режимы запуска Backend

```go
// backend/main.go

func main() {
    // Новые флаги
    daemonMode := flag.Bool("daemon", false, "Run as background daemon")
    socketActivation := flag.Bool("socket-activation", false, "Use launchd/systemd socket activation")
    externalPort := flag.Int("external-port", 18081, "Port for external API")
    
    // ...
    
    if *daemonMode {
        daemonize()
    }
    
    if *socketActivation {
        listeners := activation.Listeners()
    }
}
```

### External API Layer

```go
// backend/internal/api/external_api.go

type ExternalAPIServer struct {
    server     *Server
    sessionMgr *session.Manager
    clients    map[string]*ExternalClient
    mu         sync.RWMutex
}

type ExternalClient struct {
    ID          string
    Name        string    // "vscode-ext", "alfred", etc.
    Permissions []Permission
    Conn        net.Conn
    Subscribed  map[string]bool  // "realtime", "sessions", etc.
}

type Permission int
const (
    PermissionRecord Permission = iota
    PermissionReadSessions
    PermissionRealtime
    PermissionControl
)
```

### Типы сообщений External API

```go
const (
    // Регистрация
    MsgExtRegister    = "ext.register"
    MsgExtRegistered  = "ext.registered"
    
    // Управление записью
    MsgExtStartRecord  = "ext.record.start"
    MsgExtStopRecord   = "ext.record.stop"
    MsgExtRecordStatus = "ext.record.status"
    
    // События (push от сервера)
    MsgExtRecordStarted    = "ext.event.record_started"
    MsgExtRecordStopped    = "ext.event.record_stopped"
    MsgExtRealtimeChunk    = "ext.event.realtime_chunk"
    MsgExtChunkTranscribed = "ext.event.chunk_transcribed"
    
    // Сессии
    MsgExtListSessions   = "ext.sessions.list"
    MsgExtGetSession     = "ext.sessions.get"
    MsgExtSearchSessions = "ext.sessions.search"
    
    // Подписки
    MsgExtSubscribe   = "ext.subscribe"
    MsgExtUnsubscribe = "ext.unsubscribe"
)
```

### Протокол взаимодействия (JSON)

```json
// Регистрация клиента
{
    "type": "ext.register",
    "data": {
        "name": "my-vscode-extension",
        "version": "1.0.0",
        "capabilities": ["record", "realtime", "sessions"]
    }
}

// Ответ
{
    "type": "ext.registered",
    "id": "req_001",
    "data": {
        "client_id": "ext_abc123",
        "permissions": ["record", "realtime", "sessions"],
        "server_version": "0.1.0"
    }
}

// Запуск записи
{
    "type": "ext.record.start",
    "id": "req_002",
    "data": {
        "language": "ru",
        "diarization": true,
        "streaming": true
    }
}

// Push-событие о новом чанке (realtime)
{
    "type": "ext.event.realtime_chunk",
    "data": {
        "session_id": "sess_xyz",
        "text": "Привет, это тест",
        "speaker": "Speaker 1",
        "timestamp_ms": 1500,
        "is_final": false
    }
}
```

### macOS Launch Agent (on-demand)

```xml
<!-- ~/Library/LaunchAgents/com.aiwisper.daemon.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" 
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aiwisper.daemon</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/AIWisper.app/Contents/Resources/aiwisper-backend</string>
        <string>--socket-activation</string>
        <string>--daemon</string>
    </array>
    
    <!-- On-demand запуск через socket -->
    <key>Sockets</key>
    <dict>
        <key>Listeners</key>
        <dict>
            <key>SockPathName</key>
            <string>/tmp/aiwisper-external.sock</string>
            <key>SockPathMode</key>
            <integer>438</integer>
        </dict>
    </dict>
    
    <key>RunAtLoad</key>
    <false/>
    
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    
    <!-- Автозавершение при неактивности 5 минут -->
    <key>ExitTimeOut</key>
    <integer>300</integer>
</dict>
</plist>
```

**Принцип работы:**
1. Клиент подключается к `/tmp/aiwisper-external.sock`
2. launchd автоматически запускает backend если он не запущен
3. Backend обрабатывает запросы
4. При отсутствии подключений 5 минут — backend завершается
5. При следующем подключении — снова запускается

---

## SDK и инструменты

### Python SDK

```python
# pip install aiwisper

from aiwisper import AIWisper
import asyncio

async def main():
    # Подключение (запустится автоматически через launchd)
    wisper = AIWisper()
    await wisper.connect()
    
    # Callback для realtime транскрипции
    @wisper.on_realtime
    async def on_text(chunk):
        print(f"[{chunk.speaker}]: {chunk.text}")
    
    # Запуск записи
    session = await wisper.start_recording(
        language="ru",
        diarization=True,
        streaming=True
    )
    
    input("Press Enter to stop...")
    
    await session.stop()
    
    # Полная транскрипция
    transcript = await session.get_transcript()
    print(f"\nFull transcript:\n{transcript.text}")
    
    # Список сессий
    sessions = await wisper.list_sessions(limit=10)
    for s in sessions:
        print(f"- {s.id}: {s.title} ({s.duration_sec}s)")

asyncio.run(main())
```

### Node.js/TypeScript SDK

```typescript
// npm install @aiwisper/sdk

import { AIWisper } from '@aiwisper/sdk';

const wisper = new AIWisper();
await wisper.connect();

// Подписка на события
wisper.on('realtime', (chunk) => {
    console.log(`[${chunk.speaker}]: ${chunk.text}`);
});

// Запуск записи
const session = await wisper.startRecording({ language: 'ru' });

// Через 10 секунд останавливаем
setTimeout(async () => {
    await session.stop();
    const transcript = await session.getTranscript();
    console.log(transcript.fullText);
}, 10000);
```

### CLI

```bash
# Установка
brew install aiwisper-cli

# Управление записью
aiwisper record start --language=ru --diarization
aiwisper record stop
aiwisper record status

# Realtime вывод (для pipe)
aiwisper stream --format=json | jq '.text'

# Сессии
aiwisper sessions list
aiwisper sessions get <id> --format=txt
aiwisper sessions export <id> --format=srt > subtitles.srt

# Интерактивный режим
aiwisper interactive
```

### Интеграция с Alfred/Raycast

```bash
#!/bin/bash
# Alfred workflow: "Start AIWisper Recording"

# Подключение к backend (запустится автоматически)
echo '{"type":"ext.record.start","data":{"language":"ru"}}' | \
    nc -U /tmp/aiwisper-external.sock

osascript -e 'display notification "Recording started" with title "AIWisper"'
```

### VS Code Extension (пример)

```typescript
// extension.ts
import * as vscode from 'vscode';
import { AIWisperClient } from './aiwisper-client';

class AIWisperDictation {
    private client: AIWisperClient;
    
    async startDictation() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        await this.client.connect();
        
        this.client.on('realtime', (chunk) => {
            editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, chunk.text);
            });
        });
        
        await this.client.startRecording({ 
            language: 'ru',
            streaming: true 
        });
    }
    
    async stopDictation() {
        await this.client.stopRecording();
    }
}
```

---

## Альтернатива: Backend как компонент

Вместо создания External API можно просто переиспользовать backend как компонент в другом приложении:

### Вариант A: Запуск из другого приложения

```
┌──────────────────────────────────────────────────────────────┐
│                  Другое приложение                            │
│                                                               │
│  ┌─────────────────┐      spawn       ┌───────────────────┐  │
│  │  Ваш код        │──────────────────►│ aiwisper-backend  │  │
│  │  (Python/Node/  │                   │ (child process)   │  │
│  │   Go/Swift)     │◄──────────────────│                   │  │
│  └─────────────────┘   gRPC/WebSocket  └───────────────────┘  │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

**Пример на Python:**

```python
import subprocess
import socket
import json

class AIWisperBackend:
    def __init__(self, backend_path, data_dir, models_dir):
        self.backend_path = backend_path
        self.data_dir = data_dir
        self.models_dir = models_dir
        self.process = None
        self.socket_path = "/tmp/my-app-aiwisper.sock"
    
    def start(self):
        """Запуск backend как subprocess"""
        self.process = subprocess.Popen([
            self.backend_path,
            "-data", self.data_dir,
            "-models", self.models_dir,
            "-grpc-addr", f"unix:{self.socket_path}",
            "-port", "0",  # Отключить HTTP
        ])
    
    def stop(self):
        if self.process:
            self.process.terminate()
            self.process.wait(timeout=5)
    
    def connect(self):
        """Подключение к gRPC через существующий протокол"""
        # Используем тот же протокол что и Electron frontend
        pass
```

### Вариант B: Использование как Go-модуля

Если другое приложение на Go, можно импортировать напрямую:

```go
package main

import (
    "aiwisper/ai"
    "aiwisper/audio"
    "aiwisper/session"
    "aiwisper/models"
    "aiwisper/internal/service"
)

func main() {
    // Инициализация менеджеров
    sessionMgr, _ := session.NewManager("/path/to/data")
    modelMgr, _ := models.NewManager("/path/to/models")
    engineMgr := ai.NewEngineManager(modelMgr)
    
    capture, _ := audio.NewCapture()
    defer capture.Close()
    
    transcriptionService := service.NewTranscriptionService(sessionMgr, engineMgr)
    recordingService := service.NewRecordingService(sessionMgr, capture)
    
    // Использование напрямую
    sess, _ := sessionMgr.CreateSession("ru", "default")
    recordingService.StartRecording(sess.ID)
    
    // ...
    
    recordingService.StopRecording()
}
```

### Преимущества переиспользования как компонента

1. **Простота** — не нужно создавать новый API
2. **Изоляция** — каждое приложение имеет свой экземпляр
3. **Гибкость** — полный контроль над жизненным циклом
4. **Нет конфликтов** — разные приложения не мешают друг другу

### Недостатки

1. **Дублирование ресурсов** — модели загружаются в память отдельно для каждого приложения
2. **Нет централизации** — сессии не шарятся между приложениями
3. **Больше кода** — каждое приложение должно управлять backend

---

## Технологии IPC

### Обзор вариантов

| Технология | Платформа | Скорость | Сложность | Примечания |
|------------|-----------|----------|-----------|------------|
| **Unix Socket** | macOS, Linux | Высокая | Низкая | Текущий выбор для gRPC |
| **Named Pipe** | Windows | Высокая | Низкая | Текущий выбор для Windows |
| **TCP Socket** | Все | Средняя | Низкая | Универсально, но localhost only |
| **D-Bus** | Linux | Средняя | Средняя | Стандарт для Linux desktop |
| **XPC** | macOS | Высокая | Высокая | Apple-native, песочница |
| **Shared Memory** | Все | Очень высокая | Высокая | Для больших объёмов данных |
| **gRPC** | Все | Высокая | Средняя | Уже используется |

### Рекомендации

Для AIWisper оптимальный выбор:

1. **Primary**: Unix Socket (macOS/Linux) / Named Pipe (Windows) — уже реализовано
2. **Secondary**: TCP localhost:18081 — для простоты интеграции
3. **Протокол**: JSON over WebSocket или gRPC — совместимость с текущим API

### Golang IPC библиотеки

- **github.com/james-barrow/golang-ipc** — кроссплатформенный IPC
- **github.com/takama/daemon** — создание системных демонов
- **github.com/sevlyar/go-daemon** — daemonization для Go
- **github.com/coreos/go-systemd/activation** — systemd socket activation

---

## Выводы и рекомендации

### Краткосрочные решения (быстрая реализация)

1. **Backend как subprocess** — другие приложения запускают `aiwisper-backend` и подключаются через существующий gRPC API
2. **Добавить TCP listener** — дополнительный порт (например, 18081) для внешних подключений

### Среднесрочные решения

1. **Режим daemon** — флаг `--daemon` для запуска без привязки к терминалу
2. **External API** — отдельный упрощённый API для внешних клиентов с подписками на события
3. **CLI utility** — `aiwisper-cli` для скриптов и автоматизации

### Долгосрочные решения

1. **launchd/systemd интеграция** — on-demand запуск backend при подключении клиента
2. **SDK для разных языков** — Python, Node.js, Swift
3. **Plugin система** — возможность расширения функциональности

### Приоритеты реализации

| Приоритет | Задача | Сложность | Ценность |
|-----------|--------|-----------|----------|
| 1 | TCP listener для внешних подключений | Низкая | Высокая |
| 2 | Режим daemon (`--daemon`) | Низкая | Средняя |
| 3 | CLI utility | Средняя | Высокая |
| 4 | External API с подписками | Средняя | Высокая |
| 5 | Python SDK | Средняя | Средняя |
| 6 | launchd интеграция | Высокая | Средняя |

---

## Открытые вопросы

1. **Безопасность**: Достаточно ли localhost-only доступа? Нужны ли API-ключи?
2. **Разделение ресурсов**: Как Electron app и внешние клиенты должны "делить" backend?
3. **Версионирование**: Нужно ли версионирование External API?
4. **Приоритет интеграций**: Какие сценарии (CLI, VS Code, Alfred) важнее?

---

## Ссылки

- [D-Bus Tutorial](https://dbus.freedesktop.org/doc/dbus-tutorial.html)
- [macOS Launch Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [XPC Services](https://developer.apple.com/documentation/xpc)
- [golang-ipc](https://github.com/james-barrow/golang-ipc)
- [Inter-process communication with gRPC (Microsoft)](https://learn.microsoft.com/en-us/aspnet/core/grpc/interprocess)
