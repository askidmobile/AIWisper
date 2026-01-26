package session

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExtractSegmentStereoGo(t *testing.T) {
	// Ищем тестовый MP3 файл в директории сессий
	appSupport := os.Getenv("HOME") + "/Library/Application Support/aiwisper/sessions"

	// Используем конкретную сессию из логов
	testMP3 := filepath.Join(appSupport, "5f581ceb-3cda-4f16-bb76-e19fe9c642e7", "full.mp3")

	if _, err := os.Stat(testMP3); os.IsNotExist(err) {
		t.Skipf("Test MP3 not found: %s", testMP3)
		return
	}

	// Тест 1: Извлечение первых 30 секунд (стерео)
	t.Run("ExtractStereo30s", func(t *testing.T) {
		left, right, err := ExtractSegmentStereoGo(testMP3, 0, 30000, 16000)
		if err != nil {
			t.Fatalf("ExtractSegmentStereoGo failed: %v", err)
		}

		// Проверяем что получили данные
		if len(left) == 0 || len(right) == 0 {
			t.Error("Expected non-empty samples")
		}

		// Проверяем что длины совпадают
		if len(left) != len(right) {
			t.Errorf("Left and right channels have different lengths: %d vs %d", len(left), len(right))
		}

		// Ожидаем примерно 30 секунд * 16000 = 480000 сэмплов
		expectedSamples := 30 * 16000
		tolerance := 1000 // +/- 1000 сэмплов из-за MP3 фреймов
		if len(left) < expectedSamples-tolerance || len(left) > expectedSamples+tolerance {
			t.Logf("Warning: Got %d samples, expected ~%d", len(left), expectedSamples)
		}

		t.Logf("Extracted %d samples per channel (%.1f sec)", len(left), float64(len(left))/16000)
	})

	// Тест 2: Извлечение сегмента из середины
	t.Run("ExtractMiddleSegment", func(t *testing.T) {
		left, right, err := ExtractSegmentStereoGo(testMP3, 30000, 60000, 16000)
		if err != nil {
			t.Fatalf("ExtractSegmentStereoGo failed: %v", err)
		}

		if len(left) == 0 || len(right) == 0 {
			t.Error("Expected non-empty samples")
		}

		t.Logf("Extracted middle segment: %d samples (%.1f sec)", len(left), float64(len(left))/16000)
	})

	// Тест 3: Моно извлечение
	t.Run("ExtractMono", func(t *testing.T) {
		mono, err := ExtractSegmentGo(testMP3, 0, 10000, 16000)
		if err != nil {
			t.Fatalf("ExtractSegmentGo failed: %v", err)
		}

		if len(mono) == 0 {
			t.Error("Expected non-empty mono samples")
		}

		// Проверяем диапазон значений
		var min, max float32 = 1, -1
		for _, s := range mono {
			if s < min {
				min = s
			}
			if s > max {
				max = s
			}
		}

		if min < -1.0 || max > 1.0 {
			t.Errorf("Samples out of range: min=%f, max=%f", min, max)
		}

		t.Logf("Mono: %d samples, range [%.3f, %.3f]", len(mono), min, max)
	})
}

func TestMP3Reader(t *testing.T) {
	appSupport := os.Getenv("HOME") + "/Library/Application Support/aiwisper/sessions"
	testMP3 := filepath.Join(appSupport, "5f581ceb-3cda-4f16-bb76-e19fe9c642e7", "full.mp3")

	if _, err := os.Stat(testMP3); os.IsNotExist(err) {
		t.Skipf("Test MP3 not found: %s", testMP3)
		return
	}

	reader, err := NewMP3Reader(testMP3)
	if err != nil {
		t.Fatalf("NewMP3Reader failed: %v", err)
	}
	defer reader.Close()

	t.Logf("MP3 info: sampleRate=%d, channels=%d, duration=%.1f sec",
		reader.SampleRate(), reader.Channels(), reader.Duration())

	// Должен быть стандартный MP3 (44100 Hz) или 48000 Hz
	if reader.SampleRate() != 44100 && reader.SampleRate() != 48000 {
		t.Logf("Unusual sample rate: %d", reader.SampleRate())
	}
}

// BenchmarkExtractSegment сравнивает производительность Go vs FFmpeg
func BenchmarkExtractSegmentGo(b *testing.B) {
	appSupport := os.Getenv("HOME") + "/Library/Application Support/aiwisper/sessions"
	testMP3 := filepath.Join(appSupport, "5f581ceb-3cda-4f16-bb76-e19fe9c642e7", "full.mp3")

	if _, err := os.Stat(testMP3); os.IsNotExist(err) {
		b.Skipf("Test MP3 not found: %s", testMP3)
		return
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, err := ExtractSegmentStereoGo(testMP3, 0, 30000, 16000)
		if err != nil {
			b.Fatalf("ExtractSegmentStereoGo failed: %v", err)
		}
	}
}
