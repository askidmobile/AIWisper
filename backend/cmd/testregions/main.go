// Тест per-region транскрипции для разных моделей
// Запуск: go run ./cmd/testregions
//
// Сравнивает качество транскрипции между:
// - GigaAM V3 E2E (с пунктуацией)
// - Whisper Large V3
// - Whisper Large V3 Turbo
//
// Для каждой модели тестируем два метода:
// 1. VAD compression (склеивание регионов)
// 2. Per-region (раздельная транскрипция)

package main

import (
	"aiwisper/ai"
	"aiwisper/models"
	"aiwisper/session"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	testSessionID = "6c7d4c72-a8bf-4374-ba75-0ea10e0bfa8c"
	sampleRate    = 16000
)

type TestResult struct {
	ModelID          string
	ModelName        string
	VADCompression   string
	VADCompressionMs int64
	PerRegion        string
	PerRegionMs      int64
}

func main() {
	log.Println("=== Сравнение моделей транскрипции ===")
	log.Println("Тестовая фраза: \"Как говорится, снова здравствуйте\"")
	log.Println()

	// Определяем путь к сессии
	homeDir, _ := os.UserHomeDir()
	sessionDir := filepath.Join(homeDir, "Library/Application Support/aiwisper/sessions", testSessionID)
	mp3Path := filepath.Join(sessionDir, "full.mp3")
	modelsDir := filepath.Join(homeDir, "Library/Application Support/aiwisper/models")

	// Проверяем файлы
	if _, err := os.Stat(mp3Path); os.IsNotExist(err) {
		log.Fatalf("MP3 файл не найден: %s", mp3Path)
	}

	// Инициализируем менеджер моделей
	modelsMgr, err := models.NewManager(modelsDir)
	if err != nil {
		log.Fatalf("Ошибка инициализации моделей: %v", err)
	}

	// Извлекаем аудио один раз
	log.Println("Извлекаем аудио из chunk 0 (0-30500ms)...")
	micSamples, _, err := session.ExtractSegmentStereoGo(mp3Path, 0, 30500, sampleRate)
	if err != nil {
		log.Fatalf("Ошибка извлечения аудио: %v", err)
	}
	log.Printf("Извлечено: %d samples (%.1fs)\n", len(micSamples), float64(len(micSamples))/float64(sampleRate))

	// Определяем VAD регионы один раз
	regions := session.DetectSpeechRegions(micSamples, sampleRate)
	log.Printf("VAD нашёл %d регионов речи\n", len(regions))
	for i, r := range regions {
		log.Printf("  [%d] %dms - %dms (%.1fs)", i, r.StartMs, r.EndMs, float64(r.EndMs-r.StartMs)/1000)
	}
	log.Println()

	// Подготавливаем сжатое аудио
	compressed := session.CompressSpeechFromRegions(micSamples, regions, sampleRate)

	// Список моделей для тестирования
	testModels := []string{
		"gigaam-v3-e2e-ctc",
		"ggml-large-v3-turbo",
		"ggml-large-v3",
	}

	var results []TestResult

	for _, modelID := range testModels {
		if !modelsMgr.IsModelDownloaded(modelID) {
			log.Printf("⚠️  Модель %s не скачана, пропускаем\n", modelID)
			continue
		}

		modelInfo := models.GetModelByID(modelID)
		if modelInfo == nil {
			continue
		}

		log.Printf("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
		log.Printf("Тестируем: %s (%s)", modelInfo.Name, modelID)
		log.Printf("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

		// Создаём движок
		engineMgr := ai.NewEngineManager(modelsMgr)
		if err := engineMgr.SetActiveModel(modelID); err != nil {
			log.Printf("❌ Ошибка загрузки модели: %v\n", err)
			continue
		}

		result := TestResult{
			ModelID:   modelID,
			ModelName: modelInfo.Name,
		}

		// Тест 1: VAD compression
		log.Println("\n📦 Метод 1: VAD compression (склеивание регионов)")
		start := time.Now()
		segments1, err := engineMgr.TranscribeWithSegments(compressed.CompressedSamples)
		result.VADCompressionMs = time.Since(start).Milliseconds()
		if err != nil {
			log.Printf("   ❌ Ошибка: %v", err)
		} else {
			result.VADCompression = segmentsToText(segments1)
			log.Printf("   Результат: %q", result.VADCompression)
			log.Printf("   Время: %dms", result.VADCompressionMs)
		}

		// Тест 2: Per-region
		log.Println("\n🔹 Метод 2: Per-region (раздельная транскрипция)")
		start = time.Now()
		var allSegments []ai.TranscriptSegment
		for i, region := range regions {
			startSample := int(region.StartMs * int64(sampleRate) / 1000)
			endSample := int(region.EndMs * int64(sampleRate) / 1000)
			if startSample < 0 {
				startSample = 0
			}
			if endSample > len(micSamples) {
				endSample = len(micSamples)
			}
			if startSample >= endSample {
				continue
			}

			regionSamples := micSamples[startSample:endSample]
			segments, err := engineMgr.TranscribeWithSegments(regionSamples)
			if err != nil {
				log.Printf("   Region[%d]: ❌ %v", i, err)
				continue
			}

			text := segmentsToText(segments)
			if text != "" {
				log.Printf("   Region[%d] (%dms-%dms): %q", i, region.StartMs, region.EndMs, text)
			}

			// Корректируем timestamps
			for j := range segments {
				segments[j].Start += region.StartMs
				segments[j].End += region.StartMs
			}
			allSegments = append(allSegments, segments...)
		}
		result.PerRegionMs = time.Since(start).Milliseconds()
		result.PerRegion = segmentsToText(allSegments)
		log.Printf("   Итого: %q", result.PerRegion)
		log.Printf("   Время: %dms", result.PerRegionMs)

		results = append(results, result)
		engineMgr.Close()
		log.Println()
	}

	// Итоговая таблица
	log.Println("\n" + strings.Repeat("═", 80))
	log.Println("ИТОГОВОЕ СРАВНЕНИЕ")
	log.Println(strings.Repeat("═", 80))
	log.Println("Ожидаемый текст: \"Как говорится, снова здравствуйте\"")
	log.Println()

	for _, r := range results {
		log.Printf("📊 %s (%s):", r.ModelName, r.ModelID)
		log.Printf("   VAD compression (%4dms): %q", r.VADCompressionMs, r.VADCompression)
		log.Printf("   Per-region      (%4dms): %q", r.PerRegionMs, r.PerRegion)

		// Проверяем наличие "Как говорится"
		vadHas := strings.Contains(strings.ToLower(r.VADCompression), "как говорится")
		perHas := strings.Contains(strings.ToLower(r.PerRegion), "как говорится")

		if vadHas && perHas {
			log.Printf("   ✅ Оба метода распознали \"Как говорится\"")
		} else if perHas {
			log.Printf("   ⚠️  Только per-region распознал \"Как говорится\"")
		} else if vadHas {
			log.Printf("   ⚠️  Только VAD compression распознал \"Как говорится\"")
		} else {
			log.Printf("   ❌ Ни один метод не распознал \"Как говорится\"")
		}
		log.Println()
	}
}

func segmentsToText(segments []ai.TranscriptSegment) string {
	var texts []string
	for _, seg := range segments {
		t := strings.TrimSpace(seg.Text)
		if t != "" {
			texts = append(texts, t)
		}
	}
	return strings.Join(texts, " ")
}
