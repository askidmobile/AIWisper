package ai

import (
	"encoding/binary"
	"os"
	"os/exec"
	"testing"
)

func TestGigaAMEngine_Integration(t *testing.T) {
	// Пропускаем если нет модели
	modelPath := os.Getenv("GIGAAM_MODEL_PATH")
	vocabPath := os.Getenv("GIGAAM_VOCAB_PATH")

	if modelPath == "" || vocabPath == "" {
		t.Skip("GIGAAM_MODEL_PATH and GIGAAM_VOCAB_PATH not set")
	}

	// Проверяем переменную ONNX Runtime
	if os.Getenv("ONNXRUNTIME_SHARED_LIBRARY_PATH") == "" {
		t.Skip("ONNXRUNTIME_SHARED_LIBRARY_PATH not set")
	}

	engine, err := NewGigaAMEngine(modelPath, vocabPath)
	if err != nil {
		t.Fatalf("Failed to create GigaAM engine: %v", err)
	}
	defer engine.Close()

	// Проверяем базовые свойства
	if engine.Name() != "gigaam" {
		t.Errorf("Expected name 'gigaam', got %q", engine.Name())
	}

	langs := engine.SupportedLanguages()
	if len(langs) != 1 || langs[0] != "ru" {
		t.Errorf("Expected supported languages [ru], got %v", langs)
	}

	// Тест с тишиной (должен вернуть пустой результат)
	silence := make([]float32, 16000) // 1 секунда тишины
	text, err := engine.Transcribe(silence, false)
	if err != nil {
		t.Errorf("Transcribe failed: %v", err)
	}
	t.Logf("Silence transcription: %q", text)
}

func TestMelFilterbank(t *testing.T) {
	// GigaAM v3 параметры
	filters := createMelFilterbank(320, 64, 16000)

	if len(filters) != 64 {
		t.Errorf("Expected 64 mel filters, got %d", len(filters))
	}

	// Проверяем что каждый фильтр имеет правильный размер
	expectedBins := 320/2 + 1 // 161
	for i, f := range filters {
		if len(f) != expectedBins {
			t.Errorf("Filter %d: expected %d bins, got %d", i, expectedBins, len(f))
		}
	}

	// Выводим диапазоны bins для первых 10 фильтров
	t.Log("First 10 mel filters (non-zero bin ranges):")
	for m := 0; m < 10; m++ {
		start, end := -1, -1
		maxVal := 0.0
		for k := 0; k < len(filters[m]); k++ {
			if filters[m][k] > 0 {
				if start < 0 {
					start = k
				}
				end = k
				if filters[m][k] > maxVal {
					maxVal = filters[m][k]
				}
			}
		}
		t.Logf("  Filter %d: bins %d-%d, max=%.4f", m, start, end, maxVal)
	}

	// Проверяем что фильтры не все нулевые
	hasNonZero := false
	for _, f := range filters {
		for _, v := range f {
			if v > 0 {
				hasNonZero = true
				break
			}
		}
		if hasNonZero {
			break
		}
	}
	if !hasNonZero {
		t.Error("All mel filters are zero")
	}
}

func TestHannWindow(t *testing.T) {
	window := createHannWindow(400)

	if len(window) != 400 {
		t.Errorf("Expected window size 400, got %d", len(window))
	}

	// Проверяем свойства окна Ханна
	// Начало и конец должны быть близки к 0
	if window[0] > 0.01 {
		t.Errorf("Window start should be near 0, got %f", window[0])
	}
	if window[len(window)-1] > 0.01 {
		t.Errorf("Window end should be near 0, got %f", window[len(window)-1])
	}

	// Середина должна быть близка к 1
	mid := window[len(window)/2]
	if mid < 0.99 || mid > 1.01 {
		t.Errorf("Window middle should be near 1, got %f", mid)
	}
}

func TestLoadGigaAMVocab(t *testing.T) {
	// Создаём временный файл словаря (формат v3_ctc - character-based)
	content := `▁ 0
а 1
б 2
в 3
<blk> 4
`
	tmpFile, err := os.CreateTemp("", "vocab*.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(content); err != nil {
		t.Fatal(err)
	}
	tmpFile.Close()

	vocab, blankID, spaceID, err := loadGigaAMVocab(tmpFile.Name())
	if err != nil {
		t.Fatalf("Failed to load vocab: %v", err)
	}

	if len(vocab) != 5 {
		t.Errorf("Expected 5 tokens, got %d", len(vocab))
	}

	if blankID != 4 {
		t.Errorf("Expected blank_id=4, got %d", blankID)
	}

	if spaceID != 0 {
		t.Errorf("Expected space_id=0, got %d", spaceID)
	}

	if vocab[0] != "▁" {
		t.Errorf("Expected first token '▁', got %q", vocab[0])
	}
}

// TestMelSpectrogramComparison сравнивает нашу mel-спектрограмму с torchaudio
func TestMelSpectrogramComparison(t *testing.T) {
	// Путь к тестовому аудио
	audioPath := "/Users/askid/Library/Application Support/aiwisper/sessions/5f581ceb-3cda-4f16-bb76-e19fe9c642e7/full.mp3"

	// Проверяем существование файла
	if _, err := os.Stat(audioPath); os.IsNotExist(err) {
		t.Skip("Test audio file not found")
	}

	// Загружаем аудио через ffmpeg
	samples, err := loadAudioFFmpegTest(audioPath)
	if err != nil {
		t.Fatalf("Failed to load audio: %v", err)
	}
	t.Logf("Loaded %d samples (%.2fs)", len(samples), float64(len(samples))/16000)

	// GigaAM v3 параметры
	config := MelConfig{
		SampleRate: 16000,
		NMels:      64,
		HopLength:  160,
		WinLength:  320,
		NFFT:       320,
		Center:     false, // GigaAM v3
	}

	processor := NewMelProcessor(config)
	mel, numFrames := processor.Compute(samples)

	t.Logf("Mel shape: [%d][%d]", numFrames, config.NMels)

	// Статистика
	var minVal, maxVal float32 = 1e10, -1e10
	var sum float64
	count := 0

	for frame := 0; frame < numFrames; frame++ {
		for m := 0; m < config.NMels; m++ {
			v := mel[frame][m]
			if v < minVal {
				minVal = v
			}
			if v > maxVal {
				maxVal = v
			}
			sum += float64(v)
			count++
		}
	}
	mean := sum / float64(count)

	t.Logf("Mel statistics:")
	t.Logf("  Min: %.4f", minVal)
	t.Logf("  Max: %.4f", maxVal)
	t.Logf("  Mean: %.4f", mean)

	// Выводим первые несколько фреймов
	t.Logf("First 3 frames (first 10 mel bins):")
	for frame := 0; frame < 3 && frame < numFrames; frame++ {
		t.Logf("  Frame %d: %v", frame, mel[frame][:10])
	}

	// Выводим первые 10 аудио сэмплов
	t.Logf("First 10 audio samples: %v", samples[:10])

	// Сравнение с Python (torchaudio)
	// Ожидаемые значения от Python:
	// Min: -20.7233, Max: 4.3761, Mean: -9.5856
	// Допустимая погрешность
	tolerance := float32(0.5)

	if minVal < -21.5 || minVal > -20.0 {
		t.Errorf("Min value %.4f differs significantly from expected ~-20.7233", minVal)
	}
	if maxVal < 3.5 || maxVal > 5.0 {
		t.Errorf("Max value %.4f differs significantly from expected ~4.3761", maxVal)
	}
	_ = tolerance

	// Сохраняем mel в файл для сравнения с Python
	saveMelToFile(mel, numFrames, config.NMels, "/tmp/mel_go.bin")
	t.Logf("Saved mel to /tmp/mel_go.bin")
}

func saveMelToFile(mel [][]float32, numFrames, nMels int, path string) {
	f, err := os.Create(path)
	if err != nil {
		return
	}
	defer f.Close()

	binary.Write(f, binary.LittleEndian, int32(numFrames))
	binary.Write(f, binary.LittleEndian, int32(nMels))
	for frame := 0; frame < numFrames; frame++ {
		for m := 0; m < nMels; m++ {
			binary.Write(f, binary.LittleEndian, mel[frame][m])
		}
	}
}

func loadAudioFFmpegTest(path string) ([]float32, error) {
	cmd := exec.Command("ffmpeg",
		"-nostdin", "-threads", "0",
		"-i", path,
		"-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le",
		"-ar", "16000", "-",
	)

	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	// Конвертируем int16 в float32
	numSamples := len(output) / 2
	samples := make([]float32, numSamples)
	for i := 0; i < numSamples; i++ {
		sample := int16(binary.LittleEndian.Uint16(output[i*2 : i*2+2]))
		samples[i] = float32(sample) / 32768.0
	}

	return samples, nil
}

func TestLoadGigaAMVocab_V3CTC(t *testing.T) {
	// Создаём временный файл словаря (формат v3_vocab.txt - 34 токена)
	content := `▁ 0
а 1
б 2
в 3
г 4
д 5
е 6
ж 7
з 8
и 9
й 10
к 11
л 12
м 13
н 14
о 15
п 16
р 17
с 18
т 19
у 20
ф 21
х 22
ц 23
ч 24
ш 25
щ 26
ъ 27
ы 28
ь 29
э 30
ю 31
я 32
<blk> 33
`
	tmpFile, err := os.CreateTemp("", "vocab_v3*.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(content); err != nil {
		t.Fatal(err)
	}
	tmpFile.Close()

	vocab, blankID, spaceID, err := loadGigaAMVocab(tmpFile.Name())
	if err != nil {
		t.Fatalf("Failed to load vocab: %v", err)
	}

	if len(vocab) != 34 {
		t.Errorf("Expected 34 tokens, got %d", len(vocab))
	}

	if blankID != 33 {
		t.Errorf("Expected blank_id=33, got %d", blankID)
	}

	if spaceID != 0 {
		t.Errorf("Expected space_id=0, got %d", spaceID)
	}

	// Проверяем несколько букв
	if vocab[1] != "а" {
		t.Errorf("Expected token 1 'а', got %q", vocab[1])
	}

	if vocab[32] != "я" {
		t.Errorf("Expected token 32 'я', got %q", vocab[32])
	}
}
