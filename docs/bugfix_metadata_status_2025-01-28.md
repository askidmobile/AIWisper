# Исправление: Обновление статуса в метаданных после остановки записи

**Дата:** 2025-01-28  
**Статус:** Исправлено ✅

## Проблема

После остановки записи в файле `meta.json` не обновлялся статус на `"completed"` и не записывалось время окончания `endTime`. 

### Причина

В процессе остановки записи происходило следующее:

1. **`stop_recording()` в `mod.rs:435`**: Вызывал `handle.stop()`
2. **`RecordingHandle::stop()` в `recording.rs:207`**: 
   - Останавливал поток записи
   - Возвращал `RecordingResult` с информацией о записи
   - **НЕ обновлял файл `meta.json` на диске**
3. **`stop_recording()` продолжал**:
   - Создавал объект `Session` в памяти со статусом `"completed"`
   - Добавлял его в память (`self.inner.sessions.write().push(session)`)
   - **НЕ сохранял обновлённые метаданные на диск**

### Симптомы

- В UI отображался корректный статус (так как использовалась сессия из памяти)
- При перезапуске приложения или загрузке сессий с диска статус был `"recording"`
- Поле `endTime` в `meta.json` было `null`

## Решение

Модифицирован метод `RecordingHandle::stop()` в файле `rust/src-tauri/src/state/recording.rs:205-220`:

```rust
impl RecordingHandle {
    /// Stop recording and get result
    pub fn stop(mut self) -> Result<RecordingResult> {
        // Signal stop
        self.stop_flag.store(true, Ordering::SeqCst);

        // Wait for thread
        let result = if let Some(handle) = self.join_handle.take() {
            handle
                .join()
                .map_err(|_| anyhow::anyhow!("Recording thread panicked"))?
        } else {
            return Err(anyhow::anyhow!("Recording already stopped"));
        };

        // Update session metadata with final state
        let end_time = chrono::Utc::now();
        self.session.save_meta(
            Some(end_time),
            result.duration_ms,
            result.chunks.len(),
        )?;

        Ok(result)
    }
}
```

### Что изменилось

1. После получения результата от потока записи добавлен вызов `self.session.save_meta()`
2. Передаётся `end_time = chrono::Utc::now()` (текущее время UTC)
3. Передаётся `duration_ms` и количество чанков из результата
4. Метод `save_meta()` автоматически устанавливает статус в `"completed"`, если передан `end_time`

### Логика в `save_meta()` (recording.rs:104-132)

```rust
let meta = serde_json::json!({
    "id": self.id,
    "startTime": self.start_time.to_rfc3339(),
    "endTime": end_time.map(|t| t.to_rfc3339()),
    "status": if end_time.is_some() { "completed" } else { "recording" },
    "language": self.language,
    "model": self.model_id,
    "title": title,
    "tags": [],
    "totalDuration": duration_ms,
    "chunksCount": chunks_count,
});

std::fs::write(self.meta_path(), serde_json::to_string_pretty(&meta)?)?;
```

## Результат

Теперь при остановке записи:

1. ✅ Поток записи корректно останавливается
2. ✅ Файл `meta.json` обновляется с:
   - `"status": "completed"`
   - `"endTime": "<ISO 8601 timestamp>"`
   - Корректными значениями `totalDuration` и `chunksCount`
3. ✅ Session в памяти также имеет статус `"completed"`
4. ✅ При перезапуске приложения статус загружается корректно

## Тестирование

Для проверки исправления:

1. Запустить запись
2. Остановить запись
3. Проверить файл `~/Library/Application Support/aiwisper/sessions/{session_id}/meta.json`
4. Убедиться, что:
   ```json
   {
     "status": "completed",
     "endTime": "2025-01-28T12:34:56.789Z",
     "totalDuration": 123456,
     "chunksCount": 10
   }
   ```

## Связанные файлы

- `rust/src-tauri/src/state/recording.rs:205-220` - Основное исправление
- `rust/src-tauri/src/state/recording.rs:104-132` - Логика сохранения метаданных
- `rust/src-tauri/src/state/mod.rs:435-515` - Вызов stop_recording
