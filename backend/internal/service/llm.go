package service

import (
	"aiwisper/session"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

type LLMService struct{}

func NewLLMService() *LLMService {
	return &LLMService{}
}

// GenerateSummaryWithLLM generates a summary using Ollama or fallback
func (s *LLMService) GenerateSummaryWithLLM(transcriptText string, ollamaModel string, ollamaUrl string) (string, error) {
	summary, err := s.generateSummaryWithOllama(transcriptText, ollamaModel, ollamaUrl)
	if err == nil && summary != "" {
		return summary, nil
	}
	log.Printf("Ollama not available: %v, using fallback...", err)
	return s.generateSummaryFallback(transcriptText)
}

func (s *LLMService) generateSummaryWithOllama(transcriptText string, model string, baseUrl string) (string, error) {
	resp, err := http.Get(baseUrl + "/api/tags")
	if err != nil {
		return "", fmt.Errorf("Ollama not running at %s", baseUrl)
	}
	resp.Body.Close()

	maxChars := 16000
	text := transcriptText
	if len(text) > maxChars {
		text = text[:maxChars] + "\n...[text trimmed]..."
	}

	systemPrompt := `Ты — ассистент для создания кратких резюме деловых разговоров и встреч.
ТВОЯ ЗАДАЧА: Проанализировать транскрипцию и создать структурированное резюме.
ФОРМАТ ОТВЕТА (строго в Markdown):
## 📋 Тема встречи
[1-2 предложения]
## 🎯 Ключевые моменты
- [пункт 1]
## ✅ Решения и договорённости
- [пункт 1]
## 📌 Следующие шаги
- [пункт 1]
ПРАВИЛА: Markdown, без лишних слов, на русском языке.`

	userPrompt := fmt.Sprintf("Вот транскрипция разговора:\n\n%s", text)

	reqBody := map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"stream": false,
		"options": map[string]interface{}{
			"temperature": 0.3,
			"num_predict": 4096,
		},
	}

	return s.callOllama(baseUrl, reqBody)
}

func (s *LLMService) generateSummaryFallback(transcriptText string) (string, error) {
	lines := strings.Split(transcriptText, "\n")
	if len(lines) == 0 {
		return "", fmt.Errorf("empty transcript")
	}

	var youLines, otherLines, totalWords int
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		words := strings.Fields(line)
		totalWords += len(words)
		if strings.HasPrefix(line, "Вы:") {
			youLines++
		} else if strings.HasPrefix(line, "Собеседник:") {
			otherLines++
		}
	}

	summary := fmt.Sprintf(`📊 Статистика записи:
• Реплик "Вы": %d
• Реплик "Собеседник": %d  
• Всего слов: %d
💡 Для полноценного AI-анализа установите Ollama.`, youLines, otherLines, totalWords)
	return summary, nil
}

// ImproveTranscriptionWithLLM improves transcription quality
// Поддерживает batch обработку для длинных текстов (более 40000 символов)
func (s *LLMService) ImproveTranscriptionWithLLM(dialogue []session.TranscriptSegment, ollamaModel string, ollamaUrl string) ([]session.TranscriptSegment, error) {
	resp, err := http.Get(ollamaUrl + "/api/tags")
	if err != nil {
		return nil, fmt.Errorf("Ollama not running at %s", ollamaUrl)
	}
	resp.Body.Close()

	// Для длинных текстов используем batch обработку
	const maxCharsPerBatch = 40000 // ~10K токенов, безопасно для большинства моделей

	// Считаем общую длину
	totalLen := 0
	for _, seg := range dialogue {
		totalLen += len(seg.Text) + 30 // +30 на метку спикера
	}

	// Если текст короткий - обрабатываем целиком
	if totalLen <= maxCharsPerBatch {
		return s.improveDialogueBatch(dialogue, ollamaModel, ollamaUrl)
	}

	// Разбиваем на батчи по сегментам (не разрезаем реплики)
	log.Printf("LLM Improve: text too long (%d chars), splitting into batches", totalLen)

	var allImproved []session.TranscriptSegment
	var batch []session.TranscriptSegment
	batchLen := 0

	for _, seg := range dialogue {
		segLen := len(seg.Text) + 30

		// Если добавление сегмента превысит лимит - обрабатываем текущий батч
		if batchLen+segLen > maxCharsPerBatch && len(batch) > 0 {
			improved, err := s.improveDialogueBatch(batch, ollamaModel, ollamaUrl)
			if err != nil {
				log.Printf("LLM Improve batch error: %v, keeping original", err)
				allImproved = append(allImproved, batch...)
			} else {
				allImproved = append(allImproved, improved...)
			}
			batch = nil
			batchLen = 0
		}

		batch = append(batch, seg)
		batchLen += segLen
	}

	// Обрабатываем последний батч
	if len(batch) > 0 {
		improved, err := s.improveDialogueBatch(batch, ollamaModel, ollamaUrl)
		if err != nil {
			log.Printf("LLM Improve last batch error: %v, keeping original", err)
			allImproved = append(allImproved, batch...)
		} else {
			allImproved = append(allImproved, improved...)
		}
	}

	return allImproved, nil
}

// improveDialogueBatch улучшает один батч диалога
func (s *LLMService) improveDialogueBatch(dialogue []session.TranscriptSegment, ollamaModel string, ollamaUrl string) ([]session.TranscriptSegment, error) {
	var dialogueText strings.Builder
	for _, seg := range dialogue {
		// Определяем отображаемую метку для LLM
		displaySpeaker := "Вы"
		if seg.Speaker != "" && seg.Speaker != "mic" {
			// Поддержка "sys", "Собеседник", "Собеседник 1", "Собеседник 2", "Speaker N" и т.д.
			switch {
			case strings.HasPrefix(seg.Speaker, "Собеседник"):
				displaySpeaker = seg.Speaker // Уже в нужном формате
			case strings.HasPrefix(seg.Speaker, "Speaker "):
				// "Speaker 0" -> "Собеседник 1"
				var num int
				fmt.Sscanf(seg.Speaker, "Speaker %d", &num)
				displaySpeaker = fmt.Sprintf("Собеседник %d", num+1)
			case seg.Speaker == "sys":
				displaySpeaker = "Собеседник" // Один собеседник без номера
			default:
				// Кастомное имя - сохраняем как есть
				displaySpeaker = seg.Speaker
			}
		}
		dialogueText.WriteString(fmt.Sprintf("[%s] %s\n", displaySpeaker, seg.Text))
	}

	text := dialogueText.String()

	systemPrompt := `Ты — эксперт по редактированию транскрипций русской речи.

ТВОИ ЗАДАЧИ (в порядке приоритета):
1. РАЗДЕЛЯЙ СКЛЕЕННЫЕ СЛОВА: "вопросеянеможо" → "вопросе я не могу", "какомсостояни" → "каком состоянии"
2. Добавляй пунктуацию: точки, запятые, вопросительные и восклицательные знаки
3. Исправляй регистр: начало предложения с заглавной буквы
4. Исправляй очевидные ошибки распознавания (опечатки, пропущенные буквы)
5. РАЗБИВАЙ длинные реплики (больше 2-3 предложений) на отдельные строки с тем же спикером

ФОРМАТ ВХОДА:
[Вы] текст реплики
[Собеседник] текст реплики
[Собеседник 1] текст реплики  
[Собеседник 2] текст реплики

ФОРМАТ ВЫХОДА (строго такой же, СОХРАНЯЯ НОМЕРА СОБЕСЕДНИКОВ):
[Вы] Исправленный текст.
[Собеседник] Исправленный текст.
[Собеседник 1] Исправленный текст.
[Собеседник 2] Исправленный текст.

СТРОГИЕ ПРАВИЛА:
- НЕ меняй смысл и порядок слов
- НЕ удаляй и НЕ добавляй реплики
- НЕ объединяй реплики разных спикеров
- СОХРАНЯЙ ТОЧНЫЕ МЕТКИ СПИКЕРОВ: [Собеседник 1] должен остаться [Собеседник 1], а НЕ [Собеседник]
- Сохраняй порядок реплик
- Если реплика длинная — разбей на несколько строк с ТЕМ ЖЕ спикером и ТОЙ ЖЕ МЕТКОЙ
- Отвечай ТОЛЬКО исправленным текстом, без комментариев`

	userPrompt := fmt.Sprintf("Улучши эту транскрипцию:\n\n%s", text)

	reqBody := map[string]interface{}{
		"model": ollamaModel,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"stream":  false,
		"options": map[string]interface{}{"temperature": 0.1, "num_predict": 16384}, // Увеличен для длинных текстов
	}

	response, err := s.callOllama(ollamaUrl, reqBody)
	if err != nil {
		return nil, err
	}

	return s.parseImprovedDialogue(response, dialogue), nil
}

func (s *LLMService) parseImprovedDialogue(improvedText string, originalDialogue []session.TranscriptSegment) []session.TranscriptSegment {
	lines := strings.Split(improvedText, "\n")
	var improved []session.TranscriptSegment
	origIdx := 0 // Индекс в оригинальном диалоге для timestamps
	var lastSpeakerType string

	// Вспомогательная функция для определения типа спикера (mic или sys)
	getSpeakerType := func(speaker string) string {
		if speaker == "mic" || speaker == "Вы" {
			return "mic"
		}
		return "sys" // Все остальные - собеседники
	}

	// Вспомогательная функция для получения оригинального спикера по типу
	// Это нужно чтобы сохранить оригинальные метки (sys, Speaker 0, etc.)
	getOriginalSpeaker := func(speakerType string, origIdx int) string {
		if origIdx < len(originalDialogue) {
			origSpeaker := originalDialogue[origIdx].Speaker
			origType := getSpeakerType(origSpeaker)
			if origType == speakerType {
				return origSpeaker
			}
		}
		// Fallback: возвращаем стандартные метки
		if speakerType == "mic" {
			return "mic"
		}
		return "sys"
	}

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var parsedSpeakerType, text string

		// Парсим разные форматы спикеров
		switch {
		case strings.HasPrefix(line, "[Вы]"):
			parsedSpeakerType = "mic"
			text = strings.TrimPrefix(line, "[Вы]")
		case strings.HasPrefix(line, "[Собеседник"):
			// Поддержка [Собеседник], [Собеседник 1], [Собеседник 2] и т.д.
			parsedSpeakerType = "sys"
			idx := strings.Index(line, "]")
			if idx > 0 {
				text = line[idx+1:]
			}
		case strings.HasPrefix(line, "Вы:"):
			parsedSpeakerType = "mic"
			text = strings.TrimPrefix(line, "Вы:")
		case strings.HasPrefix(line, "Собеседник"):
			// Поддержка Собеседник:, Собеседник 1:, Собеседник 2: и т.д.
			parsedSpeakerType = "sys"
			idx := strings.Index(line, ":")
			if idx > 0 {
				text = line[idx+1:]
			}
		default:
			// Если строка без префикса - это продолжение предыдущей реплики
			// или мусор от LLM - пропускаем
			continue
		}

		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}

		// Определяем timestamps и оригинального спикера
		var start, end int64
		var speaker string

		// Если тип спикера (mic/sys) сменился - берём следующий оригинальный сегмент
		// Если тот же тип (разбитая реплика) - интерполируем время
		if parsedSpeakerType != lastSpeakerType {
			// Новый тип спикера - синхронизируем с оригиналом
			// Ищем следующий оригинальный сегмент с таким же типом
			for origIdx < len(originalDialogue) {
				origType := getSpeakerType(originalDialogue[origIdx].Speaker)
				if origType == parsedSpeakerType {
					break
				}
				origIdx++
			}

			if origIdx < len(originalDialogue) {
				start = originalDialogue[origIdx].Start
				end = originalDialogue[origIdx].End
				speaker = originalDialogue[origIdx].Speaker // ВАЖНО: сохраняем оригинальную метку!
				origIdx++
			} else {
				// Fallback если не нашли
				speaker = getOriginalSpeaker(parsedSpeakerType, 0)
			}
		} else {
			// Тот же тип спикера - это разбитая реплика от LLM
			// Используем время предыдущего сегмента (примерно)
			if len(improved) > 0 {
				prev := improved[len(improved)-1]
				start = prev.End
				end = start + 2000     // +2 секунды по умолчанию
				speaker = prev.Speaker // Сохраняем того же спикера

				// Если есть следующий оригинальный сегмент с тем же типом спикера - подтягиваем время
				if origIdx < len(originalDialogue) {
					origType := getSpeakerType(originalDialogue[origIdx].Speaker)
					if origType == parsedSpeakerType {
						end = originalDialogue[origIdx].End
						origIdx++
					}
				}
			} else {
				speaker = getOriginalSpeaker(parsedSpeakerType, 0)
			}
		}

		lastSpeakerType = parsedSpeakerType

		improved = append(improved, session.TranscriptSegment{
			Start: start, End: end, Text: text, Speaker: speaker,
		})
	}

	if len(improved) == 0 {
		return originalDialogue
	}
	return improved
}

func (s *LLMService) callOllama(baseUrl string, reqBody interface{}) (string, error) {
	jsonBody, _ := json.Marshal(reqBody)
	client := &http.Client{Timeout: 300 * time.Second}
	resp, err := client.Post(baseUrl+"/api/chat", "application/json", bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var result struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		Error string `json:"error"`
	}
	json.Unmarshal(bodyBytes, &result)

	if result.Error != "" {
		return "", fmt.Errorf("Ollama error: %s", result.Error)
	}
	return strings.TrimSpace(result.Message.Content), nil
}

// OllamaModel represents a model from Ollama API
type OllamaModel struct {
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modified_at"`
	Digest     string `json:"digest"`
	Details    struct {
		Format            string   `json:"format"`
		Family            string   `json:"family"`
		Families          []string `json:"families"`
		ParameterSize     string   `json:"parameter_size"`
		QuantizationLevel string   `json:"quantization_level"`
	} `json:"details"`
}

// DiarizeWithLLM разбивает текст по собеседникам с помощью LLM
// Принимает диалог где все sys-реплики помечены как "Собеседник" и разбивает их по разным собеседникам
func (s *LLMService) DiarizeWithLLM(dialogue []session.TranscriptSegment, ollamaModel string, ollamaUrl string) ([]session.TranscriptSegment, error) {
	resp, err := http.Get(ollamaUrl + "/api/tags")
	if err != nil {
		return nil, fmt.Errorf("Ollama not running at %s", ollamaUrl)
	}
	resp.Body.Close()

	// Для длинных текстов используем batch обработку
	const maxCharsPerBatch = 40000

	totalLen := 0
	for _, seg := range dialogue {
		totalLen += len(seg.Text) + 30
	}

	if totalLen <= maxCharsPerBatch {
		return s.diarizeDialogueBatch(dialogue, ollamaModel, ollamaUrl)
	}

	log.Printf("LLM Diarize: text too long (%d chars), splitting into batches", totalLen)

	var allDiarized []session.TranscriptSegment
	var batch []session.TranscriptSegment
	batchLen := 0

	for _, seg := range dialogue {
		segLen := len(seg.Text) + 30

		if batchLen+segLen > maxCharsPerBatch && len(batch) > 0 {
			diarized, err := s.diarizeDialogueBatch(batch, ollamaModel, ollamaUrl)
			if err != nil {
				log.Printf("LLM Diarize batch error: %v, keeping original", err)
				allDiarized = append(allDiarized, batch...)
			} else {
				allDiarized = append(allDiarized, diarized...)
			}
			batch = nil
			batchLen = 0
		}

		batch = append(batch, seg)
		batchLen += segLen
	}

	if len(batch) > 0 {
		diarized, err := s.diarizeDialogueBatch(batch, ollamaModel, ollamaUrl)
		if err != nil {
			log.Printf("LLM Diarize last batch error: %v, keeping original", err)
			allDiarized = append(allDiarized, batch...)
		} else {
			allDiarized = append(allDiarized, diarized...)
		}
	}

	return allDiarized, nil
}

// diarizeDialogueBatch разбивает один батч диалога по собеседникам
func (s *LLMService) diarizeDialogueBatch(dialogue []session.TranscriptSegment, ollamaModel string, ollamaUrl string) ([]session.TranscriptSegment, error) {
	var dialogueText strings.Builder
	for _, seg := range dialogue {
		speaker := "Вы"
		if seg.Speaker != "" && seg.Speaker != "mic" {
			speaker = "Собеседник"
		}
		dialogueText.WriteString(fmt.Sprintf("[%s] %s\n", speaker, seg.Text))
	}

	text := dialogueText.String()

	systemPrompt := `Ты — эксперт по анализу диалогов и определению говорящих.

ТВОЯ ЗАДАЧА:
Проанализировать диалог и разбить реплики "Собеседник" по разным собеседникам (Собеседник 1, Собеседник 2 и т.д.)
на основе контекста, стиля речи, логики беседы.

ФОРМАТ ВХОДА:
[Вы] текст вашей реплики
[Собеседник] текст реплики собеседника

ФОРМАТ ВЫХОДА (ОБЯЗАТЕЛЬНО с нумерацией собеседников):
[Вы] текст вашей реплики
[Собеседник 1] текст первого собеседника
[Собеседник 2] текст второго собеседника

ПРАВИЛА ОПРЕДЕЛЕНИЯ СОБЕСЕДНИКОВ:
1. Анализируй контекст: разные темы обсуждения = разные собеседники
2. Анализируй стиль: формальный/неформальный, технический/бытовой
3. Анализируй логику: если реплики противоречат друг другу - скорее всего разные люди
4. Если разговор один-на-один (только 1 собеседник) - используй просто "Собеседник 1"
5. НЕ меняй текст реплик, только метки спикеров
6. НЕ объединяй и НЕ разделяй реплики
7. Сохраняй порядок реплик
8. Отвечай ТОЛЬКО размеченным текстом, без комментариев`

	userPrompt := fmt.Sprintf("Разбей этот диалог по собеседникам:\n\n%s", text)

	reqBody := map[string]interface{}{
		"model": ollamaModel,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"stream":  false,
		"options": map[string]interface{}{"temperature": 0.2, "num_predict": 16384},
	}

	response, err := s.callOllama(ollamaUrl, reqBody)
	if err != nil {
		return nil, err
	}

	return s.parseDiarizedDialogue(response, dialogue), nil
}

// parseDiarizedDialogue парсит результат диаризации от LLM
// ВАЖНО: Использует fuzzy matching по тексту для сопоставления timestamps
// Это гарантирует что реплики "Вы" не потеряются даже если LLM изменит порядок
func (s *LLMService) parseDiarizedDialogue(diarizedText string, originalDialogue []session.TranscriptSegment) []session.TranscriptSegment {
	lines := strings.Split(diarizedText, "\n")
	var result []session.TranscriptSegment

	// Создаём карту оригинальных реплик для fuzzy matching
	// Ключ - нормализованный текст (lowercase, без пробелов по краям)
	type origSegment struct {
		seg  session.TranscriptSegment
		used bool
	}
	origMap := make([]origSegment, len(originalDialogue))
	for i, seg := range originalDialogue {
		origMap[i] = origSegment{seg: seg, used: false}
	}

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var speaker, text string

		switch {
		case strings.HasPrefix(line, "[Вы]"):
			speaker = "mic"
			text = strings.TrimPrefix(line, "[Вы]")
		case strings.HasPrefix(line, "[Собеседник"):
			idx := strings.Index(line, "]")
			if idx > 0 {
				speakerLabel := strings.TrimSpace(line[1:idx])
				speaker = speakerLabel
				text = line[idx+1:]
			}
		case strings.HasPrefix(line, "Вы:"):
			speaker = "mic"
			text = strings.TrimPrefix(line, "Вы:")
		case strings.HasPrefix(line, "Собеседник"):
			idx := strings.Index(line, ":")
			if idx > 0 {
				speakerLabel := strings.TrimSpace(line[:idx])
				speaker = speakerLabel
				text = line[idx+1:]
			}
		default:
			continue
		}

		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}

		// Ищем наиболее похожую оригинальную реплику для timestamps
		var start, end int64
		bestMatchIdx := -1
		bestMatchScore := 0.0

		normalizedText := strings.ToLower(strings.TrimSpace(text))

		for i, orig := range origMap {
			if orig.used {
				continue
			}

			origText := strings.ToLower(strings.TrimSpace(orig.seg.Text))

			// Вычисляем схожесть текстов
			score := textSimilarity(normalizedText, origText)

			// Бонус за совпадение типа спикера (mic vs sys)
			origIsMic := orig.seg.Speaker == "mic" || orig.seg.Speaker == "Вы"
			newIsMic := speaker == "mic"
			if origIsMic == newIsMic {
				score += 0.1
			}

			if score > bestMatchScore {
				bestMatchScore = score
				bestMatchIdx = i
			}
		}

		// Если нашли хорошее совпадение (>50%) - используем его timestamps
		if bestMatchIdx >= 0 && bestMatchScore > 0.5 {
			start = origMap[bestMatchIdx].seg.Start
			end = origMap[bestMatchIdx].seg.End
			origMap[bestMatchIdx].used = true
		} else if len(result) > 0 {
			// Если не нашли - интерполируем от предыдущей реплики
			prev := result[len(result)-1]
			start = prev.End
			end = start + 2000 // +2 секунды
		}

		result = append(result, session.TranscriptSegment{
			Start:   start,
			End:     end,
			Text:    text,
			Speaker: speaker,
		})
	}

	// Добавляем неиспользованные оригинальные реплики (которые LLM пропустил)
	for _, orig := range origMap {
		if !orig.used {
			// Сохраняем оригинальную реплику с её timestamps
			result = append(result, orig.seg)
		}
	}

	// Сортируем по времени начала
	sortSegmentsByTime(result)

	if len(result) == 0 {
		return originalDialogue
	}
	return result
}

// textSimilarity вычисляет схожесть двух строк (0.0 - 1.0)
// Использует Jaccard similarity на основе слов
func textSimilarity(a, b string) float64 {
	wordsA := strings.Fields(a)
	wordsB := strings.Fields(b)

	if len(wordsA) == 0 && len(wordsB) == 0 {
		return 1.0
	}
	if len(wordsA) == 0 || len(wordsB) == 0 {
		return 0.0
	}

	// Создаём множества слов
	setA := make(map[string]bool)
	for _, w := range wordsA {
		setA[w] = true
	}

	setB := make(map[string]bool)
	for _, w := range wordsB {
		setB[w] = true
	}

	// Считаем пересечение и объединение
	intersection := 0
	for w := range setA {
		if setB[w] {
			intersection++
		}
	}

	union := len(setA)
	for w := range setB {
		if !setA[w] {
			union++
		}
	}

	if union == 0 {
		return 0.0
	}

	return float64(intersection) / float64(union)
}

// sortSegmentsByTime сортирует сегменты по времени начала
func sortSegmentsByTime(segments []session.TranscriptSegment) {
	for i := 0; i < len(segments)-1; i++ {
		for j := i + 1; j < len(segments); j++ {
			if segments[j].Start < segments[i].Start {
				segments[i], segments[j] = segments[j], segments[i]
			}
		}
	}
}

// SelectBestTranscription выбирает лучший вариант транскрипции с помощью LLM
// Используется для гибридной транскрипции
// LLM может выбрать один из вариантов или создать комбинированный вариант
func (s *LLMService) SelectBestTranscription(original, alternative, context, ollamaModel, ollamaUrl string) (string, error) {
	resp, err := http.Get(ollamaUrl + "/api/tags")
	if err != nil {
		return "", fmt.Errorf("Ollama not running at %s", ollamaUrl)
	}
	resp.Body.Close()

	systemPrompt := `Ты — эксперт по улучшению транскрипций русской речи.

ТВОЯ ЗАДАЧА:
Создать наилучшую транскрипцию на основе двух вариантов от разных моделей распознавания речи.

ВАЖНО: Модели часто ошибаются по-разному:
- Одна модель может лучше распознать имена и термины
- Другая может лучше расставить пунктуацию
- Обе могут пропустить или исказить разные слова

КРИТЕРИИ (в порядке приоритета):
1. ПРАВИЛЬНОСТЬ СЛОВ — выбирай слова, которые имеют смысл в контексте
2. ПОЛНОТА — не теряй слова, которые есть в одном варианте
3. Имена собственные — "Люха", "Лёша" лучше чем "Ильюха" если контекст неформальный
4. Технические термины — "notify", "API", "B2C" должны быть корректны
5. Пунктуация — добавь точки, запятые, вопросительные знаки

ЧТО МОЖНО ДЕЛАТЬ:
- Выбрать один из вариантов целиком
- Взять слова из разных вариантов и объединить
- Исправить очевидные ошибки (например "протиФ" → "про notify")
- Добавить пунктуацию

ФОРМАТ ОТВЕТА:
Верни ТОЛЬКО итоговый текст транскрипции, без объяснений.`

	userPrompt := fmt.Sprintf(`Контекст (предыдущие реплики):
%s

Вариант 1:
%s

Вариант 2:
%s

Создай лучшую транскрипцию:`, context, original, alternative)

	reqBody := map[string]interface{}{
		"model": ollamaModel,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"stream": false,
		"options": map[string]interface{}{
			"temperature": 0.1,
			"num_predict": 512,
		},
	}

	response, err := s.callOllama(ollamaUrl, reqBody)
	if err != nil {
		return "", err
	}

	response = strings.TrimSpace(response)

	// Если LLM вернул пустой ответ — возвращаем оригинал
	if len(response) == 0 {
		return original, nil
	}

	// Проверяем что ответ не слишком короткий (защита от галлюцинаций)
	// Ответ должен быть хотя бы 30% длины оригинала
	if len(response) < len(original)/3 {
		log.Printf("[SelectBestTranscription] Response too short (%d vs %d), keeping original", len(response), len(original))
		return original, nil
	}

	// Проверяем схожесть с вариантами
	origSim := textSimilarity(strings.ToLower(response), strings.ToLower(original))
	altSim := textSimilarity(strings.ToLower(response), strings.ToLower(alternative))

	log.Printf("[SelectBestTranscription] Similarity: orig=%.2f, alt=%.2f", origSim, altSim)

	// Если ответ совсем не похож ни на один вариант (< 30% схожести) — это галлюцинация
	if origSim < 0.3 && altSim < 0.3 {
		log.Printf("[SelectBestTranscription] Response not similar to either variant, keeping original")
		return original, nil
	}

	// Возвращаем ответ LLM (может быть комбинированным)
	return response, nil
}

// GetOllamaModels gets models list from Ollama
func (s *LLMService) GetOllamaModels(baseUrl string) ([]OllamaModel, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(baseUrl + "/api/tags")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Ollama API returned status: %d", resp.StatusCode)
	}

	var result struct {
		Models []OllamaModel `json:"models"`
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, err
	}

	return result.Models, nil
}
