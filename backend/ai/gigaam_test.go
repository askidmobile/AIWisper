package ai

import (
	"os"
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
	filters := createMelFilterbank(400, 64, 16000)

	if len(filters) != 64 {
		t.Errorf("Expected 64 mel filters, got %d", len(filters))
	}

	// Проверяем что каждый фильтр имеет правильный размер
	expectedBins := 400/2 + 1 // 201
	for i, f := range filters {
		if len(f) != expectedBins {
			t.Errorf("Filter %d: expected %d bins, got %d", i, expectedBins, len(f))
		}
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
	// Создаём временный файл словаря
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

	vocab, blankID, err := loadGigaAMVocab(tmpFile.Name())
	if err != nil {
		t.Fatalf("Failed to load vocab: %v", err)
	}

	if len(vocab) != 5 {
		t.Errorf("Expected 5 tokens, got %d", len(vocab))
	}

	if blankID != 4 {
		t.Errorf("Expected blank_id=4, got %d", blankID)
	}

	if vocab[0] != "▁" {
		t.Errorf("Expected first token '▁', got %q", vocab[0])
	}
}
