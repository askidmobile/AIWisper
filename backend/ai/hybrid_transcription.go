// Package ai предоставляет гибридную транскрипцию с использованием двух моделей
package ai

import (
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
)

// HybridMode режим гибридной транскрипции
type HybridMode string

const (
	// HybridModeConfidence - перетранскрибировать только слова с низким confidence
	// Проблема: GigaAM даёт высокий confidence даже для ошибок
	HybridModeConfidence HybridMode = "confidence"

	// HybridModeFullCompare - транскрибировать обеими моделями и сравнивать
	// LLM выбирает лучший вариант для каждого сегмента
	HybridModeFullCompare HybridMode = "full_compare"

	// HybridModeParallel - параллельная транскрипция обеими моделями
	// Собственный анализатор выбирает лучшие слова на основе confidence
	// Быстрее чем full_compare, не требует LLM
	HybridModeParallel HybridMode = "parallel"
)

// HybridTranscriptionConfig конфигурация гибридной транскрипции
type HybridTranscriptionConfig struct {
	Enabled             bool         // Включена ли гибридная транскрипция
	SecondaryModelID    string       // ID дополнительной модели
	ConfidenceThreshold float32      // Порог уверенности (0.0 - 1.0)
	ContextWords        int          // Количество слов контекста вокруг проблемного слова
	UseLLMForMerge      bool         // Использовать LLM для выбора лучшего варианта
	Mode                HybridMode   // Режим работы: confidence, full_compare или parallel
	OllamaModel         string       // Модель Ollama для LLM
	OllamaURL           string       // URL Ollama API
	Hotwords            []string     // Словарь подсказок для моделей (термины, имена)
	Voting              VotingConfig // Конфигурация voting-системы
}

// VotingConfig конфигурация системы голосования для выбора лучшего слова
type VotingConfig struct {
	Enabled           bool                    `json:"enabled"`             // Включена ли voting-система
	UseCalibration    bool                    `json:"use_calibration"`     // Критерий A: калиброванный confidence
	UseLatinDetection bool                    `json:"use_latin_detection"` // Критерий B: предпочитать латиницу
	UseHotwords       bool                    `json:"use_hotwords"`        // Критерий C: совпадение с hotwords
	UseGrammarCheck   bool                    `json:"use_grammar_check"`   // Критерий D: грамматическая проверка
	Calibrations      []ConfidenceCalibration `json:"calibrations"`        // Коэффициенты калибровки по моделям
	GrammarDictPath   string                  `json:"grammar_dict_path"`   // Путь к словарю для грамматики
}

// ConfidenceCalibration калибровка confidence для конкретной модели
// CTC/RNN-T модели (GigaAM) систематически завышают confidence
// Источник: https://developer.nvidia.com/blog/entropy-based-methods-for-word-level-asr-confidence-estimation/
type ConfidenceCalibration struct {
	ModelPattern string  `json:"model_pattern"` // Regexp паттерн имени модели
	ScaleFactor  float32 `json:"scale_factor"`  // Множитель (GigaAM: 0.75, Whisper/Parakeet: 1.0)
	Bias         float32 `json:"bias"`          // Сдвиг (обычно 0)
}

// DefaultCalibrations дефолтные калибровки для известных моделей
// GigaAM завышает confidence на ~25% из-за особенностей CTC loss
var DefaultCalibrations = []ConfidenceCalibration{
	{ModelPattern: "(?i)gigaam", ScaleFactor: 0.75, Bias: 0},
	{ModelPattern: "(?i)whisper", ScaleFactor: 1.0, Bias: 0},
	{ModelPattern: "(?i)parakeet", ScaleFactor: 1.0, Bias: 0},
	{ModelPattern: "(?i)fluid", ScaleFactor: 1.0, Bias: 0},
}

// DefaultVotingConfig возвращает дефолтную конфигурацию voting-системы
func DefaultVotingConfig() VotingConfig {
	return VotingConfig{
		Enabled:           true,
		UseCalibration:    true,
		UseLatinDetection: true,
		UseHotwords:       true,
		UseGrammarCheck:   true,
		Calibrations:      DefaultCalibrations,
	}
}

// VoteResult результат голосования для одного слова
type VoteResult struct {
	PrimaryWord   TranscriptWord // Слово от первичной модели
	SecondaryWord TranscriptWord // Слово от вторичной модели
	Winner        string         // "primary" | "secondary"
	Votes         VoteDetails    // Детали голосования
	Reason        string         // Человекочитаемое объяснение
}

// VoteDetails детали голосования по каждому критерию
type VoteDetails struct {
	CalibrationVote string // "primary" | "secondary" | "tie" | "abstain"
	LatinVote       string // "primary" | "secondary" | "abstain"
	HotwordVote     string // "primary" | "secondary" | "abstain"
	GrammarVote     string // "primary" | "secondary" | "abstain"
	PrimaryVotes    int    // Общее количество голосов за primary
	SecondaryVotes  int    // Общее количество голосов за secondary
}

// LowConfidenceRegion участок с низкой уверенностью
type LowConfidenceRegion struct {
	StartMs       int64            // Начало участка в миллисекундах
	EndMs         int64            // Конец участка в миллисекундах
	Words         []TranscriptWord // Слова в участке
	AvgConfidence float32          // Средняя уверенность
	SegmentIndex  int              // Индекс сегмента
}

// HybridTranscriptionResult результат гибридной транскрипции
type HybridTranscriptionResult struct {
	Segments           []TranscriptSegment        // Финальные сегменты
	LowConfidenceCount int                        // Количество слов с низкой уверенностью
	RetranscribedCount int                        // Количество перетранскрибированных участков
	Improvements       []TranscriptionImprovement // Список улучшений
}

// TranscriptionImprovement информация об улучшении
type TranscriptionImprovement struct {
	StartMs      int64   // Начало участка
	EndMs        int64   // Конец участка
	OriginalText string  // Оригинальный текст
	ImprovedText string  // Улучшенный текст
	OriginalConf float32 // Оригинальная уверенность
	ImprovedConf float32 // Улучшенная уверенность
	Source       string  // Источник улучшения: "secondary_model" или "llm"
}

// GrammarChecker интерфейс для проверки грамматической корректности слов
type GrammarChecker interface {
	IsValidWord(word string, lang string) bool
	Close() error
}

// HybridTranscriber выполняет гибридную транскрипцию
type HybridTranscriber struct {
	primaryEngine   TranscriptionEngine
	secondaryEngine TranscriptionEngine
	config          HybridTranscriptionConfig
	llmSelector     LLMTranscriptionSelector
	grammarChecker  GrammarChecker // Опциональный grammar checker
}

// LLMTranscriptionSelector интерфейс для LLM выбора лучшей транскрипции
type LLMTranscriptionSelector interface {
	SelectBestTranscription(original, alternative string, context string) (string, error)
}

// NewHybridTranscriber создаёт новый гибридный транскрибер
func NewHybridTranscriber(
	primary TranscriptionEngine,
	secondary TranscriptionEngine,
	config HybridTranscriptionConfig,
	llmSelector LLMTranscriptionSelector,
) *HybridTranscriber {
	return &HybridTranscriber{
		primaryEngine:   primary,
		secondaryEngine: secondary,
		config:          config,
		llmSelector:     llmSelector,
	}
}

// SetGrammarChecker устанавливает grammar checker для voting-системы
func (h *HybridTranscriber) SetGrammarChecker(checker GrammarChecker) {
	h.grammarChecker = checker
}

// Transcribe выполняет гибридную транскрипцию
func (h *HybridTranscriber) Transcribe(samples []float32) (*HybridTranscriptionResult, error) {
	// Выбираем режим работы
	mode := h.config.Mode
	if mode == "" {
		mode = HybridModeParallel // По умолчанию - параллельный режим (быстрый)
	}

	switch mode {
	case HybridModeFullCompare:
		return h.transcribeFullCompare(samples)
	case HybridModeParallel:
		return h.transcribeParallel(samples)
	default:
		// Режим confidence (оригинальный)
		return h.transcribeConfidenceBased(samples)
	}
}

// GPUBackend тип GPU бэкенда для определения конфликтов
type GPUBackend int

const (
	GPUBackendNone   GPUBackend = iota // CPU only или безопасный для параллельной работы
	GPUBackendMetal                    // Apple Metal (whisper.cpp, ggml)
	GPUBackendCoreML                   // Apple CoreML/ANE (FluidAudio, Parakeet)
)

// getEngineGPUBackend определяет GPU бэкенд движка по его имени
func getEngineGPUBackend(engineName string) GPUBackend {
	switch engineName {
	case "whisper":
		return GPUBackendMetal // whisper.cpp использует Metal
	case "fluid-asr":
		return GPUBackendCoreML // FluidAudio/Parakeet использует CoreML
	case "gigaam", "gigaam-rnnt":
		// GigaAM использует ONNX Runtime - работает корректно параллельно с Metal и CoreML
		// INT8 модели работают на CPU, обычные могут использовать CoreML,
		// но ONNX Runtime корректно управляет ресурсами и не конфликтует
		return GPUBackendNone
	default:
		return GPUBackendNone
	}
}

// canRunParallel проверяет, могут ли два движка работать параллельно без конфликтов
//
// Известные конфликты на Apple Silicon:
// - Metal (Whisper/ggml) + CoreML (Parakeet/FluidAudio) = crash на уровне GPU драйвера
//
// Безопасные комбинации:
// - GigaAM (ONNX) + Whisper (Metal) = OK
// - GigaAM (ONNX) + Parakeet (CoreML) = OK
// - Whisper + Whisper = OK (mutex защитит)
// - Parakeet + Parakeet = OK (subprocess изолирован)
func canRunParallel(primary, secondary GPUBackend) bool {
	// Если хотя бы один не использует конфликтующий GPU бэкенд - можно параллельно
	if primary == GPUBackendNone || secondary == GPUBackendNone {
		return true
	}

	// Metal + CoreML = конфликт на Apple Silicon
	// Это единственная известная конфликтующая комбинация
	if (primary == GPUBackendMetal && secondary == GPUBackendCoreML) ||
		(primary == GPUBackendCoreML && secondary == GPUBackendMetal) {
		return false
	}

	// Одинаковые бэкенды - можно параллельно (внутренние mutex защитят)
	return true
}

// transcribeParallel выполняет транскрипцию обеими моделями
// Автоматически определяет, могут ли модели работать параллельно или нужно последовательно
func (h *HybridTranscriber) transcribeParallel(samples []float32) (*HybridTranscriptionResult, error) {
	if h.secondaryEngine == nil {
		// Нет вторичной модели - просто транскрибируем первичной
		segments, err := h.primaryEngine.TranscribeWithSegments(samples)
		if err != nil {
			return nil, err
		}
		return &HybridTranscriptionResult{Segments: segments}, nil
	}

	// Определяем GPU бэкенды движков
	primaryBackend := getEngineGPUBackend(h.primaryEngine.Name())
	secondaryBackend := getEngineGPUBackend(h.secondaryEngine.Name())

	// Проверяем, можно ли запускать параллельно
	parallel := canRunParallel(primaryBackend, secondaryBackend)

	var primarySegments, secondarySegments []TranscriptSegment
	var primaryErr, secondaryErr error

	if parallel {
		// Безопасно запускать параллельно
		log.Printf("[HybridTranscriber] Parallel mode: %s (%d) + %s (%d) - no GPU conflict",
			h.primaryEngine.Name(), primaryBackend, h.secondaryEngine.Name(), secondaryBackend)

		primaryChan := make(chan struct {
			segments []TranscriptSegment
			err      error
		}, 1)
		secondaryChan := make(chan struct {
			segments []TranscriptSegment
			err      error
		}, 1)

		go func() {
			log.Printf("[HybridTranscriber] Parallel: Starting primary transcription with %s", h.primaryEngine.Name())
			segs, err := h.primaryEngine.TranscribeWithSegments(samples)
			primaryChan <- struct {
				segments []TranscriptSegment
				err      error
			}{segs, err}
		}()

		go func() {
			log.Printf("[HybridTranscriber] Parallel: Starting secondary transcription with %s", h.secondaryEngine.Name())
			segs, err := h.secondaryEngine.TranscribeWithSegments(samples)
			secondaryChan <- struct {
				segments []TranscriptSegment
				err      error
			}{segs, err}
		}()

		primaryResult := <-primaryChan
		secondaryResult := <-secondaryChan

		primarySegments, primaryErr = primaryResult.segments, primaryResult.err
		secondarySegments, secondaryErr = secondaryResult.segments, secondaryResult.err

		log.Printf("[HybridTranscriber] Parallel: Primary (%s) done, err=%v", h.primaryEngine.Name(), primaryErr)
		log.Printf("[HybridTranscriber] Parallel: Secondary (%s) done, err=%v", h.secondaryEngine.Name(), secondaryErr)
	} else {
		// GPU конфликт - выполняем последовательно
		log.Printf("[HybridTranscriber] Sequential mode: %s (%d) + %s (%d) - GPU conflict detected",
			h.primaryEngine.Name(), primaryBackend, h.secondaryEngine.Name(), secondaryBackend)

		// Первичная модель
		log.Printf("[HybridTranscriber] Sequential: Starting primary transcription with %s", h.primaryEngine.Name())
		primarySegments, primaryErr = h.primaryEngine.TranscribeWithSegments(samples)
		log.Printf("[HybridTranscriber] Sequential: Primary (%s) done, err=%v", h.primaryEngine.Name(), primaryErr)

		// Вторичная модель - ПОСЛЕ завершения primary
		log.Printf("[HybridTranscriber] Sequential: Starting secondary transcription with %s", h.secondaryEngine.Name())
		secondarySegments, secondaryErr = h.secondaryEngine.TranscribeWithSegments(samples)
		log.Printf("[HybridTranscriber] Sequential: Secondary (%s) done, err=%v", h.secondaryEngine.Name(), secondaryErr)
	}

	// Если первичная модель упала - пробуем вторичную
	if primaryErr != nil {
		if secondaryErr != nil {
			return nil, fmt.Errorf("both models failed: primary: %v, secondary: %v", primaryErr, secondaryErr)
		}
		return &HybridTranscriptionResult{Segments: secondarySegments}, nil
	}

	// Если вторичная модель упала - используем первичную
	if secondaryErr != nil {
		return &HybridTranscriptionResult{Segments: primarySegments}, nil
	}

	// Обе модели отработали - анализируем и объединяем результаты
	primaryText := segmentsToFullText(primarySegments)
	secondaryText := segmentsToFullText(secondarySegments)

	log.Printf("[HybridTranscriber] Sequential: Primary text: %q", primaryText)
	log.Printf("[HybridTranscriber] Sequential: Secondary text: %q", secondaryText)

	// Если тексты идентичны - возвращаем первичный
	if primaryText == secondaryText {
		log.Printf("[HybridTranscriber] Sequential: Texts identical, using primary")
		return &HybridTranscriptionResult{Segments: primarySegments}, nil
	}

	// Анализируем и объединяем на основе confidence
	mergedSegments, improvements := h.mergeByConfidence(primarySegments, secondarySegments)

	// Применяем hotwords для исправления известных терминов
	if len(h.config.Hotwords) > 0 {
		mergedSegments = h.applyHotwords(mergedSegments, primarySegments, secondarySegments)
	}

	// Если есть LLM и он включён - дополнительно проверяем через LLM
	if h.config.UseLLMForMerge && h.llmSelector != nil && len(improvements) > 0 {
		mergedText := segmentsToFullText(mergedSegments)
		log.Printf("[HybridTranscriber] Sequential: Merged text: %q", mergedText)
		log.Printf("[HybridTranscriber] Sequential: Verifying with LLM...")

		// LLM проверяет объединённый результат
		selected, err := h.llmSelector.SelectBestTranscription(primaryText, mergedText, "")
		if err == nil && selected != primaryText && selected != mergedText {
			// LLM предложил свой вариант
			log.Printf("[HybridTranscriber] Sequential: LLM suggested: %q", selected)
			mergedSegments = []TranscriptSegment{{
				Start: 0,
				End:   int64(len(samples) * 1000 / 16000),
				Text:  selected,
			}}
		}
	}

	return &HybridTranscriptionResult{
		Segments:           mergedSegments,
		RetranscribedCount: len(improvements),
		Improvements:       improvements,
	}, nil
}

// mergeByConfidence объединяет результаты двух моделей на основе confidence слов
func (h *HybridTranscriber) mergeByConfidence(primary, secondary []TranscriptSegment) ([]TranscriptSegment, []TranscriptionImprovement) {
	var improvements []TranscriptionImprovement

	// Извлекаем слова с confidence из обеих моделей
	primaryWords := extractWordsWithConfidence(primary)
	secondaryWords := extractWordsWithConfidence(secondary)

	log.Printf("[HybridTranscriber] MergeByConfidence: primary=%d words, secondary=%d words",
		len(primaryWords), len(secondaryWords))

	// Если у одной из моделей нет слов с confidence - возвращаем ту что есть
	if len(primaryWords) == 0 {
		return secondary, nil
	}
	if len(secondaryWords) == 0 {
		return primary, nil
	}

	// Вычисляем средний confidence для каждой модели
	primaryAvgConf := calcAverageConfidence(primaryWords)
	secondaryAvgConf := calcAverageConfidence(secondaryWords)

	log.Printf("[HybridTranscriber] MergeByConfidence: primaryAvgConf=%.4f, secondaryAvgConf=%.4f",
		primaryAvgConf, secondaryAvgConf)

	// Стратегия выбора:
	// 1. Если разница в confidence > 10% - берём модель с большим confidence
	// 2. Иначе - пытаемся объединить по словам

	confDiff := primaryAvgConf - secondaryAvgConf
	if confDiff < -0.1 {
		// Вторичная модель значительно лучше
		log.Printf("[HybridTranscriber] MergeByConfidence: Secondary model significantly better (diff=%.2f)", confDiff)
		improvements = append(improvements, TranscriptionImprovement{
			OriginalText: segmentsToFullText(primary),
			ImprovedText: segmentsToFullText(secondary),
			OriginalConf: primaryAvgConf,
			ImprovedConf: secondaryAvgConf,
			Source:       "parallel_confidence",
		})
		return secondary, improvements
	} else if confDiff > 0.1 {
		// Первичная модель значительно лучше
		log.Printf("[HybridTranscriber] MergeByConfidence: Primary model significantly better (diff=%.2f)", confDiff)
		return primary, nil
	}

	// Разница небольшая - пытаемся объединить по словам
	// Выравниваем слова по времени и выбираем лучшие
	mergedSegments := h.mergeWordsByTime(primary, secondary, primaryWords, secondaryWords)

	// Проверяем были ли улучшения
	mergedText := segmentsToFullText(mergedSegments)
	primaryText := segmentsToFullText(primary)
	if mergedText != primaryText {
		improvements = append(improvements, TranscriptionImprovement{
			OriginalText: primaryText,
			ImprovedText: mergedText,
			OriginalConf: primaryAvgConf,
			ImprovedConf: secondaryAvgConf,
			Source:       "parallel_word_merge",
		})
	}

	return mergedSegments, improvements
}

// extractWordsWithConfidence извлекает все слова с confidence из сегментов
func extractWordsWithConfidence(segments []TranscriptSegment) []TranscriptWord {
	var words []TranscriptWord
	for _, seg := range segments {
		words = append(words, seg.Words...)
	}
	return words
}

// calcAverageConfidence вычисляет средний confidence для слов
func calcAverageConfidence(words []TranscriptWord) float32 {
	if len(words) == 0 {
		return 0
	}
	var sum float32
	var count int
	for _, w := range words {
		if w.P > 0 {
			sum += w.P
			count++
		}
	}
	if count == 0 {
		return 0
	}
	return sum / float32(count)
}

// mergeWordsByTime объединяет слова из двух моделей по времени
// Для каждого слова первичной модели ищет соответствующее во вторичной
// и выбирает лучшее по confidence. Использованные слова вторичной модели помечаются.
func (h *HybridTranscriber) mergeWordsByTime(
	primarySegs, secondarySegs []TranscriptSegment,
	primaryWords, secondaryWords []TranscriptWord,
) []TranscriptSegment {
	// Если у вторичной модели нет слов с таймингами - возвращаем первичную
	hasSecondaryTimings := false
	for _, w := range secondaryWords {
		if w.Start > 0 || w.End > 0 {
			hasSecondaryTimings = true
			break
		}
	}
	if !hasSecondaryTimings {
		log.Printf("[HybridTranscriber] MergeWordsByTime: Secondary has no word timings, using primary")
		return primarySegs
	}

	// Создаём список слов вторичной модели с флагом использования
	type wordEntry struct {
		word TranscriptWord
		mid  int64
		used bool
	}
	secondaryByTime := make([]*wordEntry, 0, len(secondaryWords))
	for _, w := range secondaryWords {
		if w.Start > 0 || w.End > 0 {
			mid := (w.Start + w.End) / 2
			secondaryByTime = append(secondaryByTime, &wordEntry{word: w, mid: mid, used: false})
		}
	}

	// Для каждого слова первичной модели ищем соответствующее во вторичной
	// и выбираем лучшее по confidence
	result := make([]TranscriptSegment, len(primarySegs))
	for i, seg := range primarySegs {
		result[i] = TranscriptSegment{
			Start:   seg.Start,
			End:     seg.End,
			Speaker: seg.Speaker,
		}

		var newWords []TranscriptWord
		var newTextParts []string

		for _, pw := range seg.Words {
			bestWord := pw // По умолчанию - слово из первичной модели

			// Ищем соответствующее слово во вторичной модели
			if pw.Start > 0 || pw.End > 0 {
				pwMid := (pw.Start + pw.End) / 2
				tolerance := int64(300) // 300ms tolerance

				var bestMatch *wordEntry
				var bestDist int64 = tolerance + 1

				for _, sw := range secondaryByTime {
					if sw.used {
						continue // Пропускаем уже использованные слова
					}

					dist := abs64(sw.mid - pwMid)
					if dist <= tolerance && dist < bestDist {
						bestDist = dist
						bestMatch = sw
					}
				}

				// Если нашли кандидата - используем voting-систему для выбора
				if bestMatch != nil {
					// Помечаем слово как использованное
					bestMatch.used = true

					// Используем voting-систему если включена
					if h.config.Voting.Enabled {
						voteResult := h.selectBestWordByVoting(pw, bestMatch.word)
						if voteResult.Winner == "secondary" {
							bestWord = bestMatch.word
							log.Printf("[HybridTranscriber] MergeWordsByTime: Voting selected '%s' over '%s' - %s",
								bestMatch.word.Text, pw.Text, voteResult.Reason)
						}
					} else {
						// Fallback на старую логику (простое сравнение confidence)
						if bestMatch.word.P > pw.P && bestMatch.word.P > 0 {
							bestWord = bestMatch.word
							log.Printf("[HybridTranscriber] MergeWordsByTime: Replaced '%s' (%.2f) with '%s' (%.2f)",
								pw.Text, pw.P, bestMatch.word.Text, bestMatch.word.P)
						}
					}
				}
			}

			newWords = append(newWords, bestWord)
			newTextParts = append(newTextParts, bestWord.Text)
		}

		result[i].Words = newWords
		result[i].Text = joinWords(newTextParts)
	}

	return result
}

// joinWords объединяет слова в текст с правильными пробелами
func joinWords(words []string) string {
	if len(words) == 0 {
		return ""
	}
	result := words[0]
	for i := 1; i < len(words); i++ {
		// Не добавляем пробел перед пунктуацией
		w := words[i]
		if len(w) > 0 && (w[0] == '.' || w[0] == ',' || w[0] == '!' || w[0] == '?' || w[0] == ':' || w[0] == ';') {
			result += w
		} else {
			result += " " + w
		}
	}
	return result
}

// maxInt64 возвращает максимум из двух int64
func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// minInt64 возвращает минимум из двух int64
func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// applyHotwords применяет словарь подсказок для исправления слов
// Ищет в результатах обеих моделей слова похожие на hotwords и заменяет
func (h *HybridTranscriber) applyHotwords(merged, primary, secondary []TranscriptSegment) []TranscriptSegment {
	if len(h.config.Hotwords) == 0 {
		return merged
	}

	// Собираем все слова из обеих моделей для поиска лучших вариантов
	allWords := make(map[string]bool)
	for _, seg := range primary {
		for _, w := range seg.Words {
			allWords[strings.ToLower(w.Text)] = true
		}
		// Также разбиваем текст на слова
		for _, word := range strings.Fields(seg.Text) {
			allWords[strings.ToLower(word)] = true
		}
	}
	for _, seg := range secondary {
		for _, w := range seg.Words {
			allWords[strings.ToLower(w.Text)] = true
		}
		for _, word := range strings.Fields(seg.Text) {
			allWords[strings.ToLower(word)] = true
		}
	}

	// Для каждого hotword ищем похожие слова в результатах
	replacements := make(map[string]string) // lowercase -> правильное написание

	for _, hotword := range h.config.Hotwords {
		hotwordLower := strings.ToLower(hotword)
		hotwordLen := len([]rune(hotwordLower)) // Длина в символах (для Unicode)

		for word := range allWords {
			wordLen := len([]rune(word))

			// Пропускаем слишком короткие слова (< 3 символов) - они слишком часто ложно срабатывают
			if wordLen < 3 {
				continue
			}

			// Пропускаем если длины слишком разные (> 50% разницы)
			lenDiff := hotwordLen - wordLen
			if lenDiff < 0 {
				lenDiff = -lenDiff
			}
			maxLenDiff := hotwordLen / 2
			if maxLenDiff < 1 {
				maxLenDiff = 1
			}
			if lenDiff > maxLenDiff {
				continue
			}

			// Проверяем похожесть (расстояние Левенштейна)
			dist := levenshteinDistance(word, hotwordLower)

			// Вычисляем максимально допустимое расстояние:
			// - Для коротких слов (<=4 символов): только dist=1 (опечатка в 1 символ)
			// - Для средних слов (5-8 символов): до 20% длины, минимум 1
			// - Для длинных слов (>8 символов): до 25% длины
			var maxDist int
			if hotwordLen <= 4 {
				maxDist = 1 // Для коротких hotwords очень строго
			} else if hotwordLen <= 8 {
				maxDist = hotwordLen * 2 / 10 // 20%
				if maxDist < 1 {
					maxDist = 1
				}
			} else {
				maxDist = hotwordLen * 25 / 100 // 25%
			}

			// Дополнительная проверка: первый символ должен совпадать для коротких слов
			if hotwordLen <= 5 && len(word) > 0 && len(hotwordLower) > 0 {
				wordRunes := []rune(word)
				hotwordRunes := []rune(hotwordLower)
				if wordRunes[0] != hotwordRunes[0] {
					continue // Первые буквы разные - скорее всего не то слово
				}
			}

			if dist <= maxDist && dist > 0 {
				// Слово похоже на hotword - запоминаем замену
				replacements[word] = hotword
				log.Printf("[HybridTranscriber] Hotword match: '%s' -> '%s' (dist=%d, maxDist=%d)", word, hotword, dist, maxDist)
			}
		}
	}

	if len(replacements) == 0 {
		return merged
	}

	// Применяем замены к результату
	result := make([]TranscriptSegment, len(merged))
	for i, seg := range merged {
		result[i] = seg

		// Заменяем в тексте сегмента
		newText := seg.Text
		for from, to := range replacements {
			// Заменяем с учётом регистра
			newText = replaceWordIgnoreCase(newText, from, to)
		}

		if newText != seg.Text {
			log.Printf("[HybridTranscriber] Hotword applied: '%s' -> '%s'", seg.Text, newText)
			result[i].Text = newText
		}

		// Заменяем в словах
		newWords := make([]TranscriptWord, len(seg.Words))
		for j, w := range seg.Words {
			newWords[j] = w
			wordLower := strings.ToLower(w.Text)
			if replacement, ok := replacements[wordLower]; ok {
				newWords[j].Text = replacement
			}
		}
		result[i].Words = newWords
	}

	return result
}

// replaceWordIgnoreCase заменяет слово в тексте без учёта регистра
func replaceWordIgnoreCase(text, from, to string) string {
	// Простая замена - ищем слово как подстроку
	textLower := strings.ToLower(text)
	fromLower := strings.ToLower(from)

	result := text
	idx := 0
	for {
		pos := strings.Index(textLower[idx:], fromLower)
		if pos < 0 {
			break
		}
		pos += idx

		// Проверяем что это целое слово (не часть другого слова)
		isWordStart := pos == 0 || !isLetter(rune(text[pos-1]))
		isWordEnd := pos+len(from) >= len(text) || !isLetter(rune(text[pos+len(from)]))

		if isWordStart && isWordEnd {
			result = result[:pos] + to + result[pos+len(from):]
			textLower = strings.ToLower(result)
			idx = pos + len(to)
		} else {
			idx = pos + 1
		}
	}

	return result
}

// isLetter проверяет является ли символ буквой
func isLetter(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
		(r >= 'а' && r <= 'я') || (r >= 'А' && r <= 'Я') ||
		r == 'ё' || r == 'Ё'
}

// abs64 возвращает абсолютное значение int64
func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// transcribeFullCompare транскрибирует обеими моделями и сравнивает результаты через LLM
func (h *HybridTranscriber) transcribeFullCompare(samples []float32) (*HybridTranscriptionResult, error) {
	// Шаг 1: Транскрипция первичной моделью
	log.Printf("[HybridTranscriber] FullCompare Step 1: Primary transcription with %s", h.primaryEngine.Name())
	primarySegments, err := h.primaryEngine.TranscribeWithSegments(samples)
	if err != nil {
		return nil, fmt.Errorf("primary transcription failed: %w", err)
	}

	if h.secondaryEngine == nil {
		return &HybridTranscriptionResult{Segments: primarySegments}, nil
	}

	// Шаг 2: Транскрипция вторичной моделью
	log.Printf("[HybridTranscriber] FullCompare Step 2: Secondary transcription with %s", h.secondaryEngine.Name())
	secondarySegments, err := h.secondaryEngine.TranscribeWithSegments(samples)
	if err != nil {
		log.Printf("[HybridTranscriber] Secondary transcription failed: %v, using primary only", err)
		return &HybridTranscriptionResult{Segments: primarySegments}, nil
	}

	// Собираем полные тексты
	primaryText := segmentsToFullText(primarySegments)
	secondaryText := segmentsToFullText(secondarySegments)

	log.Printf("[HybridTranscriber] Primary text: %q", primaryText)
	log.Printf("[HybridTranscriber] Secondary text: %q", secondaryText)

	// Если тексты идентичны - нет смысла сравнивать
	if primaryText == secondaryText {
		log.Printf("[HybridTranscriber] Texts are identical, no comparison needed")
		return &HybridTranscriptionResult{Segments: primarySegments}, nil
	}

	// Шаг 3: LLM выбирает лучший вариант
	if h.config.UseLLMForMerge && h.llmSelector != nil {
		log.Printf("[HybridTranscriber] FullCompare Step 3: LLM selecting best transcription")

		// Контекст для LLM - оба варианта
		context := fmt.Sprintf("Модель 1 (%s): %s\nМодель 2 (%s): %s",
			h.primaryEngine.Name(), primaryText,
			h.secondaryEngine.Name(), secondaryText)

		selected, err := h.llmSelector.SelectBestTranscription(primaryText, secondaryText, context)
		if err != nil {
			log.Printf("[HybridTranscriber] LLM selection failed: %v, using primary", err)
			return &HybridTranscriptionResult{Segments: primarySegments}, nil
		}

		log.Printf("[HybridTranscriber] LLM selected: %q", selected)

		// Определяем какой вариант выбран
		var finalSegments []TranscriptSegment
		var improvements []TranscriptionImprovement

		if selected == secondaryText || levenshteinDistance(selected, secondaryText) < levenshteinDistance(selected, primaryText) {
			// Выбран вторичный вариант
			finalSegments = secondarySegments
			improvements = append(improvements, TranscriptionImprovement{
				StartMs:      0,
				EndMs:        int64(len(samples) * 1000 / 16000),
				OriginalText: primaryText,
				ImprovedText: secondaryText,
				Source:       "llm_full_compare",
			})
			log.Printf("[HybridTranscriber] Using secondary model result")
		} else if selected == primaryText {
			// Выбран первичный вариант
			finalSegments = primarySegments
			log.Printf("[HybridTranscriber] Using primary model result")
		} else {
			// LLM вернул модифицированный текст - используем его
			// Создаём один сегмент с результатом LLM
			finalSegments = []TranscriptSegment{{
				Start: 0,
				End:   int64(len(samples) * 1000 / 16000),
				Text:  selected,
			}}
			improvements = append(improvements, TranscriptionImprovement{
				StartMs:      0,
				EndMs:        int64(len(samples) * 1000 / 16000),
				OriginalText: primaryText,
				ImprovedText: selected,
				Source:       "llm_merged",
			})
			log.Printf("[HybridTranscriber] Using LLM merged result")
		}

		return &HybridTranscriptionResult{
			Segments:           finalSegments,
			RetranscribedCount: len(improvements),
			Improvements:       improvements,
		}, nil
	}

	// Без LLM - просто возвращаем первичный результат
	log.Printf("[HybridTranscriber] No LLM configured, using primary result")
	return &HybridTranscriptionResult{Segments: primarySegments}, nil
}

// transcribeConfidenceBased выполняет гибридную транскрипцию на основе confidence
func (h *HybridTranscriber) transcribeConfidenceBased(samples []float32) (*HybridTranscriptionResult, error) {
	// Шаг 1: Первичная транскрипция
	log.Printf("[HybridTranscriber] Step 1: Primary transcription with %s", h.primaryEngine.Name())
	primarySegments, err := h.primaryEngine.TranscribeWithSegments(samples)
	if err != nil {
		return nil, fmt.Errorf("primary transcription failed: %w", err)
	}

	if !h.config.Enabled || h.secondaryEngine == nil {
		// Гибридная транскрипция отключена - возвращаем результат первичной модели
		return &HybridTranscriptionResult{
			Segments: primarySegments,
		}, nil
	}

	// Шаг 2: Поиск участков с низкой уверенностью
	log.Printf("[HybridTranscriber] Step 2: Finding low confidence regions (threshold: %.2f)", h.config.ConfidenceThreshold)
	regions := h.findLowConfidenceRegions(primarySegments)

	if len(regions) == 0 {
		log.Printf("[HybridTranscriber] No low confidence regions found")
		return &HybridTranscriptionResult{
			Segments: primarySegments,
		}, nil
	}

	log.Printf("[HybridTranscriber] Found %d low confidence regions", len(regions))

	// Шаг 3: Перетранскрибация проблемных участков
	log.Printf("[HybridTranscriber] Step 3: Retranscribing with %s", h.secondaryEngine.Name())
	improvements := h.retranscribeRegions(samples, regions, primarySegments)

	// Шаг 4: Слияние результатов
	log.Printf("[HybridTranscriber] Step 4: Merging results (%d improvements)", len(improvements))
	mergedSegments := h.mergeResults(primarySegments, improvements)

	// Подсчёт статистики
	lowConfCount := 0
	for _, region := range regions {
		lowConfCount += len(region.Words)
	}

	return &HybridTranscriptionResult{
		Segments:           mergedSegments,
		LowConfidenceCount: lowConfCount,
		RetranscribedCount: len(improvements),
		Improvements:       improvements,
	}, nil
}

// findLowConfidenceRegions находит участки с низкой уверенностью
func (h *HybridTranscriber) findLowConfidenceRegions(segments []TranscriptSegment) []LowConfidenceRegion {
	var regions []LowConfidenceRegion

	// Статистика confidence
	var totalWords, wordsWithConf, lowConfWords int
	var minConf, maxConf, sumConf float32 = 1.0, 0.0, 0.0

	for segIdx, seg := range segments {
		if len(seg.Words) == 0 {
			continue
		}

		// Собираем статистику confidence
		for _, word := range seg.Words {
			totalWords++
			if word.P > 0 {
				wordsWithConf++
				sumConf += word.P
				if word.P < minConf {
					minConf = word.P
				}
				if word.P > maxConf {
					maxConf = word.P
				}
			}
		}

		// Ищем последовательности слов с низкой уверенностью
		var currentRegion *LowConfidenceRegion

		for i, word := range seg.Words {
			isLowConf := word.P > 0 && word.P < h.config.ConfidenceThreshold
			if isLowConf {
				lowConfWords++
			}

			if isLowConf {
				if currentRegion == nil {
					// Начинаем новый регион с контекстом
					startIdx := maxInt(0, i-h.config.ContextWords)
					currentRegion = &LowConfidenceRegion{
						StartMs:      seg.Words[startIdx].Start,
						SegmentIndex: segIdx,
					}
					// Добавляем контекстные слова слева
					for j := startIdx; j < i; j++ {
						currentRegion.Words = append(currentRegion.Words, seg.Words[j])
					}
				}
				currentRegion.Words = append(currentRegion.Words, word)
				currentRegion.EndMs = word.End
			} else if currentRegion != nil {
				// Добавляем контекстные слова справа
				endIdx := minInt(len(seg.Words), i+h.config.ContextWords)
				for j := i; j < endIdx; j++ {
					currentRegion.Words = append(currentRegion.Words, seg.Words[j])
					currentRegion.EndMs = seg.Words[j].End
				}

				// Вычисляем среднюю уверенность
				currentRegion.AvgConfidence = h.calcAvgConfidence(currentRegion.Words)
				regions = append(regions, *currentRegion)
				currentRegion = nil
			}
		}

		// Закрываем последний регион если есть
		if currentRegion != nil {
			currentRegion.AvgConfidence = h.calcAvgConfidence(currentRegion.Words)
			regions = append(regions, *currentRegion)
		}
	}

	// Объединяем близкие регионы (менее 500мс между ними)
	regions = h.mergeCloseRegions(regions, 500)

	// Логируем итоговую статистику
	avgConf := float32(0)
	if wordsWithConf > 0 {
		avgConf = sumConf / float32(wordsWithConf)
	}
	log.Printf("[HybridTranscriber] Confidence stats: totalWords=%d, wordsWithConf=%d, lowConfWords=%d, min=%.4f, max=%.4f, avg=%.4f, threshold=%.2f",
		totalWords, wordsWithConf, lowConfWords, minConf, maxConf, avgConf, h.config.ConfidenceThreshold)

	return regions
}

// calcAvgConfidence вычисляет среднюю уверенность для слов
func (h *HybridTranscriber) calcAvgConfidence(words []TranscriptWord) float32 {
	if len(words) == 0 {
		return 0
	}
	var sum float32
	count := 0
	for _, w := range words {
		if w.P > 0 {
			sum += w.P
			count++
		}
	}
	if count == 0 {
		return 0
	}
	return sum / float32(count)
}

// mergeCloseRegions объединяет близкие регионы
func (h *HybridTranscriber) mergeCloseRegions(regions []LowConfidenceRegion, gapMs int64) []LowConfidenceRegion {
	if len(regions) <= 1 {
		return regions
	}

	// Сортируем по времени начала
	sort.Slice(regions, func(i, j int) bool {
		return regions[i].StartMs < regions[j].StartMs
	})

	var merged []LowConfidenceRegion
	current := regions[0]

	for i := 1; i < len(regions); i++ {
		next := regions[i]

		// Если регионы близко и в одном сегменте - объединяем
		if next.StartMs-current.EndMs <= gapMs && next.SegmentIndex == current.SegmentIndex {
			current.EndMs = next.EndMs
			current.Words = append(current.Words, next.Words...)
			current.AvgConfidence = h.calcAvgConfidence(current.Words)
		} else {
			merged = append(merged, current)
			current = next
		}
	}
	merged = append(merged, current)

	return merged
}

// retranscribeRegions перетранскрибирует проблемные участки
func (h *HybridTranscriber) retranscribeRegions(
	samples []float32,
	regions []LowConfidenceRegion,
	originalSegments []TranscriptSegment,
) []TranscriptionImprovement {
	var improvements []TranscriptionImprovement
	sampleRate := 16000 // 16kHz

	for _, region := range regions {
		// Извлекаем аудио для региона с небольшим запасом (100мс)
		startSample := int((region.StartMs - 100) * int64(sampleRate) / 1000)
		endSample := int((region.EndMs + 100) * int64(sampleRate) / 1000)

		if startSample < 0 {
			startSample = 0
		}
		if endSample > len(samples) {
			endSample = len(samples)
		}
		if startSample >= endSample {
			continue
		}

		regionSamples := samples[startSample:endSample]

		// Транскрибируем вторичной моделью
		altSegments, err := h.secondaryEngine.TranscribeWithSegments(regionSamples)
		if err != nil {
			log.Printf("[HybridTranscriber] Secondary transcription failed for region %d-%d: %v",
				region.StartMs, region.EndMs, err)
			continue
		}

		if len(altSegments) == 0 {
			continue
		}

		// Собираем текст из альтернативной транскрипции
		var altText string
		var altConf float32
		var altWordCount int
		for _, seg := range altSegments {
			if altText != "" {
				altText += " "
			}
			altText += seg.Text
			for _, w := range seg.Words {
				if w.P > 0 {
					altConf += w.P
					altWordCount++
				}
			}
		}
		if altWordCount > 0 {
			altConf /= float32(altWordCount)
		}

		// Собираем оригинальный текст
		var origText string
		for _, w := range region.Words {
			if origText != "" {
				origText += " "
			}
			origText += w.Text
		}

		// Выбираем лучший вариант
		var finalText string
		var source string

		if h.config.UseLLMForMerge && h.llmSelector != nil {
			// Используем LLM для выбора
			context := h.getContextForRegion(originalSegments, region)
			selected, err := h.llmSelector.SelectBestTranscription(origText, altText, context)
			if err != nil {
				log.Printf("[HybridTranscriber] LLM selection failed: %v, using confidence-based selection", err)
				// Fallback на выбор по confidence
				if altConf > region.AvgConfidence {
					finalText = altText
					source = "secondary_model"
				} else {
					continue // Оставляем оригинал
				}
			} else {
				finalText = selected
				source = "llm"
			}
		} else {
			// Выбор по confidence
			if altConf > region.AvgConfidence {
				finalText = altText
				source = "secondary_model"
			} else {
				continue // Оставляем оригинал
			}
		}

		// Если текст изменился - добавляем улучшение
		if finalText != origText {
			improvements = append(improvements, TranscriptionImprovement{
				StartMs:      region.StartMs,
				EndMs:        region.EndMs,
				OriginalText: origText,
				ImprovedText: finalText,
				OriginalConf: region.AvgConfidence,
				ImprovedConf: altConf,
				Source:       source,
			})
		}
	}

	return improvements
}

// getContextForRegion получает контекст вокруг региона для LLM
func (h *HybridTranscriber) getContextForRegion(segments []TranscriptSegment, region LowConfidenceRegion) string {
	var context string

	// Берём текст из того же сегмента
	if region.SegmentIndex < len(segments) {
		seg := segments[region.SegmentIndex]
		context = seg.Text
	}

	// Добавляем предыдущий сегмент если есть
	if region.SegmentIndex > 0 {
		prevSeg := segments[region.SegmentIndex-1]
		context = prevSeg.Text + " ... " + context
	}

	// Добавляем следующий сегмент если есть
	if region.SegmentIndex < len(segments)-1 {
		nextSeg := segments[region.SegmentIndex+1]
		context = context + " ... " + nextSeg.Text
	}

	return context
}

// mergeResults объединяет оригинальные сегменты с улучшениями
func (h *HybridTranscriber) mergeResults(
	segments []TranscriptSegment,
	improvements []TranscriptionImprovement,
) []TranscriptSegment {
	if len(improvements) == 0 {
		return segments
	}

	// Создаём карту улучшений по времени
	improvementMap := make(map[int64]TranscriptionImprovement)
	for _, imp := range improvements {
		improvementMap[imp.StartMs] = imp
	}

	// Применяем улучшения к сегментам
	result := make([]TranscriptSegment, len(segments))
	for i, seg := range segments {
		result[i] = seg

		// Проверяем есть ли улучшения для слов в этом сегменте
		if len(seg.Words) == 0 {
			continue
		}

		for startMs, imp := range improvementMap {
			// Проверяем попадает ли улучшение в этот сегмент
			if startMs >= seg.Start && startMs <= seg.End {
				// Заменяем текст в сегменте
				// Простая замена - в реальности нужна более сложная логика
				// для точного позиционирования
				newText := replaceTextInSegment(seg.Text, imp.OriginalText, imp.ImprovedText)
				result[i].Text = newText

				log.Printf("[HybridTranscriber] Applied improvement: '%s' -> '%s' (source: %s)",
					imp.OriginalText, imp.ImprovedText, imp.Source)
			}
		}
	}

	return result
}

// replaceTextInSegment заменяет текст в сегменте
func replaceTextInSegment(segmentText, original, replacement string) string {
	// Простая замена подстроки
	// В реальности может потребоваться fuzzy matching
	if original == "" {
		return segmentText
	}

	// Пробуем точную замену
	result := segmentText
	for {
		idx := findSubstringFuzzy(result, original)
		if idx < 0 {
			break
		}
		result = result[:idx] + replacement + result[idx+len(original):]
		break // Заменяем только первое вхождение
	}

	return result
}

// findSubstringFuzzy ищет подстроку с учётом небольших различий
func findSubstringFuzzy(text, substr string) int {
	// Сначала пробуем точное совпадение
	for i := 0; i <= len(text)-len(substr); i++ {
		if text[i:i+len(substr)] == substr {
			return i
		}
	}

	// Если не нашли - возвращаем -1
	// В будущем можно добавить fuzzy matching
	return -1
}

// minInt возвращает минимум из двух чисел
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// maxInt возвращает максимум из двух чисел
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// segmentsToFullText объединяет текст из всех сегментов
func segmentsToFullText(segments []TranscriptSegment) string {
	var result string
	for i, seg := range segments {
		if i > 0 {
			result += " "
		}
		result += seg.Text
	}
	return result
}

// levenshteinDistance вычисляет расстояние Левенштейна между двумя строками
func levenshteinDistance(s1, s2 string) int {
	r1 := []rune(s1)
	r2 := []rune(s2)

	if len(r1) == 0 {
		return len(r2)
	}
	if len(r2) == 0 {
		return len(r1)
	}

	// Создаём матрицу
	matrix := make([][]int, len(r1)+1)
	for i := range matrix {
		matrix[i] = make([]int, len(r2)+1)
		matrix[i][0] = i
	}
	for j := range matrix[0] {
		matrix[0][j] = j
	}

	// Заполняем матрицу
	for i := 1; i <= len(r1); i++ {
		for j := 1; j <= len(r2); j++ {
			cost := 1
			if r1[i-1] == r2[j-1] {
				cost = 0
			}
			matrix[i][j] = minInt(
				minInt(matrix[i-1][j]+1, matrix[i][j-1]+1),
				matrix[i-1][j-1]+cost,
			)
		}
	}

	return matrix[len(r1)][len(r2)]
}

// ============================================================================
// Voting-система для выбора лучшего слова между двумя моделями
// Использует 4 критерия: калибровка confidence, латиница, hotwords, грамматика
// ============================================================================

// getCalibrationFactor возвращает коэффициент калибровки для модели
// GigaAM завышает confidence на ~25% из-за CTC loss
func getCalibrationFactor(modelName string, calibrations []ConfidenceCalibration) float32 {
	for _, cal := range calibrations {
		matched, err := regexp.MatchString(cal.ModelPattern, modelName)
		if err == nil && matched {
			return cal.ScaleFactor
		}
	}
	return 1.0 // По умолчанию без калибровки
}

// voteByCalibration голосование по калиброванному confidence (Критерий A)
// Применяет коэффициенты калибровки к raw confidence и сравнивает
func voteByCalibration(
	primary, secondary TranscriptWord,
	primaryModel, secondaryModel string,
	calibrations []ConfidenceCalibration,
) string {
	primaryFactor := getCalibrationFactor(primaryModel, calibrations)
	secondaryFactor := getCalibrationFactor(secondaryModel, calibrations)

	primaryCalibrated := primary.P * primaryFactor
	secondaryCalibrated := secondary.P * secondaryFactor

	// Логируем для отладки
	log.Printf("[Voting] Calibration: primary '%s' %.3f*%.2f=%.3f vs secondary '%s' %.3f*%.2f=%.3f",
		primary.Text, primary.P, primaryFactor, primaryCalibrated,
		secondary.Text, secondary.P, secondaryFactor, secondaryCalibrated)

	if primaryCalibrated > secondaryCalibrated+0.01 { // небольшой порог для избежания шума
		return "primary"
	} else if secondaryCalibrated > primaryCalibrated+0.01 {
		return "secondary"
	}
	return "tie"
}

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

// voteByLatin голосование по наличию латиницы (Критерий B)
// Предпочитаем модель, которая распознала латинские буквы (иностранные термины)
func voteByLatin(primary, secondary TranscriptWord) string {
	primaryHasLatin := containsLatin(primary.Text)
	secondaryHasLatin := containsLatin(secondary.Text)

	// Если одна модель распознала латиницу, а другая нет — голосуем за латиницу
	if secondaryHasLatin && !primaryHasLatin {
		log.Printf("[Voting] Latin: secondary '%s' has latin, primary '%s' doesn't -> secondary",
			secondary.Text, primary.Text)
		return "secondary"
	} else if primaryHasLatin && !secondaryHasLatin {
		log.Printf("[Voting] Latin: primary '%s' has latin, secondary '%s' doesn't -> primary",
			primary.Text, secondary.Text)
		return "primary"
	}

	// Оба или ни один — воздерживаемся
	return "abstain"
}

// normalizeWordForComparison нормализует слово для сравнения
func normalizeWordForComparison(word string) string {
	word = strings.TrimSpace(word)
	word = strings.ToLower(word)
	word = strings.Trim(word, ".,!?;:\"'()-–—")
	return word
}

// matchesHotword проверяет совпадение слова с hotword (fuzzy matching)
func matchesHotword(word string, hotwords []string) (bool, string) {
	wordNorm := normalizeWordForComparison(word)
	if wordNorm == "" {
		return false, ""
	}

	for _, hw := range hotwords {
		hwNorm := normalizeWordForComparison(hw)
		if hwNorm == "" {
			continue
		}

		// Точное совпадение
		if wordNorm == hwNorm {
			return true, hw
		}

		// Fuzzy matching (расстояние Левенштейна ≤ 20% длины hotword)
		dist := levenshteinDistance(wordNorm, hwNorm)
		maxDist := len(hwNorm) / 5
		if maxDist < 1 {
			maxDist = 1
		}
		if dist <= maxDist && dist > 0 {
			return true, hw
		}
	}
	return false, ""
}

// voteByHotwords голосование по совпадению с hotwords (Критерий C)
func voteByHotwords(primary, secondary TranscriptWord, hotwords []string) string {
	if len(hotwords) == 0 {
		return "abstain"
	}

	primaryMatches, primaryHW := matchesHotword(primary.Text, hotwords)
	secondaryMatches, secondaryHW := matchesHotword(secondary.Text, hotwords)

	if secondaryMatches && !primaryMatches {
		log.Printf("[Voting] Hotwords: secondary '%s' matches '%s', primary '%s' doesn't -> secondary",
			secondary.Text, secondaryHW, primary.Text)
		return "secondary"
	} else if primaryMatches && !secondaryMatches {
		log.Printf("[Voting] Hotwords: primary '%s' matches '%s', secondary '%s' doesn't -> primary",
			primary.Text, primaryHW, secondary.Text)
		return "primary"
	}
	return "abstain"
}

// detectWordLanguage определяет язык слова по содержимому
func detectWordLanguage(word string) string {
	if containsCyrillic(word) {
		return "ru"
	}
	return "en"
}

// voteByGrammar голосование по грамматической корректности (Критерий D)
func voteByGrammar(primary, secondary TranscriptWord, checker GrammarChecker) string {
	if checker == nil {
		return "abstain"
	}

	// Определяем язык по содержимому
	primaryLang := detectWordLanguage(primary.Text)
	secondaryLang := detectWordLanguage(secondary.Text)

	primaryValid := checker.IsValidWord(primary.Text, primaryLang)
	secondaryValid := checker.IsValidWord(secondary.Text, secondaryLang)

	if secondaryValid && !primaryValid {
		log.Printf("[Voting] Grammar: secondary '%s' valid, primary '%s' invalid -> secondary",
			secondary.Text, primary.Text)
		return "secondary"
	} else if primaryValid && !secondaryValid {
		log.Printf("[Voting] Grammar: primary '%s' valid, secondary '%s' invalid -> primary",
			primary.Text, secondary.Text)
		return "primary"
	}
	return "abstain"
}

// selectBestWordByVoting выбирает лучшее слово через систему голосования
// Использует до 4 критериев, побеждает модель с большинством голосов
// При ничьей выбирается первичная модель
func (h *HybridTranscriber) selectBestWordByVoting(
	primary, secondary TranscriptWord,
) VoteResult {
	result := VoteResult{
		PrimaryWord:   primary,
		SecondaryWord: secondary,
	}

	votes := VoteDetails{}
	votingConfig := h.config.Voting

	// Если voting отключён — используем простое сравнение confidence
	if !votingConfig.Enabled {
		if secondary.P > primary.P {
			result.Winner = "secondary"
			result.Reason = "Voting disabled, secondary has higher confidence"
		} else {
			result.Winner = "primary"
			result.Reason = "Voting disabled, primary wins by default"
		}
		result.Votes = votes
		return result
	}

	// Критерий A: Калиброванный confidence
	if votingConfig.UseCalibration {
		calibrations := votingConfig.Calibrations
		if len(calibrations) == 0 {
			calibrations = DefaultCalibrations
		}
		votes.CalibrationVote = voteByCalibration(
			primary, secondary,
			h.primaryEngine.Name(), h.secondaryEngine.Name(),
			calibrations,
		)
		if votes.CalibrationVote == "primary" {
			votes.PrimaryVotes++
		} else if votes.CalibrationVote == "secondary" {
			votes.SecondaryVotes++
		}
	}

	// Критерий B: Латиница
	if votingConfig.UseLatinDetection {
		votes.LatinVote = voteByLatin(primary, secondary)
		if votes.LatinVote == "primary" {
			votes.PrimaryVotes++
		} else if votes.LatinVote == "secondary" {
			votes.SecondaryVotes++
		}
	}

	// Критерий C: Hotwords
	if votingConfig.UseHotwords && len(h.config.Hotwords) > 0 {
		votes.HotwordVote = voteByHotwords(primary, secondary, h.config.Hotwords)
		if votes.HotwordVote == "primary" {
			votes.PrimaryVotes++
		} else if votes.HotwordVote == "secondary" {
			votes.SecondaryVotes++
		}
	}

	// Критерий D: Грамматика
	if votingConfig.UseGrammarCheck && h.grammarChecker != nil {
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
		result.Reason = fmt.Sprintf("Secondary wins %d:%d (cal=%s lat=%s hw=%s gram=%s)",
			votes.SecondaryVotes, votes.PrimaryVotes,
			votes.CalibrationVote, votes.LatinVote, votes.HotwordVote, votes.GrammarVote)
	} else {
		// При ничьей или преимуществе primary — выбираем primary
		result.Winner = "primary"
		if votes.PrimaryVotes == votes.SecondaryVotes {
			result.Reason = fmt.Sprintf("Tie %d:%d, primary wins by default (cal=%s lat=%s hw=%s gram=%s)",
				votes.PrimaryVotes, votes.SecondaryVotes,
				votes.CalibrationVote, votes.LatinVote, votes.HotwordVote, votes.GrammarVote)
		} else {
			result.Reason = fmt.Sprintf("Primary wins %d:%d (cal=%s lat=%s hw=%s gram=%s)",
				votes.PrimaryVotes, votes.SecondaryVotes,
				votes.CalibrationVote, votes.LatinVote, votes.HotwordVote, votes.GrammarVote)
		}
	}

	log.Printf("[Voting] Result for '%s' vs '%s': %s - %s",
		primary.Text, secondary.Text, result.Winner, result.Reason)

	return result
}
