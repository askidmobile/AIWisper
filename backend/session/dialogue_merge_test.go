package session

import (
	"testing"
)

// TestMergeWordsToDialogue_SpeakerInterleaving проверяет правильное чередование спикеров
func TestMergeWordsToDialogue_SpeakerInterleaving(t *testing.T) {
	// Симулируем проблемный сценарий:
	// Собеседник: "Может быть..." (0-2000ms)
	// Вы: "Так, давай-ка..." (1800-4000ms) - небольшое перекрытие
	// Собеседник: "Будешь показывать?" (4200-5500ms)
	// Вы: "угу" (5600-5900ms) - короткая реплика
	// Собеседник: "По-моему, да" (6000-7000ms)

	micSegments := []TranscriptSegment{
		{
			Start:   1800,
			End:     4000,
			Speaker: "Вы",
			Text:    "Так, давай-ка проверим",
			Words: []TranscriptWord{
				{Start: 1800, End: 2200, Text: "Так,", Speaker: "Вы"},
				{Start: 2200, End: 2800, Text: "давай-ка", Speaker: "Вы"},
				{Start: 2800, End: 4000, Text: "проверим", Speaker: "Вы"},
			},
		},
		{
			Start:   5600,
			End:     5900,
			Speaker: "Вы",
			Text:    "угу",
			Words: []TranscriptWord{
				{Start: 5600, End: 5900, Text: "угу", Speaker: "Вы"},
			},
		},
	}

	sysSegments := []TranscriptSegment{
		{
			Start:   0,
			End:     2000,
			Speaker: "Собеседник 1",
			Text:    "Может быть вот это",
			Words: []TranscriptWord{
				{Start: 0, End: 600, Text: "Может", Speaker: "Собеседник 1"},
				{Start: 600, End: 1000, Text: "быть", Speaker: "Собеседник 1"},
				{Start: 1000, End: 1400, Text: "вот", Speaker: "Собеседник 1"},
				{Start: 1400, End: 2000, Text: "это", Speaker: "Собеседник 1"},
			},
		},
		{
			Start:   4200,
			End:     5500,
			Speaker: "Собеседник 1",
			Text:    "Будешь показывать?",
			Words: []TranscriptWord{
				{Start: 4200, End: 4800, Text: "Будешь", Speaker: "Собеседник 1"},
				{Start: 4800, End: 5500, Text: "показывать?", Speaker: "Собеседник 1"},
			},
		},
		{
			Start:   6000,
			End:     7000,
			Speaker: "Собеседник 1",
			Text:    "По-моему, да",
			Words: []TranscriptWord{
				{Start: 6000, End: 6500, Text: "По-моему,", Speaker: "Собеседник 1"},
				{Start: 6500, End: 7000, Text: "да", Speaker: "Собеседник 1"},
			},
		},
	}

	result := mergeWordsToDialogue(micSegments, sysSegments)

	// Ожидаемый порядок:
	// 1. Собеседник: "Может быть вот это"
	// 2. Вы: "Так, давай-ка проверим"
	// 3. Собеседник: "Будешь показывать?"
	// 4. Вы: "угу"
	// 5. Собеседник: "По-моему, да"

	if len(result) < 4 {
		t.Errorf("Expected at least 4 phrases, got %d", len(result))
		for i, r := range result {
			t.Logf("  [%d] %s: %s (%d-%d)", i, r.Speaker, r.Text, r.Start, r.End)
		}
		return
	}

	// Проверяем что короткая реплика "угу" не потерялась
	foundUgu := false
	for _, phrase := range result {
		if phrase.Text == "угу" {
			foundUgu = true
			if !isMicSpeaker(phrase.Speaker) {
				t.Errorf("'угу' should be from mic speaker, got %s", phrase.Speaker)
			}
			break
		}
	}
	if !foundUgu {
		t.Error("Short phrase 'угу' was lost in merge")
		for i, r := range result {
			t.Logf("  [%d] %s: %s (%d-%d)", i, r.Speaker, r.Text, r.Start, r.End)
		}
	}

	// Проверяем что реплики собеседника НЕ склеились в одну
	sysPhraseCount := 0
	for _, phrase := range result {
		if !isMicSpeaker(phrase.Speaker) {
			sysPhraseCount++
		}
	}
	if sysPhraseCount < 3 {
		t.Errorf("Expected at least 3 sys phrases (not merged), got %d", sysPhraseCount)
		for i, r := range result {
			t.Logf("  [%d] %s: %s (%d-%d)", i, r.Speaker, r.Text, r.Start, r.End)
		}
	}

	// Логируем результат для отладки
	t.Log("Result:")
	for i, r := range result {
		t.Logf("  [%d] %s: %s (%d-%d)", i, r.Speaker, r.Text, r.Start, r.End)
	}
}

// TestMergeSegmentsToDialogue_NoWords проверяет fallback когда нет word-level данных
func TestMergeSegmentsToDialogue_NoWords(t *testing.T) {
	micSegments := []TranscriptSegment{
		{Start: 0, End: 2000, Speaker: "Вы", Text: "Привет"},
	}
	sysSegments := []TranscriptSegment{
		{Start: 2500, End: 4000, Speaker: "Собеседник", Text: "Привет"},
	}

	// Используем mergeSegmentsToDialogue который проверяет наличие слов
	result := mergeSegmentsToDialogue(micSegments, sysSegments)

	// Должен использоваться fallback алгоритм (segment-level)
	if len(result) != 2 {
		t.Errorf("Expected 2 phrases, got %d", len(result))
		for i, r := range result {
			t.Logf("  [%d] %s: %s", i, r.Speaker, r.Text)
		}
	}
}

// TestCollectAllWords проверяет сбор слов из обоих каналов
func TestCollectAllWords(t *testing.T) {
	micSegments := []TranscriptSegment{
		{
			Speaker: "Вы",
			Words: []TranscriptWord{
				{Start: 100, End: 200, Text: "Привет"},
				{Start: 200, End: 300, Text: "мир"},
			},
		},
	}
	sysSegments := []TranscriptSegment{
		{
			Speaker: "Собеседник",
			Words: []TranscriptWord{
				{Start: 50, End: 150, Text: "Здравствуй"},
			},
		},
	}

	words := collectAllWords(micSegments, sysSegments)

	if len(words) != 3 {
		t.Errorf("Expected 3 words, got %d", len(words))
	}

	// Проверяем что спикеры проставлены
	for _, w := range words {
		if w.Speaker == "" {
			t.Errorf("Word '%s' has empty speaker", w.Text)
		}
	}
}

// TestIsMicSpeaker проверяет определение спикера микрофона
func TestIsMicSpeaker(t *testing.T) {
	tests := []struct {
		speaker  string
		expected bool
	}{
		{"mic", true},
		{"Вы", true},
		{"sys", false},
		{"Собеседник", false},
		{"Собеседник 1", false},
		{"Собеседник 2", false},
		{"", false},
	}

	for _, tt := range tests {
		result := isMicSpeaker(tt.speaker)
		if result != tt.expected {
			t.Errorf("isMicSpeaker(%q) = %v, expected %v", tt.speaker, result, tt.expected)
		}
	}
}

// TestPostProcessDialogue проверяет объединение коротких фраз
func TestPostProcessDialogue(t *testing.T) {
	phrases := []TranscriptSegment{
		{Start: 0, End: 500, Speaker: "Вы", Text: "Да"},
		{Start: 600, End: 1000, Speaker: "Вы", Text: "конечно"}, // Должно объединиться с предыдущей
		{Start: 2000, End: 3000, Speaker: "Собеседник", Text: "Хорошо"},
	}

	result := postProcessDialogue(phrases)

	// Первые две фразы должны объединиться (короткая пауза 100ms)
	if len(result) != 2 {
		t.Errorf("Expected 2 phrases after post-processing, got %d", len(result))
		for i, r := range result {
			t.Logf("  [%d] %s: %s", i, r.Speaker, r.Text)
		}
		return
	}

	if result[0].Text != "Да конечно" {
		t.Errorf("Expected first phrase to be 'Да конечно', got '%s'", result[0].Text)
	}
}
