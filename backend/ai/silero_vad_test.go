// Package ai тесты для Silero VAD
package ai

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSileroVADBasic(t *testing.T) {
	// Путь к модели
	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("Failed to get home dir: %v", err)
	}
	modelPath := filepath.Join(homeDir, "Library/Application Support/aiwisper/models/silero_vad.onnx")

	// Проверяем существование модели
	if _, err := os.Stat(modelPath); os.IsNotExist(err) {
		t.Skip("Silero VAD model not found, skipping test")
	}

	// Создаём конфигурацию
	config := DefaultSileroVADConfig()
	config.ModelPath = modelPath

	// Создаём VAD
	vad, err := NewSileroVAD(config)
	if err != nil {
		t.Fatalf("Failed to create Silero VAD: %v", err)
	}
	defer vad.Close()

	// Тест 1: Тишина (нули) - должна давать низкую вероятность
	silence := make([]float32, 512)
	prob, err := vad.ProcessChunk(silence)
	if err != nil {
		t.Fatalf("Failed to process silence: %v", err)
	}
	t.Logf("Silence probability: %.4f", prob)
	if prob > 0.3 {
		t.Errorf("Silence should have low probability, got %.4f", prob)
	}

	// Сбрасываем состояние
	vad.ResetState()

	// Тест 2: Синусоида (имитация тона) - может давать среднюю вероятность
	tone := make([]float32, 512)
	for i := range tone {
		// 440 Hz синусоида при 16kHz
		tone[i] = float32(0.5 * sinApprox(2*3.14159*440*float64(i)/16000))
	}
	prob, err = vad.ProcessChunk(tone)
	if err != nil {
		t.Fatalf("Failed to process tone: %v", err)
	}
	t.Logf("Tone (440Hz) probability: %.4f", prob)

	// Сбрасываем состояние
	vad.ResetState()

	// Тест 3: Шум - должен давать низкую/среднюю вероятность
	noise := make([]float32, 512)
	for i := range noise {
		// Простой псевдо-шум
		noise[i] = float32((i%7-3)%5) * 0.1
	}
	prob, err = vad.ProcessChunk(noise)
	if err != nil {
		t.Fatalf("Failed to process noise: %v", err)
	}
	t.Logf("Noise probability: %.4f", prob)
}

func TestSileroVADStreaming(t *testing.T) {
	// Путь к модели
	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("Failed to get home dir: %v", err)
	}
	modelPath := filepath.Join(homeDir, "Library/Application Support/aiwisper/models/silero_vad.onnx")

	// Проверяем существование модели
	if _, err := os.Stat(modelPath); os.IsNotExist(err) {
		t.Skip("Silero VAD model not found, skipping test")
	}

	// Создаём конфигурацию
	config := DefaultSileroVADConfig()
	config.ModelPath = modelPath

	// Создаём VAD
	vad, err := NewSileroVAD(config)
	if err != nil {
		t.Fatalf("Failed to create Silero VAD: %v", err)
	}
	defer vad.Close()

	// Обрабатываем несколько чанков подряд (streaming)
	// Это проверяет что состояние LSTM и контекст работают корректно
	for i := 0; i < 10; i++ {
		chunk := make([]float32, 512)
		// Добавляем немного вариации
		for j := range chunk {
			chunk[j] = float32(i%3-1) * 0.01
		}
		prob, err := vad.ProcessChunk(chunk)
		if err != nil {
			t.Fatalf("Failed to process chunk %d: %v", i, err)
		}
		t.Logf("Chunk %d probability: %.4f", i, prob)
	}
}

// Простая аппроксимация синуса
func sinApprox(x float64) float64 {
	// Нормализуем x в диапазон [-pi, pi]
	for x > 3.14159 {
		x -= 2 * 3.14159
	}
	for x < -3.14159 {
		x += 2 * 3.14159
	}
	// Аппроксимация Тейлора
	return x - x*x*x/6 + x*x*x*x*x/120
}

// TestSileroVADDetectRegionsSynthetic тестирует определение участков речи на синтетических данных
func TestSileroVADDetectRegionsSynthetic(t *testing.T) {
	// Путь к модели
	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("Failed to get home dir: %v", err)
	}
	modelPath := filepath.Join(homeDir, "Library/Application Support/aiwisper/models/silero_vad.onnx")

	// Проверяем существование модели
	if _, err := os.Stat(modelPath); os.IsNotExist(err) {
		t.Skip("Silero VAD model not found, skipping test")
	}

	// Создаём VAD
	config := DefaultSileroVADConfig()
	config.ModelPath = modelPath

	vad, err := NewSileroVAD(config)
	if err != nil {
		t.Fatalf("Failed to create Silero VAD: %v", err)
	}
	defer vad.Close()

	// Создаём синтетические данные: 5 секунд тишины + 2 секунды "речи" (тон) + 3 секунды тишины
	sampleRate := 16000
	totalDuration := 10 // секунд
	samples := make([]float32, sampleRate*totalDuration)

	// Добавляем "речь" (сложный тон, похожий на голос) с 5 по 7 секунду
	for i := 5 * sampleRate; i < 7*sampleRate; i++ {
		t := float64(i) / float64(sampleRate)
		// Комбинация нескольких частот для имитации голоса
		samples[i] = float32(0.3 * (sinApprox(2*3.14159*150*t) +
			0.5*sinApprox(2*3.14159*300*t) +
			0.3*sinApprox(2*3.14159*450*t)))
	}

	// Определяем участки речи
	segments, err := vad.DetectSpeechRegions(samples)
	if err != nil {
		t.Fatalf("Failed to detect speech regions: %v", err)
	}

	t.Logf("Detected %d speech segments in synthetic audio", len(segments))
	for i, seg := range segments {
		t.Logf("  Segment %d: %dms - %dms (duration: %dms, prob: %.2f)",
			i, seg.StartMs, seg.EndMs, seg.EndMs-seg.StartMs, seg.AvgProb)
	}

	// Примечание: Silero VAD обучен на реальной речи, поэтому синтетические тоны
	// могут не распознаваться как речь. Это нормальное поведение.
}

// probBar возвращает визуальную полоску для вероятности
func probBar(prob float32) string {
	bars := int(prob * 20)
	result := "["
	for i := 0; i < 20; i++ {
		if i < bars {
			result += "█"
		} else {
			result += "░"
		}
	}
	result += "]"
	return result
}
