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

// TestFixAnomalousTimestamps проверяет коррекцию аномально длинных слов
func TestFixAnomalousTimestamps(t *testing.T) {
	segments := []TranscriptSegment{
		{
			Start:   0,
			End:     10000,
			Speaker: "Собеседник",
			Text:    "Это будешь показывать?",
			Words: []TranscriptWord{
				// "Это" длится 6 секунд - аномалия
				{Start: 0, End: 6000, Text: "Это", Speaker: "Собеседник"},
				{Start: 6500, End: 7000, Text: "будешь", Speaker: "Собеседник"},
				{Start: 7000, End: 8000, Text: "показывать?", Speaker: "Собеседник"},
			},
		},
	}

	result := fixAnomalousTimestamps(segments)

	// Проверяем что "Это" было скорректировано до 500ms
	if len(result) != 1 || len(result[0].Words) != 3 {
		t.Fatalf("Expected 1 segment with 3 words, got %d segments", len(result))
	}

	firstWord := result[0].Words[0]
	duration := firstWord.End - firstWord.Start
	if duration > 2000 {
		t.Errorf("Expected word 'Это' duration <= 2000ms, got %dms", duration)
	}

	t.Logf("Word 'Это' corrected: %d-%d (duration %dms)", firstWord.Start, firstWord.End, duration)
}

// TestMergeSegmentsWithOverlapHandling проверяет segment-level слияние
func TestMergeSegmentsWithOverlapHandling(t *testing.T) {
	micSegments := []TranscriptSegment{
		{Start: 1800, End: 4000, Speaker: "Вы", Text: "Так, давай-ка проверим"},
		{Start: 5600, End: 5900, Speaker: "Вы", Text: "угу"},
	}
	sysSegments := []TranscriptSegment{
		{Start: 0, End: 2000, Speaker: "Собеседник 1", Text: "Может быть вот это"},
		{Start: 4200, End: 5500, Speaker: "Собеседник 1", Text: "Будешь показывать?"},
		{Start: 6000, End: 7000, Speaker: "Собеседник 1", Text: "По-моему, да"},
	}

	result := mergeSegmentsWithOverlapHandling(micSegments, sysSegments)

	t.Log("Result from mergeSegmentsWithOverlapHandling:")
	for i, r := range result {
		t.Logf("  [%d] %s: %s (%d-%d)", i, r.Speaker, r.Text, r.Start, r.End)
	}

	// Ожидаем 5 фраз в правильном порядке
	if len(result) != 5 {
		t.Errorf("Expected 5 phrases, got %d", len(result))
		return
	}

	// Проверяем порядок: sys, mic, sys, mic, sys
	expectedOrder := []bool{false, true, false, true, false} // false = sys, true = mic
	for i, expected := range expectedOrder {
		actual := isMicSpeaker(result[i].Speaker)
		if actual != expected {
			t.Errorf("Phrase %d: expected isMic=%v, got %v (speaker: %s)",
				i, expected, actual, result[i].Speaker)
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

// TestMergeWordsToDialogue_RealDataChunk001 тестирует на реальных данных из проблемного чанка
// Проблема: timestamps в Whisper могут быть очень неточными (слово "Это" длится 6 секунд)
func TestMergeWordsToDialogue_RealDataChunk001(t *testing.T) {
	// Реальные данные из chunks/001.json сессии 114bbb18-747b-4f9b-841f-6f6cd075bd39
	// Проблема: timestamps очень неточные
	// - "Это" длится с 34680 до 40690 (6 секунд для одного слова!)
	// - "По-моему," длится с 42500 до 51620 (9 секунд!)

	micSegments := []TranscriptSegment{
		{
			Start:   31460,
			End:     41140,
			Speaker: "Вы",
			Text:    "Так, давай-ка мы проверим два момента.",
			Words: []TranscriptWord{
				{Start: 31840, End: 32080, Text: "Так,", Speaker: "Вы"},
				{Start: 32120, End: 36430, Text: "давай-ка", Speaker: "Вы"},
				{Start: 36440, End: 36800, Text: "мы", Speaker: "Вы"},
				{Start: 36800, End: 37960, Text: "проверим", Speaker: "Вы"},
				{Start: 37960, End: 38390, Text: "два", Speaker: "Вы"},
				{Start: 38390, End: 41140, Text: "момента.", Speaker: "Вы"},
			},
		},
		{
			Start:   41140,
			End:     50480,
			Speaker: "Вы",
			Text:    "Во-первых, посмотрим, появился ли ты у нас тут.",
			Words: []TranscriptWord{
				{Start: 41140, End: 41840, Text: "Во-первых,", Speaker: "Вы"},
				{Start: 41840, End: 47900, Text: "посмотрим,", Speaker: "Вы"},
				{Start: 47900, End: 49240, Text: "появился", Speaker: "Вы"},
				{Start: 49270, End: 49390, Text: "ли", Speaker: "Вы"},
				{Start: 49490, End: 49620, Text: "ты", Speaker: "Вы"},
				{Start: 49620, End: 49730, Text: "у", Speaker: "Вы"},
				{Start: 49730, End: 49920, Text: "нас", Speaker: "Вы"},
				{Start: 49920, End: 50480, Text: "тут.", Speaker: "Вы"},
			},
		},
	}

	sysSegments := []TranscriptSegment{
		{
			Start:   31280,
			End:     34680,
			Speaker: "Собеседник 1",
			Text:    "Может быть, имеет смысл тогда с ним встречаться, абсурдать, я не знаю.",
			Words: []TranscriptWord{
				{Start: 31280, End: 31410, Text: "Может", Speaker: "Собеседник 1"},
				{Start: 31780, End: 31980, Text: "быть,", Speaker: "Собеседник 1"},
				{Start: 31980, End: 32330, Text: "имеет", Speaker: "Собеседник 1"},
				{Start: 32330, End: 32700, Text: "смысл", Speaker: "Собеседник 1"},
				{Start: 32700, End: 32960, Text: "тогда", Speaker: "Собеседник 1"},
				{Start: 32960, End: 33000, Text: "с", Speaker: "Собеседник 1"},
				{Start: 33010, End: 33200, Text: "ним", Speaker: "Собеседник 1"},
				{Start: 33200, End: 33700, Text: "встречаться,", Speaker: "Собеседник 1"},
				{Start: 33700, End: 34200, Text: "абсурдать,", Speaker: "Собеседник 1"},
				{Start: 34200, End: 34220, Text: "я", Speaker: "Собеседник 1"},
				{Start: 34260, End: 34390, Text: "не", Speaker: "Собеседник 1"},
				{Start: 34390, End: 34680, Text: "знаю.", Speaker: "Собеседник 1"},
			},
		},
		{
			Start:   34680,
			End:     42040,
			Speaker: "Собеседник 1",
			Text:    "Это будешь показывать?",
			Words: []TranscriptWord{
				// Проблема: "Это" длится 6 секунд - явная ошибка timestamps
				{Start: 34680, End: 40690, Text: "Это", Speaker: "Собеседник 1"},
				{Start: 41000, End: 41210, Text: "будешь", Speaker: "Собеседник 1"},
				{Start: 41210, End: 42020, Text: "показывать?", Speaker: "Собеседник 1"},
			},
		},
		{
			Start:   42040,
			End:     52500,
			Speaker: "Собеседник 1",
			Text:    "По-моему, да.",
			Words: []TranscriptWord{
				// Проблема: "По-моему," длится 9 секунд - явная ошибка timestamps
				{Start: 42500, End: 51620, Text: "По-моему,", Speaker: "Собеседник 1"},
				{Start: 51650, End: 52500, Text: "да.", Speaker: "Собеседник 1"},
			},
		},
	}

	result := mergeWordsToDialogue(micSegments, sysSegments)

	// Логируем результат
	t.Log("Result from real data:")
	for i, r := range result {
		t.Logf("  [%d] %s: %s (%d-%d)", i, r.Speaker, r.Text, r.Start, r.End)
	}

	// Проверяем базовые требования:
	// 1. Должно быть чередование спикеров
	// 2. Реплики собеседника не должны быть склеены в одну огромную фразу

	if len(result) < 3 {
		t.Errorf("Expected at least 3 phrases, got %d", len(result))
		return
	}

	// Проверяем что есть чередование спикеров (не все фразы от одного спикера подряд)
	lastSpeakerIsMic := isMicSpeaker(result[0].Speaker)
	speakerChanges := 0
	for i := 1; i < len(result); i++ {
		currentIsMic := isMicSpeaker(result[i].Speaker)
		if currentIsMic != lastSpeakerIsMic {
			speakerChanges++
			lastSpeakerIsMic = currentIsMic
		}
	}

	if speakerChanges < 2 {
		t.Errorf("Expected at least 2 speaker changes (interleaving), got %d", speakerChanges)
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

// TestSplitSegmentsByWordGaps проверяет разбиение сегментов по разрывам между словами
// Это критично для Whisper, который может возвращать один большой сегмент
// с разрывами внутри (когда VAD compression склеивает регионы речи)
func TestSplitSegmentsByWordGaps(t *testing.T) {
	// Симулируем реальную проблему из chunk 002:
	// SYS сегмент [77170-111180] содержит слова с большим разрывом:
	// - "да" [77170-77670]
	// - "конечно" [105080-105720] - разрыв 27 секунд!
	sysSegment := TranscriptSegment{
		Start:   77170,
		End:     111180,
		Speaker: "Собеседник 1",
		Text:    "да конечно ну давай тебе расскажу по сути",
		Words: []TranscriptWord{
			{Start: 77170, End: 77670, Text: "да", Speaker: "Собеседник 1"},
			{Start: 105080, End: 105720, Text: "конечно", Speaker: "Собеседник 1"}, // Разрыв 27 сек!
			{Start: 105720, End: 105980, Text: "ну", Speaker: "Собеседник 1"},
			{Start: 106150, End: 106760, Text: "давай", Speaker: "Собеседник 1"},
			{Start: 106760, End: 107190, Text: "тебе", Speaker: "Собеседник 1"},
			{Start: 107340, End: 108290, Text: "расскажу", Speaker: "Собеседник 1"},
			{Start: 108410, End: 109260, Text: "по", Speaker: "Собеседник 1"},
			{Start: 109260, End: 111170, Text: "сути", Speaker: "Собеседник 1"},
		},
	}

	result := splitSegmentsByWordGaps([]TranscriptSegment{sysSegment})

	// Ожидаем 2 фразы:
	// 1. "да" [77170-77670]
	// 2. "конечно ну давай тебе расскажу по сути" [105080-111170]
	if len(result) != 2 {
		t.Errorf("Expected 2 phrases after split, got %d", len(result))
		for i, r := range result {
			t.Logf("  [%d] [%d-%d] %s: %s", i, r.Start, r.End, r.Speaker, r.Text)
		}
		return
	}

	// Проверяем первую фразу
	if result[0].Text != "да" {
		t.Errorf("Expected first phrase to be 'да', got '%s'", result[0].Text)
	}
	if result[0].Start != 77170 || result[0].End != 77670 {
		t.Errorf("Expected first phrase timestamps [77170-77670], got [%d-%d]", result[0].Start, result[0].End)
	}

	// Проверяем вторую фразу
	if result[1].Start != 105080 {
		t.Errorf("Expected second phrase start 105080, got %d", result[1].Start)
	}
	if result[1].End != 111170 {
		t.Errorf("Expected second phrase end 111170, got %d", result[1].End)
	}

	t.Log("Result after split:")
	for i, r := range result {
		t.Logf("  [%d] [%d-%d] %s: %s", i, r.Start, r.End, r.Speaker, r.Text)
	}
}

// TestSplitSegmentsByWordGaps_NoSplit проверяет что сегменты без разрывов не разбиваются
func TestSplitSegmentsByWordGaps_NoSplit(t *testing.T) {
	// Сегмент с непрерывными словами (без больших разрывов)
	segment := TranscriptSegment{
		Start:   0,
		End:     3000,
		Speaker: "Вы",
		Text:    "Привет как дела",
		Words: []TranscriptWord{
			{Start: 0, End: 500, Text: "Привет", Speaker: "Вы"},
			{Start: 600, End: 1000, Text: "как", Speaker: "Вы"},   // Разрыв 100ms - OK
			{Start: 1100, End: 1500, Text: "дела", Speaker: "Вы"}, // Разрыв 100ms - OK
		},
	}

	result := splitSegmentsByWordGaps([]TranscriptSegment{segment})

	// Ожидаем 1 фразу (без разбиения)
	if len(result) != 1 {
		t.Errorf("Expected 1 phrase (no split), got %d", len(result))
		for i, r := range result {
			t.Logf("  [%d] [%d-%d] %s: %s", i, r.Start, r.End, r.Speaker, r.Text)
		}
	}
}

// TestSplitSegmentsByWordGaps_GigaAM проверяет что GigaAM сегменты (без слов) не ломаются
// GigaAM E2E возвращает сегменты БЕЗ word-level timestamps
func TestSplitSegmentsByWordGaps_GigaAM(t *testing.T) {
	// Симулируем вывод GigaAM E2E - один сегмент без слов
	gigaamSegment := TranscriptSegment{
		Start:   66700,
		End:     109400,
		Speaker: "Вы",
		Text:    "А-а, подготовьте, пожалуйста, слайд с анализом пересечений сервисов TFr в периметре продукта.",
		Words:   nil, // GigaAM E2E не возвращает word-level timestamps!
	}

	result := splitSegmentsByWordGaps([]TranscriptSegment{gigaamSegment})

	// Ожидаем 1 фразу (без изменений) - сегмент должен остаться как есть
	if len(result) != 1 {
		t.Errorf("Expected 1 phrase (GigaAM unchanged), got %d", len(result))
		for i, r := range result {
			t.Logf("  [%d] [%d-%d] %s: %s", i, r.Start, r.End, r.Speaker, r.Text)
		}
		return
	}

	// Проверяем что сегмент не изменился
	if result[0].Start != gigaamSegment.Start || result[0].End != gigaamSegment.End {
		t.Errorf("GigaAM segment timestamps changed: expected [%d-%d], got [%d-%d]",
			gigaamSegment.Start, gigaamSegment.End, result[0].Start, result[0].End)
	}
	if result[0].Text != gigaamSegment.Text {
		t.Errorf("GigaAM segment text changed")
	}

	t.Logf("GigaAM segment preserved: [%d-%d] %s", result[0].Start, result[0].End, result[0].Text[:50])
}

// TestSplitSegmentsByWordGaps_Parakeet проверяет что Parakeet сегменты (без слов) не ломаются
// Parakeet также возвращает сегменты БЕЗ word-level timestamps
func TestSplitSegmentsByWordGaps_Parakeet(t *testing.T) {
	// Симулируем вывод Parakeet С word-level timestamps (новое поведение!)
	// Parakeet теперь возвращает tokenTimings, которые конвертируются в Words
	parakeetSegments := []TranscriptSegment{
		{
			Start:   67900,
			End:     112780,
			Speaker: "Вы",
			Text:    "Подготовьте, пожалуйста, слайд. Да, конечно. Ну, давай начать тебе расскажу.",
			Words: []TranscriptWord{
				// Первая фраза
				{Start: 67900, End: 68500, Text: "Подготовьте", Speaker: "Вы"},
				{Start: 68500, End: 69000, Text: ",", Speaker: "Вы"},
				{Start: 69000, End: 69500, Text: "пожалуйста", Speaker: "Вы"},
				{Start: 69500, End: 70000, Text: ",", Speaker: "Вы"},
				{Start: 70000, End: 70500, Text: "слайд", Speaker: "Вы"},
				{Start: 70500, End: 75180, Text: ".", Speaker: "Вы"},
				// Большой разрыв (>2 секунд) - должен разбить на новый сегмент
				// Вторая фраза начинается через 29+ секунд
				{Start: 104700, End: 105000, Text: "Да", Speaker: "Вы"},
				{Start: 105000, End: 105500, Text: ",", Speaker: "Вы"},
				{Start: 105500, End: 106000, Text: "конечно", Speaker: "Вы"},
				{Start: 106000, End: 106500, Text: ".", Speaker: "Вы"},
				{Start: 106500, End: 107000, Text: "Ну", Speaker: "Вы"},
				{Start: 107000, End: 107500, Text: ",", Speaker: "Вы"},
				{Start: 107500, End: 108000, Text: "давай", Speaker: "Вы"},
				{Start: 108000, End: 109000, Text: "начать", Speaker: "Вы"},
				{Start: 109000, End: 110000, Text: "тебе", Speaker: "Вы"},
				{Start: 110000, End: 112780, Text: "расскажу", Speaker: "Вы"},
			},
		},
	}

	result := splitSegmentsByWordGaps(parakeetSegments)

	// Ожидаем 2 фразы - алгоритм должен разбить по большому разрыву (29+ секунд)
	if len(result) != 2 {
		t.Errorf("Expected 2 phrases (Parakeet with word gaps), got %d", len(result))
		for i, r := range result {
			t.Logf("  [%d] [%d-%d] %s: %s", i, r.Start, r.End, r.Speaker, r.Text)
		}
		return
	}

	// Проверяем первый сегмент
	if result[0].Start != 67900 || result[0].End != 75180 {
		t.Errorf("First segment timestamps wrong: got [%d-%d], expected [67900-75180]",
			result[0].Start, result[0].End)
	}

	// Проверяем второй сегмент
	if result[1].Start != 104700 || result[1].End != 112780 {
		t.Errorf("Second segment timestamps wrong: got [%d-%d], expected [104700-112780]",
			result[1].Start, result[1].End)
	}

	t.Logf("Parakeet segments split correctly: %d -> %d segments", len(parakeetSegments), len(result))
	for i, r := range result {
		t.Logf("  [%d] [%d-%d] %s", i, r.Start, r.End, r.Text[:min(50, len(r.Text))]+"...")
	}
}

// TestMergeWordsToDialogue_WhisperWithGaps тестирует полный pipeline слияния
// с реальными данными из проблемного чанка (Whisper с разрывами)
func TestMergeWordsToDialogue_WhisperWithGaps(t *testing.T) {
	// Симулируем данные из chunk 002 (упрощённо)
	micSegments := []TranscriptSegment{
		{
			Start:   67080,
			End:     101120,
			Speaker: "Вы",
			Text:    "Подготовьте пожалуйста слайд",
			Words: []TranscriptWord{
				{Start: 67080, End: 68950, Text: "Подготовьте", Speaker: "Вы"},
				{Start: 68950, End: 69400, Text: "пожалуйста", Speaker: "Вы"},
				{Start: 69400, End: 69860, Text: "слайд", Speaker: "Вы"},
			},
		},
		{
			Start:   101450,
			End:     104000,
			Speaker: "Вы",
			Text:    "погоди погоди",
			Words: []TranscriptWord{
				{Start: 101450, End: 102000, Text: "погоди", Speaker: "Вы"},
				{Start: 102000, End: 104000, Text: "погоди", Speaker: "Вы"},
			},
		},
	}

	sysSegments := []TranscriptSegment{
		{
			Start:   77170,
			End:     111180,
			Speaker: "Собеседник 1",
			Text:    "да конечно ну давай расскажу",
			Words: []TranscriptWord{
				{Start: 77170, End: 77670, Text: "да", Speaker: "Собеседник 1"},
				// Большой разрыв 27 секунд!
				{Start: 105080, End: 105720, Text: "конечно", Speaker: "Собеседник 1"},
				{Start: 105720, End: 105980, Text: "ну", Speaker: "Собеседник 1"},
				{Start: 106150, End: 106760, Text: "давай", Speaker: "Собеседник 1"},
				{Start: 107340, End: 108290, Text: "расскажу", Speaker: "Собеседник 1"},
			},
		},
	}

	result := mergeWordsToDialogue(micSegments, sysSegments)

	t.Log("Result after merge:")
	for i, r := range result {
		t.Logf("  [%d] [%d-%d] %s: %s", i, r.Start, r.End, r.Speaker, r.Text)
	}

	// Ожидаем правильный порядок:
	// 1. Вы: "Подготовьте пожалуйста слайд" [67080-69860]
	// 2. Собеседник 1: "да" [77170-77670]
	// 3. Вы: "погоди погоди" [101450-104000]
	// 4. Собеседник 1: "конечно ну давай расскажу" [105080-108290]

	if len(result) < 3 {
		t.Errorf("Expected at least 3 phrases, got %d", len(result))
		return
	}

	// Проверяем что "да" от собеседника идёт ПОСЛЕ первой фразы "Вы"
	// и ПЕРЕД "погоди погоди"
	foundDa := false
	daIndex := -1
	for i, r := range result {
		if r.Text == "да" && r.Speaker == "Собеседник 1" {
			foundDa = true
			daIndex = i
			break
		}
	}

	if !foundDa {
		t.Error("Expected to find 'да' from Собеседник 1 as separate phrase")
	} else {
		// "да" должно быть после первой фразы "Вы" (index 0) и перед "погоди" (index 2)
		if daIndex != 1 {
			t.Errorf("Expected 'да' at index 1, got index %d", daIndex)
		}
	}
}
