//go:build darwin && integration

// Интеграционные тесты для регрессионного тестирования транскрипции
// Запуск: go test -tags=integration -v ./ai -run TestRegression
// Требуют: реальные аудиофайлы в ~/Library/Application Support/aiwisper/sessions/

package ai

import (
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"aiwisper/session"
)

const (
	// Тестовый аудиофайл с диалогом
	regressionAudioPath = "/Users/askid/Library/Application Support/aiwisper/sessions/114bbb18-747b-4f9b-841f-6f6cd075bd39/full.mp3"
)

/*
РЕЗУЛЬТАТЫ АНАЛИЗА АУДИО:
========================
- Секунды 0-4: практически тишина (RMS < 0.007), "Привет" и "Привет, Лёш" не записаны или очень тихие
- Секунда 4.5: начало реальной речи (RMS ~0.14)
- Все модели ошибаются на имени "Ильюха" → "люка" (фонетически похоже)
- Все модели ошибаются на английском слове "Notifier" → "натифа/на тифа/на ТВ"

СРАВНЕНИЕ МОДЕЛЕЙ (4-35 сек):
============================
| Модель           | Полнота текста | "Ильюха"        | "Notifier"  |
|------------------|----------------|-----------------|-------------|
| Parakeet TDT v3  | ★★★★☆ (много)  | "люка" (ошибка) | "натифа"    |
| Large v3 Turbo   | ★★☆☆☆ (мало)   | пропуск         | "на ТВ"     |
| Large v3 Full    | ★★★☆☆ (средне) | "люка" (ошибка) | "на тифа"   |

РЕКОМЕНДАЦИИ:
============
1. Parakeet TDT v3 даёт наилучший результат по полноте текста
2. Для русского языка Parakeet превосходит Whisper по качеству
3. Английские слова (Notifier) плохо распознаются всеми моделями
4. Первые 4 секунды записи — тишина, это не проблема моделей
*/

// loadRegressionAudioSegment загружает фрагмент аудио (в секундах)
func loadRegressionAudioSegment(t *testing.T, startSec, endSec float64) []float32 {
	t.Helper()

	if _, err := os.Stat(regressionAudioPath); err != nil {
		t.Skipf("Аудио не найдено: %v", err)
	}

	startMs := int64(startSec * 1000)
	endMs := int64(endSec * 1000)

	samples, err := session.ExtractSegmentGo(regressionAudioPath, startMs, endMs, 16000)
	if err != nil {
		t.Fatalf("Не удалось извлечь аудио: %v", err)
	}

	return samples
}

// normalizeAudio нормализует аудио до целевого RMS
func normalizeAudio(in []float32, targetRMS float64) []float32 {
	if len(in) == 0 {
		return in
	}
	var sum float64
	for _, s := range in {
		sum += float64(s * s)
	}
	rms := math.Sqrt(sum / float64(len(in)))
	scale := targetRMS / (rms + 1e-6)
	if scale > 10.0 {
		scale = 10.0
	}
	out := make([]float32, len(in))
	for i, v := range in {
		x := float64(v) * scale
		if x > 1 {
			x = 1
		} else if x < -1 {
			x = -1
		}
		out[i] = float32(x)
	}
	return out
}

func concatSegments(segments []TranscriptSegment) string {
	sort.Slice(segments, func(i, j int) bool {
		return segments[i].Start < segments[j].Start
	})
	var b strings.Builder
	for _, seg := range segments {
		if seg.Text == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString(" ")
		}
		b.WriteString(strings.TrimSpace(seg.Text))
	}
	return b.String()
}

// TestRegression_Parakeet_TDT_v3 — ЛУЧШАЯ модель для русского языка
// Даёт наиболее полный текст, хорошо справляется с разговорной речью
func TestRegression_Parakeet_TDT_v3(t *testing.T) {
	// Начинаем с 4 секунды — первые 4 сек тишина
	samples := loadRegressionAudioSegment(t, 4, 35)

	engine, err := NewFluidASREngine(FluidASRConfig{
		PauseThreshold: 0.4, // меньший порог для лучшей сегментации диалога
	})
	if err != nil {
		t.Skipf("Пропускаем Parakeet: %v", err)
		return
	}
	defer engine.Close()
	engine.SetLanguage("ru")

	segments, err := engine.TranscribeWithSegments(samples)
	if err != nil {
		t.Fatalf("Parakeet ошибка транскрипции: %v", err)
	}
	if len(segments) == 0 {
		t.Fatalf("Parakeet вернул пустой результат")
	}

	text := concatSegments(segments)
	t.Logf("Parakeet TDT v3 (%d сегментов):", len(segments))
	t.Logf("  Текст: %s", text)
	for i, seg := range segments {
		t.Logf("  [%d] %.2fs-%.2fs: %s", i, float64(seg.Start)/1000, float64(seg.End)/1000, seg.Text)
	}

	// Проверки качества
	textLower := strings.ToLower(text)

	// Должны присутствовать ключевые фразы
	mustContain := []string{
		"рассказывай",
		"описания",
		"понял",
		"скинул",
		"архитектур",
	}
	for _, phrase := range mustContain {
		if !strings.Contains(textLower, phrase) {
			t.Errorf("Не найдена ключевая фраза: %q", phrase)
		}
	}
}

// TestRegression_LargeV3Turbo — быстрая модель Whisper, но менее точная для русского
func TestRegression_LargeV3Turbo(t *testing.T) {
	samples := loadRegressionAudioSegment(t, 4, 35)

	modelPath := filepath.Join(os.Getenv("HOME"), "Library/Application Support/aiwisper/models/ggml-large-v3-turbo.bin")
	if _, err := os.Stat(modelPath); err != nil {
		t.Skipf("Пропускаем Whisper: модель не найдена: %v", err)
		return
	}

	engine, err := NewWhisperEngine(modelPath)
	if err != nil {
		t.Fatalf("Whisper не создан: %v", err)
	}
	defer engine.Close()
	engine.SetLanguage("ru")

	segments, err := engine.TranscribeHighQuality(samples)
	if err != nil {
		t.Fatalf("Whisper ошибка транскрипции: %v", err)
	}
	if len(segments) == 0 {
		t.Fatalf("Whisper вернул пустой результат")
	}

	text := concatSegments(segments)
	t.Logf("Whisper Large v3 Turbo (%d сегментов):", len(segments))
	t.Logf("  Текст: %s", text)
	for i, seg := range segments {
		t.Logf("  [%d] %.2fs-%.2fs: %s", i, float64(seg.Start)/1000, float64(seg.End)/1000, seg.Text)
	}

	// Базовые проверки
	textLower := strings.ToLower(text)
	if !strings.Contains(textLower, "понял") {
		t.Errorf("Не найдена базовая фраза 'понял'")
	}
}

// TestRegression_LargeV3_Full — полная модель Whisper, медленнее но точнее turbo
func TestRegression_LargeV3_Full(t *testing.T) {
	samples := loadRegressionAudioSegment(t, 4, 35)

	modelPath := filepath.Join(os.Getenv("HOME"), "Library/Application Support/aiwisper/models/ggml-large-v3.bin")
	if _, err := os.Stat(modelPath); err != nil {
		t.Skipf("Пропускаем Whisper Large v3: модель не найдена: %v", err)
		return
	}

	engine, err := NewWhisperEngine(modelPath)
	if err != nil {
		t.Fatalf("Whisper не создан: %v", err)
	}
	defer engine.Close()
	engine.SetLanguage("ru")

	segments, err := engine.TranscribeHighQuality(samples)
	if err != nil {
		t.Fatalf("Whisper ошибка транскрипции: %v", err)
	}

	text := concatSegments(segments)
	t.Logf("Whisper Large v3 Full (%d сегментов):", len(segments))
	t.Logf("  Текст: %s", text)
	for i, seg := range segments {
		t.Logf("  [%d] %.2fs-%.2fs: %s", i, float64(seg.Start)/1000, float64(seg.End)/1000, seg.Text)
	}
}

// TestRegression_GigaAM_V3_E2E — модель для русского языка (требует ONNX Runtime)
func TestRegression_GigaAM_V3_E2E(t *testing.T) {
	samples := loadRegressionAudioSegment(t, 4, 35)

	base := filepath.Join(os.Getenv("HOME"), "Library/Application Support/aiwisper/models")
	modelPath := filepath.Join(base, "gigaam-v3-e2e-ctc.onnx")
	vocabPath := filepath.Join(base, "gigaam-v3-e2e-ctc_vocab.txt")

	if _, err := os.Stat(modelPath); err != nil {
		t.Skipf("Пропускаем GigaAM: модель не найдена: %v", err)
		return
	}
	if _, err := os.Stat(vocabPath); err != nil {
		t.Skipf("Пропускаем GigaAM: словарь не найден: %v", err)
		return
	}

	engine, err := NewGigaAMEngine(modelPath, vocabPath)
	if err != nil {
		t.Skipf("GigaAM недоступен: %v", err)
		return
	}
	defer engine.Close()
	engine.SetLanguage("ru")

	segments, err := engine.TranscribeHighQuality(samples)
	if err != nil {
		t.Fatalf("GigaAM ошибка транскрипции: %v", err)
	}

	text := concatSegments(segments)
	t.Logf("GigaAM V3 E2E (%d сегментов):", len(segments))
	t.Logf("  Текст: %s", text)
	for i, seg := range segments {
		t.Logf("  [%d] %.2fs-%.2fs: %s", i, float64(seg.Start)/1000, float64(seg.End)/1000, seg.Text)
	}
}

// loadRegressionAudioStereo загружает раздельные каналы (left=mic, right=sys)
func loadRegressionAudioStereo(t *testing.T, startSec, endSec float64) ([]float32, []float32) {
	t.Helper()

	if _, err := os.Stat(regressionAudioPath); err != nil {
		t.Skipf("Аудио не найдено: %v", err)
	}

	startMs := int64(startSec * 1000)
	endMs := int64(endSec * 1000)

	left, right, err := session.ExtractSegmentStereoGo(regressionAudioPath, startMs, endMs, 16000)
	if err != nil {
		t.Fatalf("Не удалось извлечь стерео аудио: %v", err)
	}

	return left, right
}

// TestRegression_StereoChannels_Parakeet — тест раздельных каналов с Parakeet
// ВАЖНО: проверяем временные метки для правильного порядка фраз
func TestRegression_StereoChannels_Parakeet(t *testing.T) {
	// Загружаем раздельные каналы (4-35 сек, первые 4 — тишина)
	micSamples, sysSamples := loadRegressionAudioStereo(t, 4, 35)

	engine, err := NewFluidASREngine(FluidASRConfig{
		PauseThreshold: 0.4,
	})
	if err != nil {
		t.Skipf("Пропускаем Parakeet: %v", err)
		return
	}
	defer engine.Close()
	engine.SetLanguage("ru")

	// Транскрибируем МИКРОФОН (левый канал)
	t.Log("=== МИКРОФОН (левый канал) ===")
	micSegments, err := engine.TranscribeWithSegments(micSamples)
	if err != nil {
		t.Fatalf("Ошибка транскрипции микрофона: %v", err)
	}
	t.Logf("Микрофон: %d сегментов", len(micSegments))
	for i, seg := range micSegments {
		// Добавляем offset 4 сек к временным меткам (начали с 4 сек)
		realStart := float64(seg.Start)/1000 + 4.0
		realEnd := float64(seg.End)/1000 + 4.0
		t.Logf("  [%d] [%.2fs-%.2fs]: %s", i, realStart, realEnd, seg.Text)
	}

	// Транскрибируем СИСТЕМНЫЙ ЗВУК (правый канал)
	t.Log("=== СИСТЕМНЫЙ ЗВУК (правый канал) ===")
	sysSegments, err := engine.TranscribeWithSegments(sysSamples)
	if err != nil {
		t.Fatalf("Ошибка транскрипции системного звука: %v", err)
	}
	t.Logf("Системный звук: %d сегментов", len(sysSegments))
	for i, seg := range sysSegments {
		realStart := float64(seg.Start)/1000 + 4.0
		realEnd := float64(seg.End)/1000 + 4.0
		t.Logf("  [%d] [%.2fs-%.2fs]: %s", i, realStart, realEnd, seg.Text)
	}

	// Объединяем и сортируем по времени
	t.Log("=== ОБЪЕДИНЁННЫЙ РЕЗУЛЬТАТ (по времени) ===")
	type taggedSegment struct {
		Start   float64
		End     float64
		Text    string
		Speaker string
	}
	var allSegments []taggedSegment

	for _, seg := range micSegments {
		allSegments = append(allSegments, taggedSegment{
			Start:   float64(seg.Start)/1000 + 4.0,
			End:     float64(seg.End)/1000 + 4.0,
			Text:    seg.Text,
			Speaker: "Вы",
		})
	}
	for _, seg := range sysSegments {
		allSegments = append(allSegments, taggedSegment{
			Start:   float64(seg.Start)/1000 + 4.0,
			End:     float64(seg.End)/1000 + 4.0,
			Text:    seg.Text,
			Speaker: "Собеседник",
		})
	}

	// Сортируем по времени начала
	sort.Slice(allSegments, func(i, j int) bool {
		return allSegments[i].Start < allSegments[j].Start
	})

	for i, seg := range allSegments {
		t.Logf("  [%d] [%.2fs-%.2fs] %s: %s", i, seg.Start, seg.End, seg.Speaker, seg.Text)
	}
}

// TestRegression_StereoChannels_Whisper — тест раздельных каналов с Whisper
func TestRegression_StereoChannels_Whisper(t *testing.T) {
	micSamples, sysSamples := loadRegressionAudioStereo(t, 4, 35)

	modelPath := filepath.Join(os.Getenv("HOME"), "Library/Application Support/aiwisper/models/ggml-large-v3-turbo.bin")
	if _, err := os.Stat(modelPath); err != nil {
		t.Skipf("Пропускаем Whisper: модель не найдена: %v", err)
		return
	}

	engine, err := NewWhisperEngine(modelPath)
	if err != nil {
		t.Fatalf("Whisper не создан: %v", err)
	}
	defer engine.Close()
	engine.SetLanguage("ru")

	// Транскрибируем МИКРОФОН
	t.Log("=== МИКРОФОН (левый канал) ===")
	micSegments, err := engine.TranscribeHighQuality(micSamples)
	if err != nil {
		t.Fatalf("Ошибка транскрипции микрофона: %v", err)
	}
	t.Logf("Микрофон: %d сегментов", len(micSegments))
	for i, seg := range micSegments {
		realStart := float64(seg.Start)/1000 + 4.0
		realEnd := float64(seg.End)/1000 + 4.0
		t.Logf("  [%d] [%.2fs-%.2fs]: %s", i, realStart, realEnd, seg.Text)
	}

	// Транскрибируем СИСТЕМНЫЙ ЗВУК
	t.Log("=== СИСТЕМНЫЙ ЗВУК (правый канал) ===")
	sysSegments, err := engine.TranscribeHighQuality(sysSamples)
	if err != nil {
		t.Fatalf("Ошибка транскрипции системного звука: %v", err)
	}
	t.Logf("Системный звук: %d сегментов", len(sysSegments))
	for i, seg := range sysSegments {
		realStart := float64(seg.Start)/1000 + 4.0
		realEnd := float64(seg.End)/1000 + 4.0
		t.Logf("  [%d] [%.2fs-%.2fs]: %s", i, realStart, realEnd, seg.Text)
	}

	// Объединяем и сортируем по времени
	t.Log("=== ОБЪЕДИНЁННЫЙ РЕЗУЛЬТАТ (по времени) ===")
	type taggedSegment struct {
		Start   float64
		End     float64
		Text    string
		Speaker string
	}
	var allSegments []taggedSegment

	for _, seg := range micSegments {
		allSegments = append(allSegments, taggedSegment{
			Start:   float64(seg.Start)/1000 + 4.0,
			End:     float64(seg.End)/1000 + 4.0,
			Text:    seg.Text,
			Speaker: "Вы",
		})
	}
	for _, seg := range sysSegments {
		allSegments = append(allSegments, taggedSegment{
			Start:   float64(seg.Start)/1000 + 4.0,
			End:     float64(seg.End)/1000 + 4.0,
			Text:    seg.Text,
			Speaker: "Собеседник",
		})
	}

	sort.Slice(allSegments, func(i, j int) bool {
		return allSegments[i].Start < allSegments[j].Start
	})

	for i, seg := range allSegments {
		t.Logf("  [%d] [%.2fs-%.2fs] %s: %s", i, seg.Start, seg.End, seg.Speaker, seg.Text)
	}
}

// TestRegression_ChannelAnalysis — анализ RMS каждого канала отдельно
func TestRegression_ChannelAnalysis(t *testing.T) {
	micSamples, sysSamples := loadRegressionAudioStereo(t, 0, 35)

	t.Log("=== АНАЛИЗ КАНАЛОВ (первые 35 сек) ===")

	analyzeChannel := func(name string, samples []float32) {
		t.Logf("\n%s:", name)
		for sec := 0; sec < 35; sec++ {
			start := sec * 16000
			end := start + 16000
			if end > len(samples) {
				end = len(samples)
			}
			if start >= len(samples) {
				break
			}
			chunk := samples[start:end]

			var sum float64
			var maxAmp float32
			for _, s := range chunk {
				sum += float64(s * s)
				if s > maxAmp {
					maxAmp = s
				} else if -s > maxAmp {
					maxAmp = -s
				}
			}
			rms := math.Sqrt(sum / float64(len(chunk)))

			// Показываем только секунды с активностью
			if rms > 0.01 {
				t.Logf("  Сек %2d: RMS=%.4f, max=%.3f <<<", sec, rms, maxAmp)
			} else if rms > 0.001 {
				t.Logf("  Сек %2d: RMS=%.4f, max=%.3f", sec, rms, maxAmp)
			}
		}
	}

	analyzeChannel("МИКРОФОН (левый)", micSamples)
	analyzeChannel("СИСТЕМНЫЙ ЗВУК (правый)", sysSamples)
}

// TestRegression_First6Seconds_Detailed — детальный анализ первых 6 секунд
// Здесь должны быть "Привет" (правый) и "Привет, Лёш" (левый)
func TestRegression_First6Seconds_Detailed(t *testing.T) {
	micSamples, sysSamples := loadRegressionAudioStereo(t, 0, 6)

	t.Log("=== ДЕТАЛЬНЫЙ АНАЛИЗ ПЕРВЫХ 6 СЕКУНД (шаг 0.25 сек) ===")

	analyzeDetailed := func(name string, samples []float32) {
		t.Logf("\n%s:", name)
		// Шаг 0.25 секунды = 4000 сэмплов
		stepSamples := 4000
		for i := 0; i < 24; i++ { // 6 сек / 0.25 = 24 шага
			start := i * stepSamples
			end := start + stepSamples
			if end > len(samples) {
				end = len(samples)
			}
			if start >= len(samples) {
				break
			}
			chunk := samples[start:end]

			var sum float64
			var maxAmp float32
			for _, s := range chunk {
				sum += float64(s * s)
				if s > maxAmp {
					maxAmp = s
				} else if -s > maxAmp {
					maxAmp = -s
				}
			}
			rms := math.Sqrt(sum / float64(len(chunk)))

			startTime := float64(i) * 0.25
			endTime := startTime + 0.25

			// Показываем уровень визуально
			level := ""
			if rms > 0.05 {
				level = " ████████ ГРОМКО"
			} else if rms > 0.02 {
				level = " ████ средне"
			} else if rms > 0.005 {
				level = " ██ тихо"
			} else if rms > 0.001 {
				level = " █ очень тихо"
			}

			t.Logf("  %.2f-%.2f: RMS=%.5f max=%.4f%s", startTime, endTime, rms, maxAmp, level)
		}
	}

	analyzeDetailed("ПРАВЫЙ КАНАЛ (Собеседник) - должен быть 'Привет'", sysSamples)
	analyzeDetailed("ЛЕВЫЙ КАНАЛ (Вы) - должен быть 'Привет, Лёш'", micSamples)
}

// TestRegression_First6Seconds_Transcribe_Whisper — транскрипция Whisper первых 6 секунд
func TestRegression_First6Seconds_Transcribe_Whisper(t *testing.T) {
	micSamples, sysSamples := loadRegressionAudioStereo(t, 0, 6)

	modelPath := filepath.Join(os.Getenv("HOME"), "Library/Application Support/aiwisper/models/ggml-large-v3-turbo.bin")
	if _, err := os.Stat(modelPath); err != nil {
		t.Skipf("Пропускаем Whisper: модель не найдена: %v", err)
		return
	}

	engine, err := NewWhisperEngine(modelPath)
	if err != nil {
		t.Fatalf("Whisper не создан: %v", err)
	}
	defer engine.Close()
	engine.SetLanguage("ru")

	// Усиливаем сигнал для тихих участков
	amplify := func(samples []float32, gain float64) []float32 {
		out := make([]float32, len(samples))
		for i, s := range samples {
			v := float64(s) * gain
			if v > 1 {
				v = 1
			} else if v < -1 {
				v = -1
			}
			out[i] = float32(v)
		}
		return out
	}

	// Пробуем с разным усилением
	for _, gain := range []float64{1.0, 5.0, 10.0, 20.0} {
		t.Logf("\n=== WHISPER УСИЛЕНИЕ x%.0f ===", gain)

		// Правый канал (Собеседник - "Привет")
		sysAmp := amplify(sysSamples, gain)
		sysSegs, err := engine.TranscribeHighQuality(sysAmp)
		if err != nil {
			t.Logf("  Правый канал: ошибка %v", err)
		} else if len(sysSegs) == 0 {
			t.Logf("  Правый канал: пусто")
		} else {
			for _, seg := range sysSegs {
				t.Logf("  Правый [%.2fs-%.2fs]: %s", float64(seg.Start)/1000, float64(seg.End)/1000, seg.Text)
			}
		}

		// Левый канал (Вы - "Привет, Лёш")
		micAmp := amplify(micSamples, gain)
		micSegs, err := engine.TranscribeHighQuality(micAmp)
		if err != nil {
			t.Logf("  Левый канал: ошибка %v", err)
		} else if len(micSegs) == 0 {
			t.Logf("  Левый канал: пусто")
		} else {
			for _, seg := range micSegs {
				t.Logf("  Левый [%.2fs-%.2fs]: %s", float64(seg.Start)/1000, float64(seg.End)/1000, seg.Text)
			}
		}
	}
}

// TestRegression_First6Seconds_Transcribe — транскрипция Parakeet первых 6 секунд с усилением
func TestRegression_First6Seconds_Transcribe(t *testing.T) {
	micSamples, sysSamples := loadRegressionAudioStereo(t, 0, 6)

	engine, err := NewFluidASREngine(FluidASRConfig{
		PauseThreshold: 0.2, // очень агрессивная сегментация
	})
	if err != nil {
		t.Skipf("Пропускаем Parakeet: %v", err)
		return
	}
	defer engine.Close()
	engine.SetLanguage("ru")

	// Усиливаем сигнал для тихих участков
	amplify := func(samples []float32, gain float64) []float32 {
		out := make([]float32, len(samples))
		for i, s := range samples {
			v := float64(s) * gain
			if v > 1 {
				v = 1
			} else if v < -1 {
				v = -1
			}
			out[i] = float32(v)
		}
		return out
	}

	// Пробуем с разным усилением
	for _, gain := range []float64{1.0, 5.0, 10.0, 20.0} {
		t.Logf("\n=== PARAKEET УСИЛЕНИЕ x%.0f ===", gain)

		// Правый канал (Собеседник - "Привет")
		sysAmp := amplify(sysSamples, gain)
		sysSegs, err := engine.TranscribeWithSegments(sysAmp)
		if err != nil {
			t.Logf("  Правый канал: ошибка %v", err)
		} else if len(sysSegs) == 0 {
			t.Logf("  Правый канал: пусто")
		} else {
			for _, seg := range sysSegs {
				t.Logf("  Правый [%.2fs-%.2fs]: %s", float64(seg.Start)/1000, float64(seg.End)/1000, seg.Text)
			}
		}

		// Левый канал (Вы - "Привет, Лёш")
		micAmp := amplify(micSamples, gain)
		micSegs, err := engine.TranscribeWithSegments(micAmp)
		if err != nil {
			t.Logf("  Левый канал: ошибка %v", err)
		} else if len(micSegs) == 0 {
			t.Logf("  Левый канал: пусто")
		} else {
			for _, seg := range micSegs {
				t.Logf("  Левый [%.2fs-%.2fs]: %s", float64(seg.Start)/1000, float64(seg.End)/1000, seg.Text)
			}
		}
	}
}

// TestRegression_AudioAnalysis — анализ характеристик аудио (моно)
func TestRegression_AudioAnalysis(t *testing.T) {
	if _, err := os.Stat(regressionAudioPath); err != nil {
		t.Skipf("Аудио не найдено: %v", err)
	}

	// Анализ первых 10 секунд
	samples := loadRegressionAudioSegment(t, 0, 10)

	t.Logf("Анализ аудио МОНО (первые 10 сек):")
	t.Logf("  Всего сэмплов: %d", len(samples))
	t.Logf("  Длительность: %.2f сек", float64(len(samples))/16000)

	// RMS по секундам
	for sec := 0; sec < 10; sec++ {
		start := sec * 16000
		end := start + 16000
		if end > len(samples) {
			end = len(samples)
		}
		chunk := samples[start:end]

		var sum float64
		var maxAmp float32
		for _, s := range chunk {
			sum += float64(s * s)
			if s > maxAmp {
				maxAmp = s
			} else if -s > maxAmp {
				maxAmp = -s
			}
		}
		rms := math.Sqrt(sum / float64(len(chunk)))
		t.Logf("  Секунда %d: RMS=%.6f, max=%.4f", sec, rms, maxAmp)
	}
}
