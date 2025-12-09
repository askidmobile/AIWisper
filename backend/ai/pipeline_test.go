package ai

import (
	"testing"
)

// mockTranscriber реализует TranscriptionEngine для тестов
type mockTranscriber struct {
	name     string
	segments []TranscriptSegment
	lang     string
}

func (m *mockTranscriber) Name() string {
	return m.name
}

func (m *mockTranscriber) Transcribe(samples []float32, useContext bool) (string, error) {
	text := ""
	for _, seg := range m.segments {
		if text != "" {
			text += " "
		}
		text += seg.Text
	}
	return text, nil
}

func (m *mockTranscriber) TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error) {
	return m.segments, nil
}

func (m *mockTranscriber) TranscribeHighQuality(samples []float32) ([]TranscriptSegment, error) {
	return m.segments, nil
}

func (m *mockTranscriber) SetLanguage(lang string) {
	m.lang = lang
}

func (m *mockTranscriber) SetModel(path string) error {
	return nil
}

func (m *mockTranscriber) SupportedLanguages() []string {
	return []string{"ru", "en"}
}

func (m *mockTranscriber) Close() {}

func TestNewAudioPipeline(t *testing.T) {
	mock := &mockTranscriber{name: "mock"}
	config := DefaultPipelineConfig()

	pipeline, err := NewAudioPipeline(mock, config)
	if err != nil {
		t.Fatalf("Failed to create pipeline: %v", err)
	}
	defer pipeline.Close()

	if pipeline.GetTranscriber().Name() != mock.Name() {
		t.Error("Transcriber should match")
	}

	if pipeline.IsDiarizationEnabled() {
		t.Error("Diarization should be disabled by default")
	}
}

func TestAudioPipeline_NilTranscriber(t *testing.T) {
	config := DefaultPipelineConfig()

	_, err := NewAudioPipeline(nil, config)
	if err == nil {
		t.Error("Expected error for nil transcriber")
	}
}

func TestAudioPipeline_Process(t *testing.T) {
	segments := []TranscriptSegment{
		{Start: 0, End: 2000, Text: "Первый сегмент"},
		{Start: 2000, End: 4000, Text: "Второй сегмент"},
	}

	mock := &mockTranscriber{
		name:     "mock",
		segments: segments,
	}
	config := DefaultPipelineConfig()

	pipeline, err := NewAudioPipeline(mock, config)
	if err != nil {
		t.Fatalf("Failed to create pipeline: %v", err)
	}
	defer pipeline.Close()

	// Обрабатываем тестовое аудио
	samples := make([]float32, 16000*4) // 4 секунды
	result, err := pipeline.Process(samples)
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}

	if len(result.Segments) != 2 {
		t.Errorf("Expected 2 segments, got %d", len(result.Segments))
	}

	expectedText := "Первый сегмент Второй сегмент"
	if result.FullText != expectedText {
		t.Errorf("Expected full text %q, got %q", expectedText, result.FullText)
	}

	// Без диаризации не должно быть сегментов спикеров
	if result.NumSpeakers != 0 {
		t.Errorf("Expected 0 speakers without diarization, got %d", result.NumSpeakers)
	}
}

func TestAudioPipeline_ProcessEmpty(t *testing.T) {
	mock := &mockTranscriber{name: "mock"}
	config := DefaultPipelineConfig()

	pipeline, err := NewAudioPipeline(mock, config)
	if err != nil {
		t.Fatalf("Failed to create pipeline: %v", err)
	}
	defer pipeline.Close()

	// Пустой ввод
	result, err := pipeline.Process(nil)
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}

	if len(result.Segments) != 0 {
		t.Errorf("Expected 0 segments for empty input, got %d", len(result.Segments))
	}
	if result.FullText != "" {
		t.Errorf("Expected empty text, got %q", result.FullText)
	}
}

func TestAudioPipeline_SetTranscriber(t *testing.T) {
	mock1 := &mockTranscriber{name: "mock1"}
	mock2 := &mockTranscriber{name: "mock2"}
	config := DefaultPipelineConfig()

	pipeline, err := NewAudioPipeline(mock1, config)
	if err != nil {
		t.Fatalf("Failed to create pipeline: %v", err)
	}
	defer pipeline.Close()

	if pipeline.GetTranscriber().Name() != "mock1" {
		t.Error("Initial transcriber should be mock1")
	}

	pipeline.SetTranscriber(mock2)

	if pipeline.GetTranscriber().Name() != "mock2" {
		t.Error("Transcriber should be mock2 after set")
	}
}

func TestDefaultPipelineConfig(t *testing.T) {
	config := DefaultPipelineConfig()

	if config.EnableDiarization {
		t.Error("Diarization should be disabled by default")
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
	if config.NumThreads != 4 {
		t.Errorf("Expected 4 threads, got %d", config.NumThreads)
	}
	// Provider по умолчанию теперь "auto" для автоопределения
	if config.Provider != "auto" {
		t.Errorf("Expected provider 'auto', got %q", config.Provider)
	}
}

func TestMergeSegmentsWithSpeakers(t *testing.T) {
	transcriptSegments := []TranscriptSegment{
		{Start: 0, End: 2000, Text: "Привет"},
		{Start: 2000, End: 4000, Text: "Пока"},
	}

	speakerSegments := []SpeakerSegment{
		{Start: 0.0, End: 2.5, Speaker: 0},
		{Start: 2.5, End: 5.0, Speaker: 1},
	}

	result := MergeSegmentsWithSpeakers(transcriptSegments, speakerSegments)

	if len(result) != 2 {
		t.Fatalf("Expected 2 segments, got %d", len(result))
	}

	if result[0].Speaker != "Speaker 0" {
		t.Errorf("First segment should be Speaker 0, got %q", result[0].Speaker)
	}
	if result[1].Speaker != "Speaker 1" {
		t.Errorf("Second segment should be Speaker 1, got %q", result[1].Speaker)
	}
}

func TestMergeSegmentsWithSpeakers_EmptyInputs(t *testing.T) {
	// Пустые транскрипции
	result := MergeSegmentsWithSpeakers(nil, []SpeakerSegment{{Start: 0, End: 1, Speaker: 0}})
	if len(result) != 0 {
		t.Errorf("Expected empty result for nil transcripts, got %d", len(result))
	}

	// Пустые сегменты спикеров
	transcripts := []TranscriptSegment{{Start: 0, End: 1000, Text: "Test"}}
	result = MergeSegmentsWithSpeakers(transcripts, nil)
	if len(result) != 1 {
		t.Errorf("Expected 1 segment, got %d", len(result))
	}
}

func TestFindBestSpeaker(t *testing.T) {
	speakerSegments := []SpeakerSegment{
		{Start: 0.0, End: 2.0, Speaker: 0},
		{Start: 2.0, End: 4.0, Speaker: 1},
		{Start: 4.0, End: 6.0, Speaker: 2},
	}

	tests := []struct {
		name     string
		start    float32
		end      float32
		expected int
	}{
		{"Full overlap Speaker 0", 0.0, 1.5, 0},
		{"Full overlap Speaker 1", 2.5, 3.5, 1},
		{"Full overlap Speaker 2", 4.5, 5.5, 2},
		{"Mostly Speaker 0", 0.0, 2.2, 0},  // 2.0 vs 0.2
		{"Mostly Speaker 1", 1.8, 3.8, 1},  // 0.2 vs 1.8
		{"Edge at boundary", 2.0, 3.0, 1},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := findBestSpeaker(tc.start, tc.end, speakerSegments)
			if result != tc.expected {
				t.Errorf("Expected speaker %d, got %d", tc.expected, result)
			}
		})
	}
}

func TestPipelineResult(t *testing.T) {
	result := PipelineResult{
		Segments: []TranscriptSegment{
			{Start: 0, End: 1000, Text: "Тест", Speaker: "Speaker 0"},
		},
		SpeakerSegments: []SpeakerSegment{
			{Start: 0, End: 1.0, Speaker: 0},
		},
		NumSpeakers: 1,
		FullText:    "Тест",
	}

	if len(result.Segments) != 1 {
		t.Errorf("Expected 1 segment, got %d", len(result.Segments))
	}
	if len(result.SpeakerSegments) != 1 {
		t.Errorf("Expected 1 speaker segment, got %d", len(result.SpeakerSegments))
	}
	if result.NumSpeakers != 1 {
		t.Errorf("Expected 1 speaker, got %d", result.NumSpeakers)
	}
	if result.FullText != "Тест" {
		t.Errorf("Expected 'Тест', got %q", result.FullText)
	}
}
