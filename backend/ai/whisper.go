package ai

import (
	whisper "aiwisper/ai/binding"
	"log"
	"math"
	"os"
	"strings"
	"sync"
)

// Engine движок распознавания речи на основе whisper.cpp
type Engine struct {
	model     whisper.Model
	modelPath string
	language  string
	mu        sync.Mutex
}

// NewEngine создаёт новый движок с указанной моделью
func NewEngine(modelPath string) (*Engine, error) {
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

	return &Engine{
		model:     model,
		modelPath: modelPath,
		language:  lang,
	}, nil
}

// TranscriptSegment сегмент с таймстемпами
type TranscriptSegment struct {
	Start int64            // миллисекунды
	End   int64            // миллисекунды
	Text  string           // полный текст сегмента
	Words []TranscriptWord // слова с точными timestamps (word-level)
}

// TranscriptWord слово с точными таймстемпами
type TranscriptWord struct {
	Start int64   // миллисекунды
	End   int64   // миллисекунды
	Text  string  // текст слова
	P     float32 // вероятность (confidence)
}

// Transcribe транскрибирует аудио и возвращает текст
func (e *Engine) Transcribe(samples []float32, useContext bool) (string, error) {
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
func (e *Engine) TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error) {
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

	if err := ctx.Process(norm, nil, nil, nil); err != nil {
		return nil, err
	}

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
		log.Printf("Audio RMS %.4f below threshold %.4f", rms, minRMS)
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
		log.Printf("Audio max amplitude %.4f too low", maxAbs)
		return false
	}

	return true
}

// Close закрывает движок
func (e *Engine) Close() {
	if e.model != nil {
		e.model.Close()
	}
}

// SetLanguage устанавливает язык распознавания
func (e *Engine) SetLanguage(lang string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	lang = strings.TrimSpace(lang)
	if lang == "" {
		return
	}
	e.language = lang
}

// SetModel переключает модель
func (e *Engine) SetModel(path string) error {
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
