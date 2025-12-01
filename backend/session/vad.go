package session

import (
	"math"
)

// DetectSpeechStart определяет момент начала речи в аудио (в миллисекундах)
// Использует простой Voice Activity Detection на основе энергии сигнала
func DetectSpeechStart(samples []float32, sampleRate int) int64 {
	if len(samples) == 0 {
		return 0
	}

	const (
		// Размер окна для анализа (50 мс)
		windowMs = 50
		// Порог энергии для определения речи
		energyThreshold = 0.01
		// Количество последовательных окон с речью для подтверждения
		confirmWindows = 2
	)

	windowSamples := (sampleRate * windowMs) / 1000
	if windowSamples <= 0 {
		windowSamples = 1
	}

	var confirmedCount int
	var speechStartWindow int = -1

	// Анализируем окнами
	for i := 0; i < len(samples); i += windowSamples {
		end := i + windowSamples
		if end > len(samples) {
			end = len(samples)
		}

		// Вычисляем RMS энергию окна
		energy := calculateWindowEnergy(samples[i:end])

		if energy >= energyThreshold {
			if confirmedCount == 0 {
				speechStartWindow = i / windowSamples
			}
			confirmedCount++

			// Если нашли достаточно подтверждений подряд
			if confirmedCount >= confirmWindows {
				// Возвращаем начало первого окна с речью
				startMs := int64(speechStartWindow * windowMs)
				return startMs
			}
		} else {
			// Сбрасываем счетчик если встретили тишину
			confirmedCount = 0
			speechStartWindow = -1
		}
	}

	// Если не нашли речь, возвращаем 0
	return 0
}

// calculateWindowEnergy вычисляет RMS энергию окна
func calculateWindowEnergy(samples []float32) float64 {
	if len(samples) == 0 {
		return 0
	}

	var sum float64
	for _, s := range samples {
		sum += float64(s * s)
	}

	return math.Sqrt(sum / float64(len(samples)))
}

// AlignSegmentTimestamps корректирует таймстемпы сегментов с учётом offset начала речи
func AlignSegmentTimestamps(segments []TranscriptSegment, offsetMs int64) []TranscriptSegment {
	if offsetMs == 0 {
		return segments
	}

	aligned := make([]TranscriptSegment, len(segments))
	for i, seg := range segments {
		aligned[i] = TranscriptSegment{
			Start:   seg.Start + offsetMs,
			End:     seg.End + offsetMs,
			Text:    seg.Text,
			Speaker: seg.Speaker,
		}
	}

	return aligned
}

// ApplyOffsetToSegments применяет offset ко времени начала и конца всех сегментов
// Работает с любым типом сегментов (просто меняет start/end)
func ApplyOffsetToSegments(segments interface{}, offsetMs int64) interface{} {
	return segments // Placeholder, будет использоваться в main.go напрямую
}
