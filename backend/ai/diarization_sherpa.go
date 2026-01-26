// Package ai предоставляет SherpaDiarizer для диаризации спикеров через sherpa-onnx
package ai

import (
	"fmt"
	"log"
	"os"
	"runtime"
	"sync"
	"sync/atomic"

	sherpa "github.com/k2-fsa/sherpa-onnx-go/sherpa_onnx"
)

// SpeakerSegment представляет сегмент речи с идентификатором спикера
type SpeakerSegment struct {
	Start   float32 // Время начала в секундах
	End     float32 // Время окончания в секундах
	Speaker int     // ID спикера (0, 1, 2...)
}

// SpeakerEmbedding представляет embedding спикера для глобального сопоставления
type SpeakerEmbedding struct {
	Speaker   int       // ID спикера (0, 1, 2...)
	Embedding []float32 // 256-мерный вектор
	Duration  float32   // Общая длительность речи спикера (сек)
}

// DiarizationResult результат диаризации с embeddings для сопоставления
type DiarizationResult struct {
	Segments          []SpeakerSegment   // Сегменты речи
	NumSpeakers       int                // Количество уникальных спикеров
	SpeakerEmbeddings []SpeakerEmbedding // Embeddings спикеров (для глобального сопоставления)
}

// SherpaDiarizerConfig конфигурация для SherpaDiarizer
type SherpaDiarizerConfig struct {
	SegmentationModelPath string  // Путь к модели сегментации (pyannote)
	EmbeddingModelPath    string  // Путь к модели эмбеддингов (wespeaker/3dspeaker)
	NumThreads            int     // Количество потоков
	ClusteringThreshold   float32 // Порог кластеризации (0.0-1.0, по умолчанию 0.5)
	MinDurationOn         float32 // Минимальная длительность речи (сек)
	MinDurationOff        float32 // Минимальная длительность паузы (сек)
	Provider              string  // ONNX provider: cpu, cuda, coreml, auto
}

// detectBestProvider определяет лучший provider для текущей платформы
func detectBestProvider() string {
	// На macOS с Apple Silicon предпочитаем CoreML
	if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
		return "coreml"
	}
	// На Linux/Windows с NVIDIA GPU можно использовать cuda
	// Но для безопасности по умолчанию используем cpu
	return "cpu"
}

// DefaultSherpaDiarizerConfig возвращает конфигурацию по умолчанию
// с автоматическим определением лучшего provider для платформы
func DefaultSherpaDiarizerConfig(segmentationPath, embeddingPath string) SherpaDiarizerConfig {
	return SherpaDiarizerConfig{
		SegmentationModelPath: segmentationPath,
		EmbeddingModelPath:    embeddingPath,
		NumThreads:            4,
		ClusteringThreshold:   0.5,
		MinDurationOn:         0.3,
		MinDurationOff:        0.5,
		Provider:              "auto", // Автоопределение
	}
}

// SherpaDiarizer выполняет диаризацию спикеров через sherpa-onnx
type SherpaDiarizer struct {
	config      SherpaDiarizerConfig
	diarizer    *sherpa.OfflineSpeakerDiarization
	mu          sync.Mutex
	initialized bool
	inProgress  int32 // Атомарный счётчик текущих операций (для диагностики)
}

// NewSherpaDiarizer создаёт новый диаризатор на базе sherpa-onnx
func NewSherpaDiarizer(config SherpaDiarizerConfig) (*SherpaDiarizer, error) {
	// Проверяем существование файлов моделей
	if _, err := os.Stat(config.SegmentationModelPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("segmentation model not found: %s", config.SegmentationModelPath)
	}
	if _, err := os.Stat(config.EmbeddingModelPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("embedding model not found: %s", config.EmbeddingModelPath)
	}

	// Определяем provider (auto = автоопределение)
	provider := config.Provider
	if provider == "auto" || provider == "" {
		provider = detectBestProvider()
	}
	log.Printf("SherpaDiarizer: using provider=%s (requested=%s)", provider, config.Provider)

	// Конфигурация sherpa-onnx
	sherpaConfig := &sherpa.OfflineSpeakerDiarizationConfig{
		Segmentation: sherpa.OfflineSpeakerSegmentationModelConfig{
			Pyannote: sherpa.OfflineSpeakerSegmentationPyannoteModelConfig{
				Model: config.SegmentationModelPath,
			},
			NumThreads: config.NumThreads,
			Debug:      0,
			Provider:   provider,
		},
		Embedding: sherpa.SpeakerEmbeddingExtractorConfig{
			Model:      config.EmbeddingModelPath,
			NumThreads: config.NumThreads,
			Debug:      0,
			Provider:   provider,
		},
		Clustering: sherpa.FastClusteringConfig{
			NumClusters: -1, // Автоматическое определение количества спикеров
			Threshold:   config.ClusteringThreshold,
		},
		MinDurationOn:  config.MinDurationOn,
		MinDurationOff: config.MinDurationOff,
	}

	diarizer := sherpa.NewOfflineSpeakerDiarization(sherpaConfig)
	if diarizer == nil {
		// Если CoreML не сработал, пробуем CPU
		if provider != "cpu" {
			log.Printf("SherpaDiarizer: %s provider failed, falling back to CPU", provider)
			sherpaConfig.Segmentation.Provider = "cpu"
			sherpaConfig.Embedding.Provider = "cpu"
			diarizer = sherpa.NewOfflineSpeakerDiarization(sherpaConfig)
			if diarizer == nil {
				return nil, fmt.Errorf("failed to create sherpa-onnx diarizer (tried %s and cpu)", provider)
			}
			provider = "cpu"
		} else {
			return nil, fmt.Errorf("failed to create sherpa-onnx diarizer")
		}
	}

	log.Printf("SherpaDiarizer initialized: provider=%s, segmentation=%s, embedding=%s",
		provider, config.SegmentationModelPath, config.EmbeddingModelPath)

	// Сохраняем фактически используемый provider
	config.Provider = provider

	return &SherpaDiarizer{
		config:      config,
		diarizer:    diarizer,
		initialized: true,
	}, nil
}

// Максимальный размер аудио для диаризации (в семплах)
// ~15 секунд при 16kHz - безопасный лимит, предотвращающий зависание нативного кода
const maxDiarizationSamples = 240000 // 15 секунд * 16000 Hz

// Diarize выполняет диаризацию аудио и возвращает сегменты с метками спикеров
// samples - аудио данные в формате float32, 16kHz, mono
//
// ВАЖНО: Sherpa ONNX нативный код может зависнуть на определённых данных.
// Вызывающий код должен использовать таймаут (через diarizeWithTimeout в pipeline).
// Мы используем TryLock чтобы избежать накопления ожидающих goroutines при зависании.
func (d *SherpaDiarizer) Diarize(samples []float32) ([]SpeakerSegment, error) {
	// Пробуем взять lock без блокировки - если уже занят, возвращаем ошибку
	// Это предотвращает накопление goroutines при зависании нативного кода
	if !d.mu.TryLock() {
		inProg := atomic.LoadInt32(&d.inProgress)
		return nil, fmt.Errorf("diarizer is busy (inProgress=%d), try again later", inProg)
	}
	defer d.mu.Unlock()

	if !d.initialized {
		return nil, fmt.Errorf("diarizer not initialized")
	}

	if len(samples) == 0 {
		return nil, nil
	}

	// Ограничиваем размер входных данных, чтобы избежать зависания нативного кода
	// При превышении лимита разбиваем на части
	if len(samples) > maxDiarizationSamples {
		log.Printf("SherpaDiarizer: audio too long (%d samples, %.1fs), splitting into chunks",
			len(samples), float64(len(samples))/16000.0)
		return d.diarizeInChunks(samples)
	}

	return d.diarizeSingle(samples)
}

// diarizeSingle выполняет диаризацию одного фрагмента
func (d *SherpaDiarizer) diarizeSingle(samples []float32) ([]SpeakerSegment, error) {
	// Отмечаем что операция в процессе
	atomic.AddInt32(&d.inProgress, 1)
	defer atomic.AddInt32(&d.inProgress, -1)

	// Выполняем диаризацию
	// ВНИМАНИЕ: Этот вызов может зависнуть в нативном коде!
	segments := d.diarizer.Process(samples)
	if len(segments) == 0 {
		return nil, nil
	}

	// Конвертируем результаты
	result := make([]SpeakerSegment, len(segments))
	for i, seg := range segments {
		result[i] = SpeakerSegment{
			Start:   seg.Start,
			End:     seg.End,
			Speaker: seg.Speaker,
		}
	}

	log.Printf("SherpaDiarizer: found %d segments from %d speakers",
		len(result), d.countUniqueSpeakers(result))

	return result, nil
}

// diarizeInChunks разбивает длинное аудио на части и диаризует их отдельно
// Это предотвращает зависание нативного кода на длинных аудио
func (d *SherpaDiarizer) diarizeInChunks(samples []float32) ([]SpeakerSegment, error) {
	const chunkSize = maxDiarizationSamples // 15 секунд
	const overlapSize = 16000               // 1 секунда перекрытия для лучшей стыковки
	const sampleRate = 16000

	var allSegments []SpeakerSegment
	offset := 0
	chunkIndex := 0

	for offset < len(samples) {
		end := offset + chunkSize
		if end > len(samples) {
			end = len(samples)
		}

		chunk := samples[offset:end]
		chunkOffsetSec := float32(offset) / float32(sampleRate)

		log.Printf("SherpaDiarizer: processing chunk %d (offset=%.1fs, samples=%d)",
			chunkIndex, chunkOffsetSec, len(chunk))

		// Диаризуем чанк
		atomic.AddInt32(&d.inProgress, 1)
		segments := d.diarizer.Process(chunk)
		atomic.AddInt32(&d.inProgress, -1)

		// Конвертируем и добавляем смещение
		for _, seg := range segments {
			allSegments = append(allSegments, SpeakerSegment{
				Start:   seg.Start + chunkOffsetSec,
				End:     seg.End + chunkOffsetSec,
				Speaker: seg.Speaker,
			})
		}

		// Следующий чанк с перекрытием (для лучшей стыковки)
		offset = end - overlapSize
		if offset < 0 {
			offset = 0
		}
		// Но если остаток меньше минимального, просто завершаем
		if len(samples)-offset < sampleRate {
			break
		}
		chunkIndex++
	}

	log.Printf("SherpaDiarizer: chunked diarization complete, %d total segments from %d chunks",
		len(allSegments), chunkIndex+1)

	// Мержим перекрывающиеся сегменты того же спикера
	return d.mergeOverlappingSegments(allSegments), nil
}

// mergeOverlappingSegments объединяет перекрывающиеся сегменты одного спикера
func (d *SherpaDiarizer) mergeOverlappingSegments(segments []SpeakerSegment) []SpeakerSegment {
	if len(segments) <= 1 {
		return segments
	}

	// Сортируем по времени начала
	// (простая пузырьковая сортировка - сегментов обычно мало)
	for i := 0; i < len(segments)-1; i++ {
		for j := i + 1; j < len(segments); j++ {
			if segments[j].Start < segments[i].Start {
				segments[i], segments[j] = segments[j], segments[i]
			}
		}
	}

	// Мержим перекрывающиеся сегменты одного спикера
	var merged []SpeakerSegment
	current := segments[0]

	for i := 1; i < len(segments); i++ {
		seg := segments[i]
		// Если тот же спикер и сегменты перекрываются или почти соприкасаются
		if seg.Speaker == current.Speaker && seg.Start <= current.End+0.5 {
			// Расширяем текущий сегмент
			if seg.End > current.End {
				current.End = seg.End
			}
		} else {
			// Сохраняем текущий и начинаем новый
			merged = append(merged, current)
			current = seg
		}
	}
	merged = append(merged, current)

	return merged
}

// SetClusteringConfig обновляет параметры кластеризации
func (d *SherpaDiarizer) SetClusteringConfig(numClusters int, threshold float32) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.diarizer != nil {
		config := &sherpa.OfflineSpeakerDiarizationConfig{
			Clustering: sherpa.FastClusteringConfig{
				NumClusters: numClusters,
				Threshold:   threshold,
			},
		}
		d.diarizer.SetConfig(config)
	}
}

// SampleRate возвращает ожидаемую частоту дискретизации (16kHz)
func (d *SherpaDiarizer) SampleRate() int {
	if d.diarizer != nil {
		return d.diarizer.SampleRate()
	}
	return 16000
}

// Close освобождает ресурсы
func (d *SherpaDiarizer) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.diarizer != nil {
		sherpa.DeleteOfflineSpeakerDiarization(d.diarizer)
		d.diarizer = nil
	}
	d.initialized = false
	log.Printf("SherpaDiarizer closed")
}

// IsInitialized проверяет инициализирован ли диаризатор
func (d *SherpaDiarizer) IsInitialized() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.initialized
}

// GetProvider возвращает текущий ONNX provider (cpu, coreml, cuda)
func (d *SherpaDiarizer) GetProvider() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.config.Provider
}

// countUniqueSpeakers подсчитывает количество уникальных спикеров
func (d *SherpaDiarizer) countUniqueSpeakers(segments []SpeakerSegment) int {
	speakers := make(map[int]bool)
	for _, seg := range segments {
		speakers[seg.Speaker] = true
	}
	return len(speakers)
}

// DiarizeWithTranscription объединяет результаты диаризации с транскрипцией
// Сопоставляет слова с сегментами спикеров по временным меткам
func (d *SherpaDiarizer) DiarizeWithTranscription(
	segments []TranscriptSegment,
	speakerSegments []SpeakerSegment,
) []TranscriptSegment {
	if len(segments) == 0 || len(speakerSegments) == 0 {
		return segments
	}

	result := make([]TranscriptSegment, len(segments))
	copy(result, segments)

	for i := range result {
		// Находим спикера для каждого сегмента транскрипции
		segStart := float32(result[i].Start) / 1000.0 // ms -> sec
		segEnd := float32(result[i].End) / 1000.0

		speaker := d.findSpeakerForTimeRange(segStart, segEnd, speakerSegments)
		result[i].Speaker = fmt.Sprintf("Speaker %d", speaker)

		// Также обновляем спикеров для отдельных слов
		for j := range result[i].Words {
			wordStart := float32(result[i].Words[j].Start) / 1000.0
			wordEnd := float32(result[i].Words[j].End) / 1000.0
			wordSpeaker := d.findSpeakerForTimeRange(wordStart, wordEnd, speakerSegments)
			// Можно добавить поле Speaker в TranscriptWord если нужно
			_ = wordSpeaker
		}
	}

	return result
}

// findSpeakerForTimeRange находит спикера с максимальным перекрытием для временного диапазона
func (d *SherpaDiarizer) findSpeakerForTimeRange(
	start, end float32,
	speakerSegments []SpeakerSegment,
) int {
	maxOverlap := float32(0)
	bestSpeaker := 0

	for _, seg := range speakerSegments {
		// Вычисляем перекрытие
		overlapStart := max(start, seg.Start)
		overlapEnd := min(end, seg.End)
		overlap := overlapEnd - overlapStart

		if overlap > maxOverlap {
			maxOverlap = overlap
			bestSpeaker = seg.Speaker
		}
	}

	return bestSpeaker
}

func max(a, b float32) float32 {
	if a > b {
		return a
	}
	return b
}

func min(a, b float32) float32 {
	if a < b {
		return a
	}
	return b
}
