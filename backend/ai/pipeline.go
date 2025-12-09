// Package ai предоставляет AudioPipeline для комплексной обработки аудио
package ai

import (
	"fmt"
	"log"
	"sync"
)

// PipelineConfig конфигурация аудио пайплайна
type PipelineConfig struct {
	// Диаризация
	EnableDiarization     bool   // Включить диаризацию спикеров
	SegmentationModelPath string // Путь к модели сегментации pyannote
	EmbeddingModelPath    string // Путь к модели speaker embedding

	// Параметры диаризации
	ClusteringThreshold float32 // Порог кластеризации (0.0-1.0)
	MinDurationOn       float32 // Мин. длительность речи (сек)
	MinDurationOff      float32 // Мин. длительность паузы (сек)

	// ONNX
	NumThreads int    // Количество потоков
	Provider   string // ONNX provider: cpu, cuda, coreml
}

// DefaultPipelineConfig возвращает конфигурацию по умолчанию
// Provider "auto" означает автоматическое определение лучшего устройства
func DefaultPipelineConfig() PipelineConfig {
	return PipelineConfig{
		EnableDiarization:   false,
		ClusteringThreshold: 0.5,
		MinDurationOn:       0.3,
		MinDurationOff:      0.5,
		NumThreads:          4,
		Provider:            "auto", // Автоопределение: coreml на Apple Silicon, cpu иначе
	}
}

// PipelineResult результат обработки аудио пайплайном
type PipelineResult struct {
	Segments        []TranscriptSegment // Сегменты с текстом и таймстемпами
	SpeakerSegments []SpeakerSegment    // Сегменты смены спикеров (если диаризация включена)
	NumSpeakers     int                 // Количество обнаруженных спикеров
	FullText        string              // Полный текст транскрипции
}

// AudioPipeline оркестрирует транскрипцию и диаризацию
type AudioPipeline struct {
	transcriber TranscriptionEngine // Движок транскрипции (Whisper/GigaAM)
	diarizer    *SherpaDiarizer     // Диаризатор (опционально)
	config      PipelineConfig
	mu          sync.RWMutex
}

// NewAudioPipeline создаёт новый пайплайн обработки аудио
func NewAudioPipeline(transcriber TranscriptionEngine, config PipelineConfig) (*AudioPipeline, error) {
	if transcriber == nil {
		return nil, fmt.Errorf("transcriber is required")
	}

	pipeline := &AudioPipeline{
		transcriber: transcriber,
		config:      config,
	}

	// Инициализируем диаризатор если включен
	if config.EnableDiarization {
		if err := pipeline.initDiarizer(); err != nil {
			log.Printf("Warning: diarization initialization failed: %v", err)
			// Продолжаем без диаризации
		}
	}

	return pipeline, nil
}

// initDiarizer инициализирует диаризатор
func (p *AudioPipeline) initDiarizer() error {
	if p.config.SegmentationModelPath == "" || p.config.EmbeddingModelPath == "" {
		return fmt.Errorf("segmentation and embedding model paths are required for diarization")
	}

	diarizerConfig := SherpaDiarizerConfig{
		SegmentationModelPath: p.config.SegmentationModelPath,
		EmbeddingModelPath:    p.config.EmbeddingModelPath,
		NumThreads:            p.config.NumThreads,
		ClusteringThreshold:   p.config.ClusteringThreshold,
		MinDurationOn:         p.config.MinDurationOn,
		MinDurationOff:        p.config.MinDurationOff,
		Provider:              p.config.Provider,
	}

	diarizer, err := NewSherpaDiarizer(diarizerConfig)
	if err != nil {
		return err
	}

	p.diarizer = diarizer
	log.Printf("AudioPipeline: diarization enabled")
	return nil
}

// Process обрабатывает аудио: транскрипция + диаризация (если включена)
// samples - аудио данные в формате float32, 16kHz, mono
func (p *AudioPipeline) Process(samples []float32) (*PipelineResult, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if len(samples) == 0 {
		return &PipelineResult{}, nil
	}

	result := &PipelineResult{}

	// 1. Транскрипция через Whisper/GigaAM
	segments, err := p.transcriber.TranscribeWithSegments(samples)
	if err != nil {
		return nil, fmt.Errorf("transcription failed: %w", err)
	}
	result.Segments = segments

	// Собираем полный текст
	for _, seg := range segments {
		if result.FullText != "" {
			result.FullText += " "
		}
		result.FullText += seg.Text
	}

	// 2. Диаризация (если включена и инициализирована)
	if p.diarizer != nil && p.diarizer.IsInitialized() {
		speakerSegments, err := p.diarizer.Diarize(samples)
		if err != nil {
			log.Printf("Warning: diarization failed: %v", err)
			// Продолжаем без диаризации
		} else {
			result.SpeakerSegments = speakerSegments
			result.NumSpeakers = p.countUniqueSpeakers(speakerSegments)

			// 3. Объединяем результаты: назначаем спикеров сегментам транскрипции
			result.Segments = p.diarizer.DiarizeWithTranscription(segments, speakerSegments)
		}
	}

	return result, nil
}

// ProcessHighQuality выполняет высококачественную обработку (для финальной транскрипции)
func (p *AudioPipeline) ProcessHighQuality(samples []float32) (*PipelineResult, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if len(samples) == 0 {
		return &PipelineResult{}, nil
	}

	result := &PipelineResult{}

	// 1. Высококачественная транскрипция
	segments, err := p.transcriber.TranscribeHighQuality(samples)
	if err != nil {
		return nil, fmt.Errorf("high-quality transcription failed: %w", err)
	}
	result.Segments = segments

	// Собираем полный текст
	for _, seg := range segments {
		if result.FullText != "" {
			result.FullText += " "
		}
		result.FullText += seg.Text
	}

	// 2. Диаризация
	if p.diarizer != nil && p.diarizer.IsInitialized() {
		speakerSegments, err := p.diarizer.Diarize(samples)
		if err != nil {
			log.Printf("Warning: diarization failed: %v", err)
		} else {
			result.SpeakerSegments = speakerSegments
			result.NumSpeakers = p.countUniqueSpeakers(speakerSegments)
			result.Segments = p.diarizer.DiarizeWithTranscription(segments, speakerSegments)
		}
	}

	return result, nil
}

// EnableDiarization включает диаризацию с указанными моделями
func (p *AudioPipeline) EnableDiarization(segmentationPath, embeddingPath string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Закрываем старый диаризатор если есть
	if p.diarizer != nil {
		p.diarizer.Close()
		p.diarizer = nil
	}

	p.config.EnableDiarization = true
	p.config.SegmentationModelPath = segmentationPath
	p.config.EmbeddingModelPath = embeddingPath

	return p.initDiarizer()
}

// DisableDiarization отключает диаризацию
func (p *AudioPipeline) DisableDiarization() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.diarizer != nil {
		p.diarizer.Close()
		p.diarizer = nil
	}
	p.config.EnableDiarization = false
}

// IsDiarizationEnabled возвращает true если диаризация включена и инициализирована
func (p *AudioPipeline) IsDiarizationEnabled() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.diarizer != nil && p.diarizer.IsInitialized()
}

// GetDiarizationProvider возвращает текущий provider для диаризации (cpu, coreml, cuda)
// Возвращает пустую строку если диаризация не включена
func (p *AudioPipeline) GetDiarizationProvider() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.diarizer != nil {
		return p.diarizer.GetProvider()
	}
	return ""
}

// SetTranscriber устанавливает новый движок транскрипции
func (p *AudioPipeline) SetTranscriber(transcriber TranscriptionEngine) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.transcriber = transcriber
}

// GetTranscriber возвращает текущий движок транскрипции
func (p *AudioPipeline) GetTranscriber() TranscriptionEngine {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.transcriber
}

// Close освобождает ресурсы пайплайна
func (p *AudioPipeline) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.diarizer != nil {
		p.diarizer.Close()
		p.diarizer = nil
	}
	// Примечание: transcriber не закрываем, им управляет EngineManager
}

// countUniqueSpeakers подсчитывает уникальных спикеров
func (p *AudioPipeline) countUniqueSpeakers(segments []SpeakerSegment) int {
	speakers := make(map[int]bool)
	for _, seg := range segments {
		speakers[seg.Speaker] = true
	}
	return len(speakers)
}

// MergeSegmentsWithSpeakers объединяет сегменты транскрипции с информацией о спикерах
// Это утилитарная функция для случаев когда диаризация выполняется отдельно
func MergeSegmentsWithSpeakers(
	transcriptSegments []TranscriptSegment,
	speakerSegments []SpeakerSegment,
) []TranscriptSegment {
	if len(transcriptSegments) == 0 || len(speakerSegments) == 0 {
		return transcriptSegments
	}

	result := make([]TranscriptSegment, len(transcriptSegments))
	copy(result, transcriptSegments)

	for i := range result {
		segStart := float32(result[i].Start) / 1000.0
		segEnd := float32(result[i].End) / 1000.0

		speaker := findBestSpeaker(segStart, segEnd, speakerSegments)
		result[i].Speaker = fmt.Sprintf("Speaker %d", speaker)
	}

	return result
}

// findBestSpeaker находит спикера с максимальным перекрытием
func findBestSpeaker(start, end float32, speakerSegments []SpeakerSegment) int {
	maxOverlap := float32(0)
	bestSpeaker := 0

	for _, seg := range speakerSegments {
		overlapStart := start
		if seg.Start > start {
			overlapStart = seg.Start
		}
		overlapEnd := end
		if seg.End < end {
			overlapEnd = seg.End
		}
		overlap := overlapEnd - overlapStart

		if overlap > maxOverlap {
			maxOverlap = overlap
			bestSpeaker = seg.Speaker
		}
	}

	return bestSpeaker
}
