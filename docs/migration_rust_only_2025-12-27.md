# План миграции AIWisper на Pure Rust

**Дата:** 2025-12-27
**Обновлено:** 2025-12-27
**Статус:** ✅ Завершено (Фазы 0-4), Фаза 5 ongoing
**Цель:** Полный отказ от Go backend и Electron frontend, переход на Tauri + Rust

---

## Обзор

### Текущая архитектура (Pure Rust) ✅
```
Tauri UI ──IPC──> Rust Backend (единый процесс)
                       │
                       ├── aiwisper-ml (whisper-rs, ort, fluid-asr, voiceprint)
                       ├── aiwisper-audio (cpal, screencapture)
                       ├── aiwisper-types (Session, Chunk, VoicePrint)
                       └── aiwisper-worker (async tasks)

Swift modules (swift/)
                       ├── screencapture (ScreenCaptureKit)
                       ├── coreaudio (Process Tap)
                       ├── diarization (FluidAudio)
                       └── transcription (Parakeet TDT)
```

### Преимущества достигнуты
- **Безопасность:** Нет network attack surface (TCP/WebSocket)
- **Производительность:** Нет JSON сериализации через сеть
- **Простота:** Один процесс, один язык (Rust + Swift для macOS APIs)
- **Надёжность:** Нет reconnect логики, нет race conditions между процессами
- **Размер:** ~15MB vs ~150MB (Electron)

---

## Статус миграции

### Фаза 0: Подготовка ✅
- [x] Создать документ плана миграции
- [x] Задокументировать GAP

### Фаза 1: Типизация IPC ✅
- [x] ts-rs для генерации TypeScript типов
- [x] Типизированные Tauri команды (rust/ui/src/lib/tauri.ts)
- [x] Унифицированный BackendContext для UI
- [x] TauriContext с маппингом событий

### Фаза 2: Core Features ✅
| Функция | Статус | Файл |
|---------|--------|------|
| Speaker Rename | ✅ | `src-tauri/src/commands/session.rs:324` |
| Speaker Merge | ✅ | `src-tauri/src/commands/session.rs:346` |
| VoicePrint Matching | ✅ | `crates/aiwisper-ml/src/voiceprint.rs` |
| Word-level Dialogue Merge | ✅ | `crates/aiwisper-ml/src/dialogue_merge.rs` |
| Audio Import | ✅ | `src-tauri/src/commands/audio.rs:126` |
| Search Sessions | ✅ | `src-tauri/src/commands/session.rs:368` |

### Фаза 3: Миграция данных ✅
- [x] Версионирование сессий (`CURRENT_SESSION_VERSION = 2`)
- [x] Автоматическая миграция v1→v2 (`migrate_session_v1_to_v2`)
- [x] Валидация данных (`validate_session_meta`)
- [x] Статистика загрузки (`SessionLoadStats`)

### Фаза 4: Cleanup ✅
- [x] Swift модули перенесены в `swift/` 
- [x] Обновлены пути поиска бинарников в Rust
- [x] Создан `scripts/build-swift.sh`
- [x] Обновлён `AGENTS.md` (deprecated: backend/, frontend/)
- [ ] Удаление `backend/` и `frontend/` — ожидает финального тестирования

### Фаза 5: Оптимизация 🔄 (ongoing)
| Задача | Статус | Примечание |
|--------|--------|------------|
| parking_lot::Mutex | ✅ | capture.rs, diarization.rs, vad.rs, gigaam.rs |
| FFT вместо DFT в gigaam.rs | ⏳ | Низкий приоритет |
| React.memo для списков | ⏳ | Низкий приоритет |
| Виртуализация длинных списков | ⏳ | Низкий приоритет |

---

## Ключевые файлы

### Rust Backend
```
rust/
├── src-tauri/src/
│   ├── state/
│   │   ├── mod.rs          # AppState, версионирование, валидация, миграция
│   │   └── recording.rs    # Запись, транскрипция, dialogue merge
│   ├── commands/
│   │   ├── session.rs      # CRUD сессий, speaker rename/merge, search
│   │   ├── audio.rs        # Запись, import, devices
│   │   ├── voiceprints.rs  # VoicePrint CRUD, matching
│   │   └── transcription.rs # Транскрипция файлов
│   └── lib.rs              # Tauri команды регистрация
├── crates/
│   ├── aiwisper-ml/src/
│   │   ├── dialogue_merge.rs  # Word-level merge алгоритм
│   │   ├── voiceprint.rs      # VoicePrint matching + storage
│   │   ├── diarization.rs     # FluidAudio diarization
│   │   ├── gigaam.rs          # GigaAM модель
│   │   └── vad.rs             # Voice Activity Detection
│   ├── aiwisper-audio/src/
│   │   ├── capture.rs         # Аудио захват
│   │   └── system_audio/      # System audio (ScreenCaptureKit)
│   └── aiwisper-types/src/
│       └── lib.rs             # Общие типы с ts-rs
└── ui/src/
    ├── context/
    │   ├── BackendContext.tsx   # Унифицированный API
    │   ├── TauriContext.tsx     # Tauri IPC layer
    │   ├── SessionContext.tsx   # Сессии, запись
    │   └── ...
    └── lib/tauri.ts             # Типизированные команды
```

### Swift модули
```
swift/
├── screencapture/     # ScreenCaptureKit (захват системного аудио)
├── coreaudio/         # CoreAudio Process Tap (macOS 14.2+)
├── diarization/       # FluidAudio diarization
├── transcription/     # FluidAudio transcription (Parakeet TDT)
└── transcription-stream/
```

### Deprecated (не изменять без запроса)
```
backend/               # Go backend (миграция завершена)
frontend/              # Electron UI (заменён на Tauri)
```

---

## Команды сборки

```bash
# Сборка Tauri приложения
./scripts/build-tauri.sh

# Сборка Swift модулей
./scripts/build-swift.sh

# Проверка Rust
cd rust && cargo check --package aiwisper

# Проверка TypeScript
cd rust/ui && npm run typecheck

# Тесты dialogue merge
cd rust && cargo test --package aiwisper-ml dialogue_merge
```

---

## Риски и митигация

| Риск | Статус | Митигация |
|------|--------|-----------|
| Несовместимость формата сессий | ✅ Решено | Версионирование v1→v2 + автомиграция |
| Регрессии в транскрипции | ✅ Решено | Word-level merge портирован из Go |
| Проблемы с VoicePrint | ✅ Решено | Полный порт алгоритма |
| Потеря данных | ✅ Решено | Атомарная запись через temp file |

---

## Следующие шаги

1. **Финальное тестирование** — проверить все функции в production-like режиме
2. **Удаление deprecated** — `backend/` и `frontend/` после подтверждения стабильности
3. **Оптимизация UI** — React.memo, виртуализация списков
4. **CI/CD** — обновить для Pure Rust сборки
