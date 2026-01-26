# Отладка проблемы с пустым экраном записи

## Проблема
При нажатии "Начать запись" экран остаётся пустым, не показывается транскрипция и статус.
После остановки записи не отображается только что записанная сессия.

## Добавленное логирование

Я добавил подробное логирование в критические места:

### 1. TauriContext (`rust/ui/src/context/TauriContext.tsx`)
- Логирует все входящие события от Rust бэкенда
- Показывает количество зарегистрированных обработчиков для каждого типа события
- Предупреждает, если событие пришло, но нет обработчиков

### 2. SessionContext (`rust/ui/src/context/SessionContext.tsx`)
- Логирует события `session_started`, `chunk_created`, `chunk_transcribed`
- Показывает структуру данных в событиях
- Отслеживает обновления состояния `currentSession`

### 3. RecordingView (`rust/ui/src/components/views/RecordingView.tsx`)
- Логирует каждый рендер с текущим состоянием
- Показывает количество чанков и ID сессии

## Как проверить

### Шаг 1: Запустите приложение в режиме разработки

```bash
cd /Users/askid/Projects/AIWisper/rust
cargo tauri dev
```

### Шаг 2: Откройте DevTools

В окне приложения нажмите:
- **macOS**: `Cmd + Option + I`
- **Windows/Linux**: `Ctrl + Shift + I`

Перейдите на вкладку **Console**.

### Шаг 3: Начните запись

1. Нажмите кнопку "Начать запись"
2. Внимательно следите за логами в консоли

### Что искать в логах

#### ✅ Нормальный поток событий:

```
[Tauri] Setting up listeners for events: [...]
[Tauri] All listeners set up, total: XX
[Tauri] Invoking command: start_recording {...}
[Tauri] ✅ Event received: session_started -> session_started {...}
[Tauri] notify: type="session_started", handlers count: 1
[SessionContext] session_started event received: {...}
[SessionContext] session object: {id: "...", startTime: "...", status: "recording", chunks: []}
[RecordingView] Render - currentSession: <session-id>
[RecordingView] Render - chunks count: 0
[RecordingView] Render - enableStreaming: true/false
```

Через несколько секунд должны появиться события чанков:

```
[Tauri] ✅ Event received: chunk_created -> chunk_created {...}
[SessionContext] chunk_created event received: {...}
[SessionContext] chunk_created: updated currentSession, chunks count: 1
[RecordingView] Render - chunks count: 1
```

После транскрипции:

```
[Tauri] ✅ Event received: chunk_transcribed -> chunk_transcribed {...}
[SessionContext] chunk_transcribed event received: {...}
[SessionContext] chunk_transcribed: updated chunks, count: 1
```

#### ❌ Проблемные сценарии:

**Сценарий 1: События не приходят от Rust**
```
[Tauri] Invoking command: start_recording {...}
// Нет событий session_started, chunk_created
```
→ **Проблема**: Rust бэкенд не отправляет события через Tauri event system

**Сценарий 2: События приходят, но нет обработчиков**
```
[Tauri] ✅ Event received: session_started -> session_started {...}
[Tauri] notify: type="session_started", handlers count: 0
[Tauri] No handlers registered for event type: session_started
```
→ **Проблема**: SessionContext не подписался на события (проблема с порядком инициализации)

**Сценарий 3: События обрабатываются, но состояние не обновляется**
```
[SessionContext] session_started event received: {...}
[SessionContext] session object: null  // или неправильная структура
```
→ **Проблема**: Неправильная структура данных в событии

**Сценарий 4: Состояние обновляется, но UI не рендерится**
```
[SessionContext] chunk_created: updated currentSession, chunks count: 1
// Нет логов [RecordingView] Render
```
→ **Проблема**: RecordingView не перерендеривается при изменении currentSession

## Возможные решения

### Если события не приходят от Rust

Проверьте, что Rust бэкенд правильно отправляет события:

```bash
# Проверьте логи Rust в терминале, где запущен cargo tauri dev
# Должны быть строки типа:
# Recording started: session=...
# Chunk created: index=0, start=0ms, end=5000ms
```

### Если нет обработчиков

Проблема с порядком инициализации провайдеров. Проверьте `AppTauri.tsx`:

```typescript
<TauriProvider>
    <ModelProvider>
        <SessionProvider>  {/* Должен быть ПОСЛЕ TauriProvider */}
```

### Если неправильная структура данных

Проверьте, что Rust отправляет правильную структуру:

```rust
// В state/recording.rs
app_handle.emit(
    "session_started",
    serde_json::json!({
        "sessionId": session_id,
        "session": {
            "id": session_id,
            "startTime": chrono::Utc::now().to_rfc3339(),
            "status": "recording",
            "chunks": [],
            // Добавьте недостающие поля, если нужно
        }
    }),
);
```

## Дополнительная отладка

### Проверка Tauri событий напрямую

Добавьте в консоль браузера:

```javascript
// Слушаем все события Tauri
window.__TAURI__.event.listen('session_started', (event) => {
    console.log('Direct Tauri event:', event);
});
```

### Проверка состояния React

В консоли браузера:

```javascript
// Получить текущее состояние (если используете React DevTools)
$r.props  // props текущего выбранного компонента
$r.state  // state текущего выбранного компонента
```

## Следующие шаги

1. Запустите приложение с открытой консолью
2. Начните запись
3. Скопируйте ВСЕ логи из консоли
4. Отправьте логи для анализа

Логи покажут точно, где происходит сбой в цепочке:
`Rust emit → Tauri events → TauriContext → SessionContext → RecordingView`
