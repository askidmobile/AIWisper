//go:build darwin

package ai

import (
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestFluidASREngineRealAudio тестирует транскрипцию на реальных аудио файлах
func TestFluidASREngineRealAudio(t *testing.T) {
	engine, err := NewFluidASREngine(FluidASRConfig{
		BinaryPath: "../audio/transcription/.build/release/transcription-fluid",
	})

	if err != nil {
		t.Skipf("Skipping test: %v (build transcription-fluid first)", err)
		return
	}

	defer engine.Close()

	// Тестовые файлы
	testFiles := []struct {
		path     string
		language string
		minWords int // минимальное количество слов в результате
	}{
		{
			path:     "../whisper.cpp/samples/jfk.wav",
			language: "en",
			minWords: 10,
		},
		{
			path:     "../cmd/spike_gigaam/test_russian.wav",
			language: "ru",
			minWords: 5,
		},
	}

	for _, tc := range testFiles {
		t.Run(filepath.Base(tc.path), func(t *testing.T) {
			// Проверяем существование файла
			if _, err := os.Stat(tc.path); os.IsNotExist(err) {
				t.Skipf("Test file not found: %s", tc.path)
				return
			}

			// Загружаем аудио
			samples, err := loadWAVFile(tc.path)
			if err != nil {
				t.Fatalf("Failed to load audio: %v", err)
			}

			t.Logf("Loaded %d samples (%.2f seconds)", len(samples), float64(len(samples))/16000.0)

			// Транскрибируем
			start := time.Now()
			segments, err := engine.TranscribeWithSegments(samples)
			elapsed := time.Since(start)

			if err != nil {
				t.Fatalf("Transcription failed: %v", err)
			}

			// Собираем полный текст
			var fullText string
			for _, seg := range segments {
				fullText += seg.Text + " "
			}

			// Проверки
			if len(segments) == 0 {
				t.Error("Expected at least one segment")
			}

			wordCount := len([]rune(fullText)) / 5 // примерная оценка
			if wordCount < tc.minWords {
				t.Errorf("Expected at least %d words, got ~%d", tc.minWords, wordCount)
			}

			// Вычисляем RTFx
			audioDuration := float64(len(samples)) / 16000.0
			rtfx := audioDuration / elapsed.Seconds()

			// Логируем результаты
			t.Logf("Language: %s", tc.language)
			t.Logf("Segments: %d", len(segments))
			t.Logf("Text: %s", fullText)
			t.Logf("Duration: %.2fs", audioDuration)
			t.Logf("Processing time: %.2fs", elapsed.Seconds())
			t.Logf("RTFx: %.1fx", rtfx)

			// Проверяем что RTFx разумный (должен быть > 1x для эффективной модели)
			if rtfx < 1.0 {
				t.Logf("Warning: RTFx is low (%.1fx), expected >1x", rtfx)
			}

			// Проверяем timestamps
			for i, seg := range segments {
				if seg.Start < 0 || seg.End < 0 {
					t.Errorf("Segment %d has negative timestamp: start=%d, end=%d", i, seg.Start, seg.End)
				}
				if seg.Start >= seg.End {
					t.Errorf("Segment %d has invalid timestamps: start=%d >= end=%d", i, seg.Start, seg.End)
				}
			}
		})
	}
}

// TestFluidASREnginePerformance тестирует производительность на разных длинах аудио
func TestFluidASREnginePerformance(t *testing.T) {
	engine, err := NewFluidASREngine(FluidASRConfig{
		BinaryPath: "../audio/transcription/.build/release/transcription-fluid",
	})

	if err != nil {
		t.Skipf("Skipping test: %v", err)
		return
	}

	defer engine.Close()

	// Тестируем разные длины аудио
	durations := []float64{1.0, 5.0, 10.0, 30.0} // секунды

	for _, duration := range durations {
		t.Run(fmt.Sprintf("%.0fs", duration), func(t *testing.T) {
			// Генерируем тестовое аудио (белый шум)
			sampleRate := 16000
			numSamples := int(float64(sampleRate) * duration)
			samples := make([]float32, numSamples)

			for i := range samples {
				// Белый шум + синусоида для имитации речи
				noise := (float32(i%100) / 100.0) - 0.5
				sine := float32(0.3 * math.Sin(2*math.Pi*440*float64(i)/float64(sampleRate)))
				samples[i] = noise*0.1 + sine
			}

			// Транскрибируем
			start := time.Now()
			_, err := engine.TranscribeWithSegments(samples)
			elapsed := time.Since(start)

			if err != nil {
				t.Fatalf("Transcription failed: %v", err)
			}

			rtfx := duration / elapsed.Seconds()

			t.Logf("Duration: %.1fs", duration)
			t.Logf("Processing time: %.2fs", elapsed.Seconds())
			t.Logf("RTFx: %.1fx", rtfx)

			// Для длинных аудио ожидаем лучший RTFx (амортизация загрузки модели)
			if duration >= 10.0 && rtfx < 10.0 {
				t.Logf("Warning: RTFx is lower than expected for long audio (%.1fx)", rtfx)
			}
		})
	}
}

// TestFluidASREngineParallel тестирует параллельные вызовы
func TestFluidASREngineParallel(t *testing.T) {
	engine, err := NewFluidASREngine(FluidASRConfig{
		BinaryPath: "../audio/transcription/.build/release/transcription-fluid",
	})

	if err != nil {
		t.Skipf("Skipping test: %v", err)
		return
	}

	defer engine.Close()

	// Создаём тестовое аудио
	sampleRate := 16000
	duration := 2.0
	numSamples := int(float64(sampleRate) * duration)
	samples := make([]float32, numSamples)

	for i := range samples {
		samples[i] = float32(0.5 * math.Sin(2*math.Pi*440*float64(i)/float64(sampleRate)))
	}

	// Запускаем 3 параллельных транскрипции
	numWorkers := 3
	results := make(chan error, numWorkers)

	start := time.Now()

	for i := 0; i < numWorkers; i++ {
		go func(id int) {
			_, err := engine.Transcribe(samples, false)
			if err != nil {
				results <- fmt.Errorf("worker %d failed: %w", id, err)
			} else {
				results <- nil
			}
		}(i)
	}

	// Собираем результаты
	var errors []error
	for i := 0; i < numWorkers; i++ {
		if err := <-results; err != nil {
			errors = append(errors, err)
		}
	}

	elapsed := time.Since(start)

	if len(errors) > 0 {
		for _, err := range errors {
			t.Error(err)
		}
		t.Fatalf("Parallel transcription had %d errors", len(errors))
	}

	t.Logf("Parallel transcription: %d workers completed in %.2fs", numWorkers, elapsed.Seconds())
	t.Logf("Average time per worker: %.2fs", elapsed.Seconds()/float64(numWorkers))
}

// loadWAVFile загружает WAV файл и возвращает samples
func loadWAVFile(path string) ([]float32, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	// Читаем WAV header (44 bytes)
	header := make([]byte, 44)
	if _, err := io.ReadFull(file, header); err != nil {
		return nil, fmt.Errorf("failed to read WAV header: %w", err)
	}

	// Проверяем формат
	if string(header[0:4]) != "RIFF" || string(header[8:12]) != "WAVE" {
		return nil, fmt.Errorf("not a valid WAV file")
	}

	// Читаем audio data
	var samples []float32
	buf := make([]byte, 2) // 16-bit samples

	for {
		n, err := file.Read(buf)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if n < 2 {
			break
		}

		// Конвертируем 16-bit PCM в float32
		sample := int16(binary.LittleEndian.Uint16(buf))
		samples = append(samples, float32(sample)/32768.0)
	}

	return samples, nil
}
