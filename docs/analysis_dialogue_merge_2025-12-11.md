# Системный анализ: Проблемы слияния mic/sys сегментов в диалог

**Дата:** 2025-12-11 14:30
**Статус:** Completed
**Аналитик:** @analyst

---

## Контекст и стейкхолдеры

### Проблема
При слиянии mic (микрофон пользователя) и sys (системный звук/собеседник) сегментов в диалог теряется правильная последовательность реплик.

### Пример проблемы
- **Эталон:** "Собеседник 2: Может быть..." → "Вы: Так, давай-ка..." → "Собеседник 2: Будешь что-то показывать?" → "Вы: угу" → "Вы: Во-первых..." → "Собеседник 2: По-моему, да"
- **Результат:** "Собеседник 1: Может быть... Это будешь показывать?" (склеено) → "Вы: Так, давай-ка... Во-первых" → "Собеседник 1: По-моему" → "Вы: Да, вот ты красавчик..."

### Симптомы
1. Короткие реплики ("угу") теряются
2. Реплики собеседника склеиваются в одну длинную
3. Порядок нарушается из-за неточных timestamps (±1-2 секунды)

---

## AS-IS (как сейчас)

### Текущий алгоритм (файл: `backend/session/manager.go`)

#### 1. `mergeSegmentsToDialogue` (строки 379-425)
- Точка входа для слияния
- Проверяет наличие word-level данных
- Если есть words → вызывает `mergeWordsToDialogue`
- Иначе → группировка сегментов через `groupSegmentsToPhrases` + простая сортировка

#### 2. `mergeWordsToDialogue` (строки 489-505)
- Собирает слова из mic и sys сегментов через `collectWords` **ОТДЕЛЬНО**
- Группирует в фразы через `groupWordsToPhrases` **ОТДЕЛЬНО для каждого канала**
- Объединяет через `interleaveDialogue`

#### 3. `groupWordsToPhrases` (строки 600-687)
- Сортирует слова по времени
- Группирует по паузам (`maxPauseMs=2000`) и смене спикера
- Разбивает длинные фразы (>10 сек)
- Использует `minPhraseDurationMs=1000` для фильтрации

#### 4. `interleaveDialogue` (строки 507-570)
- Объединяет mic и sys фразы в один список
- Сортирует по времени начала (mic первым при равенстве)
- Обрезает перекрывающиеся фразы разных спикеров

### Константы (строки 592-598)
```go
const (
    defaultMaxPauseMs   = 2000  // Пауза для разделения фраз (2 сек)
    maxPhraseDurationMs = 10000 // Максимальная длина фразы (10 сек)
    minPhraseDurationMs = 1000  // Минимальная длина фразы (1 сек)
    shortPauseMs        = 300   // Короткая пауза для поиска точки разбиения
)
```

### Выявленные проблемы

#### Проблема 1: Раздельная группировка каналов
**Корень:** Алгоритм сначала группирует слова КАЖДОГО канала отдельно (`groupWordsToPhrases` вызывается для mic и sys отдельно), а потом пытается их "переплести".

**Последствие:** Если между репликами собеседника была короткая реплика mic, но timestamps неточные (±1-2 сек), реплики собеседника склеятся в одну фразу, потому что при группировке sys канала алгоритм не знает о существовании mic реплики между ними.

#### Проблема 2: Потеря коротких реплик
**Корень:** `minPhraseDurationMs = 1000` (1 секунда) используется в `interleaveDialogue` (строка 545):
```go
if phrase.Start > prev.Start+minPhraseDurationMs {
    // Обрезаем предыдущую только если остаётся достаточная длина
    prev.End = phrase.Start
```

**Последствие:** Короткие реплики типа "угу", "да", "ага" (длительность ~300-500мс) могут быть "поглощены" при обрезке перекрывающихся фраз.

#### Проблема 3: Неточная сортировка
**Корень:** Сортировка только по `Start` времени без учёта контекста:
```go
sort.Slice(allPhrases, func(i, j int) bool {
    if allPhrases[i].Start == allPhrases[j].Start {
        return allPhrases[i].Speaker == "mic"
    }
    return allPhrases[i].Start < allPhrases[j].Start
})
```

**Последствие:** При неточности timestamps ±1-2 сек порядок может быть неверным. Нет учёта логики диалога (вопрос-ответ).

#### Проблема 4: Слишком большой порог паузы
**Корень:** `defaultMaxPauseMs = 2000` (2 секунды) - слишком много для естественного диалога.

**Последствие:** Реплики одного спикера с паузой до 2 секунд склеиваются, даже если между ними была реплика другого спикера.

---

## TO-BE (как должно быть)

### Новый алгоритм: "Event-based interleaving" (событийное переплетение)

#### Принцип
Объединить ВСЕ слова из обоих каналов в единый поток и группировать их с учётом смены спикера как главного критерия.

#### Новые константы
```go
const (
    speakerSwitchToleranceMs = 500   // Толерантность к неточности timestamps при смене спикера
    minPauseBetweenPhrasesMs = 800   // Минимальная пауза для разделения фраз одного спикера
    maxOverlapMs             = 1500  // Максимальное перекрытие для "одновременной речи"
    minWordsInPhrase         = 1     // Минимум слов в фразе (не фильтруем короткие!)
)
```

#### Новая функция `mergeWordsToDialogueV2`
```go
func mergeWordsToDialogueV2(micSegments, sysSegments []TranscriptSegment) []TranscriptSegment {
    // 1. Собираем ВСЕ слова в единый поток
    allWords := collectAllWords(micSegments, sysSegments)
    
    if len(allWords) == 0 {
        return nil
    }
    
    // 2. Сортируем по времени начала
    sort.Slice(allWords, func(i, j int) bool {
        if allWords[i].Start == allWords[j].Start {
            // При равном времени - mic первым (инициатор диалога)
            return allWords[i].Speaker == "mic"
        }
        return allWords[i].Start < allWords[j].Start
    })
    
    // 3. Группируем в фразы с учётом смены спикера
    phrases := groupWordsToDialogueV2(allWords)
    
    // 4. Постобработка: объединение соседних коротких фраз одного спикера
    phrases = postProcessDialogue(phrases)
    
    return phrases
}
```

#### Новая функция `collectAllWords`
```go
func collectAllWords(micSegments, sysSegments []TranscriptSegment) []TranscriptWord {
    var words []TranscriptWord
    
    // Собираем слова из mic
    for _, seg := range micSegments {
        speaker := seg.Speaker
        if speaker == "" {
            speaker = "mic"
        }
        for _, w := range seg.Words {
            word := w
            if word.Speaker == "" {
                word.Speaker = speaker
            }
            words = append(words, word)
        }
    }
    
    // Собираем слова из sys
    for _, seg := range sysSegments {
        speaker := seg.Speaker
        if speaker == "" {
            speaker = "sys"
        }
        for _, w := range seg.Words {
            word := w
            if word.Speaker == "" {
                word.Speaker = speaker
            }
            words = append(words, word)
        }
    }
    
    return words
}
```

#### Новая функция `groupWordsToDialogueV2`
```go
func groupWordsToDialogueV2(words []TranscriptWord) []TranscriptSegment {
    if len(words) == 0 {
        return nil
    }
    
    var phrases []TranscriptSegment
    var currentPhrase TranscriptSegment
    var currentWords []TranscriptWord
    var phraseTexts []string
    
    finishPhrase := func() {
        if len(phraseTexts) > 0 {
            currentPhrase.Text = strings.Join(phraseTexts, " ")
            currentPhrase.Words = currentWords
            phrases = append(phrases, currentPhrase)
        }
    }
    
    startNewPhrase := func(word TranscriptWord) {
        currentPhrase = TranscriptSegment{
            Start:   word.Start,
            End:     word.End,
            Speaker: word.Speaker,
        }
        phraseTexts = []string{word.Text}
        currentWords = []TranscriptWord{word}
    }
    
    for i, word := range words {
        if i == 0 {
            startNewPhrase(word)
            continue
        }
        
        prevWord := words[i-1]
        
        // Условие 1: Смена спикера = новая фраза
        if word.Speaker != currentPhrase.Speaker {
            // Проверяем перекрытие
            overlap := prevWord.End - word.Start
            
            if overlap > maxOverlapMs {
                // Сильное перекрытие - возможно ошибка timestamps
                // Игнорируем это слово (или добавляем в буфер)
                log.Printf("groupWordsToDialogueV2: ignoring word due to overlap %dms: %s", overlap, word.Text)
                continue
            }
            
            // Реальная смена спикера
            finishPhrase()
            startNewPhrase(word)
            continue
        }
        
        // Условие 2: Большая пауза между словами одного спикера
        pause := word.Start - prevWord.End
        if pause > minPauseBetweenPhrasesMs {
            // Проверяем: был ли между ними другой спикер?
            // Ищем слова другого спикера в этом промежутке
            hasOtherSpeaker := false
            for j := i - 1; j >= 0 && words[j].End > prevWord.End-speakerSwitchToleranceMs; j-- {
                if words[j].Speaker != currentPhrase.Speaker && 
                   words[j].Start >= prevWord.End-speakerSwitchToleranceMs &&
                   words[j].End <= word.Start+speakerSwitchToleranceMs {
                    hasOtherSpeaker = true
                    break
                }
            }
            
            // Если была реплика другого спикера или пауза > 2 сек - новая фраза
            if hasOtherSpeaker || pause > 2000 {
                finishPhrase()
                startNewPhrase(word)
                continue
            }
        }
        
        // Продолжаем текущую фразу
        currentPhrase.End = word.End
        phraseTexts = append(phraseTexts, word.Text)
        currentWords = append(currentWords, word)
    }
    
    // Завершаем последнюю фразу
    finishPhrase()
    
    return phrases
}
```

#### Новая функция `postProcessDialogue`
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
        
        // Объединяем соседние короткие фразы одного спикера
        if prev.Speaker == phrase.Speaker {
            gap := phrase.Start - prev.End
            prevWordCount := len(strings.Fields(prev.Text))
            
            // Объединяем если:
            // - пауза < 500мс И предыдущая фраза короткая (< 3 слов)
            // - ИЛИ пауза < 200мс (очень короткая пауза)
            if (gap < 500 && prevWordCount < 3) || gap < 200 {
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

---

## Сценарии использования

### UC-1: Обычный диалог с чередованием
**Вход:**
- mic: "Так, давай-ка посмотрим" (0-2000ms)
- sys: "Может быть вот это?" (1800-4000ms)
- mic: "угу" (4200-4500ms)
- sys: "Будешь показывать?" (4600-6000ms)

**Ожидаемый результат:**
1. Вы: "Так, давай-ка посмотрим"
2. Собеседник: "Может быть вот это?"
3. Вы: "угу"
4. Собеседник: "Будешь показывать?"

### UC-2: Перекрывающаяся речь
**Вход:**
- mic: "Да, вот именно" (0-1500ms)
- sys: "Понял, сейчас" (1200-2500ms) - перекрытие 300ms

**Ожидаемый результат:**
1. Вы: "Да, вот именно"
2. Собеседник: "Понял, сейчас"

### UC-3: Неточные timestamps
**Вход:**
- sys: "Первая фраза" (0-2000ms)
- mic: "Ответ" (1800-3000ms) - timestamps сдвинуты на 200ms раньше
- sys: "Вторая фраза" (3200-5000ms)

**Ожидаемый результат:**
1. Собеседник: "Первая фраза"
2. Вы: "Ответ"
3. Собеседник: "Вторая фраза"

(НЕ склеивать "Первая фраза" и "Вторая фраза" в одну!)

---

## Глоссарий

| Термин | Определение |
|--------|-------------|
| mic | Канал микрофона пользователя ("Вы") |
| sys | Канал системного звука ("Собеседник") |
| segment | Сегмент транскрипции с timestamps (start, end, text, speaker) |
| word | Слово с точными timestamps (word-level) |
| phrase | Логическая фраза/реплика в диалоге |
| interleaving | Переплетение/чередование реплик разных спикеров |
| overlap | Перекрытие по времени между сегментами |

---

## Качественные атрибуты (черновик)

### Корректность
- Порядок реплик должен соответствовать реальному диалогу в 95%+ случаев
- Короткие реплики (< 1 сек) не должны теряться

### Производительность
- Время обработки не должно увеличиться более чем на 20%
- Алгоритм должен работать за O(n log n) где n - количество слов

### Устойчивость к ошибкам
- Алгоритм должен корректно работать при неточности timestamps ±2 секунды
- При отсутствии word-level данных должен использоваться fallback на segment-level

---

## Данные и интеграции

### Входные данные
- `micSegments []TranscriptSegment` - сегменты с микрофона
- `sysSegments []TranscriptSegment` - сегменты системного звука
- Каждый сегмент содержит `Words []TranscriptWord` с word-level timestamps

### Выходные данные
- `[]TranscriptSegment` - объединённый диалог в хронологическом порядке

### Зависимости
- Функция вызывается из `UpdateChunkStereoWithSegments` и `UpdateFullTranscription`
- Результат сохраняется в `chunk.Dialogue`

---

## Ограничения и предположения

### Ограничения
1. Timestamps могут быть неточными на ±1-2 секунды
2. Word-level данные могут отсутствовать (fallback на segment-level)
3. Диаризация sys канала может давать несколько спикеров

### Предположения
1. Mic канал всегда содержит одного спикера ("Вы")
2. Слова внутри одного сегмента идут в правильном порядке
3. Перекрытие речи > 1.5 сек - скорее всего ошибка timestamps

---

## Открытые вопросы и риски

| # | Вопрос/Риск | Приоритет | Следующее действие |
|---|-------------|-----------|-------------------|
| 1 | Как обрабатывать случаи когда оба говорят одновременно > 1.5 сек? | Средний | Тестирование на реальных данных |
| 2 | Нужно ли учитывать пунктуацию (вопросы) для определения порядка? | Низкий | Отложить до следующей итерации |
| 3 | Как влияет качество диаризации sys канала на результат? | Высокий | Проверить с разными моделями диаризации |

---

## Хэндовер для @architect и @planner

### Ключевые артефакты
1. Анализ текущего алгоритма (AS-IS)
2. Предложенный новый алгоритм (TO-BE) с кодом
3. Сценарии использования для тестирования
4. Новые константы и их обоснование

### Области требующие особого внимания
1. **Обратная совместимость:** Новый алгоритм должен работать и при отсутствии word-level данных
2. **Тестирование:** Нужны unit-тесты с реальными примерами проблемных диалогов
3. **Логирование:** Добавить детальное логирование для отладки проблем с порядком

### Рекомендуемый план реализации
1. Добавить новые функции (`mergeWordsToDialogueV2`, `collectAllWords`, `groupWordsToDialogueV2`, `postProcessDialogue`)
2. Заменить вызов `mergeWordsToDialogue` на `mergeWordsToDialogueV2` в `mergeSegmentsToDialogue`
3. Обновить константы
4. Написать unit-тесты
5. Протестировать на реальных записях
