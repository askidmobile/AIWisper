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
func (s *LLMService) ImproveTranscriptionWithLLM(dialogue []session.TranscriptSegment, ollamaModel string, ollamaUrl string) ([]session.TranscriptSegment, error) {
	resp, err := http.Get(ollamaUrl + "/api/tags")
	if err != nil {
		return nil, fmt.Errorf("Ollama not running at %s", ollamaUrl)
	}
	resp.Body.Close()

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
	if len(text) > 12000 {
		text = text[:12000] + "\n...[trimmed]..."
	}

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

ФОРМАТ ВЫХОДА (строго такой же):
[Вы] Исправленный текст.
[Собеседник] Исправленный текст.

СТРОГИЕ ПРАВИЛА:
- НЕ меняй смысл и порядок слов
- НЕ удаляй и НЕ добавляй реплики
- НЕ объединяй реплики разных спикеров
- Сохраняй порядок реплик
- Если реплика длинная — разбей на несколько строк с ТЕМ ЖЕ спикером
- Отвечай ТОЛЬКО исправленным текстом, без комментариев`

	userPrompt := fmt.Sprintf("Улучши эту транскрипцию:\n\n%s", text)

	reqBody := map[string]interface{}{
		"model": ollamaModel,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"stream":  false,
		"options": map[string]interface{}{"temperature": 0.1, "num_predict": 8192},
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
			speaker = "sys"
			idx := strings.Index(line, "]")
			if idx > 0 {
				text = line[idx+1:]
			}
		case strings.HasPrefix(line, "Вы:"):
			speaker = "mic"
			text = strings.TrimPrefix(line, "Вы:")
		case strings.HasPrefix(line, "Собеседник"):
			// Поддержка Собеседник:, Собеседник 1:, Собеседник 2: и т.д.
			speaker = "sys"
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

		// Определяем timestamps
		var start, end int64

		// Если спикер сменился - берём следующий оригинальный сегмент
		// Если тот же спикер (разбитая реплика) - интерполируем время
		if speaker != lastSpeaker {
			// Новый спикер - синхронизируем с оригиналом
			if origIdx < len(originalDialogue) {
				start = originalDialogue[origIdx].Start
				end = originalDialogue[origIdx].End
				origIdx++
			}
		} else {
			// Тот же спикер - это разбитая реплика от LLM
			// Используем время предыдущего сегмента (примерно)
			if len(improved) > 0 {
				prev := improved[len(improved)-1]
				start = prev.End
				end = start + 2000 // +2 секунды по умолчанию
				// Если есть следующий оригинальный сегмент с тем же спикером - подтягиваем
				if origIdx < len(originalDialogue) && originalDialogue[origIdx].Speaker == speaker {
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
