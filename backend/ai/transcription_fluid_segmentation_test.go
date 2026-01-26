//go:build darwin

package ai

import (
	"testing"
)

// TestFluidASREnginePauseThreshold тестирует разные значения pause threshold
func TestFluidASREnginePauseThreshold(t *testing.T) {
	// Тестируем разные thresholds
	thresholds := []struct {
		value       float64
		description string
	}{
		{0.3, "aggressive (more segments)"},
		{0.5, "default (balanced)"},
		{1.0, "conservative (fewer segments)"},
		{2.0, "very conservative"},
	}

	// Загружаем тестовый файл
	samples, err := loadWAVFile("../whisper.cpp/samples/jfk.wav")
	if err != nil {
		t.Skipf("Test file not found: %v", err)
		return
	}

	for _, tc := range thresholds {
		t.Run(tc.description, func(t *testing.T) {
			engine, err := NewFluidASREngine(FluidASRConfig{
				BinaryPath:     "../audio/transcription/.build/release/transcription-fluid",
				PauseThreshold: tc.value,
			})

			if err != nil {
				t.Skipf("Skipping test: %v", err)
				return
			}

			defer engine.Close()

			segments, err := engine.TranscribeWithSegments(samples)
			if err != nil {
				t.Fatalf("Transcription failed: %v", err)
			}

			// Собираем полный текст
			var fullText string
			for _, seg := range segments {
				fullText += seg.Text + " "
			}

			t.Logf("Pause threshold: %.1fs", tc.value)
			t.Logf("Segments: %d", len(segments))
			t.Logf("Text: %s", fullText)

			// Проверяем что есть хотя бы один сегмент
			if len(segments) == 0 {
				t.Error("Expected at least one segment")
			}

			// Для агрессивного threshold ожидаем больше сегментов
			if tc.value == 0.3 && len(segments) < 2 {
				t.Logf("Warning: expected more segments with aggressive threshold (got %d)", len(segments))
			}

			// Для консервативного threshold ожидаем меньше сегментов
			if tc.value == 2.0 && len(segments) > 3 {
				t.Logf("Warning: expected fewer segments with conservative threshold (got %d)", len(segments))
			}
		})
	}
}

// TestFluidASREngineSegmentQuality проверяет качество сегментации
func TestFluidASREngineSegmentQuality(t *testing.T) {
	engine, err := NewFluidASREngine(FluidASRConfig{
		BinaryPath:     "../audio/transcription/.build/release/transcription-fluid",
		PauseThreshold: 0.5,
	})

	if err != nil {
		t.Skipf("Skipping test: %v", err)
		return
	}

	defer engine.Close()

	samples, err := loadWAVFile("../whisper.cpp/samples/jfk.wav")
	if err != nil {
		t.Skipf("Test file not found: %v", err)
		return
	}

	segments, err := engine.TranscribeWithSegments(samples)
	if err != nil {
		t.Fatalf("Transcription failed: %v", err)
	}

	// Проверяем качество сегментов
	for i, seg := range segments {
		// Проверяем что timestamps валидны
		if seg.Start < 0 || seg.End < 0 {
			t.Errorf("Segment %d has negative timestamp: start=%d, end=%d", i, seg.Start, seg.End)
		}

		if seg.Start >= seg.End {
			t.Errorf("Segment %d has invalid timestamps: start=%d >= end=%d", i, seg.Start, seg.End)
		}

		// Проверяем что текст не пустой
		if seg.Text == "" {
			t.Errorf("Segment %d has empty text", i)
		}

		// Проверяем что сегменты не перекрываются
		if i > 0 {
			prevSeg := segments[i-1]
			if seg.Start < prevSeg.End {
				t.Errorf("Segment %d overlaps with previous segment: %d < %d", i, seg.Start, prevSeg.End)
			}
		}

		// Логируем детали сегмента
		duration := float64(seg.End-seg.Start) / 1000.0
		t.Logf("Segment %d: %.2fs-%.2fs (%.2fs) - %s", i, float64(seg.Start)/1000.0, float64(seg.End)/1000.0, duration, seg.Text)
	}
}
