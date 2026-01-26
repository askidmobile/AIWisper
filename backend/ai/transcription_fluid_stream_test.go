package ai

import (
	"math"
	"testing"
	"time"
)

func TestStreamingFluidASREngineCreation(t *testing.T) {
	t.Skip("Skipping: requires transcription-fluid-stream binary")

	config := StreamingFluidASRConfig{
		ModelCacheDir:         "/tmp/fluidaudio-test",
		ChunkSeconds:          15.0,
		ConfirmationThreshold: 0.85,
	}

	engine, err := NewStreamingFluidASREngine(config)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}
	defer engine.Close()

	if engine == nil {
		t.Fatal("Engine is nil")
	}
}

func TestStreamingFluidASREngineBasicFlow(t *testing.T) {
	t.Skip("Skipping: requires transcription-fluid-stream binary and model download")

	config := StreamingFluidASRConfig{
		ModelCacheDir:         "/tmp/fluidaudio-test",
		ChunkSeconds:          15.0,
		ConfirmationThreshold: 0.85,
	}

	engine, err := NewStreamingFluidASREngine(config)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}
	defer engine.Close()

	// Создаём тестовый аудио (синусоида 440Hz, 2 секунды)
	sampleRate := 16000
	duration := 2.0
	frequency := 440.0

	samples := make([]float32, int(float64(sampleRate)*duration))
	for i := range samples {
		t := float64(i) / float64(sampleRate)
		samples[i] = float32(0.5 * math.Sin(2*math.Pi*frequency*t))
	}

	// Callback для обновлений
	updateCount := 0
	engine.SetUpdateCallback(func(update StreamingTranscriptionUpdate) {
		updateCount++
		t.Logf("Update #%d: text='%s', confirmed=%v, confidence=%.2f",
			updateCount, update.Text, update.IsConfirmed, update.Confidence)
	})

	// Отправляем аудио чанками по 0.5 секунды
	chunkSize := sampleRate / 2
	for i := 0; i < len(samples); i += chunkSize {
		end := i + chunkSize
		if end > len(samples) {
			end = len(samples)
		}

		chunk := samples[i:end]
		if err := engine.StreamAudio(chunk); err != nil {
			t.Fatalf("Failed to stream audio: %v", err)
		}

		// Небольшая задержка для имитации real-time
		time.Sleep(100 * time.Millisecond)
	}

	// Завершаем
	finalText, err := engine.Finish()
	if err != nil {
		t.Fatalf("Failed to finish: %v", err)
	}

	t.Logf("Final text: '%s'", finalText)
	t.Logf("Total updates received: %d", updateCount)

	if updateCount == 0 {
		t.Error("Expected at least one update")
	}
}

func TestStreamingFluidASREngineReset(t *testing.T) {
	t.Skip("Skipping: requires transcription-fluid-stream binary")

	config := StreamingFluidASRConfig{
		ModelCacheDir: "/tmp/fluidaudio-test",
	}

	engine, err := NewStreamingFluidASREngine(config)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}
	defer engine.Close()

	// Первая сессия
	samples1 := generateTestAudio(16000, 1.0, 440.0)
	if err := engine.StreamAudio(samples1); err != nil {
		t.Fatalf("Failed to stream audio (session 1): %v", err)
	}

	text1, err := engine.Finish()
	if err != nil {
		t.Fatalf("Failed to finish (session 1): %v", err)
	}
	t.Logf("Session 1 result: '%s'", text1)

	// Reset
	if err := engine.Reset(); err != nil {
		t.Fatalf("Failed to reset: %v", err)
	}

	// Вторая сессия
	samples2 := generateTestAudio(16000, 1.0, 880.0)
	if err := engine.StreamAudio(samples2); err != nil {
		t.Fatalf("Failed to stream audio (session 2): %v", err)
	}

	text2, err := engine.Finish()
	if err != nil {
		t.Fatalf("Failed to finish (session 2): %v", err)
	}
	t.Logf("Session 2 result: '%s'", text2)
}

// generateTestAudio создаёт тестовый аудио сигнал (синусоида)
func generateTestAudio(sampleRate int, durationSec float64, frequency float64) []float32 {
	samples := make([]float32, int(float64(sampleRate)*durationSec))
	for i := range samples {
		t := float64(i) / float64(sampleRate)
		samples[i] = float32(0.5 * math.Sin(2*math.Pi*frequency*t))
	}
	return samples
}
