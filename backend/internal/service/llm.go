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
		speaker := "Вы"
		if seg.Speaker != "" && seg.Speaker != "mic" {
			// Поддержка "sys", "Собеседник", "Собеседник 1", "Собеседник 2" и т.д.
			if strings.HasPrefix(seg.Speaker, "Собеседник") {
				speaker = seg.Speaker
			} else {
				speaker = "Собеседник"
			}
		}
		dialogueText.WriteString(fmt.Sprintf("[%s] %s\n", speaker, seg.Text))
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
	var lastSpeaker string

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var speaker, text string

		// Парсим разные форматы спикеров
		switch {
		case strings.HasPrefix(line, "[Вы]"):
			speaker = "mic"
			text = strings.TrimPrefix(line, "[Вы]")
		case strings.HasPrefix(line, "[Собеседник"):
			// Поддержка [Собеседник], [Собеседник 1], [Собеседник 2] и т.д.
			// ВАЖНО: сохраняем номер собеседника!
			idx := strings.Index(line, "]")
			if idx > 0 {
				speakerLabel := strings.TrimSpace(line[1:idx]) // "Собеседник" или "Собеседник 1"
				// Извлекаем номер собеседника если есть
				if speakerLabel == "Собеседник" {
					speaker = "Собеседник"
				} else {
					// "Собеседник 1", "Собеседник 2" и т.д. - сохраняем как есть
					speaker = speakerLabel
				}
				text = line[idx+1:]
			}
		case strings.HasPrefix(line, "Вы:"):
			speaker = "mic"
			text = strings.TrimPrefix(line, "Вы:")
		case strings.HasPrefix(line, "Собеседник"):
			// Поддержка Собеседник:, Собеседник 1:, Собеседник 2: и т.д.
			// ВАЖНО: сохраняем номер собеседника!
			idx := strings.Index(line, ":")
			if idx > 0 {
				speakerLabel := strings.TrimSpace(line[:idx]) // "Собеседник" или "Собеседник 1"
				speaker = speakerLabel
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

		// Определяем timestamps
		var start, end int64

		// Нормализуем спикера для сравнения (mic vs Собеседник*)
		speakerType := speaker
		if speaker == "mic" {
			speakerType = "mic"
		} else if strings.HasPrefix(speaker, "Собеседник") {
			speakerType = "sys" // Все собеседники - это "sys" канал
		}

		lastSpeakerType := lastSpeaker
		if lastSpeaker == "mic" {
			lastSpeakerType = "mic"
		} else if strings.HasPrefix(lastSpeaker, "Собеседник") {
			lastSpeakerType = "sys"
		}

		// Если тип спикера (mic/sys) сменился - берём следующий оригинальный сегмент
		// Если тот же тип (разбитая реплика) - интерполируем время
		if speakerType != lastSpeakerType {
			// Новый тип спикера - синхронизируем с оригиналом
			if origIdx < len(originalDialogue) {
				start = originalDialogue[origIdx].Start
				end = originalDialogue[origIdx].End
				origIdx++
			}
		} else {
			// Тот же тип спикера - это разбитая реплика от LLM
			// Используем время предыдущего сегмента (примерно)
			if len(improved) > 0 {
				prev := improved[len(improved)-1]
				start = prev.End
				end = start + 2000 // +2 секунды по умолчанию
				// Если есть следующий оригинальный сегмент с тем же типом спикера - подтягиваем
				origSpeakerType := ""
				if origIdx < len(originalDialogue) {
					if originalDialogue[origIdx].Speaker == "mic" {
						origSpeakerType = "mic"
					} else {
						origSpeakerType = "sys"
					}
				}
				if origIdx < len(originalDialogue) && origSpeakerType == speakerType {
					end = originalDialogue[origIdx].End
					origIdx++
				}
			}
		}

		lastSpeaker = speaker

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
func (s *LLMService) parseDiarizedDialogue(diarizedText string, originalDialogue []session.TranscriptSegment) []session.TranscriptSegment {
	lines := strings.Split(diarizedText, "\n")
	var result []session.TranscriptSegment
	origIdx := 0

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

		// Берём timestamps из оригинального диалога
		var start, end int64
		if origIdx < len(originalDialogue) {
			start = originalDialogue[origIdx].Start
			end = originalDialogue[origIdx].End
			origIdx++
		}

		result = append(result, session.TranscriptSegment{
			Start:   start,
			End:     end,
			Text:    text,
			Speaker: speaker,
		})
	}

	if len(result) == 0 {
		return originalDialogue
	}
	return result
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
