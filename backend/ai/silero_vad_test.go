// Package ai тесты для Silero VAD
package ai

import (
	"aiwisper/session"
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

// TestSileroVADRealAudio тестирует VAD на реальном аудио с речью
func TestSileroVADRealAudio(t *testing.T) {
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

	// Ищем тестовый MP3 файл
	sessionsDir := filepath.Join(homeDir, "Library/Application Support/aiwisper/sessions")
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		t.Skip("Sessions directory not found, skipping test")
	}

	var mp3Path string
	for _, entry := range entries {
		if entry.IsDir() {
			testPath := filepath.Join(sessionsDir, entry.Name(), "full.mp3")
			if _, err := os.Stat(testPath); err == nil {
				mp3Path = testPath
				break
			}
		}
	}

	if mp3Path == "" {
		t.Skip("No MP3 file found, skipping test")
	}

	t.Logf("Testing with audio file: %s", mp3Path)

	// Извлекаем первые 10 секунд аудио
	samples, err := session.ExtractSegmentGo(mp3Path, 0, 10000, 16000)
	if err != nil {
		t.Fatalf("Failed to extract audio segment: %v", err)
	}
	t.Logf("Extracted %d samples (%.2f seconds)", len(samples), float64(len(samples))/16000)

	// Создаём VAD
	config := DefaultSileroVADConfig()
	config.ModelPath = modelPath

	vad, err := NewSileroVAD(config)
	if err != nil {
		t.Fatalf("Failed to create Silero VAD: %v", err)
	}
	defer vad.Close()

	// Обрабатываем аудио окнами по 512 сэмплов (32ms)
	windowSize := 512
	var probs []float32
	var maxProb float32
	var speechWindows int

	for i := 0; i < len(samples); i += windowSize {
		end := i + windowSize
		if end > len(samples) {
			// Дополняем нулями
			chunk := make([]float32, windowSize)
			copy(chunk, samples[i:])
			prob, err := vad.ProcessChunk(chunk)
			if err != nil {
				t.Fatalf("Failed to process chunk: %v", err)
			}
			probs = append(probs, prob)
			if prob > maxProb {
				maxProb = prob
			}
			if prob >= 0.5 {
				speechWindows++
			}
		} else {
			prob, err := vad.ProcessChunk(samples[i:end])
			if err != nil {
				t.Fatalf("Failed to process chunk: %v", err)
			}
			probs = append(probs, prob)
			if prob > maxProb {
				maxProb = prob
			}
			if prob >= 0.5 {
				speechWindows++
			}
		}
	}

	t.Logf("Processed %d windows (32ms each)", len(probs))
	t.Logf("Max probability: %.4f", maxProb)
	t.Logf("Windows with speech (prob >= 0.5): %d (%.1f%%)", speechWindows, float64(speechWindows)*100/float64(len(probs)))

	// Выводим первые 20 вероятностей
	t.Log("First 20 probabilities:")
	for i := 0; i < 20 && i < len(probs); i++ {
		timeMs := i * 32
		t.Logf("  %4dms: %.4f %s", timeMs, probs[i], probBar(probs[i]))
	}

	// Проверяем что есть хотя бы какая-то речь
	if maxProb < 0.3 {
		t.Errorf("Max probability too low (%.4f), expected at least 0.3 for real speech", maxProb)
	}
}

// TestSileroVADDetectRegions тестирует определение участков речи
func TestSileroVADDetectRegions(t *testing.T) {
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

	// Ищем тестовый MP3 файл
	sessionsDir := filepath.Join(homeDir, "Library/Application Support/aiwisper/sessions")
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		t.Skip("Sessions directory not found, skipping test")
	}

	var mp3Path string
	for _, entry := range entries {
		if entry.IsDir() {
			testPath := filepath.Join(sessionsDir, entry.Name(), "full.mp3")
			if _, err := os.Stat(testPath); err == nil {
				mp3Path = testPath
				break
			}
		}
	}

	if mp3Path == "" {
		t.Skip("No MP3 file found, skipping test")
	}

	// Извлекаем первые 30 секунд аудио
	samples, err := session.ExtractSegmentGo(mp3Path, 0, 30000, 16000)
	if err != nil {
		t.Fatalf("Failed to extract audio segment: %v", err)
	}

	// Создаём VAD
	config := DefaultSileroVADConfig()
	config.ModelPath = modelPath

	vad, err := NewSileroVAD(config)
	if err != nil {
		t.Fatalf("Failed to create Silero VAD: %v", err)
	}
	defer vad.Close()

	// Определяем участки речи
	segments, err := vad.DetectSpeechRegions(samples)
	if err != nil {
		t.Fatalf("Failed to detect speech regions: %v", err)
	}

	t.Logf("Detected %d speech segments in 30 seconds of audio", len(segments))
	for i, seg := range segments {
		t.Logf("  Segment %d: %dms - %dms (duration: %dms, prob: %.2f)",
			i, seg.StartMs, seg.EndMs, seg.EndMs-seg.StartMs, seg.AvgProb)
	}
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
