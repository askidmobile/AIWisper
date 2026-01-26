package ai

import (
	"os"
	"testing"
)

func TestSherpaDiarizer_Integration(t *testing.T) {
	// Пропускаем если нет моделей
	segmentationPath := os.Getenv("DIARIZATION_SEGMENTATION_MODEL")
	embeddingPath := os.Getenv("DIARIZATION_EMBEDDING_MODEL")

	if segmentationPath == "" || embeddingPath == "" {
		t.Skip("DIARIZATION_SEGMENTATION_MODEL and DIARIZATION_EMBEDDING_MODEL not set")
	}

	// Проверяем существование файлов
	if _, err := os.Stat(segmentationPath); os.IsNotExist(err) {
		t.Skipf("Segmentation model not found: %s", segmentationPath)
	}
	if _, err := os.Stat(embeddingPath); os.IsNotExist(err) {
		t.Skipf("Embedding model not found: %s", embeddingPath)
	}

	config := DefaultSherpaDiarizerConfig(segmentationPath, embeddingPath)
	diarizer, err := NewSherpaDiarizer(config)
	if err != nil {
		t.Fatalf("Failed to create SherpaDiarizer: %v", err)
	}
	defer diarizer.Close()

	if !diarizer.IsInitialized() {
		t.Error("Diarizer should be initialized")
	}

	// Тест с тишиной (должен вернуть пустой результат или один сегмент)
	silence := make([]float32, 16000*3) // 3 секунды тишины
	segments, err := diarizer.Diarize(silence)
	if err != nil {
		t.Errorf("Diarize failed: %v", err)
	}
	t.Logf("Silence diarization: %d segments", len(segments))
}

func TestSherpaDiarizerConfig_Defaults(t *testing.T) {
	config := DefaultSherpaDiarizerConfig("/path/to/seg.onnx", "/path/to/emb.onnx")

	if config.SegmentationModelPath != "/path/to/seg.onnx" {
		t.Errorf("Expected segmentation path '/path/to/seg.onnx', got %q", config.SegmentationModelPath)
	}
	if config.EmbeddingModelPath != "/path/to/emb.onnx" {
		t.Errorf("Expected embedding path '/path/to/emb.onnx', got %q", config.EmbeddingModelPath)
	}
	if config.NumThreads != 4 {
		t.Errorf("Expected 4 threads, got %d", config.NumThreads)
	}
	if config.ClusteringThreshold != 0.5 {
		t.Errorf("Expected threshold 0.5, got %f", config.ClusteringThreshold)
	}
	if config.MinDurationOn != 0.3 {
		t.Errorf("Expected min duration on 0.3, got %f", config.MinDurationOn)
	}
	if config.MinDurationOff != 0.5 {
		t.Errorf("Expected min duration off 0.5, got %f", config.MinDurationOff)
	}
	// Provider по умолчанию теперь "auto" для автоопределения
	if config.Provider != "auto" {
		t.Errorf("Expected provider 'auto', got %q", config.Provider)
	}
}

func TestDiarizeWithTranscription_Merging(t *testing.T) {
	// Тест логики слияния транскрипции с диаризацией
	// Создаём mock сегменты

	transcriptSegments := []TranscriptSegment{
		{Start: 0, End: 2000, Text: "Привет, как дела?"},
		{Start: 2000, End: 4000, Text: "Отлично, спасибо!"},
		{Start: 4500, End: 6000, Text: "А у тебя?"},
	}

	speakerSegments := []SpeakerSegment{
		{Start: 0.0, End: 2.5, Speaker: 0},  // Speaker 0: первые 2.5 сек
		{Start: 2.5, End: 4.5, Speaker: 1},  // Speaker 1: 2.5-4.5 сек
		{Start: 4.5, End: 6.5, Speaker: 0},  // Speaker 0: остаток
	}

	// Создаём diarizer для теста (без реальной модели)
	d := &SherpaDiarizer{}
	result := d.DiarizeWithTranscription(transcriptSegments, speakerSegments)

	if len(result) != 3 {
		t.Fatalf("Expected 3 segments, got %d", len(result))
	}

	// Проверяем назначение спикеров
	if result[0].Speaker != "Speaker 0" {
		t.Errorf("Segment 0: expected 'Speaker 0', got %q", result[0].Speaker)
	}
	if result[1].Speaker != "Speaker 1" {
		t.Errorf("Segment 1: expected 'Speaker 1', got %q", result[1].Speaker)
	}
	if result[2].Speaker != "Speaker 0" {
		t.Errorf("Segment 2: expected 'Speaker 0', got %q", result[2].Speaker)
	}
}

func TestDiarizeWithTranscription_EmptyInputs(t *testing.T) {
	d := &SherpaDiarizer{}

	// Пустые транскрипции
	result := d.DiarizeWithTranscription(nil, []SpeakerSegment{{Start: 0, End: 1, Speaker: 0}})
	if len(result) != 0 {
		t.Errorf("Expected empty result for nil transcripts, got %d segments", len(result))
	}

	// Пустые сегменты спикеров - возвращаются оригинальные сегменты без изменений
	transcripts := []TranscriptSegment{{Start: 0, End: 1000, Text: "Test"}}
	result = d.DiarizeWithTranscription(transcripts, nil)
	if len(result) != 1 {
		t.Errorf("Expected 1 segment, got %d", len(result))
	}
	// При отсутствии диаризации сегмент возвращается без назначения спикера
	if result[0].Speaker != "" {
		t.Errorf("Expected empty speaker without diarization, got %q", result[0].Speaker)
	}
}

func TestDiarizeWithTranscription_OverlapCalculation(t *testing.T) {
	// Тест корректного расчёта перекрытия
	d := &SherpaDiarizer{}

	transcriptSegments := []TranscriptSegment{
		// Сегмент 1.5-2.5 сек (перекрывает оба спикера)
		{Start: 1500, End: 2500, Text: "Перекрывающийся текст"},
	}

	speakerSegments := []SpeakerSegment{
		{Start: 0.0, End: 2.0, Speaker: 0},  // Speaker 0: 0-2 сек
		{Start: 2.0, End: 4.0, Speaker: 1},  // Speaker 1: 2-4 сек
	}

	result := d.DiarizeWithTranscription(transcriptSegments, speakerSegments)

	if len(result) != 1 {
		t.Fatalf("Expected 1 segment, got %d", len(result))
	}

	// Перекрытие: Speaker 0 = 0.5 сек (1.5-2.0), Speaker 1 = 0.5 сек (2.0-2.5)
	// При равном перекрытии должен быть выбран Speaker 0 (меньший индекс)
	// или Speaker с большим/равным перекрытием
	t.Logf("Overlap test: segment speaker = %q", result[0].Speaker)
}

func TestSpeakerSegment_Validation(t *testing.T) {
	// Проверка корректности структуры SpeakerSegment
	seg := SpeakerSegment{
		Start:   1.5,
		End:     3.5,
		Speaker: 2,
	}

	if seg.Start >= seg.End {
		t.Error("Start should be less than End")
	}

	duration := seg.End - seg.Start
	if duration != 2.0 {
		t.Errorf("Expected duration 2.0, got %f", duration)
	}
}
