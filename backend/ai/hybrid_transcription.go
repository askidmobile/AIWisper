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
	{ModelPattern: "(?i)fluid", ScaleFactor: 1.0, Bias: 0}, // fluid-asr = Parakeet TDT v3
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

// transcribeParallel выполняет параллельную транскрипцию обеими моделями
// и использует собственный анализатор для выбора лучших слов на основе confidence
func (h *HybridTranscriber) transcribeParallel(samples []float32) (*HybridTranscriptionResult, error) {
	if h.secondaryEngine == nil {
		// Нет вторичной модели - просто транскрибируем первичной
		segments, err := h.primaryEngine.TranscribeWithSegments(samples)
		if err != nil {
			return nil, err
		}
		return &HybridTranscriptionResult{Segments: segments}, nil
	}

	// Запускаем обе модели параллельно
	type transcriptionResult struct {
		segments []TranscriptSegment
		err      error
		name     string
	}

	primaryChan := make(chan transcriptionResult, 1)
	secondaryChan := make(chan transcriptionResult, 1)

	// Первичная модель
	go func() {
		log.Printf("[HybridTranscriber] Parallel: Starting primary transcription with %s", h.primaryEngine.Name())
		segments, err := h.primaryEngine.TranscribeWithSegments(samples)
		primaryChan <- transcriptionResult{segments: segments, err: err, name: h.primaryEngine.Name()}
	}()

	// Вторичная модель
	go func() {
		log.Printf("[HybridTranscriber] Parallel: Starting secondary transcription with %s", h.secondaryEngine.Name())
		segments, err := h.secondaryEngine.TranscribeWithSegments(samples)
		secondaryChan <- transcriptionResult{segments: segments, err: err, name: h.secondaryEngine.Name()}
	}()

	// Ждём результаты
	primaryResult := <-primaryChan
	secondaryResult := <-secondaryChan

	log.Printf("[HybridTranscriber] Parallel: Primary (%s) done, err=%v", primaryResult.name, primaryResult.err)
	log.Printf("[HybridTranscriber] Parallel: Secondary (%s) done, err=%v", secondaryResult.name, secondaryResult.err)

	var primarySegments, secondarySegments []TranscriptSegment
	var primaryErr, secondaryErr error
	primarySegments, primaryErr = primaryResult.segments, primaryResult.err
	secondarySegments, secondaryErr = secondaryResult.segments, secondaryResult.err

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

	log.Printf("[HybridTranscriber] Parallel: Primary text: %q", primaryText)
	log.Printf("[HybridTranscriber] Parallel: Secondary text: %q", secondaryText)

	// Если тексты идентичны - возвращаем первичный
	if primaryText == secondaryText {
		log.Printf("[HybridTranscriber] Parallel: Texts identical, using primary")
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
		log.Printf("[HybridTranscriber] Parallel: Merged text: %q", mergedText)
		log.Printf("[HybridTranscriber] Parallel: Verifying with LLM...")

		// LLM проверяет объединённый результат
		selected, err := h.llmSelector.SelectBestTranscription(primaryText, mergedText, "")
		if err == nil && selected != primaryText && selected != mergedText {
			// LLM предложил свой вариант
			log.Printf("[HybridTranscriber] Parallel: LLM suggested: %q", selected)
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

	// Вычисляем средний confidence для каждой модели (raw)
	primaryAvgConf := calcAverageConfidence(primaryWords)
	secondaryAvgConf := calcAverageConfidence(secondaryWords)

	log.Printf("[HybridTranscriber] MergeByConfidence: primaryAvgConf=%.4f, secondaryAvgConf=%.4f",
		primaryAvgConf, secondaryAvgConf)

	// Подсчитываем <unk> токены для информации (но не для выбора модели целиком)
	// Теперь <unk> обрабатываются пословно в mergeWordsByTimeWithUnkReplacement
	primaryUnkCount := countUnkTokens(primaryWords) + countUnkTokensInSegments(primary)
	secondaryUnkCount := countUnkTokens(secondaryWords) + countUnkTokensInSegments(secondary)

	if primaryUnkCount > 0 || secondaryUnkCount > 0 {
		log.Printf("[HybridTranscriber] MergeByConfidence: <unk> tokens - primary=%d, secondary=%d (will be replaced word-by-word)",
			primaryUnkCount, secondaryUnkCount)
	}

	// Применяем калибровку confidence для логирования
	calibrations := h.config.Voting.Calibrations
	if len(calibrations) == 0 {
		calibrations = DefaultCalibrations
	}
	primaryCalFactor := getCalibrationFactor(h.primaryEngine.Name(), calibrations)
	secondaryCalFactor := getCalibrationFactor(h.secondaryEngine.Name(), calibrations)

	primaryCalibratedConf := primaryAvgConf * primaryCalFactor
	secondaryCalibratedConf := secondaryAvgConf * secondaryCalFactor

	log.Printf("[HybridTranscriber] MergeByConfidence: calibrated primaryConf=%.4f (factor=%.2f), secondaryConf=%.4f (factor=%.2f)",
		primaryCalibratedConf, primaryCalFactor, secondaryCalibratedConf, secondaryCalFactor)

	// НОВАЯ СТРАТЕГИЯ: Всегда делаем пословное слияние
	// Берём Primary как базу (лучше пунктуация, заглавные буквы),
	// но заменяем проблемные слова (<unk>, низкий confidence) из Secondary

	confDiff := primaryCalibratedConf - secondaryCalibratedConf
	log.Printf("[HybridTranscriber] MergeByConfidence: confDiff=%.2f, will merge word-by-word", confDiff)

	// Всегда делаем пословное слияние, используя Primary как базу
	// Primary обычно лучше по пунктуации и форматированию
	mergedSegments := h.mergeWordsByTimeWithUnkReplacement(primary, secondary, primaryWords, secondaryWords)

	// Проверяем были ли улучшения
	mergedText := segmentsToFullText(mergedSegments)
	primaryText := segmentsToFullText(primary)
	if mergedText != primaryText {
		log.Printf("[HybridTranscriber] MergeByConfidence: Merged text differs from primary")
		improvements = append(improvements, TranscriptionImprovement{
			OriginalText: primaryText,
			ImprovedText: mergedText,
			OriginalConf: primaryAvgConf,
			ImprovedConf: secondaryAvgConf,
			Source:       "parallel_word_merge",
		})
	} else {
		log.Printf("[HybridTranscriber] MergeByConfidence: No changes after merge")
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

// countUnkTokens подсчитывает количество <unk> токенов в словах
// <unk> токены указывают на то, что модель не смогла распознать слово
func countUnkTokens(words []TranscriptWord) int {
	count := 0
	for _, w := range words {
		text := strings.ToLower(w.Text)
		if strings.Contains(text, "<unk>") || strings.Contains(text, "[unk]") {
			count++
		}
	}
	return count
}

// countUnkTokensInSegments подсчитывает <unk> токены в текстах сегментов
// Это нужно потому что некоторые движки фильтруют <unk> из Words, но оставляют в Text
func countUnkTokensInSegments(segments []TranscriptSegment) int {
	count := 0
	for _, seg := range segments {
		text := strings.ToLower(seg.Text)
		// Считаем количество вхождений <unk> в тексте
		count += strings.Count(text, "<unk>")
		count += strings.Count(text, "[unk]")
	}
	return count
}

// WordAlignment представляет выравнивание между словами двух моделей
type WordAlignment struct {
	PrimaryIdx   int  // Индекс слова в primary (-1 если gap)
	SecondaryIdx int  // Индекс слова в secondary (-1 если gap)
	Score        int  // Оценка выравнивания
	IsSimilar    bool // Слова семантически похожи
}

// alignWordsNeedlemanWunsch выравнивает две последовательности слов
// используя алгоритм Needleman-Wunsch (глобальное выравнивание)
// Возвращает список пар (primaryIdx, secondaryIdx), где -1 означает gap
func alignWordsNeedlemanWunsch(primary, secondary []TranscriptWord) []WordAlignment {
	n := len(primary)
	m := len(secondary)

	if n == 0 || m == 0 {
		return nil
	}

	// Параметры scoring
	const (
		matchScore    = 2  // Совпадение слов
		similarScore  = 1  // Похожие слова
		mismatchScore = -1 // Разные слова
		gapPenalty    = -1 // Штраф за пропуск
	)

	// Функция сравнения слов
	compareWords := func(w1, w2 TranscriptWord) (int, bool) {
		norm1 := normalizeWordForComparison(w1.Text)
		norm2 := normalizeWordForComparison(w2.Text)

		if norm1 == norm2 {
			return matchScore, true
		}
		if areWordsSimilar(w1.Text, w2.Text) {
			return similarScore, true
		}
		return mismatchScore, false
	}

	// Создаём матрицу scoring
	score := make([][]int, n+1)
	for i := range score {
		score[i] = make([]int, m+1)
	}

	// Инициализация первой строки и столбца
	for i := 0; i <= n; i++ {
		score[i][0] = i * gapPenalty
	}
	for j := 0; j <= m; j++ {
		score[0][j] = j * gapPenalty
	}

	// Заполняем матрицу
	for i := 1; i <= n; i++ {
		for j := 1; j <= m; j++ {
			matchVal, _ := compareWords(primary[i-1], secondary[j-1])

			diag := score[i-1][j-1] + matchVal
			up := score[i-1][j] + gapPenalty
			left := score[i][j-1] + gapPenalty

			score[i][j] = maxInt(maxInt(diag, up), left)
		}
	}

	// Traceback для получения выравнивания
	var alignment []WordAlignment
	i, j := n, m

	for i > 0 || j > 0 {
		if i > 0 && j > 0 {
			matchVal, isSimilar := compareWords(primary[i-1], secondary[j-1])
			if score[i][j] == score[i-1][j-1]+matchVal {
				alignment = append(alignment, WordAlignment{
					PrimaryIdx:   i - 1,
					SecondaryIdx: j - 1,
					Score:        matchVal,
					IsSimilar:    isSimilar,
				})
				i--
				j--
				continue
			}
		}

		if i > 0 && score[i][j] == score[i-1][j]+gapPenalty {
			alignment = append(alignment, WordAlignment{
				PrimaryIdx:   i - 1,
				SecondaryIdx: -1,
				Score:        gapPenalty,
				IsSimilar:    false,
			})
			i--
		} else if j > 0 {
			alignment = append(alignment, WordAlignment{
				PrimaryIdx:   -1,
				SecondaryIdx: j - 1,
				Score:        gapPenalty,
				IsSimilar:    false,
			})
			j--
		}
	}

	// Разворачиваем (traceback идёт с конца)
	for left, right := 0, len(alignment)-1; left < right; left, right = left+1, right-1 {
		alignment[left], alignment[right] = alignment[right], alignment[left]
	}

	return alignment
}

// mergeWordsByTime объединяет слова из двух моделей используя sequence alignment
// Вместо простого сопоставления по времени, использует алгоритм Needleman-Wunsch
// для корректного выравнивания последовательностей слов с учётом пропусков
func (h *HybridTranscriber) mergeWordsByTime(
	primarySegs, secondarySegs []TranscriptSegment,
	primaryWords, secondaryWords []TranscriptWord,
) []TranscriptSegment {
	// Если нет слов - возвращаем первичную
	if len(primaryWords) == 0 {
		return primarySegs
	}
	if len(secondaryWords) == 0 {
		return primarySegs
	}

	// Выравниваем слова с помощью Needleman-Wunsch
	alignment := alignWordsNeedlemanWunsch(primaryWords, secondaryWords)

	log.Printf("[HybridTranscriber] MergeWordsByAlignment: aligned %d primary words with %d secondary words, got %d alignments",
		len(primaryWords), len(secondaryWords), len(alignment))

	// Создаём карту замен: primaryIdx -> лучшее слово
	replacements := make(map[int]TranscriptWord)

	for _, align := range alignment {
		// Пропускаем gaps и несовпадения
		if align.PrimaryIdx < 0 || align.SecondaryIdx < 0 || !align.IsSimilar {
			continue
		}

		pw := primaryWords[align.PrimaryIdx]
		sw := secondaryWords[align.SecondaryIdx]

		// Используем voting-систему если включена
		if h.config.Voting.Enabled {
			voteResult := h.selectBestWordByVoting(pw, sw)
			if voteResult.Winner == "secondary" {
				replacements[align.PrimaryIdx] = sw
				log.Printf("[HybridTranscriber] MergeWordsByAlignment: Voting selected '%s' over '%s' - %s",
					sw.Text, pw.Text, voteResult.Reason)
			}
		} else {
			// Fallback на простое сравнение confidence
			if sw.P > pw.P && sw.P > 0 {
				replacements[align.PrimaryIdx] = sw
				log.Printf("[HybridTranscriber] MergeWordsByAlignment: Replaced '%s' (%.2f) with '%s' (%.2f)",
					pw.Text, pw.P, sw.Text, sw.P)
			}
		}
	}

	// Если нет замен - возвращаем оригинал
	if len(replacements) == 0 {
		log.Printf("[HybridTranscriber] MergeWordsByAlignment: No replacements needed")
		return primarySegs
	}

	// Применяем замены к сегментам
	// Нужно отслеживать глобальный индекс слова
	result := make([]TranscriptSegment, len(primarySegs))
	globalWordIdx := 0

	for i, seg := range primarySegs {
		result[i] = TranscriptSegment{
			Start:   seg.Start,
			End:     seg.End,
			Speaker: seg.Speaker,
		}

		var newWords []TranscriptWord
		var newTextParts []string

		for _, pw := range seg.Words {
			bestWord := pw

			// Проверяем есть ли замена для этого слова
			if replacement, ok := replacements[globalWordIdx]; ok {
				bestWord = replacement
			}

			newWords = append(newWords, bestWord)
			newTextParts = append(newTextParts, bestWord.Text)
			globalWordIdx++
		}

		result[i].Words = newWords
		result[i].Text = joinWords(newTextParts)
	}

	return result
}

// mergeWordsByTimeWithUnkReplacement объединяет результаты двух моделей,
// используя Primary как базу и заменяя проблемные слова из Secondary.
// Проблемные слова: содержащие <unk>, [unk], или с очень низким confidence.
// Это сохраняет пунктуацию и форматирование Primary, но исправляет ошибки распознавания.
func (h *HybridTranscriber) mergeWordsByTimeWithUnkReplacement(
	primarySegs, secondarySegs []TranscriptSegment,
	primaryWords, secondaryWords []TranscriptWord,
) []TranscriptSegment {
	// Если нет слов - возвращаем первичную
	if len(primaryWords) == 0 {
		return primarySegs
	}
	if len(secondaryWords) == 0 {
		return primarySegs
	}

	// Выравниваем слова с помощью Needleman-Wunsch
	alignment := alignWordsNeedlemanWunsch(primaryWords, secondaryWords)

	log.Printf("[HybridTranscriber] MergeWithUnkReplacement: aligned %d primary words with %d secondary words",
		len(primaryWords), len(secondaryWords))

	// Создаём карту замен: primaryIdx -> лучшее слово
	replacements := make(map[int]TranscriptWord)
	replacementReasons := make(map[int]string)

	for _, align := range alignment {
		// Пропускаем gaps
		if align.PrimaryIdx < 0 || align.SecondaryIdx < 0 {
			continue
		}

		pw := primaryWords[align.PrimaryIdx]
		sw := secondaryWords[align.SecondaryIdx]
		pwLower := strings.ToLower(pw.Text)

		// Проверяем, содержит ли primary слово <unk>
		hasUnk := strings.Contains(pwLower, "<unk>") || strings.Contains(pwLower, "[unk]")

		// Проверяем, есть ли <unk> в secondary (не заменяем на другой <unk>)
		swLower := strings.ToLower(sw.Text)
		secondaryHasUnk := strings.Contains(swLower, "<unk>") || strings.Contains(swLower, "[unk]")

		if hasUnk && !secondaryHasUnk && sw.Text != "" {
			// Primary содержит <unk>, Secondary нет - заменяем
			replacements[align.PrimaryIdx] = sw
			replacementReasons[align.PrimaryIdx] = fmt.Sprintf("<unk> replacement: '%s' -> '%s'", pw.Text, sw.Text)
			continue
		}

		// Если слова похожи, проверяем confidence
		if align.IsSimilar {
			// Очень низкий confidence в primary (< 0.5) и secondary лучше
			if pw.P < 0.5 && sw.P > pw.P+0.1 && !secondaryHasUnk {
				replacements[align.PrimaryIdx] = sw
				replacementReasons[align.PrimaryIdx] = fmt.Sprintf("low confidence: '%s' (%.2f) -> '%s' (%.2f)",
					pw.Text, pw.P, sw.Text, sw.P)
			}
		}
	}

	// Логируем замены
	if len(replacements) > 0 {
		log.Printf("[HybridTranscriber] MergeWithUnkReplacement: %d replacements:", len(replacements))
		for idx, reason := range replacementReasons {
			log.Printf("  [%d] %s", idx, reason)
		}
	} else {
		log.Printf("[HybridTranscriber] MergeWithUnkReplacement: No replacements needed")
		return primarySegs
	}

	// Применяем замены к сегментам
	result := make([]TranscriptSegment, len(primarySegs))
	globalWordIdx := 0

	for i, seg := range primarySegs {
		result[i] = TranscriptSegment{
			Start:   seg.Start,
			End:     seg.End,
			Speaker: seg.Speaker,
		}

		var newWords []TranscriptWord
		var newTextParts []string

		for _, pw := range seg.Words {
			bestWord := pw

			// Проверяем есть ли замена для этого слова
			if replacement, ok := replacements[globalWordIdx]; ok {
				// Сохраняем timing от primary, но берём текст от secondary
				bestWord = TranscriptWord{
					Start: pw.Start,
					End:   pw.End,
					Text:  replacement.Text,
					P:     replacement.P,
				}
			}

			newWords = append(newWords, bestWord)
			newTextParts = append(newTextParts, bestWord.Text)
			globalWordIdx++
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
// ВАЖНО: Это post-processing подход, который работает ТОЛЬКО для явных опечаток
// Для настоящего contextual biasing нужна интеграция на уровне декодирования (как в sherpa-onnx)
//
// Два режима работы:
//  1. Короткие hotwords (< 4 символов): ТОЛЬКО точное совпадение (без учёта регистра)
//     Это безопасно для аббревиатур типа "МТС", "API", "ВТБ"
//  2. Длинные hotwords (>= 4 символов): fuzzy matching со строгими критериями
//     - Длины слов должны отличаться не более чем на 30%
//     - Первые 2 символа должны совпадать (для слов < 8 символов)
//     - Расстояние Левенштейна должно быть <= 15% от длины hotword
//     - Нормализованное сходство >= 0.7
func (h *HybridTranscriber) applyHotwords(merged, primary, secondary []TranscriptSegment) []TranscriptSegment {
	if len(h.config.Hotwords) == 0 {
		return merged
	}

	// Разделяем hotwords на короткие (точное совпадение) и длинные (fuzzy matching)
	var shortHotwords []string // < 4 символов - только точное совпадение
	var longHotwords []string  // >= 4 символов - fuzzy matching
	for _, hw := range h.config.Hotwords {
		hwLen := len([]rune(hw))
		if hwLen < 4 {
			shortHotwords = append(shortHotwords, hw)
			log.Printf("[HybridTranscriber] Hotword '%s' (len=%d): exact match only", hw, hwLen)
		} else {
			longHotwords = append(longHotwords, hw)
		}
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

	// 1. Обрабатываем короткие hotwords - ТОЛЬКО точное совпадение
	for _, hotword := range shortHotwords {
		hotwordLower := strings.ToLower(hotword)
		// Проверяем есть ли точное совпадение в словах
		if allWords[hotwordLower] {
			// Слово уже есть в правильном написании - ничего не делаем
			continue
		}
		// Для коротких hotwords НЕ делаем fuzzy matching - слишком опасно
		// Они будут работать только через initial_prompt в Whisper
	}

	// 2. Обрабатываем длинные hotwords - fuzzy matching со строгими критериями
	for _, hotword := range longHotwords {
		hotwordLower := strings.ToLower(hotword)
		hotwordRunes := []rune(hotwordLower)
		hotwordLen := len(hotwordRunes)

		for word := range allWords {
			wordRunes := []rune(word)
			wordLen := len(wordRunes)

			// Критерий 1: Минимальная длина слова >= 4 символа
			// Короткие слова ("с", "то", "что", "мы") слишком часто ложно срабатывают
			if wordLen < 4 {
				continue
			}

			// Критерий 2: Длины должны быть похожи (разница <= 30%)
			lenDiff := hotwordLen - wordLen
			if lenDiff < 0 {
				lenDiff = -lenDiff
			}
			maxLenDiff := hotwordLen * 30 / 100
			if maxLenDiff < 1 {
				maxLenDiff = 1
			}
			if lenDiff > maxLenDiff {
				continue
			}

			// Критерий 3: Первые 2 символа должны совпадать (для слов < 8 символов)
			// Это отсекает большинство случайных совпадений
			if hotwordLen < 8 && wordLen >= 2 && len(hotwordRunes) >= 2 {
				if wordRunes[0] != hotwordRunes[0] || wordRunes[1] != hotwordRunes[1] {
					continue
				}
			}

			// Критерий 4: Расстояние Левенштейна
			dist := levenshteinDistance(word, hotwordLower)

			// Максимальное расстояние: 15% от длины hotword, минимум 1, максимум 2
			maxDist := hotwordLen * 15 / 100
			if maxDist < 1 {
				maxDist = 1
			}
			if maxDist > 2 {
				maxDist = 2 // Никогда не допускаем больше 2 ошибок
			}

			// Критерий 5: Нормализованное сходство >= 0.7
			maxLen := hotwordLen
			if wordLen > maxLen {
				maxLen = wordLen
			}
			similarity := 1.0 - float64(dist)/float64(maxLen)
			if similarity < 0.7 {
				continue
			}

			if dist <= maxDist && dist > 0 {
				// Слово похоже на hotword - запоминаем замену
				replacements[word] = hotword
				log.Printf("[HybridTranscriber] Hotword fuzzy match: '%s' -> '%s' (dist=%d, maxDist=%d, similarity=%.2f)",
					word, hotword, dist, maxDist, similarity)
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

// areWordsSimilar проверяет семантическое сходство двух слов
// Используется для предотвращения замены несвязанных слов при merge по времени
// Возвращает true если:
// - Слова идентичны (без учёта регистра)
// - Слова отличаются только пунктуацией (нам vs нам.)
// - Расстояние Левенштейна <= 30% от длины более длинного слова
// - Одно слово является частью другого (для составных слов, минимум 4 символа)
func areWordsSimilar(word1, word2 string) bool {
	// Нормализуем слова: lowercase, убираем пунктуацию
	norm1 := normalizeWordForComparison(word1)
	norm2 := normalizeWordForComparison(word2)

	// Точное совпадение после нормализации
	if norm1 == norm2 {
		return true
	}

	// Пустые слова не похожи
	if norm1 == "" || norm2 == "" {
		return false
	}

	// Определяем длины
	len1 := len([]rune(norm1))
	len2 := len([]rune(norm2))
	maxLen := len1
	if len2 > maxLen {
		maxLen = len2
	}
	minLen := len1
	if len2 < minLen {
		minLen = len2
	}

	// Если длины сильно отличаются (более чем в 2 раза) - не похожи
	// Это отсекает случаи типа "а" vs "абракадабра"
	if maxLen > minLen*2 {
		return false
	}

	// Проверяем, является ли одно слово частью другого
	// Например: "EPI-адаптера" содержит "адаптера"
	// НО: только если короткое слово >= 4 символов (чтобы избежать "а" в "абракадабра")
	if minLen >= 4 {
		if strings.Contains(norm1, norm2) || strings.Contains(norm2, norm1) {
			return true
		}
	}

	// Вычисляем расстояние Левенштейна
	dist := levenshteinDistance(norm1, norm2)

	// Допустимое расстояние: 30% от длины более длинного слова, минимум 1
	maxDist := maxLen * 30 / 100
	if maxDist < 1 {
		maxDist = 1
	}

	// Для коротких слов (< 4 символов) требуем более строгое совпадение
	if maxLen < 4 {
		maxDist = 1
	}

	return dist <= maxDist
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
// Использует строгие критерии для избежания ложных срабатываний:
// - Минимальная длина слова и hotword >= 4 символа
// - Первые 2 символа должны совпадать
// - Расстояние Левенштейна <= 15% длины, максимум 2
// - Нормализованное сходство >= 0.75
func matchesHotword(word string, hotwords []string) (bool, string) {
	wordNorm := normalizeWordForComparison(word)
	if wordNorm == "" {
		return false, ""
	}

	wordRunes := []rune(wordNorm)
	wordLen := len(wordRunes)

	// Слишком короткие слова не проверяем - высокий риск ложных срабатываний
	if wordLen < 4 {
		return false, ""
	}

	for _, hw := range hotwords {
		hwNorm := normalizeWordForComparison(hw)
		if hwNorm == "" {
			continue
		}

		hwRunes := []rune(hwNorm)
		hwLen := len(hwRunes)

		// Слишком короткие hotwords пропускаем
		if hwLen < 4 {
			continue
		}

		// Точное совпадение
		if wordNorm == hwNorm {
			return true, hw
		}

		// Проверка длин: разница не более 30%
		lenDiff := hwLen - wordLen
		if lenDiff < 0 {
			lenDiff = -lenDiff
		}
		if lenDiff > hwLen*30/100 {
			continue
		}

		// Первые 2 символа должны совпадать (для слов < 8 символов)
		if hwLen < 8 && wordLen >= 2 && hwLen >= 2 {
			if wordRunes[0] != hwRunes[0] || wordRunes[1] != hwRunes[1] {
				continue
			}
		}

		// Fuzzy matching с строгими критериями
		dist := levenshteinDistance(wordNorm, hwNorm)

		// Максимальное расстояние: 15% от длины hotword, минимум 1, максимум 2
		maxDist := hwLen * 15 / 100
		if maxDist < 1 {
			maxDist = 1
		}
		if maxDist > 2 {
			maxDist = 2
		}

		// Нормализованное сходство должно быть >= 0.75
		maxLen := hwLen
		if wordLen > maxLen {
			maxLen = wordLen
		}
		similarity := 1.0 - float64(dist)/float64(maxLen)

		if dist <= maxDist && dist > 0 && similarity >= 0.75 {
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
