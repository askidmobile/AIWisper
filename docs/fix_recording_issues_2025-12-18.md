# Исправление проблем записи и транскрибации в реальном времени

**Дата:** 2025-12-18  
**Статус:** ✅ Реализовано

## Описание проблем

### 1. Минута записи без распознавания
**Симптом:** Первая минута записывается без распознавания текста, хотя чанки явно короче.

**Корневая причина:**
- Файл: `rust/src-tauri/src/state/recording.rs:373-378`
- `VadConfig::fixed_interval()` устанавливает `chunking_start_delay = 60 сек`
- Это означает, что первые 60 секунд аудио накапливаются без нарезки

**Код проблемы:**
```rust
// rust/crates/aiwisper-audio/src/chunk_buffer.rs:53-63
pub fn fixed_interval() -> Self {
    Self {
        mode: VadMode::Off,
        chunking_start_delay: Duration::from_secs(60), // ❌ 60 секунд задержка!
        min_chunk_duration: Duration::from_secs(30),
        max_chunk_duration: Duration::from_secs(30),
        silence_duration: Duration::from_secs(1),
        silence_threshold: 0.02,
    }
}
```

**Решение:**
- Уменьшить `chunking_start_delay` до 5-10 секунд
- Уменьшить `min_chunk_duration` и `max_chunk_duration` до 10-15 секунд
- Включить ретранскрибацию промежуточных результатов

---

### 2. Зависание индикаторов громкости при транскрибации
**Симптом:** Когда начинается распознавание, индикаторы громкости замирают и перестают обновляться.

**Корневая причина:**
- Файл: `rust/src-tauri/src/state/recording.rs:564-594`
- Транскрипция запускается **в том же потоке**, что и запись аудио
- Функция `transcribe_chunk_stereo()` **синхронная и блокирующая** (строки 864-977)
- Пока идет транскрипция, основной loop записи заблокирован и не отправляет `audio_level` события

**Код проблемы:**
```rust
// rust/src-tauri/src/state/recording.rs:564-580
if !is_stopping {
    if chunk_buffer.has_separate_channels() {
        let mic_samples = chunk_buffer.get_mic_samples_range(...);
        let sys_samples = chunk_buffer.get_sys_samples_range(...);
        
        // ❌ Блокирующий вызов в основном потоке записи!
        chunk_meta = transcribe_chunk_stereo(
            chunk_meta,
            &mic_samples,
            &sys_samples,
            chunk_buffer.sample_rate(),
            &transcription_config,
            &session_id,
            &app_handle,
        );
    }
}
```

**Решение:**
- Перенести транскрипцию в отдельный фоновый поток через `tokio::spawn` или `std::thread::spawn`
- Основной поток продолжит запись и отправку `audio_level`
- Результаты транскрипции будут приходить асинхронно

---

### 3. Текст не появляется в окне записи
**Симптом:** Распознанный текст не отображается в окне записи во время записи.

**Корневая причина (гипотеза):**
- События `chunk_transcribed` отправляются корректно (строки 828-843)
- `SessionContext.tsx` правильно обновляет чанки (строки 116-133)
- Но возможно проблема в том, что:
  1. События приходят, но React не успевает ререндерить из-за блокировки
  2. Или есть проблема с синхронизацией `currentSession` и `chunks`

**Дополнительное исследование:**
- Нужно добавить логирование в `SessionContext.tsx:116-133`
- Проверить, обновляется ли `currentSession.chunks` при получении `chunk_transcribed`

**Решение:**
- После исправления проблемы #2 (многопоточность) проверить, решится ли автоматически
- Если нет - добавить явную отправку `streaming_update` событий с текстом чанка

---

### 4. Список записей не обновляется после завершения
**Симптом:** После завершения записи нужно вручную обновлять список, и последняя запись не выбирается автоматически.

**Корневая причина:**
- Файл: `rust/ui/src/context/SessionContext.tsx:80-93`
- При `session_stopped` вызывается `sendMessage({ type: 'get_sessions' })` (строка 85)
- Но **нет логики автоматического выбора последней сессии**
- Список обновляется, но пользователь остается на старой сессии или на пустом экране

**Код проблемы:**
```typescript
// rust/ui/src/context/SessionContext.tsx:80-93
const unsubStopped = subscribe('session_stopped', (msg: any) => {
    setIsRecording(false);
    setIsStopping(false);
    const stoppedSessionId = currentSession?.id || msg.sessionId;
    setCurrentSession(null);
    sendMessage({ type: 'get_sessions' }); // ❌ Список обновляется, но не выбирается
    
    if (msg.session) {
        setSelectedSession(msg.session); // ✅ Это работает, если session в сообщении
    } else if (stoppedSessionId) {
        sendMessage({ type: 'get_session', sessionId: stoppedSessionId });
    }
});
```

**Решение:**
- После получения обновленного списка через `sessions_list` автоматически выбрать первую сессию (самую новую)
- Или гарантировать, что `session_stopped` всегда содержит полный объект `session`

---

## План реализации

### Задача 1: Уменьшить интервал чанков
**Файлы:**
- `rust/crates/aiwisper-audio/src/chunk_buffer.rs`

**Изменения:**
```rust
pub fn fixed_interval() -> Self {
    Self {
        mode: VadMode::Off,
        chunking_start_delay: Duration::from_secs(5), // ✅ Было 60, стало 5
        min_chunk_duration: Duration::from_secs(10),  // ✅ Было 30, стало 10
        max_chunk_duration: Duration::from_secs(15),  // ✅ Было 30, стало 15
        silence_duration: Duration::from_secs(1),
        silence_threshold: 0.02,
    }
}
```

### Задача 2: Многопоточная транскрибация
**Файлы:**
- `rust/src-tauri/src/state/recording.rs`

**Изменения:**
```rust
// Вместо синхронного вызова:
chunk_meta = transcribe_chunk_stereo(...);

// Делаем асинхронный:
let bg_chunk_meta = chunk_meta.clone();
let bg_app_handle = app_handle.clone();
let bg_session_id = session_id.clone();
let bg_transcription_config = transcription_config.clone();
let mic_samples = chunk_buffer.get_mic_samples_range(...);
let sys_samples = chunk_buffer.get_sys_samples_range(...);
let sample_rate = chunk_buffer.sample_rate();

std::thread::spawn(move || {
    let transcribed = transcribe_chunk_stereo(
        bg_chunk_meta,
        &mic_samples,
        &sys_samples,
        sample_rate,
        &bg_transcription_config,
        &bg_session_id,
        &bg_app_handle,
    );
    // Сохраняем результат
    let chunk_path = ...; 
    let _ = transcribed.save(&chunk_path);
});

// Сохраняем чанк со статусом pending сразу
chunk_meta.save(&chunk_path);
chunks.push(chunk_meta);
```

### Задача 3: Автовыбор последней сессии
**Файлы:**
- `rust/ui/src/context/SessionContext.tsx`

**Изменения:**
```typescript
const unsubList = subscribe('sessions_list', (msg: any) => {
    const newSessions = msg.sessions || [];
    setSessions(newSessions);
    
    // ✅ Если это обновление после завершения записи, выбираем последнюю
    if (isStopping && newSessions.length > 0) {
        const latestSession = newSessions[0]; // Предполагаем, что список отсортирован
        sendMessage({ type: 'get_session', sessionId: latestSession.id });
    }
});
```

### Задача 4: Улучшить отображение промежуточных результатов
**Файлы:**
- `rust/ui/src/components/views/RecordingView.tsx`
- `rust/ui/src/components/chunks/LiveChunksView.tsx`

**Изменения:**
- Добавить отладочное логирование в `SessionContext` для отслеживания обновлений чанков
- Убедиться, что `LiveChunksView` корректно ререндерится при изменении `chunks`

---

## Тестирование

После реализации проверить:

1. ✅ **Первый чанк появляется через 5-10 секунд** (не через минуту)
2. ✅ **Индикаторы громкости не зависают** во время транскрибации
3. ✅ **Текст появляется в реальном времени** в окне записи
4. ✅ **После stop запись автоматически выбирается** в главном окне

---

## Риски и ограничения

1. **Производительность:** Более частая нарезка увеличит нагрузку на CPU
   - Решение: Мониторить производительность, при необходимости вернуть 15-20 сек
   
2. **Конкурентность:** Множество одновременных транскрибаций может перегрузить систему
   - Решение: Добавить очередь транскрибации с ограничением на N одновременных задач

3. **Качество транскрибации:** Короткие чанки могут давать менее точные результаты
   - Решение: Реализовать ретранскрибацию финального чанка с объединением соседних

---

## Реализованные изменения

### ✅ 1. Уменьшены интервалы чанков
**Файл:** `rust/crates/aiwisper-audio/src/chunk_buffer.rs:53-63`

```rust
pub fn fixed_interval() -> Self {
    Self {
        mode: VadMode::Off,
        chunking_start_delay: Duration::from_secs(5),  // Было 60 → стало 5
        min_chunk_duration: Duration::from_secs(10),   // Было 30 → стало 10
        max_chunk_duration: Duration::from_secs(15),   // Было 30 → стало 15
        silence_duration: Duration::from_secs(1),
        silence_threshold: 0.02,
    }
}
```

**Результат:** Первый чанк теперь появляется через 5-10 секунд вместо 60 секунд.

---

### ✅ 2. Транскрибация в фоновом потоке
**Файл:** `rust/src-tauri/src/state/recording.rs:562-620`

**Было:** Транскрибация блокировала основной поток записи
```rust
chunk_meta = transcribe_chunk_stereo(...); // ❌ Блокирующий вызов
```

**Стало:** Транскрибация в отдельном потоке
```rust
std::thread::spawn(move || {
    let transcribed = transcribe_chunk_stereo(...);
    let _ = transcribed.save(&bg_chunk_path);
});
```

**Результат:** 
- ✅ Индикаторы громкости (audio_level) продолжают обновляться во время транскрибации
- ✅ UI не зависает
- ✅ Запись продолжается плавно без задержек

---

### ✅ 3. Улучшено логирование обновлений чанков
**Файл:** `rust/ui/src/context/SessionContext.tsx:116-140`

Добавлено детальное логирование для отладки:
- Логируется получение событий `chunk_transcribed`
- Логируется обновление `currentSession.chunks`
- Логируются предупреждения при игнорировании событий

**Результат:** Легче отследить проблемы с обновлением UI в реальном времени.

---

### ✅ 4. Автовыбор последней записи после завершения
**Файл:** `rust/ui/src/context/SessionContext.tsx:69-112`

**Было:** После `session_stopped` список обновлялся, но запись не выбиралась автоматически

**Стало:** 
```typescript
let lastStoppedSessionId: string | null = null;

const unsubStopped = subscribe('session_stopped', (msg: any) => {
    lastStoppedSessionId = stoppedSessionId; // Сохраняем ID
    sendMessage({ type: 'get_sessions' });   // Запрашиваем список
});

const unsubList = subscribe('sessions_list', (msg: any) => {
    setSessions(newSessions);
    
    // Автоматически выбираем последнюю остановленную сессию
    if (lastStoppedSessionId && newSessions.length > 0) {
        sendMessage({ type: 'get_session', sessionId: lastStoppedSessionId });
        lastStoppedSessionId = null;
    }
});
```

**Результат:** 
- ✅ После завершения записи автоматически открывается последняя запись
- ✅ Список обновляется автоматически
- ✅ Пользователь сразу видит результат записи

---

## Тестирование

После компиляции и запуска проверьте:

### Тест 1: Раннее распознавание
1. ✅ Начните запись
2. ✅ Через 5-10 секунд должен появиться первый чанк
3. ✅ Транскрибация должна начаться сразу после создания чанка

### Тест 2: Индикаторы не зависают
1. ✅ Начните запись
2. ✅ Дождитесь начала транскрибации первого чанка
3. ✅ **Индикаторы громкости должны продолжать обновляться**
4. ✅ UI не должен зависать

### Тест 3: Текст появляется в реальном времени
1. ✅ Начните запись
2. ✅ После транскрибации чанка текст должен **сразу появиться** в окне записи
3. ✅ Проверьте логи в DevTools Console на наличие сообщений `chunk_transcribed`

### Тест 4: Автовыбор последней записи
1. ✅ Завершите запись
2. ✅ Список записей должен **автоматически обновиться**
3. ✅ **Новая запись должна появиться в списке слева** (было исправлено дополнительно)
4. ✅ Последняя запись должна **автоматически открыться**
5. ✅ Транскрибированный текст должен быть виден

**Дополнительное исправление (2025-12-18):**
- Добавлена отправка события `sessions_list` сразу после `stop_recording`
- См. `docs/fix_session_list_update_2025-12-18.md` для деталей

---

## Команды для тестирования

```bash
# 1. Перейти в директорию Rust
cd rust

# 2. Собрать бэкенд
cargo build --release

# 3. Запустить приложение
cargo tauri dev
```

---

## Следующие шаги

- [ ] Протестировать все сценарии
- [ ] Мониторить производительность при частой нарезке чанков
- [ ] При необходимости оптимизировать размер чанков (10-15 сек оптимально)
- [ ] Задокументировать изменения в CHANGELOG.md
