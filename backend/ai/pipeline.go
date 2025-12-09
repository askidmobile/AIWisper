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

// SpeakerProfile профиль спикера для глобального трекинга
type SpeakerProfile struct {
	ID        int       // Глобальный ID (1, 2, 3...)
	Embedding []float32 // Вектор голоса (усреднённый или первый найденный)
	Count     int       // Количество встреченных сегментов
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
	diarizer    *SherpaDiarizer     // Диаризатор (локальный для чанка)
	encoder     *SpeakerEncoder     // Энкодер для извлечения векторов (для глобального трекинга)
	config      PipelineConfig
	mu          sync.RWMutex

	// Глобальное состояние спикеров
	speakerProfiles map[int]*SpeakerProfile // ID -> Profile
	nextSpeakerID   int                     // Следующий свободный ID (начинаем с 1)
}

// NewAudioPipeline создаёт новый пайплайн обработки аудио
func NewAudioPipeline(transcriber TranscriptionEngine, config PipelineConfig) (*AudioPipeline, error) {
	if transcriber == nil {
		return nil, fmt.Errorf("transcriber is required")
	}

	pipeline := &AudioPipeline{
		transcriber:     transcriber,
		config:          config,
		speakerProfiles: make(map[int]*SpeakerProfile),
		nextSpeakerID:   1, // Спикеры начинаются с 1 (Собеседник 1)
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

// initDiarizer инициализирует диаризатор и энкодер
func (p *AudioPipeline) initDiarizer() error {
	if p.config.SegmentationModelPath == "" || p.config.EmbeddingModelPath == "" {
		return fmt.Errorf("segmentation and embedding model paths are required for diarization")
	}

	// 1. Инициализируем SherpaDiarizer (для сегментации и локальной кластеризации)
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
		return fmt.Errorf("failed to create diarizer: %w", err)
	}

	// 2. Инициализируем SpeakerEncoder (для получения векторов и глобального трекинга)
	// Используем ту же модель эмбеддингов
	encoderConfig := DefaultSpeakerEncoderConfig(p.config.EmbeddingModelPath)
	encoder, err := NewSpeakerEncoder(encoderConfig)
	if err != nil {
		diarizer.Close()
		return fmt.Errorf("failed to create speaker encoder: %w", err)
	}

	p.diarizer = diarizer
	p.encoder = encoder
	log.Printf("AudioPipeline: diarization enabled (with global tracking)")
	return nil
}

// ResetSpeakers сбрасывает реестр спикеров (нужно вызывать при начале новой сессии)
func (p *AudioPipeline) ResetSpeakers() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.speakerProfiles = make(map[int]*SpeakerProfile)
	p.nextSpeakerID = 1
	log.Printf("AudioPipeline: speaker registry reset")
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
		// a. Локальная диаризация (внутри чанка)
		localSegments, err := p.diarizer.Diarize(samples)
		if err != nil {
			log.Printf("Warning: diarization failed: %v", err)
			// Продолжаем без диаризации
		} else {
			// b. Глобальное сопоставление спикеров
			// Преобразуем локальные ID (0, 1...) в глобальные (1, 2...)
			globalSegments := p.mapToGlobalSpeakers(samples, localSegments)

			result.SpeakerSegments = globalSegments
			result.NumSpeakers = p.countUniqueSpeakers(globalSegments)

			// 3. Объединяем результаты: назначаем спикеров сегментам транскрипции
			result.Segments = p.diarizer.DiarizeWithTranscription(segments, globalSegments)
		}
	}

	return result, nil
}

// mapToGlobalSpeakers сопоставляет локальных спикеров с глобальным реестром
func (p *AudioPipeline) mapToGlobalSpeakers(samples []float32, localSegments []SpeakerSegment) []SpeakerSegment {
	if len(localSegments) == 0 || p.encoder == nil {
		return localSegments
	}

	// 1. Группируем сегменты по локальным спикерам
	localSpeakers := make(map[int][]SpeakerSegment)
	for _, seg := range localSegments {
		localSpeakers[seg.Speaker] = append(localSpeakers[seg.Speaker], seg)
	}

	// 2. Карта соответствия: Local ID -> Global ID
	mapping := make(map[int]int)

	// Для каждого локального спикера вычисляем эмбеддинг и ищем совпадение
	for localID, segs := range localSpeakers {
		// Находим самый длинный сегмент для лучшего качества эмбеддинга
		var bestSeg SpeakerSegment
		maxLen := float32(0)

		for _, seg := range segs {
			length := seg.End - seg.Start
			if length > maxLen {
				maxLen = length
				bestSeg = seg
			}
		}

		if maxLen < 0.1 { // Слишком короткий сегмент, пропускаем
			mapping[localID] = -1 // Unknown
			continue
		}

		// Извлекаем аудио
		startIdx := int(bestSeg.Start * 16000)
		endIdx := int(bestSeg.End * 16000)
		if startIdx < 0 {
			startIdx = 0
		}
		if endIdx > len(samples) {
			endIdx = len(samples)
		}

		if startIdx >= endIdx {
			mapping[localID] = -1
			continue
		}

		audioSeg := samples[startIdx:endIdx]

		// Получаем вектор
		embedding, err := p.encoder.Encode(audioSeg)
		if err != nil {
			log.Printf("Failed to encode speaker %d segment: %v", localID, err)
			mapping[localID] = -1
			continue
		}

		// Ищем совпадение в реестре
		globalID, found := p.findMatchingGlobalSpeaker(embedding)

		if found {
			mapping[localID] = globalID
			// Можно обновить профиль (усреднить вектор), но пока просто используем существующий
		} else {
			// Создаём нового спикера
			newID := p.registerNewSpeaker(embedding)
			mapping[localID] = newID
			log.Printf("New speaker detected: Global ID %d (was Local %d)", newID, localID)
		}
	}

	// 3. Создаём новые сегменты с глобальными ID
	result := make([]SpeakerSegment, len(localSegments))
	for i, seg := range localSegments {
		globalID, ok := mapping[seg.Speaker]
		if !ok || globalID == -1 {
			// Если не удалось определить, используем временный ID (но это редкость)
			// Или можно оставить как есть, но тогда будет конфликт
			// Лучше назначить новый ID? Нет, лучше -1 и потом обработать как "Unknown"
			// Но для простоты пока используем nextID (временный)
			globalID = p.nextSpeakerID // Просто резервируем, но не сохраняем в реестр?
			// Нет, давайте просто оставим локальный + offset, если совсем плохо
			// Но лучше всего - просто пропустить или присвоить "Speaker ?"
			// В текущей реализации UI ожидает "Speaker N".
			// Если mapping failed, fallback to create new ID?
			// Давайте так: если mapping -1, то это шум.
			// Но если шум, то лучше вообще убрать сегмент?
			// Пока оставим как есть, но с ID=0 (system/unknown)
			globalID = 0
		}

		result[i] = SpeakerSegment{
			Start:   seg.Start,
			End:     seg.End,
			Speaker: globalID - 1, // UI ожидает 0-based index для Speaker N
			// Наш registry 1-based, а UI: 0 -> Speaker 1, 1 -> Speaker 2
			// Поэтому возвращаем globalID - 1
		}
	}

	return result
}

// findMatchingGlobalSpeaker ищет похожего спикера в реестре
func (p *AudioPipeline) findMatchingGlobalSpeaker(embedding []float32) (int, bool) {
	bestDist := 2.0 // Максимальное косинусное расстояние
	bestID := -1
	threshold := 0.5 // Порог похожести (чем меньше, тем строже)

	for id, profile := range p.speakerProfiles {
		dist := cosineDistance(embedding, profile.Embedding)
		if dist < bestDist {
			bestDist = dist
			bestID = id
		}
	}

	if bestID != -1 && bestDist < threshold {
		return bestID, true
	}

	return -1, false
}

// registerNewSpeaker добавляет нового спикера в реестр
func (p *AudioPipeline) registerNewSpeaker(embedding []float32) int {
	id := p.nextSpeakerID
	p.nextSpeakerID++

	// Копируем вектор
	embCopy := make([]float32, len(embedding))
	copy(embCopy, embedding)

	p.speakerProfiles[id] = &SpeakerProfile{
		ID:        id,
		Embedding: embCopy,
		Count:     1,
	}

	return id
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
		// a. Локальная диаризация
		localSegments, err := p.diarizer.Diarize(samples)
		if err != nil {
			log.Printf("Warning: diarization failed: %v", err)
		} else {
			// b. Глобальное сопоставление
			globalSegments := p.mapToGlobalSpeakers(samples, localSegments)

			result.SpeakerSegments = globalSegments
			result.NumSpeakers = p.countUniqueSpeakers(globalSegments)
			result.Segments = p.diarizer.DiarizeWithTranscription(segments, globalSegments)
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

	if p.encoder != nil {
		p.encoder.Close()
		p.encoder = nil
	}

	p.speakerProfiles = nil

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
