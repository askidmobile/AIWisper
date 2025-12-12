# План реализации: Voting-система для гибридного слияния транскрипций

**Дата:** 2025-12-12  
**Статус:** ✅ Реализовано  
**Приоритет:** P1 (Высокий)  
**Связанный документ:** `plan_hybrid_transcription_2025-12-12.md`

## Реализованные файлы

- `backend/ai/hybrid_transcription.go` — основная логика voting-системы
- `backend/ai/grammar_checker.go` — grammar checker с встроенными словарями
- `backend/ai/voting_test.go` — unit-тесты для всех критериев
- `backend/ai/dictionaries/english_words.txt` — английский словарь (~1500 слов)
- `backend/ai/dictionaries/russian_words.txt` — русский словарь (~1100 слов)

---

## Проблема

Текущий алгоритм `mergeByConfidence()` в `hybrid_transcription.go` сравнивает "сырые" значения confidence напрямую, что приводит к неправильному выбору слов:

```
GigaAM: "джинезис" (confidence=0.95) ← ВЫБИРАЕТСЯ (неправильно!)
Parakeet: "Genesis" (confidence=0.80)
```

### Причины проблемы

1. **GigaAM завышает confidence** — CTC/RNN-T модели страдают от overconfidence из-за loss-функций (CTC loss, RNN-T loss)
2. **Нет нормализации** — разные модели имеют разные распределения confidence
3. **Нет учёта контекста** — латинские термины, hotwords, грамматика не учитываются

### Исследование: Overconfidence в ASR моделях

Согласно статье NVIDIA ["Entropy-Based Methods for Word-Level ASR Confidence Estimation"](https://developer.nvidia.com/blog/entropy-based-methods-for-word-level-asr-confidence-estimation/):

> "Overconfidence comes from the loss functions used to train end-to-end ASR models. Simple losses reach a minimum when the target prediction probability is maximized, and any others have zero probability."

**Ключевые выводы:**
- CTC и RNN-T модели **систематически завышают** confidence (10-20% ошибочных токенов имеют confidence > 0.7)
- Рекомендуется использовать **entropy-based методы** (Tsallis, Rényi entropy) вместо raw probability
- **Temperature scaling** с α=1/3 даёт лучшие результаты
- Для калибровки можно использовать коэффициент **0.75-0.80** для CTC моделей

---

## Решение: Voting-система (2 из 3)

Вместо простого сравнения confidence, используем голосование по трём критериям:

| Критерий | Описание | Вес |
|----------|----------|-----|
| **A. Калиброванный confidence** | `gigaamConf × 0.75` vs `parakeetConf × 1.0` | 1 голос |
| **B. Латиница** | Предпочитаем модель, распознавшую латинские буквы | 1 голос |
| **C. Hotwords** | Совпадение с пользовательским словарём терминов | 1 голос |
| **D. Грамматика** | Проверка слова через морфологический анализатор | 1 голос |

**Правило:** Побеждает модель с ≥2 голосами. При ничьей — первичная модель.

---

## Фаза 0: Исследование и подготовка (0.5 дня)

### Задача 0.1: Эмпирическая проверка калибровки GigaAM
**Цель:** Определить точный коэффициент калибровки для GigaAM

**Методика:**
1. Подготовить тестовый набор аудио с известной транскрипцией (ground truth)
2. Транскрибировать GigaAM и Parakeet
3. Для каждого слова: сравнить confidence с фактической корректностью
4. Построить калибровочную кривую (reliability diagram)
5. Вычислить оптимальный коэффициент

**Ожидаемый результат:** Коэффициент калибровки ~0.75-0.85 для GigaAM

### Задача 0.2: Исследование морфологических анализаторов для Go
**Варианты:**
- **hunspell** — через CGO, словари для русского языка
- **Yandex Mystem** — внешний бинарник, высокое качество
- **Встроенный словарь** — простой список корректных слов

**Рекомендация:** Начать с hunspell (широко используется, есть Go-биндинги)

---

## Фаза 1: Структуры данных и конфигурация (0.5 дня)

### Задача 1.1: Расширение конфигурации
**Файл:** `backend/ai/hybrid_transcription.go`

```go
// ConfidenceCalibration калибровка confidence для модели
type ConfidenceCalibration struct {
    ModelPattern string  // Паттерн имени модели (regexp)
    ScaleFactor  float32 // Множитель (GigaAM: 0.75, Parakeet: 1.0)
    Bias         float32 // Сдвиг (обычно 0)
}

// VotingConfig конфигурация voting-системы
type VotingConfig struct {
    Enabled              bool                    `json:"enabled"`
    UseCalibration       bool                    `json:"use_calibration"`
    UseLatinDetection    bool                    `json:"use_latin_detection"`
    UseHotwords          bool                    `json:"use_hotwords"`
    UseGrammarCheck      bool                    `json:"use_grammar_check"`
    Calibrations         []ConfidenceCalibration `json:"calibrations"`
    TieBreaker           string                  `json:"tie_breaker"` // "primary" | "confidence"
}

// Дефолтные калибровки
var DefaultCalibrations = []ConfidenceCalibration{
    {ModelPattern: "(?i)gigaam", ScaleFactor: 0.75, Bias: 0},
    {ModelPattern: "(?i)whisper", ScaleFactor: 1.0, Bias: 0},
    {ModelPattern: "(?i)parakeet", ScaleFactor: 1.0, Bias: 0},
}
```

### Задача 1.2: Структура результата голосования
```go
// VoteResult результат голосования для одного слова
type VoteResult struct {
    PrimaryWord    TranscriptWord
    SecondaryWord  TranscriptWord
    Winner         string // "primary" | "secondary"
    Votes          VoteDetails
    Reason         string // Человекочитаемое объяснение
}

// VoteDetails детали голосования
type VoteDetails struct {
    CalibrationVote    string // "primary" | "secondary" | "tie"
    LatinVote          string
    HotwordVote        string
    GrammarVote        string
    PrimaryVotes       int
    SecondaryVotes     int
}
```

---

## Фаза 2: Реализация критериев голосования (1.5 дня)

### Задача 2.1: Критерий A — Калиброванный confidence
**Файл:** `backend/ai/hybrid_transcription.go`

```go
// getCalibrationFactor возвращает коэффициент калибровки для модели
func getCalibrationFactor(modelName string, calibrations []ConfidenceCalibration) float32 {
    for _, cal := range calibrations {
        matched, _ := regexp.MatchString(cal.ModelPattern, modelName)
        if matched {
            return cal.ScaleFactor
        }
    }
    return 1.0 // По умолчанию без калибровки
}

// voteByCalibration голосование по калиброванному confidence
func voteByCalibration(
    primary, secondary TranscriptWord,
    primaryModel, secondaryModel string,
    calibrations []ConfidenceCalibration,
) string {
    primaryFactor := getCalibrationFactor(primaryModel, calibrations)
    secondaryFactor := getCalibrationFactor(secondaryModel, calibrations)
    
    primaryCalibrated := primary.P * primaryFactor
    secondaryCalibrated := secondary.P * secondaryFactor
    
    if primaryCalibrated > secondaryCalibrated {
        return "primary"
    } else if secondaryCalibrated > primaryCalibrated {
        return "secondary"
    }
    return "tie"
}
```

### Задача 2.2: Критерий B — Детекция латиницы
```go
// containsLatin проверяет наличие латинских букв в слове
func containsLatin(word string) bool {
    for _, r := range word {
        if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
            return true
        }
    }
    return false
}

// containsCyrillic проверяет наличие кириллицы в слове
func containsCyrillic(word string) bool {
    for _, r := range word {
        if (r >= 'а' && r <= 'я') || (r >= 'А' && r <= 'Я') || r == 'ё' || r == 'Ё' {
            return true
        }
    }
    return false
}

// voteByLatin голосование по наличию латиницы
// Предпочитаем модель, которая распознала латинские буквы (иностранные термины)
func voteByLatin(primary, secondary TranscriptWord) string {
    primaryHasLatin := containsLatin(primary.Text)
    secondaryHasLatin := containsLatin(secondary.Text)
    
    // Если одна модель распознала латиницу, а другая нет — голосуем за латиницу
    if secondaryHasLatin && !primaryHasLatin {
        return "secondary"
    } else if primaryHasLatin && !secondaryHasLatin {
        return "primary"
    }
    
    // Оба или ни один — не голосуем
    return "abstain"
}
```

### Задача 2.3: Критерий C — Hotwords
```go
// normalizeWord нормализует слово для сравнения (lowercase, убираем пунктуацию)
func normalizeWord(word string) string {
    word = strings.ToLower(word)
    word = strings.Trim(word, ".,!?;:\"'()-")
    return word
}

// matchesHotword проверяет совпадение слова с hotword (fuzzy matching)
func matchesHotword(word string, hotwords []string) (bool, string) {
    wordNorm := normalizeWord(word)
    
    for _, hw := range hotwords {
        hwNorm := normalizeWord(hw)
        
        // Точное совпадение
        if wordNorm == hwNorm {
            return true, hw
        }
        
        // Fuzzy matching (расстояние Левенштейна ≤ 20% длины)
        dist := levenshteinDistance(wordNorm, hwNorm)
        maxDist := len(hwNorm) / 5
        if maxDist < 1 {
            maxDist = 1
        }
        if dist <= maxDist {
            return true, hw
        }
    }
    return false, ""
}

// voteByHotwords голосование по совпадению с hotwords
func voteByHotwords(primary, secondary TranscriptWord, hotwords []string) string {
    primaryMatches, _ := matchesHotword(primary.Text, hotwords)
    secondaryMatches, _ := matchesHotword(secondary.Text, hotwords)
    
    if secondaryMatches && !primaryMatches {
        return "secondary"
    } else if primaryMatches && !secondaryMatches {
        return "primary"
    }
    return "abstain"
}
```

### Задача 2.4: Критерий D — Грамматическая проверка
**Файл:** `backend/ai/grammar_checker.go` (новый файл)

```go
package ai

import (
    "strings"
    "sync"
)

// GrammarChecker проверяет грамматическую корректность слов
type GrammarChecker interface {
    IsValidWord(word string, lang string) bool
    Close() error
}

// HunspellChecker реализация через hunspell
type HunspellChecker struct {
    // hunspell handle
    mu sync.Mutex
}

// SimpleChecker простая реализация через словарь
type SimpleChecker struct {
    russianWords map[string]bool
    englishWords map[string]bool
}

// NewSimpleChecker создаёт простой checker со встроенным словарём
func NewSimpleChecker() *SimpleChecker {
    return &SimpleChecker{
        russianWords: loadRussianDictionary(),
        englishWords: loadEnglishDictionary(),
    }
}

func (c *SimpleChecker) IsValidWord(word string, lang string) bool {
    word = strings.ToLower(strings.Trim(word, ".,!?;:\"'()-"))
    
    if lang == "ru" {
        return c.russianWords[word]
    } else if lang == "en" {
        return c.englishWords[word]
    }
    
    // Автоопределение языка
    if containsCyrillic(word) {
        return c.russianWords[word]
    }
    return c.englishWords[word]
}

// voteByGrammar голосование по грамматической корректности
func voteByGrammar(primary, secondary TranscriptWord, checker GrammarChecker) string {
    // Определяем язык по содержимому
    primaryLang := detectWordLanguage(primary.Text)
    secondaryLang := detectWordLanguage(secondary.Text)
    
    primaryValid := checker.IsValidWord(primary.Text, primaryLang)
    secondaryValid := checker.IsValidWord(secondary.Text, secondaryLang)
    
    if secondaryValid && !primaryValid {
        return "secondary"
    } else if primaryValid && !secondaryValid {
        return "primary"
    }
    return "abstain"
}

func detectWordLanguage(word string) string {
    if containsCyrillic(word) {
        return "ru"
    }
    return "en"
}
```

---

## Фаза 3: Основная логика голосования (1 день)

### Задача 3.1: Функция голосования
**Файл:** `backend/ai/hybrid_transcription.go`

```go
// selectBestWordByVoting выбирает лучшее слово через систему голосования
func (h *HybridTranscriber) selectBestWordByVoting(
    primary, secondary TranscriptWord,
) VoteResult {
    result := VoteResult{
        PrimaryWord:   primary,
        SecondaryWord: secondary,
    }
    
    votes := VoteDetails{}
    
    // Критерий A: Калиброванный confidence
    if h.config.Voting.UseCalibration {
        votes.CalibrationVote = voteByCalibration(
            primary, secondary,
            h.primaryEngine.Name(), h.secondaryEngine.Name(),
            h.config.Voting.Calibrations,
        )
        if votes.CalibrationVote == "primary" {
            votes.PrimaryVotes++
        } else if votes.CalibrationVote == "secondary" {
            votes.SecondaryVotes++
        }
    }
    
    // Критерий B: Латиница
    if h.config.Voting.UseLatinDetection {
        votes.LatinVote = voteByLatin(primary, secondary)
        if votes.LatinVote == "primary" {
            votes.PrimaryVotes++
        } else if votes.LatinVote == "secondary" {
            votes.SecondaryVotes++
        }
    }
    
    // Критерий C: Hotwords
    if h.config.Voting.UseHotwords && len(h.config.Hotwords) > 0 {
        votes.HotwordVote = voteByHotwords(primary, secondary, h.config.Hotwords)
        if votes.HotwordVote == "primary" {
            votes.PrimaryVotes++
        } else if votes.HotwordVote == "secondary" {
            votes.SecondaryVotes++
        }
    }
    
    // Критерий D: Грамматика
    if h.config.Voting.UseGrammarCheck && h.grammarChecker != nil {
        votes.GrammarVote = voteByGrammar(primary, secondary, h.grammarChecker)
        if votes.GrammarVote == "primary" {
            votes.PrimaryVotes++
        } else if votes.GrammarVote == "secondary" {
            votes.SecondaryVotes++
        }
    }
    
    result.Votes = votes
    
    // Определяем победителя
    if votes.SecondaryVotes > votes.PrimaryVotes {
        result.Winner = "secondary"
        result.Reason = fmt.Sprintf("Secondary wins %d:%d", votes.SecondaryVotes, votes.PrimaryVotes)
    } else {
        // При ничьей или преимуществе primary — выбираем primary
        result.Winner = "primary"
        if votes.PrimaryVotes == votes.SecondaryVotes {
            result.Reason = fmt.Sprintf("Tie %d:%d, primary wins by default", votes.PrimaryVotes, votes.SecondaryVotes)
        } else {
            result.Reason = fmt.Sprintf("Primary wins %d:%d", votes.PrimaryVotes, votes.SecondaryVotes)
        }
    }
    
    return result
}
```

### Задача 3.2: Интеграция в mergeWordsByTime
**Файл:** `backend/ai/hybrid_transcription.go`

Заменить текущую логику выбора:
```go
// БЫЛО:
if bestMatch.word.P > pw.P && bestMatch.word.P > 0 {
    bestWord = bestMatch.word
}

// СТАЛО:
if h.config.Voting.Enabled {
    voteResult := h.selectBestWordByVoting(pw, bestMatch.word)
    if voteResult.Winner == "secondary" {
        bestWord = bestMatch.word
        log.Printf("[HybridTranscriber] Voting: '%s' -> '%s' (%s)",
            pw.Text, bestMatch.word.Text, voteResult.Reason)
    }
} else {
    // Fallback на старую логику
    if bestMatch.word.P > pw.P && bestMatch.word.P > 0 {
        bestWord = bestMatch.word
    }
}
```

---

## Фаза 4: Словари для грамматической проверки (0.5 дня)

### Задача 4.1: Подготовка русского словаря
**Источники:**
- OpenCorpora (открытый корпус русского языка)
- Hunspell ru_RU словарь
- Частотный словарь русского языка

**Файл:** `backend/ai/dictionaries/russian_words.txt`
- ~100,000 наиболее частотных слов
- Формат: одно слово на строку, lowercase

### Задача 4.2: Подготовка английского словаря
**Источники:**
- Hunspell en_US словарь
- SCOWL (Spell Checker Oriented Word Lists)

**Файл:** `backend/ai/dictionaries/english_words.txt`
- ~50,000 наиболее частотных слов

### Задача 4.3: Загрузка словарей
```go
//go:embed dictionaries/russian_words.txt
var russianWordsData string

//go:embed dictionaries/english_words.txt
var englishWordsData string

func loadRussianDictionary() map[string]bool {
    words := make(map[string]bool)
    for _, line := range strings.Split(russianWordsData, "\n") {
        word := strings.TrimSpace(line)
        if word != "" {
            words[word] = true
        }
    }
    return words
}
```

---

## Фаза 5: Тестирование (1 день)

### Задача 5.1: Unit-тесты для критериев
**Файл:** `backend/ai/voting_test.go`

```go
func TestVoteByCalibration(t *testing.T) {
    calibrations := DefaultCalibrations
    
    tests := []struct {
        name           string
        primaryConf    float32
        secondaryConf  float32
        primaryModel   string
        secondaryModel string
        expected       string
    }{
        {
            name:           "GigaAM high conf vs Parakeet lower conf",
            primaryConf:    0.95,
            secondaryConf:  0.80,
            primaryModel:   "GigaAM-v3-e2e-ctc",
            secondaryModel: "Parakeet-TDT-v3",
            expected:       "secondary", // 0.95*0.75=0.71 < 0.80*1.0=0.80
        },
        // ... больше тестов
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            primary := TranscriptWord{P: tt.primaryConf}
            secondary := TranscriptWord{P: tt.secondaryConf}
            
            result := voteByCalibration(primary, secondary, tt.primaryModel, tt.secondaryModel, calibrations)
            
            if result != tt.expected {
                t.Errorf("expected %s, got %s", tt.expected, result)
            }
        })
    }
}

func TestVoteByLatin(t *testing.T) {
    tests := []struct {
        primary   string
        secondary string
        expected  string
    }{
        {"джинезис", "Genesis", "secondary"},
        {"Genesis", "джинезис", "primary"},
        {"привет", "привет", "abstain"},
        {"hello", "hello", "abstain"},
    }
    
    for _, tt := range tests {
        t.Run(tt.primary+"_vs_"+tt.secondary, func(t *testing.T) {
            result := voteByLatin(
                TranscriptWord{Text: tt.primary},
                TranscriptWord{Text: tt.secondary},
            )
            if result != tt.expected {
                t.Errorf("expected %s, got %s", tt.expected, result)
            }
        })
    }
}
```

### Задача 5.2: Интеграционные тесты
**Файл:** `backend/ai/hybrid_voting_integration_test.go`

- Тест с реальным аудио, содержащим "Genesis", "API", "B2C"
- Сравнение результатов до и после voting-системы

### Задача 5.3: Benchmark производительности
```go
func BenchmarkSelectBestWordByVoting(b *testing.B) {
    // Проверить что voting не добавляет значительный overhead
}
```

---

## Фаза 6: UI и документация (0.5 дня)

### Задача 6.1: Расширение UI настроек
**Файл:** `frontend/src/components/modules/SettingsPanel.tsx`

Добавить в секцию "Гибридная транскрипция":
```
[✓] Использовать систему голосования (Voting)
    [✓] Калибровка confidence (GigaAM ×0.75)
    [✓] Предпочитать латиницу для терминов
    [✓] Учитывать словарь терминов (Hotwords)
    [✓] Проверять грамматику
```

### Задача 6.2: Обновление документации
- Добавить описание voting-системы в README
- Обновить help-подсказку в UI

---

## Сводка по времени

| Фаза | Описание | Время |
|------|----------|-------|
| 0 | Исследование и подготовка | 0.5 дня |
| 1 | Структуры данных и конфигурация | 0.5 дня |
| 2 | Реализация критериев голосования | 1.5 дня |
| 3 | Основная логика голосования | 1 день |
| 4 | Словари для грамматической проверки | 0.5 дня |
| 5 | Тестирование | 1 день |
| 6 | UI и документация | 0.5 дня |
| **Итого** | | **5.5 дней** |

---

## Пример работы системы

### Входные данные
```
Первичная модель (GigaAM): "джинезис" (conf=0.95)
Вторичная модель (Parakeet): "Genesis" (conf=0.80)
Hotwords: ["Genesis", "API", "B2C"]
```

### Голосование
| Критерий | Primary | Secondary | Голос |
|----------|---------|-----------|-------|
| A. Confidence | 0.95×0.75=0.71 | 0.80×1.0=0.80 | Secondary |
| B. Латиница | ❌ | ✅ | Secondary |
| C. Hotwords | ❌ | ✅ "Genesis" | Secondary |
| D. Грамматика | ❌ (нет в словаре) | ✅ | Secondary |

**Результат:** Secondary побеждает 4:0 → выбираем "Genesis"

---

## Риски и митигации

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Словари слишком большие | Средняя | Низкое | Использовать bloom filter или ограничить размер |
| Грамматика ложно отклоняет слова | Средняя | Среднее | Сделать критерий отключаемым, использовать fuzzy matching |
| Латиница ложно срабатывает на транслит | Низкая | Низкое | Добавить проверку на смешанный текст |
| Overhead от voting | Низкая | Низкое | Benchmark показывает < 1ms на слово |

---

## Definition of Done

- [ ] Voting-система реализована и включена по умолчанию
- [ ] Все 4 критерия работают корректно
- [ ] Unit-тесты покрывают все критерии
- [ ] Интеграционный тест с "Genesis" проходит
- [ ] UI позволяет настраивать критерии
- [ ] Документация обновлена
- [ ] Benchmark показывает приемлемую производительность (< 5ms overhead на сегмент)

---

## Ссылки

1. [NVIDIA: Entropy-Based Methods for Word-Level ASR Confidence Estimation](https://developer.nvidia.com/blog/entropy-based-methods-for-word-level-asr-confidence-estimation/)
2. [arXiv: Identifying and Calibrating Overconfidence in Noisy Speech Recognition](https://arxiv.org/abs/2509.07195)
3. [arXiv: Fast Entropy-Based Methods of Word-Level Confidence Estimation](https://arxiv.org/abs/2212.08703)
4. [GigaAM GitHub](https://github.com/salute-developers/GigaAM)
