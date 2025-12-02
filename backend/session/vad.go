package session

import (
	"log"
	"math"
)

// DetectSpeechStart определяет момент начала речи в аудио (в миллисекундах)
// Использует простой Voice Activity Detection на основе энергии сигнала
func DetectSpeechStart(samples []float32, sampleRate int) int64 {
	if len(samples) == 0 {
		return 0
	}

	const (
		// Размер окна для анализа (20 мс) - уменьшили для точности
		windowMs = 20
		// Порог энергии для определения речи (снижен для чувствительности)
		energyThreshold = 0.005
		// Количество последовательных окон с речью для подтверждения
		confirmWindows = 3
	)

	windowSamples := (sampleRate * windowMs) / 1000
	if windowSamples <= 0 {
		windowSamples = 1
	}

	// Сначала вычислим среднюю энергию для адаптивного порога
	var totalEnergy float64
	var windowCount int
	for i := 0; i < len(samples); i += windowSamples {
		end := i + windowSamples
		if end > len(samples) {
			end = len(samples)
		}
		totalEnergy += calculateWindowEnergy(samples[i:end])
		windowCount++
	}
	avgEnergy := totalEnergy / float64(windowCount)

	// Адаптивный порог: минимум energyThreshold, но не меньше 20% от средней энергии
	adaptiveThreshold := energyThreshold
	if avgEnergy*0.2 > adaptiveThreshold {
		adaptiveThreshold = avgEnergy * 0.2
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

		if energy >= adaptiveThreshold {
			if confirmedCount == 0 {
				speechStartWindow = i / windowSamples
			}
			confirmedCount++

			// Если нашли достаточно подтверждений подряд
			if confirmedCount >= confirmWindows {
				// Возвращаем начало первого окна с речью
				// Вычисляем точное время в миллисекундах
				startSample := speechStartWindow * windowSamples
				startMs := int64(startSample) * 1000 / int64(sampleRate)
				log.Printf("DetectSpeechStart: found speech at %d ms (sample %d, threshold=%.4f, avgEnergy=%.4f)",
					startMs, startSample, adaptiveThreshold, avgEnergy)
				return startMs
			}
		} else {
			// Сбрасываем счетчик если встретили тишину
			confirmedCount = 0
			speechStartWindow = -1
		}
	}

	// Если не нашли речь, возвращаем 0
	log.Printf("DetectSpeechStart: no speech found (avgEnergy=%.4f, threshold=%.4f)", avgEnergy, adaptiveThreshold)
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

// SpeechRegion представляет участок речи в аудио
type SpeechRegion struct {
	StartMs int64 // Начало речи в миллисекундах
	EndMs   int64 // Конец речи в миллисекундах
}

// DetectSpeechRegions находит все участки речи в аудио
// Возвращает список регионов с началом и концом каждого участка речи
func DetectSpeechRegions(samples []float32, sampleRate int) []SpeechRegion {
	if len(samples) == 0 {
		return nil
	}

	const (
		windowMs        = 20 // Размер окна для анализа (20 мс)
		energyThreshold = 0.005
		confirmWindows  = 3   // Окон подряд для подтверждения начала речи
		silenceWindows  = 15  // Окон тишины для завершения региона (300ms)
		minRegionMs     = 100 // Минимальная длина региона речи (100ms)
	)

	windowSamples := (sampleRate * windowMs) / 1000
	if windowSamples <= 0 {
		windowSamples = 1
	}

	// Вычисляем среднюю энергию для адаптивного порога
	var totalEnergy float64
	var windowCount int
	for i := 0; i < len(samples); i += windowSamples {
		end := i + windowSamples
		if end > len(samples) {
			end = len(samples)
		}
		totalEnergy += calculateWindowEnergy(samples[i:end])
		windowCount++
	}
	avgEnergy := totalEnergy / float64(windowCount)

	// Адаптивный порог
	adaptiveThreshold := energyThreshold
	if avgEnergy*0.2 > adaptiveThreshold {
		adaptiveThreshold = avgEnergy * 0.2
	}

	var regions []SpeechRegion
	var inSpeech bool
	var speechStartSample int
	var silenceCount int
	var speechCount int

	// Анализируем окнами
	for i := 0; i < len(samples); i += windowSamples {
		end := i + windowSamples
		if end > len(samples) {
			end = len(samples)
		}

		energy := calculateWindowEnergy(samples[i:end])
		isSpeech := energy >= adaptiveThreshold

		if isSpeech {
			silenceCount = 0
			speechCount++

			if !inSpeech && speechCount >= confirmWindows {
				// Начало нового региона речи
				inSpeech = true
				// Откатываемся на confirmWindows назад
				speechStartSample = i - (confirmWindows-1)*windowSamples
				if speechStartSample < 0 {
					speechStartSample = 0
				}
			}
		} else {
			speechCount = 0

			if inSpeech {
				silenceCount++
				if silenceCount >= silenceWindows {
					// Конец региона речи
					endSample := i - silenceWindows*windowSamples
					startMs := int64(speechStartSample) * 1000 / int64(sampleRate)
					endMs := int64(endSample) * 1000 / int64(sampleRate)

					// Добавляем только если регион достаточно длинный
					if endMs-startMs >= minRegionMs {
						regions = append(regions, SpeechRegion{
							StartMs: startMs,
							EndMs:   endMs,
						})
					}

					inSpeech = false
					silenceCount = 0
				}
			}
		}
	}

	// Если закончили в состоянии речи, добавляем последний регион
	if inSpeech {
		endSample := len(samples)
		startMs := int64(speechStartSample) * 1000 / int64(sampleRate)
		endMs := int64(endSample) * 1000 / int64(sampleRate)

		if endMs-startMs >= minRegionMs {
			regions = append(regions, SpeechRegion{
				StartMs: startMs,
				EndMs:   endMs,
			})
		}
	}

	log.Printf("DetectSpeechRegions: found %d regions (threshold=%.4f, avgEnergy=%.4f)",
		len(regions), adaptiveThreshold, avgEnergy)
	for i, r := range regions {
		log.Printf("  region[%d]: %dms - %dms (duration: %dms)", i, r.StartMs, r.EndMs, r.EndMs-r.StartMs)
	}

	return regions
}

// MapWhisperSegmentsToRealTime сопоставляет сегменты Whisper с реальными участками речи
// Whisper возвращает таймстемпы относительно "сжатого" аудио без пауз
// Эта функция восстанавливает реальные таймстемпы на основе VAD регионов
func MapWhisperSegmentsToRealTime(whisperStarts []int64, speechRegions []SpeechRegion) []int64 {
	if len(whisperStarts) == 0 || len(speechRegions) == 0 {
		return whisperStarts
	}

	// Вычисляем общую длительность речи по регионам VAD
	var totalSpeechMs int64
	for _, r := range speechRegions {
		totalSpeechMs += r.EndMs - r.StartMs
	}

	// Вычисляем общую длительность по Whisper (последний таймстемп)
	whisperTotalMs := whisperStarts[len(whisperStarts)-1]
	if whisperTotalMs == 0 {
		whisperTotalMs = 1 // Избегаем деления на 0
	}

	log.Printf("MapWhisperSegmentsToRealTime: whisper total=%dms, VAD speech total=%dms, regions=%d",
		whisperTotalMs, totalSpeechMs, len(speechRegions))

	result := make([]int64, len(whisperStarts))

	for i, whisperStart := range whisperStarts {
		// Находим позицию в "сжатом" времени речи
		// и маппим её на реальное время с учётом пауз

		// Накапливаем время речи до нужной позиции
		var accumulatedSpeech int64
		var realTimeMs int64 = 0

		for _, region := range speechRegions {
			regionDuration := region.EndMs - region.StartMs

			if accumulatedSpeech+regionDuration >= whisperStart {
				// Нашли регион, в котором находится этот таймстемп
				offsetInRegion := whisperStart - accumulatedSpeech
				realTimeMs = region.StartMs + offsetInRegion
				break
			}

			accumulatedSpeech += regionDuration
			realTimeMs = region.EndMs // На случай если выйдем за пределы
		}

		result[i] = realTimeMs
		log.Printf("  segment[%d]: whisper=%dms -> real=%dms", i, whisperStart, realTimeMs)
	}

	return result
}

// MapWhisperTimeToRealTime маппит одиночный таймстемп Whisper на реальное время
// Используется для маппинга word-level timestamps
func MapWhisperTimeToRealTime(whisperMs int64, speechRegions []SpeechRegion) int64 {
	if len(speechRegions) == 0 {
		return whisperMs
	}

	// Накапливаем время речи до нужной позиции
	var accumulatedSpeech int64
	var realTimeMs int64 = 0

	for _, region := range speechRegions {
		regionDuration := region.EndMs - region.StartMs

		if accumulatedSpeech+regionDuration >= whisperMs {
			// Нашли регион, в котором находится этот таймстемп
			offsetInRegion := whisperMs - accumulatedSpeech
			realTimeMs = region.StartMs + offsetInRegion
			return realTimeMs
		}

		accumulatedSpeech += regionDuration
		realTimeMs = region.EndMs // На случай если выйдем за пределы
	}

	return realTimeMs
}
