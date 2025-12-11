package session

import (
	"log"
	"math"
)

// AudioFilterConfig конфигурация фильтров для улучшения качества аудио
type AudioFilterConfig struct {
	// Noise Gate - подавление шума ниже порога
	NoiseGateEnabled   bool
	NoiseGateThreshold float32 // Порог RMS ниже которого сигнал обнуляется (default: 0.01)

	// Normalization - нормализация громкости
	NormalizationEnabled bool
	TargetPeakLevel      float32 // Целевой уровень пика (default: 0.9)

	// High-Pass Filter - фильтрация низкочастотных помех
	HighPassEnabled bool
	HighPassCutoff  float32 // Частота среза в Hz (default: 80)

	// De-click - удаление щелчков и тычков
	DeClickEnabled   bool
	DeClickThreshold float32 // Порог обнаружения щелчка (default: 0.5)
}

// DefaultAudioFilterConfig возвращает конфигурацию по умолчанию
func DefaultAudioFilterConfig() AudioFilterConfig {
	return AudioFilterConfig{
		NoiseGateEnabled:     true,
		NoiseGateThreshold:   0.008, // Очень тихие сигналы - помехи
		NormalizationEnabled: true,
		TargetPeakLevel:      0.9,
		HighPassEnabled:      true,
		HighPassCutoff:       80, // Убираем гул ниже 80 Hz
		DeClickEnabled:       true,
		DeClickThreshold:     0.4, // Резкие скачки амплитуды
	}
}

// ApplyAudioFilters применяет все включённые фильтры к аудио-семплам
// Возвращает обработанные семплы (исходные не изменяются)
func ApplyAudioFilters(samples []float32, sampleRate int, config AudioFilterConfig) []float32 {
	if len(samples) == 0 {
		return samples
	}

	// Копируем семплы чтобы не изменять оригинал
	result := make([]float32, len(samples))
	copy(result, samples)

	// 1. High-Pass Filter (сначала, чтобы убрать DC offset и низкочастотный гул)
	if config.HighPassEnabled {
		result = applyHighPassFilter(result, sampleRate, config.HighPassCutoff)
	}

	// 2. De-click (удаление щелчков до нормализации)
	if config.DeClickEnabled {
		result = applyDeClick(result, config.DeClickThreshold)
	}

	// 3. Noise Gate (подавление тихих участков)
	if config.NoiseGateEnabled {
		result = applyNoiseGate(result, sampleRate, config.NoiseGateThreshold)
	}

	// 4. Normalization (в конце, после очистки)
	if config.NormalizationEnabled {
		result = applyNormalization(result, config.TargetPeakLevel)
	}

	return result
}

// applyHighPassFilter применяет фильтр высоких частот (убирает низкочастотный гул)
// Использует простой IIR фильтр первого порядка
func applyHighPassFilter(samples []float32, sampleRate int, cutoffHz float32) []float32 {
	if len(samples) == 0 || cutoffHz <= 0 {
		return samples
	}

	// Вычисляем коэффициент фильтра
	// RC = 1 / (2 * PI * cutoff)
	// alpha = RC / (RC + dt) где dt = 1/sampleRate
	rc := 1.0 / (2.0 * math.Pi * float64(cutoffHz))
	dt := 1.0 / float64(sampleRate)
	alpha := float32(rc / (rc + dt))

	result := make([]float32, len(samples))
	result[0] = samples[0]

	var prevInput float32 = samples[0]
	var prevOutput float32 = samples[0]

	for i := 1; i < len(samples); i++ {
		// y[i] = alpha * (y[i-1] + x[i] - x[i-1])
		result[i] = alpha * (prevOutput + samples[i] - prevInput)
		prevInput = samples[i]
		prevOutput = result[i]
	}

	log.Printf("AudioFilter: High-pass filter applied (cutoff=%dHz)", int(cutoffHz))
	return result
}

// applyDeClick удаляет резкие щелчки и тычки
// Обнаруживает резкие скачки амплитуды и интерполирует их
func applyDeClick(samples []float32, threshold float32) []float32 {
	if len(samples) < 3 {
		return samples
	}

	result := make([]float32, len(samples))
	copy(result, samples)

	clickCount := 0

	for i := 1; i < len(samples)-1; i++ {
		// Вычисляем разницу с соседями
		diffPrev := abs32(samples[i] - samples[i-1])
		diffNext := abs32(samples[i] - samples[i+1])

		// Если резкий скачок в обе стороны - это щелчок
		if diffPrev > threshold && diffNext > threshold {
			// Интерполируем значение между соседями
			result[i] = (samples[i-1] + samples[i+1]) / 2
			clickCount++
		}
	}

	if clickCount > 0 {
		log.Printf("AudioFilter: De-click removed %d clicks (threshold=%.2f)", clickCount, threshold)
	}

	return result
}

// applyNoiseGate подавляет сигнал ниже порогового уровня
// Работает по оконам чтобы не создавать артефактов
func applyNoiseGate(samples []float32, sampleRate int, threshold float32) []float32 {
	if len(samples) == 0 {
		return samples
	}

	// Размер окна 10мс
	windowSize := sampleRate / 100
	if windowSize < 1 {
		windowSize = 1
	}

	result := make([]float32, len(samples))
	copy(result, samples)

	silencedWindows := 0
	totalWindows := 0

	for i := 0; i < len(samples); i += windowSize {
		end := i + windowSize
		if end > len(samples) {
			end = len(samples)
		}

		// Вычисляем RMS окна
		rms := calculateRMS(samples[i:end])
		totalWindows++

		if rms < threshold {
			// Плавное затухание вместо резкого обнуления
			// Используем коэффициент на основе того, насколько сигнал ниже порога
			attenuation := rms / threshold
			if attenuation < 0.1 {
				attenuation = 0.1 // Минимальное затухание чтобы избежать полной тишины
			}

			for j := i; j < end; j++ {
				result[j] *= attenuation
			}
			silencedWindows++
		}
	}

	if silencedWindows > 0 {
		log.Printf("AudioFilter: Noise gate attenuated %d/%d windows (threshold=%.4f)",
			silencedWindows, totalWindows, threshold)
	}

	return result
}

// applyNormalization нормализует громкость к целевому пиковому уровню
func applyNormalization(samples []float32, targetPeak float32) []float32 {
	if len(samples) == 0 || targetPeak <= 0 {
		return samples
	}

	// Находим текущий пик
	var maxAbs float32 = 0
	for _, s := range samples {
		abs := abs32(s)
		if abs > maxAbs {
			maxAbs = abs
		}
	}

	if maxAbs < 0.001 {
		// Сигнал слишком тихий, нормализация может усилить шум
		log.Printf("AudioFilter: Normalization skipped (signal too quiet, peak=%.4f)", maxAbs)
		return samples
	}

	// Вычисляем коэффициент усиления
	gain := targetPeak / maxAbs
	if gain > 20 {
		// Ограничиваем максимальное усиление чтобы не усиливать шум
		gain = 20
		log.Printf("AudioFilter: Normalization gain limited to 20x (original peak=%.4f)", maxAbs)
	}

	result := make([]float32, len(samples))
	for i, s := range samples {
		result[i] = s * gain
		// Клиппинг
		if result[i] > 1 {
			result[i] = 1
		} else if result[i] < -1 {
			result[i] = -1
		}
	}

	log.Printf("AudioFilter: Normalization applied (gain=%.2fx, peak: %.4f -> %.4f)",
		gain, maxAbs, targetPeak)

	return result
}

// calculateRMS вычисляет RMS (Root Mean Square) для набора семплов
func calculateRMS(samples []float32) float32 {
	if len(samples) == 0 {
		return 0
	}

	var sum float64
	for _, s := range samples {
		sum += float64(s * s)
	}

	return float32(math.Sqrt(sum / float64(len(samples))))
}

// abs32 возвращает абсолютное значение float32
func abs32(x float32) float32 {
	if x < 0 {
		return -x
	}
	return x
}

// AnalyzeAudioQuality анализирует качество аудио и возвращает метрики
type AudioQualityMetrics struct {
	RMS         float32 // Средняя громкость
	Peak        float32 // Пиковая амплитуда
	SNR         float32 // Отношение сигнал/шум (приблизительное)
	HasVoice    bool    // Обнаружен ли голос
	NoiseLevel  float32 // Уровень фонового шума
	ClickCount  int     // Количество обнаруженных щелчков
	DCOffset    float32 // Смещение по постоянному току
	IsSilent    bool    // Канал практически пустой
	Description string  // Текстовое описание качества
}

// AnalyzeAudioQuality анализирует качество аудио канала
func AnalyzeAudioQuality(samples []float32, sampleRate int) AudioQualityMetrics {
	metrics := AudioQualityMetrics{}

	if len(samples) == 0 {
		metrics.IsSilent = true
		metrics.Description = "Пустой канал"
		return metrics
	}

	// Вычисляем базовые метрики
	var sum, sumSq float64
	var peak float32
	for _, s := range samples {
		sum += float64(s)
		sumSq += float64(s * s)
		abs := abs32(s)
		if abs > peak {
			peak = abs
		}
	}

	n := float64(len(samples))
	metrics.DCOffset = float32(sum / n)
	metrics.RMS = float32(math.Sqrt(sumSq / n))
	metrics.Peak = peak

	// Определяем тихий канал
	if metrics.RMS < 0.005 && metrics.Peak < 0.05 {
		metrics.IsSilent = true
		metrics.Description = "Тихий канал (помехи/тишина)"
		return metrics
	}

	// Оцениваем уровень шума (анализируем самые тихие участки)
	windowSize := sampleRate / 50 // 20ms окна
	var minRMS float32 = 1.0
	for i := 0; i < len(samples); i += windowSize {
		end := i + windowSize
		if end > len(samples) {
			end = len(samples)
		}
		rms := calculateRMS(samples[i:end])
		if rms < minRMS && rms > 0.0001 {
			minRMS = rms
		}
	}
	metrics.NoiseLevel = minRMS

	// Приблизительный SNR
	if metrics.NoiseLevel > 0 {
		metrics.SNR = 20 * float32(math.Log10(float64(metrics.RMS/metrics.NoiseLevel)))
	}

	// Подсчёт щелчков
	threshold := float32(0.4)
	for i := 1; i < len(samples)-1; i++ {
		diffPrev := abs32(samples[i] - samples[i-1])
		diffNext := abs32(samples[i] - samples[i+1])
		if diffPrev > threshold && diffNext > threshold {
			metrics.ClickCount++
		}
	}

	// Определяем наличие голоса (речевые регионы)
	regions := DetectSpeechRegions(samples, sampleRate)
	metrics.HasVoice = len(regions) > 0

	// Формируем описание
	if metrics.HasVoice {
		if metrics.SNR > 20 {
			metrics.Description = "Хорошее качество голоса"
		} else if metrics.SNR > 10 {
			metrics.Description = "Среднее качество, есть фоновый шум"
		} else {
			metrics.Description = "Низкое качество, сильный шум"
		}
	} else {
		if metrics.ClickCount > 10 {
			metrics.Description = "Помехи и щелчки, голос не обнаружен"
		} else {
			metrics.Description = "Фоновый шум, голос не обнаружен"
		}
	}

	return metrics
}

// FilterChannelForTranscription применяет оптимальные фильтры для транскрипции
// Автоматически определяет нужные настройки на основе анализа канала
func FilterChannelForTranscription(samples []float32, sampleRate int) []float32 {
	if len(samples) == 0 {
		return samples
	}

	// Анализируем качество
	metrics := AnalyzeAudioQuality(samples, sampleRate)

	log.Printf("AudioFilter: Channel analysis - RMS=%.4f, Peak=%.4f, SNR=%.1fdB, Voice=%v, Clicks=%d, DC=%.4f (%s)",
		metrics.RMS, metrics.Peak, metrics.SNR, metrics.HasVoice, metrics.ClickCount, metrics.DCOffset, metrics.Description)

	// Если канал пустой/тихий - не обрабатываем
	if metrics.IsSilent {
		log.Printf("AudioFilter: Channel is silent, skipping filters")
		return samples
	}

	// Настраиваем фильтры на основе анализа
	config := DefaultAudioFilterConfig()

	// Если много щелчков - включаем более агрессивный de-click
	if metrics.ClickCount > 20 {
		config.DeClickThreshold = 0.3
	}

	// Если низкий SNR - используем более агрессивный noise gate
	if metrics.SNR < 15 {
		config.NoiseGateThreshold = 0.015
	}

	// Если есть DC offset - high-pass filter обязателен
	if abs32(metrics.DCOffset) > 0.01 {
		config.HighPassEnabled = true
	}

	// Если сигнал тихий но есть голос - нормализуем
	if metrics.HasVoice && metrics.Peak < 0.3 {
		config.NormalizationEnabled = true
		config.TargetPeakLevel = 0.8
	}

	return ApplyAudioFilters(samples, sampleRate, config)
}
