// Package ai предоставляет AudioPipeline для комплексной обработки аудио
package ai

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// PipelineConfig конфигурация аудио пайплайна
type PipelineConfig struct {
	// Диаризация
	EnableDiarization     bool   // Включить диаризацию спикеров
	SegmentationModelPath string // Путь к модели сегментации pyannote
	EmbeddingModelPath    string // Путь к модели speaker embedding
	DiarizationBackend    string // Бэкенд диаризации: "sherpa" (default), "fluid" (FluidAudio/CoreML)

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
	transcriber        TranscriptionEngine // Движок транскрипции (Whisper/GigaAM)
	diarizer           DiarizationProvider // Диаризатор (sherpa или fluid)
	sherpaDiarizer     *SherpaDiarizer     // Sherpa диаризатор (для DiarizeWithTranscription)
	encoder            *SpeakerEncoder     // Энкодер для извлечения векторов (для глобального трекинга)
	config             PipelineConfig
	mu                 sync.RWMutex
	diarizationBackend string // "sherpa" или "fluid"

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
	backend := p.config.DiarizationBackend
	if backend == "" {
		backend = "sherpa" // По умолчанию используем Sherpa
	}

	// Пробуем инициализировать выбранный бэкенд
	switch backend {
	case "fluid":
		// FluidAudio - CoreML бэкенд (рекомендуется для macOS)
		fluidDiarizer, err := NewFluidDiarizer(FluidDiarizerConfig{})
		if err != nil {
			log.Printf("FluidDiarizer init failed: %v, falling back to Sherpa", err)
			backend = "sherpa"
		} else {
			p.diarizer = fluidDiarizer
			p.diarizationBackend = "fluid"
			log.Printf("AudioPipeline: diarization enabled (FluidAudio/CoreML)")
			return nil
		}
	}

	// Sherpa бэкенд (default)
	if backend == "sherpa" {
		if p.config.SegmentationModelPath == "" || p.config.EmbeddingModelPath == "" {
			return fmt.Errorf("segmentation and embedding model paths are required for Sherpa diarization")
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

		sherpaDiarizer, err := NewSherpaDiarizer(diarizerConfig)
		if err != nil {
			return fmt.Errorf("failed to create Sherpa diarizer: %w", err)
		}

		// Инициализируем SpeakerEncoder (для получения векторов и глобального трекинга)
		encoderConfig := DefaultSpeakerEncoderConfig(p.config.EmbeddingModelPath)
		encoder, err := NewSpeakerEncoder(encoderConfig)
		if err != nil {
			sherpaDiarizer.Close()
			return fmt.Errorf("failed to create speaker encoder: %w", err)
		}

		p.diarizer = sherpaDiarizer
		p.sherpaDiarizer = sherpaDiarizer
		p.encoder = encoder
		p.diarizationBackend = "sherpa"
		log.Printf("AudioPipeline: diarization enabled (Sherpa/ONNX, provider=%s)", p.config.Provider)
	}

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
		// a. Локальная диаризация (внутри чанка) с таймаутом
		localSegments, err := p.diarizeWithTimeout(samples, 20*time.Second)
		if err != nil {
			log.Printf("Warning: diarization failed: %v (fallback to plain transcription)", err)
			// Продолжаем без диаризации
		} else {
			// b. Глобальное сопоставление спикеров
			// Преобразуем локальные ID (0, 1...) в глобальные (1, 2...)
			globalSegments := p.mapToGlobalSpeakers(samples, localSegments)

			result.SpeakerSegments = globalSegments
			result.NumSpeakers = p.countUniqueSpeakers(globalSegments)

			// 3. Объединяем результаты: назначаем спикеров сегментам транскрипции
			if p.sherpaDiarizer != nil {
				result.Segments = p.sherpaDiarizer.DiarizeWithTranscription(segments, globalSegments)
			} else {
				result.Segments = assignSpeakersToSegments(segments, globalSegments)
			}
		}
	}

	return result, nil
}

// diarizeWithTimeout выполняет диаризацию с таймаутом, чтобы избежать зависаний нативной библиотеки
// ВАЖНО: Если нативный код зависает, goroutine останется в памяти, но TryLock
// в Diarize предотвратит накопление ожидающих goroutines
func (p *AudioPipeline) diarizeWithTimeout(samples []float32, timeout time.Duration) ([]SpeakerSegment, error) {
	type res struct {
		segs []SpeakerSegment
		err  error
	}

	ch := make(chan res, 1)
	go func() {
		segs, err := p.diarizer.Diarize(samples)
		ch <- res{segs: segs, err: err}
	}()

	select {
	case out := <-ch:
		return out.segs, out.err
	case <-time.After(timeout):
		log.Printf("WARNING: diarization timeout after %v - native code may have hung", timeout)
		return nil, fmt.Errorf("diarization timeout after %v", timeout)
	}
}

// mapToGlobalSpeakers сопоставляет локальных спикеров с глобальным реестром
func (p *AudioPipeline) mapToGlobalSpeakers(samples []float32, localSegments []SpeakerSegment) []SpeakerSegment {
	if len(localSegments) == 0 {
		return localSegments
	}

	// Если encoder не инициализирован (FluidAudio backend), используем локальные ID
	// FluidAudio делает собственную кластеризацию, поэтому просто преобразуем формат
	if p.encoder == nil {
		// Преобразуем к формату "Собеседник N" (speaker IDs уже корректные от FluidAudio)
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

// assignSpeakersToSegments назначает спикеров сегментам транскрипции на основе временных меток
// Используется как fallback когда SherpaDiarizer недоступен
func assignSpeakersToSegments(segments []TranscriptSegment, speakerSegments []SpeakerSegment) []TranscriptSegment {
	if len(speakerSegments) == 0 {
		return segments
	}

	result := make([]TranscriptSegment, len(segments))
	copy(result, segments)

	for i := range result {
		// Время сегмента в секундах
		segStartSec := float32(result[i].Start) / 1000.0
		segEndSec := float32(result[i].End) / 1000.0
		segMidSec := (segStartSec + segEndSec) / 2.0

		// Ищем спикера по середине сегмента
		for _, ss := range speakerSegments {
			if segMidSec >= ss.Start && segMidSec <= ss.End {
				result[i].Speaker = fmt.Sprintf("Собеседник %d", ss.Speaker)
				break
			}
		}

		// Если спикер не найден, используем ближайший
		if result[i].Speaker == "" {
			minDist := float32(1e9)
			closestSpeaker := 0
			for _, ss := range speakerSegments {
				// Расстояние до середины спикерского сегмента
				ssMid := (ss.Start + ss.End) / 2.0
				dist := segMidSec - ssMid
				if dist < 0 {
					dist = -dist
				}
				if dist < minDist {
					minDist = dist
					closestSpeaker = ss.Speaker
				}
			}
			result[i].Speaker = fmt.Sprintf("Собеседник %d", closestSpeaker)
		}
	}

	return result
}

// DiarizeOnly выполняет только диаризацию без транскрипции
// Используется для per-region режима, где транскрипция уже выполнена
func (p *AudioPipeline) DiarizeOnly(samples []float32) (*PipelineResult, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if len(samples) == 0 {
		return &PipelineResult{}, nil
	}

	result := &PipelineResult{}

	// Проверяем что диаризация включена
	if p.diarizer == nil || !p.diarizer.IsInitialized() {
		return result, fmt.Errorf("diarization not enabled")
	}

	// Выполняем только диаризацию
	localSegments, err := p.diarizeWithTimeout(samples, 20*time.Second)
	if err != nil {
		return result, fmt.Errorf("diarization failed: %w", err)
	}

	// Глобальное сопоставление спикеров
	globalSegments := p.mapToGlobalSpeakers(samples, localSegments)

	result.SpeakerSegments = globalSegments
	result.NumSpeakers = p.countUniqueSpeakers(globalSegments)

	log.Printf("DiarizeOnly: found %d speaker segments, %d unique speakers",
		len(globalSegments), result.NumSpeakers)

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
		// a. Локальная диаризация
		localSegments, err := p.diarizer.Diarize(samples)
		if err != nil {
			log.Printf("Warning: diarization failed: %v", err)
		} else {
			// b. Глобальное сопоставление
			globalSegments := p.mapToGlobalSpeakers(samples, localSegments)

			result.SpeakerSegments = globalSegments
			result.NumSpeakers = p.countUniqueSpeakers(globalSegments)
			if p.sherpaDiarizer != nil {
				result.Segments = p.sherpaDiarizer.DiarizeWithTranscription(segments, globalSegments)
			} else {
				result.Segments = assignSpeakersToSegments(segments, globalSegments)
			}
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

// GetDiarizationProvider возвращает текущий provider для диаризации (cpu, coreml, cuda, fluid)
// Возвращает пустую строку если диаризация не включена
func (p *AudioPipeline) GetDiarizationProvider() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.diarizer != nil {
		return p.diarizationBackend
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
