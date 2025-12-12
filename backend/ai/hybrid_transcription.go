// Package ai предоставляет гибридную транскрипцию с использованием двух моделей
package ai

import (
	"fmt"
	"log"
	"sort"
)

// HybridTranscriptionConfig конфигурация гибридной транскрипции
type HybridTranscriptionConfig struct {
	Enabled             bool    // Включена ли гибридная транскрипция
	SecondaryModelID    string  // ID дополнительной модели
	ConfidenceThreshold float32 // Порог уверенности (0.0 - 1.0)
	ContextWords        int     // Количество слов контекста вокруг проблемного слова
	UseLLMForMerge      bool    // Использовать LLM для выбора лучшего варианта
}

// LowConfidenceRegion участок с низкой уверенностью
type LowConfidenceRegion struct {
	StartMs       int64            // Начало участка в миллисекундах
	EndMs         int64            // Конец участка в миллисекундах
	Words         []TranscriptWord // Слова в участке
	AvgConfidence float32          // Средняя уверенность
	SegmentIndex  int              // Индекс сегмента
}

// HybridTranscriptionResult результат гибридной транскрипции
type HybridTranscriptionResult struct {
	Segments           []TranscriptSegment        // Финальные сегменты
	LowConfidenceCount int                        // Количество слов с низкой уверенностью
	RetranscribedCount int                        // Количество перетранскрибированных участков
	Improvements       []TranscriptionImprovement // Список улучшений
}

// TranscriptionImprovement информация об улучшении
type TranscriptionImprovement struct {
	StartMs      int64   // Начало участка
	EndMs        int64   // Конец участка
	OriginalText string  // Оригинальный текст
	ImprovedText string  // Улучшенный текст
	OriginalConf float32 // Оригинальная уверенность
	ImprovedConf float32 // Улучшенная уверенность
	Source       string  // Источник улучшения: "secondary_model" или "llm"
}

// HybridTranscriber выполняет гибридную транскрипцию
type HybridTranscriber struct {
	primaryEngine   TranscriptionEngine
	secondaryEngine TranscriptionEngine
	config          HybridTranscriptionConfig
	llmSelector     LLMTranscriptionSelector
}

// LLMTranscriptionSelector интерфейс для LLM выбора лучшей транскрипции
type LLMTranscriptionSelector interface {
	SelectBestTranscription(original, alternative string, context string) (string, error)
}

// NewHybridTranscriber создаёт новый гибридный транскрибер
func NewHybridTranscriber(
	primary TranscriptionEngine,
	secondary TranscriptionEngine,
	config HybridTranscriptionConfig,
	llmSelector LLMTranscriptionSelector,
) *HybridTranscriber {
	return &HybridTranscriber{
		primaryEngine:   primary,
		secondaryEngine: secondary,
		config:          config,
		llmSelector:     llmSelector,
	}
}

// Transcribe выполняет гибридную транскрипцию
func (h *HybridTranscriber) Transcribe(samples []float32) (*HybridTranscriptionResult, error) {
	// Шаг 1: Первичная транскрипция
	log.Printf("[HybridTranscriber] Step 1: Primary transcription with %s", h.primaryEngine.Name())
	primarySegments, err := h.primaryEngine.TranscribeWithSegments(samples)
	if err != nil {
		return nil, fmt.Errorf("primary transcription failed: %w", err)
	}

	if !h.config.Enabled || h.secondaryEngine == nil {
		// Гибридная транскрипция отключена - возвращаем результат первичной модели
		return &HybridTranscriptionResult{
			Segments: primarySegments,
		}, nil
	}

	// Шаг 2: Поиск участков с низкой уверенностью
	log.Printf("[HybridTranscriber] Step 2: Finding low confidence regions (threshold: %.2f)", h.config.ConfidenceThreshold)
	regions := h.findLowConfidenceRegions(primarySegments)

	if len(regions) == 0 {
		log.Printf("[HybridTranscriber] No low confidence regions found")
		return &HybridTranscriptionResult{
			Segments: primarySegments,
		}, nil
	}

	log.Printf("[HybridTranscriber] Found %d low confidence regions", len(regions))

	// Шаг 3: Перетранскрибация проблемных участков
	log.Printf("[HybridTranscriber] Step 3: Retranscribing with %s", h.secondaryEngine.Name())
	improvements := h.retranscribeRegions(samples, regions, primarySegments)

	// Шаг 4: Слияние результатов
	log.Printf("[HybridTranscriber] Step 4: Merging results (%d improvements)", len(improvements))
	mergedSegments := h.mergeResults(primarySegments, improvements)

	// Подсчёт статистики
	lowConfCount := 0
	for _, region := range regions {
		lowConfCount += len(region.Words)
	}

	return &HybridTranscriptionResult{
		Segments:           mergedSegments,
		LowConfidenceCount: lowConfCount,
		RetranscribedCount: len(improvements),
		Improvements:       improvements,
	}, nil
}

// findLowConfidenceRegions находит участки с низкой уверенностью
func (h *HybridTranscriber) findLowConfidenceRegions(segments []TranscriptSegment) []LowConfidenceRegion {
	var regions []LowConfidenceRegion

	for segIdx, seg := range segments {
		if len(seg.Words) == 0 {
			continue
		}

		// Ищем последовательности слов с низкой уверенностью
		var currentRegion *LowConfidenceRegion

		for i, word := range seg.Words {
			isLowConf := word.P > 0 && word.P < h.config.ConfidenceThreshold

			if isLowConf {
				if currentRegion == nil {
					// Начинаем новый регион с контекстом
					startIdx := maxInt(0, i-h.config.ContextWords)
					currentRegion = &LowConfidenceRegion{
						StartMs:      seg.Words[startIdx].Start,
						SegmentIndex: segIdx,
					}
					// Добавляем контекстные слова слева
					for j := startIdx; j < i; j++ {
						currentRegion.Words = append(currentRegion.Words, seg.Words[j])
					}
				}
				currentRegion.Words = append(currentRegion.Words, word)
				currentRegion.EndMs = word.End
			} else if currentRegion != nil {
				// Добавляем контекстные слова справа
				endIdx := minInt(len(seg.Words), i+h.config.ContextWords)
				for j := i; j < endIdx; j++ {
					currentRegion.Words = append(currentRegion.Words, seg.Words[j])
					currentRegion.EndMs = seg.Words[j].End
				}

				// Вычисляем среднюю уверенность
				currentRegion.AvgConfidence = h.calcAvgConfidence(currentRegion.Words)
				regions = append(regions, *currentRegion)
				currentRegion = nil
			}
		}

		// Закрываем последний регион если есть
		if currentRegion != nil {
			currentRegion.AvgConfidence = h.calcAvgConfidence(currentRegion.Words)
			regions = append(regions, *currentRegion)
		}
	}

	// Объединяем близкие регионы (менее 500мс между ними)
	regions = h.mergeCloseRegions(regions, 500)

	return regions
}

// calcAvgConfidence вычисляет среднюю уверенность для слов
func (h *HybridTranscriber) calcAvgConfidence(words []TranscriptWord) float32 {
	if len(words) == 0 {
		return 0
	}
	var sum float32
	count := 0
	for _, w := range words {
		if w.P > 0 {
			sum += w.P
			count++
		}
	}
	if count == 0 {
		return 0
	}
	return sum / float32(count)
}

// mergeCloseRegions объединяет близкие регионы
func (h *HybridTranscriber) mergeCloseRegions(regions []LowConfidenceRegion, gapMs int64) []LowConfidenceRegion {
	if len(regions) <= 1 {
		return regions
	}

	// Сортируем по времени начала
	sort.Slice(regions, func(i, j int) bool {
		return regions[i].StartMs < regions[j].StartMs
	})

	var merged []LowConfidenceRegion
	current := regions[0]

	for i := 1; i < len(regions); i++ {
		next := regions[i]

		// Если регионы близко и в одном сегменте - объединяем
		if next.StartMs-current.EndMs <= gapMs && next.SegmentIndex == current.SegmentIndex {
			current.EndMs = next.EndMs
			current.Words = append(current.Words, next.Words...)
			current.AvgConfidence = h.calcAvgConfidence(current.Words)
		} else {
			merged = append(merged, current)
			current = next
		}
	}
	merged = append(merged, current)

	return merged
}

// retranscribeRegions перетранскрибирует проблемные участки
func (h *HybridTranscriber) retranscribeRegions(
	samples []float32,
	regions []LowConfidenceRegion,
	originalSegments []TranscriptSegment,
) []TranscriptionImprovement {
	var improvements []TranscriptionImprovement
	sampleRate := 16000 // 16kHz

	for _, region := range regions {
		// Извлекаем аудио для региона с небольшим запасом (100мс)
		startSample := int((region.StartMs - 100) * int64(sampleRate) / 1000)
		endSample := int((region.EndMs + 100) * int64(sampleRate) / 1000)

		if startSample < 0 {
			startSample = 0
		}
		if endSample > len(samples) {
			endSample = len(samples)
		}
		if startSample >= endSample {
			continue
		}

		regionSamples := samples[startSample:endSample]

		// Транскрибируем вторичной моделью
		altSegments, err := h.secondaryEngine.TranscribeWithSegments(regionSamples)
		if err != nil {
			log.Printf("[HybridTranscriber] Secondary transcription failed for region %d-%d: %v",
				region.StartMs, region.EndMs, err)
			continue
		}

		if len(altSegments) == 0 {
			continue
		}

		// Собираем текст из альтернативной транскрипции
		var altText string
		var altConf float32
		var altWordCount int
		for _, seg := range altSegments {
			if altText != "" {
				altText += " "
			}
			altText += seg.Text
			for _, w := range seg.Words {
				if w.P > 0 {
					altConf += w.P
					altWordCount++
				}
			}
		}
		if altWordCount > 0 {
			altConf /= float32(altWordCount)
		}

		// Собираем оригинальный текст
		var origText string
		for _, w := range region.Words {
			if origText != "" {
				origText += " "
			}
			origText += w.Text
		}

		// Выбираем лучший вариант
		var finalText string
		var source string

		if h.config.UseLLMForMerge && h.llmSelector != nil {
			// Используем LLM для выбора
			context := h.getContextForRegion(originalSegments, region)
			selected, err := h.llmSelector.SelectBestTranscription(origText, altText, context)
			if err != nil {
				log.Printf("[HybridTranscriber] LLM selection failed: %v, using confidence-based selection", err)
				// Fallback на выбор по confidence
				if altConf > region.AvgConfidence {
					finalText = altText
					source = "secondary_model"
				} else {
					continue // Оставляем оригинал
				}
			} else {
				finalText = selected
				source = "llm"
			}
		} else {
			// Выбор по confidence
			if altConf > region.AvgConfidence {
				finalText = altText
				source = "secondary_model"
			} else {
				continue // Оставляем оригинал
			}
		}

		// Если текст изменился - добавляем улучшение
		if finalText != origText {
			improvements = append(improvements, TranscriptionImprovement{
				StartMs:      region.StartMs,
				EndMs:        region.EndMs,
				OriginalText: origText,
				ImprovedText: finalText,
				OriginalConf: region.AvgConfidence,
				ImprovedConf: altConf,
				Source:       source,
			})
		}
	}

	return improvements
}

// getContextForRegion получает контекст вокруг региона для LLM
func (h *HybridTranscriber) getContextForRegion(segments []TranscriptSegment, region LowConfidenceRegion) string {
	var context string

	// Берём текст из того же сегмента
	if region.SegmentIndex < len(segments) {
		seg := segments[region.SegmentIndex]
		context = seg.Text
	}

	// Добавляем предыдущий сегмент если есть
	if region.SegmentIndex > 0 {
		prevSeg := segments[region.SegmentIndex-1]
		context = prevSeg.Text + " ... " + context
	}

	// Добавляем следующий сегмент если есть
	if region.SegmentIndex < len(segments)-1 {
		nextSeg := segments[region.SegmentIndex+1]
		context = context + " ... " + nextSeg.Text
	}

	return context
}

// mergeResults объединяет оригинальные сегменты с улучшениями
func (h *HybridTranscriber) mergeResults(
	segments []TranscriptSegment,
	improvements []TranscriptionImprovement,
) []TranscriptSegment {
	if len(improvements) == 0 {
		return segments
	}

	// Создаём карту улучшений по времени
	improvementMap := make(map[int64]TranscriptionImprovement)
	for _, imp := range improvements {
		improvementMap[imp.StartMs] = imp
	}

	// Применяем улучшения к сегментам
	result := make([]TranscriptSegment, len(segments))
	for i, seg := range segments {
		result[i] = seg

		// Проверяем есть ли улучшения для слов в этом сегменте
		if len(seg.Words) == 0 {
			continue
		}

		for startMs, imp := range improvementMap {
			// Проверяем попадает ли улучшение в этот сегмент
			if startMs >= seg.Start && startMs <= seg.End {
				// Заменяем текст в сегменте
				// Простая замена - в реальности нужна более сложная логика
				// для точного позиционирования
				newText := replaceTextInSegment(seg.Text, imp.OriginalText, imp.ImprovedText)
				result[i].Text = newText

				log.Printf("[HybridTranscriber] Applied improvement: '%s' -> '%s' (source: %s)",
					imp.OriginalText, imp.ImprovedText, imp.Source)
			}
		}
	}

	return result
}

// replaceTextInSegment заменяет текст в сегменте
func replaceTextInSegment(segmentText, original, replacement string) string {
	// Простая замена подстроки
	// В реальности может потребоваться fuzzy matching
	if original == "" {
		return segmentText
	}

	// Пробуем точную замену
	result := segmentText
	for {
		idx := findSubstringFuzzy(result, original)
		if idx < 0 {
			break
		}
		result = result[:idx] + replacement + result[idx+len(original):]
		break // Заменяем только первое вхождение
	}

	return result
}

// findSubstringFuzzy ищет подстроку с учётом небольших различий
func findSubstringFuzzy(text, substr string) int {
	// Сначала пробуем точное совпадение
	for i := 0; i <= len(text)-len(substr); i++ {
		if text[i:i+len(substr)] == substr {
			return i
		}
	}

	// Если не нашли - возвращаем -1
	// В будущем можно добавить fuzzy matching
	return -1
}

// minInt возвращает минимум из двух чисел
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// maxInt возвращает максимум из двух чисел
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
