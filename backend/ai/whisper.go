package ai

import (
	whisper "aiwisper/ai/binding"
	"log"
	"math"
	"os"
	"strings"
	"sync"
)

// WhisperEngine движок распознавания речи на основе whisper.cpp
// Реализует интерфейс TranscriptionEngine
type WhisperEngine struct {
	model     whisper.Model
	modelPath string
	language  string
	mu        sync.Mutex
}

// Engine алиас для обратной совместимости
// Deprecated: используйте WhisperEngine
type Engine = WhisperEngine

// Проверяем что WhisperEngine реализует TranscriptionEngine
var _ TranscriptionEngine = (*WhisperEngine)(nil)

// NewWhisperEngine создаёт новый движок с указанной моделью
func NewWhisperEngine(modelPath string) (*WhisperEngine, error) {
	if _, err := os.Stat(modelPath); os.IsNotExist(err) {
		return nil, err
	}

	model, err := whisper.New(modelPath)
	if err != nil {
		return nil, err
	}

	lang := strings.TrimSpace(os.Getenv("WHISPER_LANG"))
	if lang == "" {
		lang = "auto"
	}

	log.Printf("Whisper init: language=%s model=%s", lang, modelPath)

	return &WhisperEngine{
		model:     model,
		modelPath: modelPath,
		language:  lang,
	}, nil
}

// NewEngine алиас для обратной совместимости
// Deprecated: используйте NewWhisperEngine
func NewEngine(modelPath string) (*WhisperEngine, error) {
	return NewWhisperEngine(modelPath)
}

// Name возвращает имя движка
func (e *WhisperEngine) Name() string {
	return "whisper"
}

// SupportedLanguages возвращает список поддерживаемых языков
func (e *WhisperEngine) SupportedLanguages() []string {
	return []string{
		"auto", "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr",
		"pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he",
		"uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur",
		"hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv",
		"bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy",
		"ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km",
		"sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am",
		"yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb",
		"my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su",
	}
}

// Transcribe транскрибирует аудио и возвращает текст
func (e *WhisperEngine) Transcribe(samples []float32, useContext bool) (string, error) {
	segments, err := e.TranscribeWithSegments(samples)
	if err != nil {
		return "", err
	}

	var texts []string
	for _, seg := range segments {
		if seg.Text != "" {
			texts = append(texts, seg.Text)
		}
	}
	return strings.Join(texts, " "), nil
}

// TranscribeWithSegments возвращает сегменты с таймстемпами
func (e *WhisperEngine) TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Проверяем что аудио содержит речь
	if !hasSignificantAudio(samples) {
		log.Printf("Skipping transcription: audio too quiet or no speech detected")
		return nil, nil
	}

	norm := normalize(samples)

	ctx, err := e.model.NewContext()
	if err != nil {
		return nil, err
	}

	if err := ctx.SetLanguage(e.language); err != nil {
		log.Printf("Failed to set language %q, falling back to auto: %v", e.language, err)
		_ = ctx.SetLanguage("auto")
	} else {
		ctx.SetTranslate(false)
	}

	// Настройки для качественной транскрипции
	ctx.SetBeamSize(5)
	ctx.SetTemperature(0.0)
	ctx.SetTemperatureFallback(0.2)
	ctx.SetMaxTokensPerSegment(128)
	ctx.SetSplitOnWord(true)
	ctx.SetEntropyThold(2.4)
	ctx.SetMaxContext(-1) // Отключаем контекст для предотвращения зацикливания

	// Включаем таймстемпы токенов для точных временных меток
	ctx.SetTokenTimestamps(true)

	// Начальный промпт для предотвращения галлюцинаций
	// Пустой промпт помогает избежать "Продолжение следует..." и подобных артефактов
	ctx.SetInitialPrompt("")

	log.Printf("TranscribeWithSegments: samples=%d duration=%.1fs lang=%s", len(samples), float64(len(samples))/16000, e.language)

	// Callback для отслеживания прогресса
	progressCb := func(progress int) {
		if progress%10 == 0 { // Логируем каждые 10%
			log.Printf("TranscribeWithSegments progress: %d%%", progress)
		}
	}

	log.Printf("TranscribeWithSegments: starting ctx.Process...")
	if err := ctx.Process(norm, nil, nil, progressCb); err != nil {
		log.Printf("TranscribeWithSegments: ctx.Process error: %v", err)
		return nil, err
	}
	log.Printf("TranscribeWithSegments: ctx.Process completed")

	// Собираем сегменты с таймстемпами и словами
	var segments []TranscriptSegment
	for {
		segment, err := ctx.NextSegment()
		if err != nil {
			break
		}

		text := strings.TrimSpace(segment.Text)
		if text == "" {
			continue
		}

		// Фильтруем типичные галлюцинации whisper
		if isHallucination(text) {
			log.Printf("Filtered hallucination: %q", text)
			continue
		}

		// Проверяем, что в сегменте действительно есть звук (фильтрация галлюцинаций на тишине)
		if isSegmentSilence(samples, segment.Start.Milliseconds(), segment.End.Milliseconds()) {
			log.Printf("Filtered silence hallucination: %q at %v-%v", text, segment.Start, segment.End)
			continue
		}

		// Извлекаем слова из токенов
		words := extractWordsFromTokens(segment.Tokens)

		segments = append(segments, TranscriptSegment{
			Start: segment.Start.Milliseconds(),
			End:   segment.End.Milliseconds(),
			Text:  text,
			Words: words,
		})
	}

	log.Printf("TranscribeWithSegments: got %d segments", len(segments))
	return segments, nil
}

// extractWordsFromTokens группирует токены в слова
// Токены whisper могут быть подсловами (subwords), нужно объединить их в слова
func extractWordsFromTokens(tokens []whisper.Token) []TranscriptWord {
	if len(tokens) == 0 {
		return nil
	}

	var words []TranscriptWord
	var currentWord TranscriptWord
	var currentText strings.Builder
	inWord := false

	for _, token := range tokens {
		text := token.Text

		// Пропускаем специальные токены (начинаются с < или [)
		if strings.HasPrefix(text, "<") || strings.HasPrefix(text, "[") {
			continue
		}

		// Пропускаем пустые токены
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			// Пробел означает конец слова
			if inWord && currentText.Len() > 0 {
				currentWord.Text = strings.TrimSpace(currentText.String())
				if currentWord.Text != "" {
					words = append(words, currentWord)
				}
				currentText.Reset()
				inWord = false
			}
			continue
		}

		// Если токен начинается с пробела - это новое слово
		if strings.HasPrefix(text, " ") {
			// Сохраняем предыдущее слово
			if inWord && currentText.Len() > 0 {
				currentWord.Text = strings.TrimSpace(currentText.String())
				if currentWord.Text != "" {
					words = append(words, currentWord)
				}
				currentText.Reset()
			}
			// Начинаем новое слово
			currentWord = TranscriptWord{
				Start: token.Start.Milliseconds(),
				End:   token.End.Milliseconds(),
				P:     token.P,
			}
			currentText.WriteString(strings.TrimPrefix(text, " "))
			inWord = true
		} else if inWord {
			// Продолжаем текущее слово (subword)
			currentText.WriteString(text)
			currentWord.End = token.End.Milliseconds()
			// Усредняем вероятность
			currentWord.P = (currentWord.P + token.P) / 2
		} else {
			// Первый токен без пробела - начало слова
			currentWord = TranscriptWord{
				Start: token.Start.Milliseconds(),
				End:   token.End.Milliseconds(),
				P:     token.P,
			}
			currentText.WriteString(text)
			inWord = true
		}
	}

	// Добавляем последнее слово
	if inWord && currentText.Len() > 0 {
		currentWord.Text = strings.TrimSpace(currentText.String())
		if currentWord.Text != "" {
			words = append(words, currentWord)
		}
	}

	return words
}

// isHallucination проверяет, является ли текст типичной галлюцинацией whisper
func isHallucination(text string) bool {
	// Приводим к нижнему регистру для сравнения
	lower := strings.ToLower(text)

	// Типичные галлюцинации whisper
	hallucinations := []string{
		"продолжение следует",
		"продолжение в следующем",
		"спасибо за просмотр",
		"подписывайтесь на канал",
		"ставьте лайки",
		"до свидания",
		"до новых встреч",
		"всего доброго",
		"благодарю за внимание",
		"конец записи",
		"субтитры",
		"subtitles",
		"редактор субтитров",
		"корректор",
		"а.семкин",
		"а.егорова",
		"семкин",
		"егорова",
		"thank you for watching",
		"please subscribe",
		"www.",
		"http",
		"[музыка]",
		"[music]",
		"[аплодисменты]",
		"[applause]",
		"все это было в течение",
		"это было в течение",
	}

	for _, h := range hallucinations {
		if strings.Contains(lower, h) {
			return true
		}
	}

	// Слишком короткий текст (менее 3 символов без пробелов)
	trimmed := strings.ReplaceAll(text, " ", "")
	if len(trimmed) < 3 {
		return true
	}

	// Повторяющиеся символы (например "ааааа" или "...")
	if isRepeatingPattern(text) {
		return true
	}

	return false
}

// isRepeatingPattern проверяет на повторяющиеся паттерны
func isRepeatingPattern(text string) bool {
	// Убираем пробелы
	clean := strings.ReplaceAll(text, " ", "")
	if len(clean) < 4 {
		return false
	}

	// Проверяем на повторение одного символа
	first := rune(clean[0])
	allSame := true
	for _, r := range clean {
		if r != first {
			allSame = false
			break
		}
	}
	if allSame {
		return true
	}

	// Проверяем на "..." или подобные паттерны
	if strings.Count(text, ".") > len(text)/2 {
		return true
	}

	return false
}

// hasSignificantAudio проверяет что аудио содержит значимый сигнал
func hasSignificantAudio(samples []float32) bool {
	if len(samples) < 1600 {
		return false
	}

	var sum float64
	for _, s := range samples {
		sum += float64(s * s)
	}
	rms := math.Sqrt(sum / float64(len(samples)))

	const minRMS = 0.005
	if rms < minRMS {
		// log.Printf("Audio RMS %.4f below threshold %.4f", rms, minRMS) // Too noisy for segments
		return false
	}

	var maxAbs float32
	for _, s := range samples {
		if s > maxAbs {
			maxAbs = s
		} else if -s > maxAbs {
			maxAbs = -s
		}
	}

	if maxAbs < 0.01 {
		// log.Printf("Audio max amplitude %.4f too low", maxAbs) // Too noisy
		return false
	}

	return true
}

// isSegmentSilence проверяет, является ли сегмент тишиной
func isSegmentSilence(samples []float32, startMs, endMs int64) bool {
	startIdx := int(startMs * 16) // 16 samples per ms
	endIdx := int(endMs * 16)

	if startIdx < 0 {
		startIdx = 0
	}
	if endIdx > len(samples) {
		endIdx = len(samples)
	}
	if startIdx >= endIdx {
		return true
	}

	// Для очень коротких сегментов (< 0.1s) проверка может быть ненадежной,
	// но Whisper редко выдает такие короткие сегменты с речью.
	// Если сегмент очень короткий, лучше его оставить (или проверить контекст?)
	// Пока проверяем как обычно.
	segSamples := samples[startIdx:endIdx]
	return !hasSignificantAudio(segSamples)
}

// TranscribeHighQuality выполняет высококачественную транскрипцию для полных файлов
// Параметры унифицированы с TranscribeWithSegments для консистентного качества
func (e *WhisperEngine) TranscribeHighQuality(samples []float32) ([]TranscriptSegment, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Используем такую же проверку как в TranscribeWithSegments для консистентности
	if !hasSignificantAudio(samples) {
		log.Printf("TranscribeHighQuality: audio too quiet or no speech detected")
		return nil, nil
	}

	// Логируем характеристики аудио для диагностики
	var sum float64
	var maxAbs float32
	for _, s := range samples {
		sum += float64(s * s)
		if s > maxAbs {
			maxAbs = s
		} else if -s > maxAbs {
			maxAbs = -s
		}
	}
	rms := math.Sqrt(sum / float64(len(samples)))
	log.Printf("TranscribeHighQuality: samples=%d, RMS=%.4f, maxAmp=%.4f", len(samples), rms, maxAbs)

	norm := normalize(samples)

	ctx, err := e.model.NewContext()
	if err != nil {
		return nil, err
	}

	if err := ctx.SetLanguage(e.language); err != nil {
		log.Printf("Failed to set language %q, falling back to auto: %v", e.language, err)
		_ = ctx.SetLanguage("auto")
	} else {
		ctx.SetTranslate(false)
	}

	// ВЫСОКОКАЧЕСТВЕННЫЕ НАСТРОЙКИ для полной транскрипции
	// Унифицированы с TranscribeWithSegments для консистентного качества

	// Beam search с большим размером для лучшего качества
	ctx.SetBeamSize(5)

	// Температура 0 для детерминистичного вывода (beam search)
	ctx.SetTemperature(0.0)
	// Fallback температура при низкой уверенности
	ctx.SetTemperatureFallback(0.2)

	// Порог энтропии для определения галлюцинаций
	ctx.SetEntropyThold(2.4)

	// Максимум токенов на сегмент (такой же как в realtime для консистентности)
	ctx.SetMaxTokensPerSegment(128)

	// Разделение по словам для точных timestamps
	ctx.SetSplitOnWord(true)

	// Используем контекст как в realtime транскрипции
	// -1 означает использование всего доступного контекста, что улучшает качество
	ctx.SetMaxContext(-1)

	// Включаем таймстемпы токенов для точных временных меток
	ctx.SetTokenTimestamps(true)

	// Промпт с русским контекстом для улучшения распознавания
	// Содержит типичные слова и помогает модели понять контекст
	ctx.SetInitialPrompt("Привет. Разговор о работе, техкомитет, архитектура, разработка.")

	log.Printf("TranscribeHighQuality: samples=%d duration=%.1fs lang=%s beam=5 temp=0.0",
		len(samples), float64(len(samples))/16000, e.language)

	log.Printf("TranscribeHighQuality: calling ctx.Process...")
	if err := ctx.Process(norm, nil, nil, nil); err != nil {
		log.Printf("TranscribeHighQuality: ctx.Process error: %v", err)
		return nil, err
	}
	log.Printf("TranscribeHighQuality: ctx.Process completed, collecting segments...")

	// Собираем сегменты с таймстемпами и словами
	var segments []TranscriptSegment
	segmentCount := 0
	emptyCount := 0
	hallucinationCount := 0
	for {
		segment, err := ctx.NextSegment()
		if err != nil {
			log.Printf("TranscribeHighQuality: NextSegment ended with: %v", err)
			break
		}
		segmentCount++

		text := strings.TrimSpace(segment.Text)
		if text == "" {
			emptyCount++
			continue
		}

		// Фильтруем типичные галлюцинации whisper
		if isHallucination(text) {
			hallucinationCount++
			log.Printf("Filtered hallucination: %q", text)
			continue
		}

		// Проверяем, что в сегменте действительно есть звук (фильтрация галлюцинаций на тишине)
		if isSegmentSilence(samples, segment.Start.Milliseconds(), segment.End.Milliseconds()) {
			hallucinationCount++
			log.Printf("Filtered silence hallucination: %q at %v-%v", text, segment.Start, segment.End)
			continue
		}

		// Извлекаем слова из токенов
		words := extractWordsFromTokens(segment.Tokens)

		segments = append(segments, TranscriptSegment{
			Start: segment.Start.Milliseconds(),
			End:   segment.End.Milliseconds(),
			Text:  text,
			Words: words,
		})
	}

	log.Printf("TranscribeHighQuality: raw=%d, empty=%d, hallucinations=%d, final=%d segments",
		segmentCount, emptyCount, hallucinationCount, len(segments))
	return segments, nil
}

// Close закрывает движок
func (e *WhisperEngine) Close() {
	if e.model != nil {
		e.model.Close()
	}
}

// SetLanguage устанавливает язык распознавания
func (e *WhisperEngine) SetLanguage(lang string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	lang = strings.TrimSpace(lang)
	if lang == "" {
		return
	}
	e.language = lang
}

// SetModel переключает модель
func (e *WhisperEngine) SetModel(path string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}

	if path == e.modelPath {
		return nil
	}

	if _, err := os.Stat(path); err != nil {
		return err
	}

	log.Printf("Switching model from %s to %s", e.modelPath, path)

	newModel, err := whisper.New(path)
	if err != nil {
		return err
	}

	old := e.model
	e.model = newModel
	e.modelPath = path
	if old != nil {
		old.Close()
	}
	return nil
}

// normalize нормализует аудио
func normalize(in []float32) []float32 {
	const targetRMS = 0.03
	if len(in) == 0 {
		return in
	}
	var sum float64
	for _, s := range in {
		sum += float64(s * s)
	}
	rms := math.Sqrt(sum / float64(len(in)))
	scale := targetRMS / (rms + 1e-6)
	if scale > 5.0 {
		scale = 5.0
	}
	out := make([]float32, len(in))
	for i, v := range in {
		x := float64(v) * scale
		if x > 1 {
			x = 1
		} else if x < -1 {
			x = -1
		}
		out[i] = float32(x)
	}
	return out
}
