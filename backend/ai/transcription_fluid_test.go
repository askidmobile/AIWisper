//go:build darwin

package ai

import (
	"math"
	"testing"
)

// TestFluidASREngineCreation тестирует создание FluidASREngine
func TestFluidASREngineCreation(t *testing.T) {
	engine, err := NewFluidASREngine(FluidASRConfig{
		BinaryPath: "../audio/transcription/.build/release/transcription-fluid",
	})

	if err != nil {
		t.Skipf("Skipping test: %v (build transcription-fluid first)", err)
		return
	}

	defer engine.Close()

	if engine.Name() != "fluid-asr" {
		t.Errorf("Expected engine name 'fluid-asr', got '%s'", engine.Name())
	}

	langs := engine.SupportedLanguages()
	if len(langs) == 0 {
		t.Error("Expected non-empty supported languages list")
	}

	// Проверяем что русский язык поддерживается
	hasRussian := false
	for _, lang := range langs {
		if lang == "ru" {
			hasRussian = true
			break
		}
	}
	if !hasRussian {
		t.Error("Expected Russian language support")
	}
}

// TestFluidASREngineTranscribe тестирует транскрипцию
func TestFluidASREngineTranscribe(t *testing.T) {
	engine, err := NewFluidASREngine(FluidASRConfig{
		BinaryPath: "../audio/transcription/.build/release/transcription-fluid",
	})

	if err != nil {
		t.Skipf("Skipping test: %v (build transcription-fluid first)", err)
		return
	}

	defer engine.Close()

	// Создаём тестовый аудио сигнал (1 секунда, 16kHz, синусоида 440Hz)
	sampleRate := 16000
	duration := 1.0
	frequency := 440.0

	samples := make([]float32, int(float64(sampleRate)*duration))
	for i := range samples {
		t := float64(i) / float64(sampleRate)
		samples[i] = float32(0.5 * math.Sin(2*math.Pi*frequency*t))
	}

	// Транскрибируем (ожидаем пустой результат для синусоиды, но проверяем что не падает)
	text, err := engine.Transcribe(samples, false)
	if err != nil {
		t.Errorf("Transcribe failed: %v", err)
	}

	// Для синусоиды ожидаем пустой текст или ошибку распознавания
	t.Logf("Transcription result: '%s'", text)
}

// TestFluidASREngineInterface проверяет что FluidASREngine реализует TranscriptionEngine
func TestFluidASREngineInterface(t *testing.T) {
	var _ TranscriptionEngine = (*FluidASREngine)(nil)
}
