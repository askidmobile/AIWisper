//go:build darwin

package ai

import (
	"testing"
)

// TestPipelineParakeetWithDiarization тестирует Parakeet + FluidDiarization
func TestPipelineParakeetWithDiarization(t *testing.T) {
	// Создаём FluidASR engine
	transcriber, err := NewFluidASREngine(FluidASRConfig{
		BinaryPath: "../audio/transcription/.build/release/transcription-fluid",
	})
	if err != nil {
		t.Skipf("Skipping test: %v", err)
		return
	}
	defer transcriber.Close()

	// Создаём pipeline с FluidAudio диаризацией
	config := DefaultPipelineConfig()
	config.EnableDiarization = true
	config.DiarizationBackend = "fluid" // Используем FluidAudio

	pipeline, err := NewAudioPipeline(transcriber, config)
	if err != nil {
		t.Fatalf("Failed to create pipeline: %v", err)
	}
	defer pipeline.Close()

	// Загружаем тестовый файл (желательно с несколькими спикерами)
	samples, err := loadWAVFile("../whisper.cpp/samples/jfk.wav")
	if err != nil {
		t.Skipf("Test file not found: %v", err)
		return
	}

	// Обрабатываем через pipeline
	result, err := pipeline.Process(samples)
	if err != nil {
		t.Fatalf("Pipeline processing failed: %v", err)
	}

	// Проверяем результаты
	if len(result.Segments) == 0 {
		t.Error("Expected at least one transcription segment")
	}

	t.Logf("Transcription segments: %d", len(result.Segments))
	t.Logf("Speaker segments: %d", len(result.SpeakerSegments))
	t.Logf("Unique speakers: %d", result.NumSpeakers)
	t.Logf("Full text: %s", result.FullText)

	// Проверяем что спикеры назначены
	for i, seg := range result.Segments {
		if seg.Speaker == "" {
			t.Errorf("Segment %d has no speaker assigned", i)
		}
		t.Logf("Segment %d: [%s] %s", i, seg.Speaker, seg.Text)
	}

	// Проверяем что есть speaker segments
	if config.EnableDiarization && len(result.SpeakerSegments) == 0 {
		t.Error("Expected speaker segments when diarization is enabled")
	}
}

// TestPipelineParakeetHighQuality тестирует высококачественную обработку
func TestPipelineParakeetHighQuality(t *testing.T) {
	transcriber, err := NewFluidASREngine(FluidASRConfig{
		BinaryPath: "../audio/transcription/.build/release/transcription-fluid",
	})
	if err != nil {
		t.Skipf("Skipping test: %v", err)
		return
	}
	defer transcriber.Close()

	config := DefaultPipelineConfig()
	config.EnableDiarization = true
	config.DiarizationBackend = "fluid"

	pipeline, err := NewAudioPipeline(transcriber, config)
	if err != nil {
		t.Fatalf("Failed to create pipeline: %v", err)
		return
	}
	defer pipeline.Close()

	samples, err := loadWAVFile("../whisper.cpp/samples/jfk.wav")
	if err != nil {
		t.Skipf("Test file not found: %v", err)
		return
	}

	// Используем высококачественную обработку
	result, err := pipeline.ProcessHighQuality(samples)
	if err != nil {
		t.Fatalf("High quality processing failed: %v", err)
	}

	t.Logf("High quality results:")
	t.Logf("  Segments: %d", len(result.Segments))
	t.Logf("  Speakers: %d", result.NumSpeakers)
	t.Logf("  Text: %s", result.FullText)

	// Проверяем качество
	if len(result.Segments) == 0 {
		t.Error("Expected at least one segment")
	}

	// Проверяем что текст не пустой
	if result.FullText == "" {
		t.Error("Expected non-empty full text")
	}
}

// TestPipelineParakeetPerformance сравнивает производительность с/без диаризации
func TestPipelineParakeetPerformance(t *testing.T) {
	transcriber, err := NewFluidASREngine(FluidASRConfig{
		BinaryPath: "../audio/transcription/.build/release/transcription-fluid",
	})
	if err != nil {
		t.Skipf("Skipping test: %v", err)
		return
	}
	defer transcriber.Close()

	samples, err := loadWAVFile("../whisper.cpp/samples/jfk.wav")
	if err != nil {
		t.Skipf("Test file not found: %v", err)
		return
	}

	// Тест 1: Только транскрипция
	t.Run("TranscriptionOnly", func(t *testing.T) {
		config := DefaultPipelineConfig()
		config.EnableDiarization = false

		pipeline, err := NewAudioPipeline(transcriber, config)
		if err != nil {
			t.Fatalf("Failed to create pipeline: %v", err)
		}
		defer pipeline.Close()

		result, err := pipeline.Process(samples)
		if err != nil {
			t.Fatalf("Processing failed: %v", err)
		}

		t.Logf("Transcription only: %d segments", len(result.Segments))
	})

	// Тест 2: Транскрипция + диаризация
	t.Run("WithDiarization", func(t *testing.T) {
		config := DefaultPipelineConfig()
		config.EnableDiarization = true
		config.DiarizationBackend = "fluid"

		pipeline, err := NewAudioPipeline(transcriber, config)
		if err != nil {
			t.Fatalf("Failed to create pipeline: %v", err)
		}
		defer pipeline.Close()

		result, err := pipeline.Process(samples)
		if err != nil {
			t.Fatalf("Processing failed: %v", err)
		}

		t.Logf("With diarization: %d segments, %d speakers",
			len(result.Segments), result.NumSpeakers)
	})
}
