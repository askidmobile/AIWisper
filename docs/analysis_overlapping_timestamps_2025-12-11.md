# Системный анализ: Перекрывающиеся timestamps в транскрипции двух аудиоканалов

**Дата:** 2025-12-11 16:30
**Статус:** Completed
**Аналитик:** @analyst

---

## Контекст и стейкхолдеры

### Проблема
При записи стерео аудио (левый канал = микрофон пользователя, правый = системный звук) и раздельной транскрипции через Whisper, timestamps из разных каналов перекрываются. Текущий алгоритм сортирует ВСЕ слова по времени начала, что приводит к "шахматному" чередованию слов вместо естественного диалога.

### Пример проблемы (реальные данные)
```
Собеседник: "Может быть," (31280-31980ms)
Вы: "Так," (31840-32080ms)           ← перекрытие 140ms
Собеседник: "имеет" (31980-32330ms)
Вы: "давай-ка" (32120-36430ms)       ← перекрытие 210ms
```

**Результат текущего алгоритма:** слова чередуются в "шахматном" порядке
**Ожидаемый результат:** связные фразы каждого спикера

### Причины перекрытий
1. **Реальное перебивание** — люди действительно говорят одновременно
2. **Неточность Whisper** — timestamps могут отличаться на ±500ms
3. **Разная скорость обработки каналов** — небольшая рассинхронизация

---

## AS-IS (как сейчас)

### Текущий алгоритм (файл: `backend/session/manager.go`)

#### Поток данных
```
mergeSegmentsToDialogue()
    ↓
[если есть word-level данные]
    ↓
mergeWordsToDialogue()
    ↓
collectAllWords() → сортировка по Start → groupWordsToDialogueV2() → postProcessDialogue()
```

#### Ключевые функции

**1. `collectAllWords` (строки 528-562)**
- Собирает ВСЕ слова из mic и sys сегментов в единый массив
- Проставляет спикера если отсутствует

**2. `groupWordsToDialogueV2` (строки 564-672)**
- Сортирует слова по времени начала
- Группирует в фразы по критериям:
  - Смена спикера (mic ↔ sys) = новая фраза
  - Большая пауза (>800ms) + проверка на вставку другого спикера
  - Очень большая пауза (>2500ms) = точно новая фраза
  - Фраза слишком длинная (>15 сек)

**3. `postProcessDialogue` (строки 674-714)**
- Объединяет соседние короткие фразы одного спикера
- Условия объединения: пауза <500ms И <3 слов, ИЛИ пауза <200ms

#### Текущие константы (строки 801-815)
```go
speakerSwitchToleranceMs = 500   // Толерантность при смене спикера
minPauseBetweenPhrasesMs = 800   // Мин. пауза для проверки вставки
maxOverlapMs             = 1500  // Макс. перекрытие для "одновременной речи"
longPauseMs              = 2500  // Очень большая пауза
shortMergeGapMs          = 500   // Короткий промежуток для объединения
veryShortGapMs           = 200   // Очень короткий - всегда объединяем
```

### Выявленные проблемы

#### Проблема 1: Сортировка по Start разрывает фразы
**Корень:** При перекрытии timestamps слова разных спикеров перемешиваются:
```
Сортировка по Start:
[31280] Собеседник: "Может"
[31780] Собеседник: "быть,"
[31840] Вы: "Так,"           ← вклинивается в середину фразы собеседника
[31980] Собеседник: "имеет"
[32120] Вы: "давай-ка"
```

**Последствие:** Алгоритм видит смену спикера на каждом слове и создаёт микро-фразы.

#### Проблема 2: Нет понятия "сегмента речи"
**Корень:** Whisper возвращает сегменты (фразы), но алгоритм работает только со словами, игнорируя границы сегментов.

**Последствие:** Теряется информация о том, что слова принадлежат одной логической фразе.

#### Проблема 3: Неточные timestamps Whisper
**Корень:** Whisper может давать timestamps с ошибкой ±500ms, особенно для коротких слов.

Пример из реальных данных:
```
"Это" длится 34680-40690ms (6 секунд для одного слова!)
"По-моему," длится 42500-51620ms (9 секунд!)
```

**Последствие:** Слова с аномально длинными timestamps "накрывают" слова другого спикера.

#### Проблема 4: Отсутствие приоритета сегментов
**Корень:** Все слова равноправны, нет учёта того, что слова внутри одного сегмента Whisper должны идти вместе.

---

## TO-BE (как должно быть)

### Новая стратегия: "Segment-first interleaving"

#### Принцип
1. **Работать на уровне сегментов**, а не слов
2. **Сортировать сегменты** по времени начала
3. **Обрабатывать перекрытия** между сегментами, а не словами
4. **Сохранять целостность фраз** внутри сегмента

#### Алгоритм

```
1. Получить сегменты mic и sys (уже сгруппированные Whisper)
2. Объединить в один список с меткой источника
3. Сортировать по времени начала сегмента
4. Обработать перекрытия:
   - Если перекрытие < порога (500ms) → игнорировать, оставить порядок
   - Если перекрытие > порога → это реальное перебивание, отметить
5. Объединить соседние сегменты одного спикера с малой паузой
6. Постобработка: склеить фрагментированные фразы
```

### Конкретные изменения

#### Изменение 1: Новая функция `mergeSegmentsWithOverlapHandling`

```go
// mergeSegmentsWithOverlapHandling объединяет сегменты с обработкой перекрытий
// Работает на уровне сегментов, а не слов, сохраняя целостность фраз
func mergeSegmentsWithOverlapHandling(micSegments, sysSegments []TranscriptSegment) []TranscriptSegment {
    // 1. Помечаем источник каждого сегмента
    type taggedSegment struct {
        segment TranscriptSegment
        isMic   bool
    }
    
    var allSegments []taggedSegment
    for _, seg := range micSegments {
        allSegments = append(allSegments, taggedSegment{segment: seg, isMic: true})
    }
    for _, seg := range sysSegments {
        allSegments = append(allSegments, taggedSegment{segment: seg, isMic: false})
    }
    
    // 2. Сортируем по времени начала сегмента
    sort.Slice(allSegments, func(i, j int) bool {
        if allSegments[i].segment.Start == allSegments[j].segment.Start {
            // При равном времени - mic первым (инициатор)
            return allSegments[i].isMic
        }
        return allSegments[i].segment.Start < allSegments[j].segment.Start
    })
    
    // 3. Обрабатываем перекрытия и объединяем
    var result []TranscriptSegment
    
    for i, tagged := range allSegments {
        seg := tagged.segment
        
        // Устанавливаем спикера
        if tagged.isMic {
            if seg.Speaker == "" || seg.Speaker == "mic" {
                seg.Speaker = "Вы"
            }
        } else {
            if seg.Speaker == "" || seg.Speaker == "sys" {
                seg.Speaker = "Собеседник"
            }
        }
        
        if i == 0 {
            result = append(result, seg)
            continue
        }
        
        prev := &result[len(result)-1]
        prevIsMic := isMicSpeaker(prev.Speaker)
        currIsMic := tagged.isMic
        
        // Проверяем перекрытие
        overlap := prev.End - seg.Start
        
        if prevIsMic == currIsMic {
            // Тот же спикер - проверяем нужно ли объединить
            gap := seg.Start - prev.End
            if gap < segmentMergeGapMs {
                // Объединяем сегменты одного спикера
                prev.End = seg.End
                prev.Text = prev.Text + " " + seg.Text
                prev.Words = append(prev.Words, seg.Words...)
                continue
            }
        } else {
            // Разные спикеры
            if overlap > 0 && overlap < overlapToleranceMs {
                // Небольшое перекрытие - корректируем границы
                // Обрезаем предыдущий сегмент до начала текущего
                if prev.End > seg.Start {
                    prev.End = seg.Start
                    // Обрезаем слова если есть
                    if len(prev.Words) > 0 {
                        var trimmedWords []TranscriptWord
                        var trimmedTexts []string
                        for _, w := range prev.Words {
                            if w.End <= seg.Start {
                                trimmedWords = append(trimmedWords, w)
                                trimmedTexts = append(trimmedTexts, w.Text)
                            }
                        }
                        if len(trimmedWords) > 0 {
                            prev.Words = trimmedWords
                            prev.Text = strings.Join(trimmedTexts, " ")
                        }
                    }
                }
            }
            // При большом перекрытии - это реальное перебивание, оставляем как есть
        }
        
        result = append(result, seg)
    }
    
    return result
}

const (
    segmentMergeGapMs   = 1000  // Объединять сегменты одного спикера с паузой < 1 сек
    overlapToleranceMs  = 500   // Перекрытие < 500ms считаем погрешностью timestamps
)
```

#### Изменение 2: Обновить `mergeWordsToDialogue`

```go
func mergeWordsToDialogue(micSegments, sysSegments []TranscriptSegment) []TranscriptSegment {
    // Проверяем есть ли сегменты
    if len(micSegments) == 0 && len(sysSegments) == 0 {
        return nil
    }
    
    // Используем segment-level алгоритм
    result := mergeSegmentsWithOverlapHandling(micSegments, sysSegments)
    
    // Постобработка: объединение коротких фраз
    result = postProcessDialogue(result)
    
    log.Printf("mergeWordsToDialogue: mic=%d, sys=%d -> %d phrases",
        len(micSegments), len(sysSegments), len(result))
    
    return result
}
```

#### Изменение 3: Улучшить `postProcessDialogue`

```go
func postProcessDialogue(phrases []TranscriptSegment) []TranscriptSegment {
    if len(phrases) <= 1 {
        return phrases
    }
    
    var result []TranscriptSegment
    
    for i, phrase := range phrases {
        if i == 0 {
            result = append(result, phrase)
            continue
        }
        
        prev := &result[len(result)-1]
        prevIsMic := isMicSpeaker(prev.Speaker)
        phraseIsMic := isMicSpeaker(phrase.Speaker)
        
        // Объединяем соседние фразы одного спикера
        if prevIsMic == phraseIsMic {
            gap := phrase.Start - prev.End
            prevDuration := prev.End - prev.Start
            
            // Условия объединения:
            // 1. Пауза < 800ms И предыдущая фраза короткая (< 2 сек)
            // 2. ИЛИ пауза < 300ms (очень короткая)
            // 3. ИЛИ предыдущая фраза - одно слово
            prevWordCount := len(strings.Fields(prev.Text))
            
            shouldMerge := (gap < 800 && prevDuration < 2000) ||
                           (gap < 300) ||
                           (gap < 1000 && prevWordCount == 1)
            
            if shouldMerge {
                prev.End = phrase.End
                prev.Text = prev.Text + " " + phrase.Text
                prev.Words = append(prev.Words, phrase.Words...)
                continue
            }
        }
        
        result = append(result, phrase)
    }
    
    return result
}
```

#### Изменение 4: Добавить детекцию аномальных timestamps

```go
// fixAnomalousTimestamps корректирует аномально длинные слова
// Whisper иногда даёт слову длительность в несколько секунд
func fixAnomalousTimestamps(segments []TranscriptSegment) []TranscriptSegment {
    const maxWordDurationMs = 2000 // Слово не может длиться > 2 сек
    
    for i := range segments {
        for j := range segments[i].Words {
            word := &segments[i].Words[j]
            duration := word.End - word.Start
            
            if duration > maxWordDurationMs {
                // Корректируем: слово заканчивается через 500ms после начала
                // или в начале следующего слова
                newEnd := word.Start + 500
                if j+1 < len(segments[i].Words) {
                    nextStart := segments[i].Words[j+1].Start
                    if nextStart < newEnd {
                        newEnd = nextStart
                    }
                }
                log.Printf("fixAnomalousTimestamps: word '%s' duration %dms -> %dms",
                    word.Text, duration, newEnd-word.Start)
                word.End = newEnd
            }
        }
        
        // Пересчитываем границы сегмента
        if len(segments[i].Words) > 0 {
            segments[i].Start = segments[i].Words[0].Start
            segments[i].End = segments[i].Words[len(segments[i].Words)-1].End
        }
    }
    
    return segments
}
```

---

## Сценарии использования

### UC-1: Обычный диалог без перекрытий
**Вход:**
```
mic: "Привет, как дела?" (0-2000ms)
sys: "Отлично, спасибо!" (2500-4000ms)
```
**Ожидаемый результат:**
```
Вы: "Привет, как дела?"
Собеседник: "Отлично, спасибо!"
```

### UC-2: Небольшое перекрытие (погрешность timestamps)
**Вход:**
```
mic: "Так, давай-ка" (1800-3000ms)
sys: "Может быть вот это" (0-2000ms)  ← перекрытие 200ms
```
**Ожидаемый результат:**
```
Собеседник: "Может быть вот это"
Вы: "Так, давай-ка"
```
(Порядок по началу сегмента, перекрытие игнорируется)

### UC-3: Реальное перебивание
**Вход:**
```
sys: "Я думаю что нам нужно..." (0-3000ms)
mic: "Подожди!" (1500-2000ms)  ← перекрытие 1500ms
sys: "...сделать это" (3000-4000ms)
```
**Ожидаемый результат:**
```
Собеседник: "Я думаю что нам нужно..."
Вы: "Подожди!"
Собеседник: "...сделать это"
```
(Перебивание сохраняется как отдельная реплика)

### UC-4: Аномальные timestamps Whisper
**Вход:**
```
sys: "Это" (34680-40690ms)  ← 6 секунд для одного слова!
sys: "будешь показывать?" (41000-42020ms)
```
**Ожидаемый результат:**
После коррекции:
```
sys: "Это" (34680-35180ms)  ← скорректировано до 500ms
sys: "будешь показывать?" (41000-42020ms)
```

---

## Глоссарий

| Термин | Определение |
|--------|-------------|
| mic | Канал микрофона пользователя ("Вы") |
| sys | Канал системного звука ("Собеседник") |
| segment | Сегмент транскрипции от Whisper (фраза с timestamps) |
| word | Слово с точными timestamps (word-level) |
| overlap | Перекрытие по времени между сегментами |
| interleaving | Переплетение/чередование реплик разных спикеров |
| anomalous timestamp | Аномально длинный timestamp (слово > 2 сек) |

---

## Качественные атрибуты

### Корректность
- Порядок реплик должен соответствовать реальному диалогу в 95%+ случаев
- Короткие реплики ("угу", "да") не должны теряться
- Фразы одного спикера не должны разрываться на слова

### Производительность
- Время обработки не должно увеличиться более чем на 10%
- Алгоритм O(n log n) где n - количество сегментов

### Устойчивость к ошибкам
- Корректная работа при неточности timestamps ±500ms
- Обработка аномальных timestamps (слова > 2 сек)
- Fallback на segment-level при отсутствии word-level данных

---

## Данные и интеграции

### Входные данные
- `micSegments []TranscriptSegment` - сегменты с микрофона
- `sysSegments []TranscriptSegment` - сегменты системного звука
- Каждый сегмент содержит `Words []TranscriptWord` с word-level timestamps

### Выходные данные
- `[]TranscriptSegment` - объединённый диалог в хронологическом порядке

### Точки вызова
- `UpdateChunkStereoWithSegments` (строка 309)
- `UpdateFullTranscription` (строки 1186, 1255)

---

## Ограничения и предположения

### Ограничения
1. Timestamps Whisper могут быть неточными на ±500ms
2. Аномальные timestamps (слово > 2 сек) требуют коррекции
3. Реальное перебивание (overlap > 1 сек) сложно отличить от ошибки

### Предположения
1. Mic канал всегда содержит одного спикера ("Вы")
2. Сегменты от Whisper уже сгруппированы в логические фразы
3. Слова внутри сегмента идут в правильном порядке

---

## Открытые вопросы и риски

| # | Вопрос/Риск | Приоритет | Следующее действие |
|---|-------------|-----------|-------------------|
| 1 | Как определить реальное перебивание vs ошибку timestamps? | Высокий | Использовать порог 500ms |
| 2 | Нужно ли учитывать confidence слов при коррекции? | Средний | Отложить до следующей итерации |
| 3 | Как обрабатывать случаи когда оба говорят > 2 сек? | Средний | Оставлять как перебивание |
| 4 | Влияет ли качество диаризации sys на результат? | Низкий | Мониторить в продакшене |

---

## Хэндовер для @architect и @planner

### Ключевые артефакты
1. Анализ текущего алгоритма (AS-IS) с указанием проблемных мест
2. Предложенный новый алгоритм (TO-BE) с кодом
3. Сценарии использования для тестирования
4. Новые константы и их обоснование

### Области требующие особого внимания
1. **Обратная совместимость:** Новый алгоритм должен работать и при отсутствии word-level данных
2. **Тестирование:** Нужны unit-тесты с реальными примерами проблемных диалогов
3. **Логирование:** Добавить детальное логирование для отладки

### Рекомендуемый план реализации
1. Добавить функцию `fixAnomalousTimestamps` для коррекции аномальных timestamps
2. Добавить функцию `mergeSegmentsWithOverlapHandling` для segment-level слияния
3. Обновить `mergeWordsToDialogue` для использования нового алгоритма
4. Улучшить `postProcessDialogue` с новыми условиями объединения
5. Обновить unit-тесты в `dialogue_merge_test.go`
6. Протестировать на реальных записях из проблемной сессии

### Оценка трудозатрат
- Реализация: 2-3 часа
- Тестирование: 1-2 часа
- Итого: 3-5 часов

---

## Приложение: Сравнение алгоритмов

### Текущий алгоритм (word-level)
```
Слова: [A1, B1, A2, B2, A3] (A=mic, B=sys, отсортированы по Start)
Результат: A1 | B1 | A2 | B2 | A3 (5 фраз - "шахматы")
```

### Новый алгоритм (segment-level)
```
Сегменты: [A(A1,A2,A3), B(B1,B2)] (отсортированы по Start сегмента)
Результат: A: "A1 A2 A3" | B: "B1 B2" (2 фразы - естественный диалог)
```
