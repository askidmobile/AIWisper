//go:build darwin

package ai

import (
	"os"
	"testing"
)

func TestFluidDiarizerFile(t *testing.T) {
	// Тест с реальным аудио файлом
	audioPath := "../whisper.cpp/samples/jfk.wav"
	if _, err := os.Stat(audioPath); os.IsNotExist(err) {
		t.Skip("Test audio file not found:", audioPath)
	}

	diarizer, err := NewFluidDiarizer(FluidDiarizerConfig{})
	if err != nil {
		t.Fatalf("Failed to create FluidDiarizer: %v", err)
	}
	defer diarizer.Close()

	segments, err := diarizer.DiarizeFile(audioPath)
	if err != nil {
		t.Fatalf("DiarizeFile failed: %v", err)
	}

	t.Logf("Found %d segments", len(segments))
	for i, seg := range segments {
		t.Logf("  Segment %d: speaker=%d, start=%.2f, end=%.2f", i, seg.Speaker, seg.Start, seg.End)
	}

	if len(segments) == 0 {
		t.Error("Expected at least one segment")
	}
}
