package service

import (
	"aiwisper/ai"
	"aiwisper/session"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// TranscriptionService handles the core transcription logic
type TranscriptionService struct {
	SessionMgr *session.Manager
	EngineMgr  *ai.EngineManager
	Pipeline   *ai.AudioPipeline // Опционально: пайплайн с диаризацией

	// VAD режим транскрипции
	VADMode   session.VADMode   // auto, compression, per-region, off
	VADMethod session.VADMethod // energy, silero, auto

	// LLM для автоматического улучшения транскрипции
	LLMService         *LLMService
	AutoImproveWithLLM bool   // Автоматически улучшать через LLM после транскрипции
	OllamaURL          string // URL Ollama API
	OllamaModel        string // Модель для улучшения

	// Гибридная транскрипция (двухпроходное распознавание)
	HybridConfig      *ai.HybridTranscriptionConfig // Конфигурация гибридной транскрипции
	hybridTranscriber *ai.HybridTranscriber         // Экземпляр гибридного транскрибера
	secondaryEngine   ai.TranscriptionEngine        // Вторичный движок для гибридной транскрипции

	// Callbacks for UI updates
	OnChunkTranscribed func(chunk *session.Chunk)
}

func NewTranscriptionService(sessionMgr *session.Manager, engineMgr *ai.EngineManager) *TranscriptionService {
	return &TranscriptionService{
		SessionMgr:  sessionMgr,
		EngineMgr:   engineMgr,
		VADMode:     session.VADModeAuto,   // По умолчанию автовыбор режима
		VADMethod:   session.VADMethodAuto, // По умолчанию автовыбор метода
		OllamaURL:   "http://localhost:11434",
		OllamaModel: "llama3.2",
	}
}

// SetVADMode устанавливает режим VAD для транскрипции
func (s *TranscriptionService) SetVADMode(mode session.VADMode) {
	s.VADMode = mode
	log.Printf("VAD mode set to: %s", mode)
}

// SetVADMethod устанавливает метод детекции речи
func (s *TranscriptionService) SetVADMethod(method session.VADMethod) {
	s.VADMethod = method
	log.Printf("VAD method set to: %s", method)
}

// getEffectiveVADMethod возвращает эффективный метод VAD
// При auto пытается использовать Silero если модель доступна
func (s *TranscriptionService) getEffectiveVADMethod() session.VADMethod {
	switch s.VADMethod {
	case session.VADMethodSilero:
		return session.VADMethodSilero
	case session.VADMethodEnergy:
		return session.VADMethodEnergy
	case session.VADMethodAuto, "":
		// Автовыбор: пробуем Silero, если недоступен - Energy
		// Silero VAD требует модель, проверяем её наличие
		return session.VADMethodSilero // Пробуем Silero, fallback на Energy внутри DetectSpeechRegionsWithMethod
	default:
		return session.VADMethodEnergy
	}
}

// shouldUsePerRegion определяет нужно ли использовать per-region транскрипцию
// на основе настройки VADMode и активного движка
func (s *TranscriptionService) shouldUsePerRegion() bool {
	switch s.VADMode {
	case session.VADModePerRegion:
		// Явно выбран per-region
		return true
	case session.VADModeCompression:
		// Явно выбран compression
		return false
	case session.VADModeAuto, "":
		// Автовыбор: per-region для GigaAM, compression для Whisper
		return s.EngineMgr.IsGigaAMActive()
	default:
		// VADModeOff или неизвестный режим - используем compression
		return false
	}
}

// SetLLMService устанавливает LLM сервис для автоулучшения
func (s *TranscriptionService) SetLLMService(llm *LLMService) {
	s.LLMService = llm
}

// EnableAutoImprove включает автоматическое улучшение транскрипции через LLM
func (s *TranscriptionService) EnableAutoImprove(ollamaURL, ollamaModel string) {
	s.AutoImproveWithLLM = true
	if ollamaURL != "" {
		s.OllamaURL = ollamaURL
	}
	if ollamaModel != "" {
		s.OllamaModel = ollamaModel
	}
	log.Printf("Auto-improve enabled: url=%s, model=%s", s.OllamaURL, s.OllamaModel)
}

// DisableAutoImprove отключает автоматическое улучшение
func (s *TranscriptionService) DisableAutoImprove() {
	s.AutoImproveWithLLM = false
	log.Println("Auto-improve disabled")
}

// SetHybridConfig устанавливает конфигурацию гибридной транскрипции
func (s *TranscriptionService) SetHybridConfig(config *ai.HybridTranscriptionConfig) {
	log.Printf("[SetHybridConfig] Called with config=%v", config != nil)
	if config != nil {
		log.Printf("[SetHybridConfig] Config details: Enabled=%v, SecondaryModelID=%s, Mode=%s, UseLLM=%v, OllamaModel=%s",
			config.Enabled, config.SecondaryModelID, config.Mode, config.UseLLMForMerge, config.OllamaModel)
	}

	// Закрываем старый вторичный движок если был
	if s.secondaryEngine != nil {
		s.secondaryEngine.Close()
		s.secondaryEngine = nil
	}
	s.hybridTranscriber = nil
	s.HybridConfig = config

	if config == nil || !config.Enabled || config.SecondaryModelID == "" {
		log.Println("[SetHybridConfig] Hybrid transcription disabled (config nil or not enabled)")
		return
	}

	// Создаём вторичный движок
	log.Printf("[SetHybridConfig] Creating secondary engine for model: %s", config.SecondaryModelID)
	secondaryEngine, err := s.EngineMgr.CreateEngineForModel(config.SecondaryModelID)
	if err != nil {
		log.Printf("[SetHybridConfig] FAILED to create secondary engine: %v", err)
		s.HybridConfig = nil
		return
	}
	log.Printf("[SetHybridConfig] Secondary engine created: %s", secondaryEngine.Name())
	s.secondaryEngine = secondaryEngine

	// Создаём LLM selector если нужен
	var llmSelector ai.LLMTranscriptionSelector
	if config.UseLLMForMerge && s.LLMService != nil {
		// Используем модель из конфига гибридной транскрипции, если указана
		ollamaModel := config.OllamaModel
		ollamaURL := config.OllamaURL
		if ollamaModel == "" {
			ollamaModel = s.OllamaModel
		}
		if ollamaURL == "" {
			ollamaURL = s.OllamaURL
		}
		// Дефолты если всё ещё пусто
		if ollamaModel == "" {
			ollamaModel = "llama3.2"
		}
		if ollamaURL == "" {
			ollamaURL = "http://localhost:11434"
		}

		log.Printf("Hybrid LLM selector: model=%s, url=%s", ollamaModel, ollamaURL)
		llmSelector = &llmSelectorAdapter{
			llmService:  s.LLMService,
			ollamaURL:   ollamaURL,
			ollamaModel: ollamaModel,
		}
	}

	// Передаём hotwords в движки (для Whisper это initial prompt)
	if len(config.Hotwords) > 0 {
		log.Printf("[SetHybridConfig] Setting hotwords (%d words) on engines", len(config.Hotwords))
		primaryEngine := s.EngineMgr.GetActiveEngine()
		if primaryEngine != nil {
			primaryEngine.SetHotwords(config.Hotwords)
		}
		secondaryEngine.SetHotwords(config.Hotwords)
	}

	// Создаём HybridTranscriber
	s.hybridTranscriber = ai.NewHybridTranscriber(
		s.EngineMgr.GetActiveEngine(),
		secondaryEngine,
		*config,
		llmSelector,
	)

	log.Printf("[SetHybridConfig] SUCCESS: Hybrid transcription enabled: secondaryModel=%s, threshold=%.2f, useLLM=%v, mode=%s, hotwords=%d",
		config.SecondaryModelID, config.ConfidenceThreshold, config.UseLLMForMerge, config.Mode, len(config.Hotwords))
	log.Printf("[SetHybridConfig] State after setup: hybridTranscriber=%v, secondaryEngine=%v",
		s.hybridTranscriber != nil, s.secondaryEngine != nil)
}

// IsHybridEnabled возвращает true если гибридная транскрипция включена
func (s *TranscriptionService) IsHybridEnabled() bool {
	return s.HybridConfig != nil && s.HybridConfig.Enabled && s.hybridTranscriber != nil
}

// llmSelectorAdapter адаптер для LLMService к интерфейсу LLMTranscriptionSelector
type llmSelectorAdapter struct {
	llmService  *LLMService
	ollamaURL   string
	ollamaModel string
}

func (a *llmSelectorAdapter) SelectBestTranscription(original, alternative, context string) (string, error) {
	return a.llmService.SelectBestTranscription(original, alternative, context, a.ollamaModel, a.ollamaURL)
}

// transcribeWithHybrid выполняет транскрипцию с поддержкой гибридного режима
// Если гибридная транскрипция включена - использует HybridTranscriber
// Иначе - обычную транскрипцию через EngineMgr
func (s *TranscriptionService) transcribeWithHybrid(samples []float32) ([]ai.TranscriptSegment, error) {
	// Детальное логирование состояния гибридной транскрипции
	log.Printf("[transcribeWithHybrid] Checking hybrid state: HybridConfig=%v, hybridTranscriber=%v",
		s.HybridConfig != nil, s.hybridTranscriber != nil)
	if s.HybridConfig != nil {
		log.Printf("[transcribeWithHybrid] HybridConfig: enabled=%v, secondaryModel=%s, mode=%s, useLLM=%v",
			s.HybridConfig.Enabled, s.HybridConfig.SecondaryModelID, s.HybridConfig.Mode, s.HybridConfig.UseLLMForMerge)
	}

	if s.IsHybridEnabled() && s.hybridTranscriber != nil {
		log.Printf("[transcribeWithHybrid] Using hybrid transcription (primary + %s, mode=%s)",
			s.HybridConfig.SecondaryModelID, s.HybridConfig.Mode)
		result, err := s.hybridTranscriber.Transcribe(samples)
		if err != nil {
			log.Printf("[transcribeWithHybrid] Hybrid transcription failed: %v, falling back to primary engine", err)
			return s.EngineMgr.TranscribeWithSegments(samples)
		}
		if result.RetranscribedCount > 0 {
			log.Printf("[transcribeWithHybrid] Hybrid transcription: improved %d regions (low confidence: %d words)",
				result.RetranscribedCount, result.LowConfidenceCount)
		} else {
			log.Printf("[transcribeWithHybrid] Hybrid transcription completed, no improvements made")
		}
		return result.Segments, nil
	}

	log.Printf("[transcribeWithHybrid] Hybrid disabled, using standard transcription")
	return s.EngineMgr.TranscribeWithSegments(samples)
}

// applyHybridToPipelineResult применяет гибридную транскрипцию к результату Pipeline
// Транскрибирует аудио вторичной моделью и использует LLM для выбора лучшего варианта
// Сохраняет информацию о спикерах из оригинального результата
func (s *TranscriptionService) applyHybridToPipelineResult(samples []float32, pipelineResult *ai.PipelineResult) *ai.PipelineResult {
	log.Printf("[applyHybridToPipelineResult] START: hybridTranscriber=%v, secondaryEngine=%v",
		s.hybridTranscriber != nil, s.secondaryEngine != nil)

	if s.hybridTranscriber == nil || s.secondaryEngine == nil {
		log.Printf("[applyHybridToPipelineResult] ABORT: No hybrid transcriber or secondary engine")
		return nil
	}

	// Транскрибируем вторичной моделью
	log.Printf("[applyHybridToPipelineResult] Transcribing %d samples with secondary model: %s",
		len(samples), s.secondaryEngine.Name())
	secondarySegments, err := s.secondaryEngine.TranscribeWithSegments(samples)
	if err != nil {
		log.Printf("[applyHybridToPipelineResult] ABORT: Secondary transcription failed: %v", err)
		return nil
	}
	log.Printf("[applyHybridToPipelineResult] Secondary transcription OK: %d segments", len(secondarySegments))

	// Собираем тексты
	primaryText := pipelineResult.FullText
	var secondaryTextParts []string
	for _, seg := range secondarySegments {
		secondaryTextParts = append(secondaryTextParts, seg.Text)
	}
	secondaryText := strings.Join(secondaryTextParts, " ")

	log.Printf("[applyHybridToPipelineResult] Primary: %q", primaryText)
	log.Printf("[applyHybridToPipelineResult] Secondary: %q", secondaryText)

	// Если тексты идентичны — нет смысла сравнивать
	if primaryText == secondaryText {
		log.Printf("[applyHybridToPipelineResult] Texts identical, keeping primary")
		return nil
	}

	// Используем LLM для выбора лучшего варианта
	if s.HybridConfig.UseLLMForMerge && s.LLMService != nil {
		ollamaModel := s.HybridConfig.OllamaModel
		ollamaURL := s.HybridConfig.OllamaURL
		if ollamaModel == "" {
			ollamaModel = s.OllamaModel
		}
		if ollamaURL == "" {
			ollamaURL = s.OllamaURL
		}
		if ollamaModel == "" {
			ollamaModel = "llama3.2"
		}
		if ollamaURL == "" {
			ollamaURL = "http://localhost:11434"
		}

		log.Printf("[applyHybridToPipelineResult] Using LLM to select best: model=%s", ollamaModel)

		selected, err := s.LLMService.SelectBestTranscription(primaryText, secondaryText, "", ollamaModel, ollamaURL)
		if err != nil {
			log.Printf("[applyHybridToPipelineResult] LLM selection failed: %v", err)
			return nil
		}

		log.Printf("[applyHybridToPipelineResult] LLM selected: %q", selected)

		// Если LLM выбрал вторичный вариант или модифицировал текст
		if selected != primaryText {
			// Создаём новый результат с улучшенным текстом
			// Сохраняем структуру сегментов и спикеров из оригинала, но обновляем текст
			improvedResult := &ai.PipelineResult{
				FullText:    selected,
				Segments:    pipelineResult.Segments, // Сохраняем спикеров и таймкоды
				NumSpeakers: pipelineResult.NumSpeakers,
			}

			// Если текст сильно изменился, обновляем текст в сегментах
			// Простая эвристика: если выбран вторичный текст, используем его сегменты
			if selected == secondaryText && len(secondarySegments) > 0 {
				// Переносим текст из вторичных сегментов, сохраняя спикеров из первичных
				improvedResult.Segments = mergeSegmentsWithSpeakers(secondarySegments, pipelineResult.Segments)
			}

			return improvedResult
		}
	}

	return nil
}

// mergeSegmentsWithSpeakers объединяет текст из новых сегментов с информацией о спикерах из старых
func mergeSegmentsWithSpeakers(newSegs []ai.TranscriptSegment, oldSegs []ai.TranscriptSegment) []ai.TranscriptSegment {
	if len(oldSegs) == 0 {
		return newSegs
	}

	result := make([]ai.TranscriptSegment, len(newSegs))
	for i, newSeg := range newSegs {
		result[i] = newSeg

		// Находим ближайший старый сегмент по времени для получения спикера
		var bestMatch *ai.TranscriptSegment
		var bestOverlap int64 = 0

		for j := range oldSegs {
			// Вычисляем пересечение временных интервалов
			overlapStart := max(newSeg.Start, oldSegs[j].Start)
			overlapEnd := min(newSeg.End, oldSegs[j].End)
			overlap := overlapEnd - overlapStart

			if overlap > bestOverlap {
				bestOverlap = overlap
				bestMatch = &oldSegs[j]
			}
		}

		if bestMatch != nil && bestMatch.Speaker != "" {
			result[i].Speaker = bestMatch.Speaker
		}
	}

	return result
}

// SetPipeline устанавливает AudioPipeline для расширенной обработки (диаризация)
func (s *TranscriptionService) SetPipeline(pipeline *ai.AudioPipeline) {
	s.Pipeline = pipeline
}

// EnableDiarization включает диаризацию с указанными моделями
// Provider "auto" (по умолчанию) автоматически выберет лучшее устройство:
// - CoreML на Apple Silicon (GPU ускорение)
// - CPU на других платформах
func (s *TranscriptionService) EnableDiarization(segmentationPath, embeddingPath string) error {
	return s.EnableDiarizationWithProvider(segmentationPath, embeddingPath, "auto")
}

// EnableDiarizationWithProvider включает диаризацию с указанными моделями и provider
// provider: "auto", "cpu", "coreml", "cuda"
func (s *TranscriptionService) EnableDiarizationWithProvider(segmentationPath, embeddingPath, provider string) error {
	return s.EnableDiarizationWithBackend(segmentationPath, embeddingPath, provider, "sherpa")
}

// EnableDiarizationWithBackend включает диаризацию с указанными моделями, provider и backend
// provider: "auto", "cpu", "coreml", "cuda" (только для Sherpa)
// backend: "sherpa" (ONNX), "fluid" (FluidAudio/CoreML - рекомендуется для macOS)
func (s *TranscriptionService) EnableDiarizationWithBackend(segmentationPath, embeddingPath, provider, backend string) error {
	if s.EngineMgr == nil {
		return fmt.Errorf("engine manager is required")
	}

	engine := s.EngineMgr.GetActiveEngine()
	if engine == nil {
		return fmt.Errorf("no active transcription engine")
	}

	config := ai.PipelineConfig{
		EnableDiarization:     true,
		SegmentationModelPath: segmentationPath,
		EmbeddingModelPath:    embeddingPath,
		ClusteringThreshold:   0.5,
		MinDurationOn:         0.3,
		MinDurationOff:        0.5,
		NumThreads:            4,
		Provider:              provider, // "auto" = автоопределение (для Sherpa)
		DiarizationBackend:    backend,  // "sherpa" или "fluid"
	}

	pipeline, err := ai.NewAudioPipeline(engine, config)
	if err != nil {
		return fmt.Errorf("failed to create pipeline: %w", err)
	}

	// Закрываем старый пайплайн если был
	if s.Pipeline != nil {
		s.Pipeline.Close()
	}

	s.Pipeline = pipeline
	actualProvider := pipeline.GetDiarizationProvider()
	log.Printf("Diarization enabled: backend=%s, provider=%s, segmentation=%s, embedding=%s",
		backend, actualProvider, segmentationPath, embeddingPath)
	return nil
}

// DisableDiarization отключает диаризацию
func (s *TranscriptionService) DisableDiarization() {
	if s.Pipeline != nil {
		s.Pipeline.Close()
		s.Pipeline = nil
	}
}

// IsDiarizationEnabled возвращает true если диаризация включена
func (s *TranscriptionService) IsDiarizationEnabled() bool {
	return s.Pipeline != nil && s.Pipeline.IsDiarizationEnabled()
}

// GetDiarizationProvider возвращает текущий provider диаризации (cpu, coreml, cuda)
// Возвращает пустую строку если диаризация не включена
func (s *TranscriptionService) GetDiarizationProvider() string {
	if s.Pipeline != nil {
		return s.Pipeline.GetDiarizationProvider()
	}
	return ""
}

// ResetDiarizationState сбрасывает состояние диаризации (реестр спикеров)
// Следует вызывать перед началом новой сессии записи или полной ретранскрипции
func (s *TranscriptionService) ResetDiarizationState() {
	if s.Pipeline != nil {
		s.Pipeline.ResetSpeakers()
	}
}

// HandleChunk processes a new audio chunk: VAD, transcription, mapping (async)
func (s *TranscriptionService) HandleChunk(chunk *session.Chunk) {
	if s.EngineMgr == nil {
		log.Printf("Engine is nil, skipping transcription for chunk %s", chunk.ID)
		return
	}

	sessID := chunk.SessionID

	// Process asynchronously
	go func() {
		log.Printf("Starting transcription for chunk %d (session %s), isStereo=%v",
			chunk.Index, sessID, chunk.IsStereo)

		// Всегда пробуем стерео обработку. Если файл моно или каналы идентичны,
		// processStereoFromMP3 автоматически переключится на моно режим (с включенной диаризацией).
		s.processStereoFromMP3(chunk, true)
	}()
}

// HandleChunkSync processes a chunk synchronously (for retranscription)
func (s *TranscriptionService) HandleChunkSync(chunk *session.Chunk) {
	s.HandleChunkSyncWithDiarization(chunk, true) // По умолчанию используем диаризацию если включена
}

// HandleChunkSyncWithDiarization processes a chunk with explicit diarization flag
func (s *TranscriptionService) HandleChunkSyncWithDiarization(chunk *session.Chunk, useDiarization bool) {
	if s.EngineMgr == nil {
		log.Printf("Engine is nil, skipping transcription for chunk %s", chunk.ID)
		return
	}

	log.Printf("Starting sync transcription for chunk %d (session %s), isStereo=%v, useDiarization=%v",
		chunk.Index, chunk.SessionID, chunk.IsStereo, useDiarization)

	// Всегда пробуем стерео обработку, передавая флаг диаризации для fallback случая
	s.processStereoFromMP3(chunk, useDiarization)
}

// processStereoFromMP3 extracts stereo channels from full.mp3 and transcribes:
// - MIC channel (left): always "Вы" - single speaker, no diarization needed
// - SYS channel (right): diarization to identify multiple speakers (Собеседник 1, 2, 3...)
// Results are merged by timestamps into a dialogue
func (s *TranscriptionService) processStereoFromMP3(chunk *session.Chunk, useDiarizationFallback bool) {
	// Засекаем время начала обработки
	startTime := time.Now()
	chunk.ProcessingStartTime = &startTime

	// Get session to find MP3 path
	sess, err := s.SessionMgr.GetSession(chunk.SessionID)
	if err != nil {
		log.Printf("Failed to get session: %v", err)
		s.SessionMgr.UpdateChunkStereoWithSegments(chunk.SessionID, chunk.ID, "", "", nil, nil, err)
		return
	}

	mp3Path := filepath.Join(sess.DataDir, "full.mp3")

	log.Printf("Extracting stereo segment (pure Go): %s (start=%dms, end=%dms)", mp3Path, chunk.StartMs, chunk.EndMs)

	// Используем чистый Go декодер MP3 (без FFmpeg!)
	micSamples, sysSamples, err := session.ExtractSegmentStereoGo(mp3Path, chunk.StartMs, chunk.EndMs, 16000)
	if err != nil {
		log.Printf("Failed to extract stereo segment: %v, falling back to mono", err)
		s.processMonoFromMP3Impl(chunk, useDiarizationFallback)
		return
	}

	// Проверяем что есть данные хотя бы в одном канале
	if len(micSamples) == 0 && len(sysSamples) == 0 {
		log.Printf("Both channels empty, falling back to mono extraction")
		s.processMonoFromMP3Impl(chunk, useDiarizationFallback)
		return
	}

	// Проверяем на дублированное моно (когда каналы идентичны)
	if areChannelsSimilar(micSamples, sysSamples) {
		log.Printf("Channels are similar (duplicated mono), falling back to mono processing")
		s.processMonoFromMP3Impl(chunk, useDiarizationFallback)
		return
	}

	log.Printf("Loaded samples: mic=%d (%.1fs), sys=%d (%.1fs)",
		len(micSamples), float64(len(micSamples))/16000,
		len(sysSamples), float64(len(sysSamples))/16000)

	// 0. Audio preprocessing: фильтрация для улучшения качества каналов
	// Применяем noise gate, high-pass filter, de-click и нормализацию
	log.Printf("Applying audio filters to channels...")
	micSamples = session.FilterChannelForTranscription(micSamples, 16000)
	sysSamples = session.FilterChannelForTranscription(sysSamples, 16000)

	var micText, sysText string
	var micSegments, sysSegments []ai.TranscriptSegment
	var micErr, sysErr error

	// 1. VAD preprocessing: определяем регионы речи
	// Используем выбранный метод детекции (energy, silero, auto)
	vadMethod := s.getEffectiveVADMethod()
	micRegions := session.DetectSpeechRegionsWithMethod(micSamples, 16000, vadMethod)
	sysRegions := session.DetectSpeechRegionsWithMethod(sysSamples, 16000, vadMethod)

	log.Printf("VAD: mic %d regions, sys %d regions (method: %s)", len(micRegions), len(sysRegions), vadMethod)

	// Определяем использовать ли per-region транскрипцию
	usePerRegion := s.shouldUsePerRegion()
	log.Printf("VAD mode: %s, usePerRegion: %v", s.VADMode, usePerRegion)

	// 2. Transcribe MIC channel - always "Вы" (single speaker, no diarization)
	if len(micRegions) > 0 {
		if usePerRegion {
			// Per-region: транскрибируем каждый регион отдельно
			log.Printf("Transcribing MIC channel (Вы) with per-region: %d regions", len(micRegions))
			micSegments, micErr = s.transcribeRegionsSeparately(micSamples, micRegions, 16000)
		} else {
			// Compression: используем VAD compression (склеиваем регионы)
			micCompressed := session.CompressSpeechFromRegions(micSamples, micRegions, 16000)
			log.Printf("Transcribing MIC channel (Вы) with compression: %d samples (%.1f sec, compressed from %.1f sec)",
				len(micCompressed.CompressedSamples),
				float64(len(micCompressed.CompressedSamples))/16000,
				float64(len(micSamples))/16000)

			micSegments, micErr = s.transcribeWithHybrid(micCompressed.CompressedSamples)
			if micErr == nil {
				// Восстанавливаем оригинальные timestamps
				micSegments = restoreAISegmentTimestamps(micSegments, micCompressed.Regions)
			}
		}

		if micErr != nil {
			log.Printf("MIC transcription error: %v", micErr)
		} else {
			var texts []string
			for _, seg := range micSegments {
				texts = append(texts, seg.Text)
			}
			micText = strings.Join(texts, " ")
			log.Printf("MIC transcription complete: %d chars, %d segments", len(micText), len(micSegments))
		}
	}

	// 3. Transcribe SYS channel WITH DIARIZATION (multiple speakers possible)
	if len(sysRegions) > 0 {
		if usePerRegion {
			// Per-region: транскрибируем каждый регион отдельно
			log.Printf("Transcribing SYS channel with per-region: %d regions", len(sysRegions))
			sysSegments, sysErr = s.transcribeRegionsSeparately(sysSamples, sysRegions, 16000)

			// Применяем диаризацию если включена (на сжатом аудио для экономии ресурсов)
			if sysErr == nil && s.Pipeline != nil && s.Pipeline.IsDiarizationEnabled() {
				log.Printf("Applying diarization to SYS channel (per-region mode)")
				sysSegments = s.applyDiarizationToSegments(sysSamples, sysRegions, sysSegments)
			}
		} else {
			// Compression: используем VAD compression
			sysCompressed := session.CompressSpeechFromRegions(sysSamples, sysRegions, 16000)
			log.Printf("Transcribing SYS channel with compression: %d samples (%.1f sec, compressed from %.1f sec)",
				len(sysCompressed.CompressedSamples),
				float64(len(sysCompressed.CompressedSamples))/16000,
				float64(len(sysSamples))/16000)

			// Проверяем нужна ли диаризация
			diarizationEnabled := s.Pipeline != nil && s.Pipeline.IsDiarizationEnabled()

			// 1. Транскрипция на сжатом аудио (быстрее) - с поддержкой гибридного режима
			sysSegments, sysErr = s.transcribeWithHybrid(sysCompressed.CompressedSamples)
			if sysErr == nil {
				// Восстанавливаем оригинальные timestamps СРАЗУ
				sysSegments = restoreAISegmentTimestamps(sysSegments, sysCompressed.Regions)

				var texts []string
				for _, seg := range sysSegments {
					texts = append(texts, seg.Text)
				}
				sysText = strings.Join(texts, " ")
				log.Printf("SYS transcription complete: %d chars, %d segments", len(sysText), len(sysSegments))
			}

			// 2. Диаризация на ОРИГИНАЛЬНОМ аудио (не сжатом!) - чтобы timestamps совпадали
			if sysErr == nil && diarizationEnabled {
				log.Printf("Running diarization on ORIGINAL SYS audio (%.1f sec) for accurate speaker detection",
					float64(len(sysSamples))/16000)

				diarResult, diarErr := s.Pipeline.DiarizeOnly(sysSamples)
				if diarErr != nil {
					log.Printf("Diarization error: %v, keeping transcription without speakers", diarErr)
				} else if len(diarResult.SpeakerSegments) > 0 {
					log.Printf("Diarization found %d speaker segments, %d unique speakers",
						len(diarResult.SpeakerSegments), diarResult.NumSpeakers)

					// 3. Применяем спикеров к сегментам транскрипции
					sysSegments = applySpeakersToTranscriptSegments(sysSegments, diarResult.SpeakerSegments)
				}
			}
		}

		if sysErr != nil {
			log.Printf("SYS transcription error: %v", sysErr)
		} else {
			if sysText == "" {
				var texts []string
				for _, seg := range sysSegments {
					texts = append(texts, seg.Text)
				}
				sysText = strings.Join(texts, " ")
			}
			log.Printf("SYS transcription complete: %d chars, %d segments", len(sysText), len(sysSegments))
		}
	}

	var finalErr error
	if micErr != nil && sysErr != nil {
		finalErr = fmt.Errorf("mic: %v, sys: %v", micErr, sysErr)
	}

	// 3. Apply global offset and set speakers
	log.Printf("Applying global chunk offset: %d ms to all segments", chunk.StartMs)

	// MIC segments: speaker = "Вы"
	sessionMicSegs := convertSegmentsWithGlobalOffset(micSegments, "Вы", chunk.StartMs)

	// SYS segments: speakers from diarization ("Speaker 0" -> "Собеседник 1", etc.)
	// or "Собеседник" if no diarization
	sessionSysSegs := convertSysSegmentsWithDiarization(sysSegments, chunk.StartMs)

	s.SessionMgr.UpdateChunkStereoWithSegments(chunk.SessionID, chunk.ID, micText, sysText, sessionMicSegs, sessionSysSegs, finalErr)

	log.Printf("Stereo transcription complete for chunk %d", chunk.Index)

	// 4. Автоулучшение через LLM если включено
	if s.AutoImproveWithLLM && s.LLMService != nil && finalErr == nil {
		s.autoImproveChunk(chunk)
	}
}

// transcribeRegionsSeparately транскрибирует каждый VAD регион отдельно
// Это важно для GigaAM, который плохо работает со склеенными регионами (теряет контекст на границах)
// Каждый регион транскрибируется независимо, затем результаты объединяются с правильными timestamps
// Короткие регионы (<2 сек) объединяются с соседними для лучшего контекста
func (s *TranscriptionService) transcribeRegionsSeparately(samples []float32, regions []session.SpeechRegion, sampleRate int) ([]ai.TranscriptSegment, error) {
	if len(regions) == 0 {
		return nil, nil
	}

	// Объединяем короткие регионы для лучшего контекста Whisper
	mergedRegions := mergeShortRegions(regions, 2000, 3000) // minDuration=2s, maxGap=3s

	log.Printf("transcribeRegionsSeparately: %d regions merged to %d groups", len(regions), len(mergedRegions))

	var allSegments []ai.TranscriptSegment

	for i, region := range mergedRegions {
		// Извлекаем семплы для этого региона
		startSample := int(region.StartMs * int64(sampleRate) / 1000)
		endSample := int(region.EndMs * int64(sampleRate) / 1000)

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
		regionDurationMs := region.EndMs - region.StartMs

		log.Printf("  region[%d]: %dms-%dms (duration: %dms, samples: %d)",
			i, region.StartMs, region.EndMs, regionDurationMs, len(regionSamples))

		// Транскрибируем регион (с поддержкой гибридного режима)
		segments, err := s.transcribeWithHybrid(regionSamples)
		if err != nil {
			log.Printf("  region[%d] transcription error: %v", i, err)
			continue
		}

		// Корректируем timestamps: добавляем offset начала региона
		for j := range segments {
			segments[j].Start += region.StartMs
			segments[j].End += region.StartMs

			// Корректируем timestamps для слов
			for k := range segments[j].Words {
				segments[j].Words[k].Start += region.StartMs
				segments[j].Words[k].End += region.StartMs
			}
		}

		log.Printf("  region[%d]: got %d segments, text: %q", i, len(segments), segmentsToText(segments))

		allSegments = append(allSegments, segments...)
	}

	log.Printf("transcribeRegionsSeparately: total %d segments from %d regions", len(allSegments), len(mergedRegions))
	return allSegments, nil
}

// mergeShortRegions объединяет короткие регионы с соседними для лучшего контекста при транскрипции
// minDurationMs - минимальная длина региона (короче будут объединены)
// maxGapMs - максимальный промежуток между регионами для объединения
func mergeShortRegions(regions []session.SpeechRegion, minDurationMs, maxGapMs int64) []session.SpeechRegion {
	if len(regions) <= 1 {
		return regions
	}

	var merged []session.SpeechRegion
	current := regions[0]

	for i := 1; i < len(regions); i++ {
		next := regions[i]
		currentDuration := current.EndMs - current.StartMs
		gap := next.StartMs - current.EndMs

		// Объединяем если:
		// 1. Текущий регион короткий (<minDurationMs) И промежуток небольшой
		// 2. ИЛИ следующий регион короткий И промежуток небольшой
		shouldMerge := (currentDuration < minDurationMs && gap <= maxGapMs) ||
			(next.EndMs-next.StartMs < minDurationMs && gap <= maxGapMs)

		if shouldMerge {
			// Расширяем текущий регион до конца следующего
			current.EndMs = next.EndMs
		} else {
			// Сохраняем текущий и начинаем новый
			merged = append(merged, current)
			current = next
		}
	}

	// Добавляем последний регион
	merged = append(merged, current)

	return merged
}

// segmentsToText объединяет текст из сегментов для логирования
func segmentsToText(segments []ai.TranscriptSegment) string {
	var texts []string
	for _, seg := range segments {
		texts = append(texts, seg.Text)
	}
	return strings.Join(texts, " ")
}

// applyDiarizationToSegments применяет диаризацию к уже готовым сегментам транскрипции
// Используется для per-region режима, где транскрипция уже выполнена
func (s *TranscriptionService) applyDiarizationToSegments(samples []float32, regions []session.SpeechRegion, segments []ai.TranscriptSegment) []ai.TranscriptSegment {
	if s.Pipeline == nil || !s.Pipeline.IsDiarizationEnabled() || len(segments) == 0 {
		return segments
	}

	// Создаём сжатое аудио для диаризации (только регионы речи)
	compressed := session.CompressSpeechFromRegions(samples, regions, 16000)
	if len(compressed.CompressedSamples) == 0 {
		return segments
	}

	log.Printf("applyDiarizationToSegments: running diarization on %d samples", len(compressed.CompressedSamples))

	// Выполняем только диаризацию (без повторной транскрипции)
	result, err := s.pipelineDiarizeOnly(compressed.CompressedSamples, 20*time.Second)
	if err != nil {
		log.Printf("applyDiarizationToSegments: diarization failed: %v", err)
		return segments
	}

	if len(result.SpeakerSegments) == 0 {
		log.Printf("applyDiarizationToSegments: no speaker segments found")
		return segments
	}

	log.Printf("applyDiarizationToSegments: found %d speaker segments, %d speakers",
		len(result.SpeakerSegments), result.NumSpeakers)

	// Применяем спикеров к сегментам транскрипции
	// Нужно учитывать что timestamps сегментов - в оригинальном времени,
	// а speakerSegments - в сжатом времени. Конвертируем.
	updatedSegments := make([]ai.TranscriptSegment, len(segments))
	for i, seg := range segments {
		updatedSegments[i] = seg

		// Конвертируем timestamp сегмента в сжатое время
		compressedStart := session.MapRealTimeToCompressedTime(seg.Start, regions)
		compressedEnd := session.MapRealTimeToCompressedTime(seg.End, regions)

		// Находим спикера с максимальным перекрытием
		speaker := findBestSpeakerForSegment(compressedStart, compressedEnd, result.SpeakerSegments)
		if speaker >= 0 {
			updatedSegments[i].Speaker = fmt.Sprintf("Speaker %d", speaker)
		}
	}

	return updatedSegments
}

// pipelineDiarizeOnly выполняет только диаризацию без транскрипции
func (s *TranscriptionService) pipelineDiarizeOnly(samples []float32, timeout time.Duration) (*ai.PipelineResult, error) {
	type res struct {
		result *ai.PipelineResult
		err    error
	}

	ch := make(chan res, 1)
	go func() {
		r, err := s.Pipeline.DiarizeOnly(samples)
		ch <- res{result: r, err: err}
	}()

	select {
	case out := <-ch:
		return out.result, out.err
	case <-time.After(timeout):
		return nil, fmt.Errorf("diarization timeout after %v", timeout)
	}
}

// findBestSpeakerForSegment находит спикера с максимальным перекрытием для сегмента
func findBestSpeakerForSegment(startMs, endMs int64, speakerSegments []ai.SpeakerSegment) int {
	maxOverlap := float32(0)
	bestSpeaker := -1

	startSec := float32(startMs) / 1000.0
	endSec := float32(endMs) / 1000.0

	for _, seg := range speakerSegments {
		overlapStart := startSec
		if seg.Start > startSec {
			overlapStart = seg.Start
		}
		overlapEnd := endSec
		if seg.End < endSec {
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

// pipelineProcessWithTimeout защищает вызов Pipeline.Process от зависаний нативных библиотек
func (s *TranscriptionService) pipelineProcessWithTimeout(samples []float32, timeout time.Duration) (*ai.PipelineResult, error) {
	type res struct {
		result *ai.PipelineResult
		err    error
	}

	ch := make(chan res, 1)
	go func() {
		r, err := s.Pipeline.Process(samples)
		ch <- res{result: r, err: err}
	}()

	select {
	case out := <-ch:
		return out.result, out.err
	case <-time.After(timeout):
		return nil, fmt.Errorf("pipeline process timeout after %v", timeout)
	}
}

// autoImproveChunk улучшает транскрипцию чанка через LLM
func (s *TranscriptionService) autoImproveChunk(chunk *session.Chunk) {
	// Получаем актуальные данные чанка
	sess, err := s.SessionMgr.GetSession(chunk.SessionID)
	if err != nil {
		log.Printf("Auto-improve: failed to get session: %v", err)
		return
	}

	// Находим чанк с диалогом
	var dialogue []session.TranscriptSegment
	for _, c := range sess.Chunks {
		if c.ID == chunk.ID && len(c.Dialogue) > 0 {
			dialogue = c.Dialogue
			break
		}
	}

	if len(dialogue) == 0 {
		log.Printf("Auto-improve: no dialogue to improve for chunk %d", chunk.Index)
		return
	}

	log.Printf("Auto-improve: improving %d dialogue segments for chunk %d", len(dialogue), chunk.Index)

	improved, err := s.LLMService.ImproveTranscriptionWithLLM(dialogue, s.OllamaModel, s.OllamaURL)
	if err != nil {
		log.Printf("Auto-improve: LLM error: %v", err)
		return
	}

	// Сохраняем улучшенный диалог
	if err := s.SessionMgr.UpdateImprovedDialogue(chunk.SessionID, improved); err != nil {
		log.Printf("Auto-improve: failed to save: %v", err)
		return
	}

	log.Printf("Auto-improve: successfully improved %d -> %d segments for chunk %d",
		len(dialogue), len(improved), chunk.Index)
}

// processMonoFromMP3 extracts mono audio from full.mp3 and transcribes (uses diarization if enabled)
func (s *TranscriptionService) processMonoFromMP3(chunk *session.Chunk) {
	s.processMonoFromMP3Impl(chunk, true)
}

// processMonoFromMP3Impl extracts mono audio from full.mp3 and transcribes with explicit diarization flag
func (s *TranscriptionService) processMonoFromMP3Impl(chunk *session.Chunk, useDiarization bool) {
	// Get session to find MP3 path
	sess, err := s.SessionMgr.GetSession(chunk.SessionID)
	if err != nil {
		log.Printf("Failed to get session: %v", err)
		s.SessionMgr.UpdateChunkTranscription(chunk.SessionID, chunk.ID, "", err)
		return
	}

	mp3Path := filepath.Join(sess.DataDir, "full.mp3")

	// Extract mono segment from MP3 (pure Go, no FFmpeg!)
	log.Printf("Extracting mono segment (pure Go): %s (start=%dms, end=%dms)", mp3Path, chunk.StartMs, chunk.EndMs)
	samples, err := session.ExtractSegmentGo(mp3Path, chunk.StartMs, chunk.EndMs, session.WhisperSampleRate)
	if err != nil {
		log.Printf("Failed to extract segment: %v", err)
		s.SessionMgr.UpdateChunkTranscription(chunk.SessionID, chunk.ID, "", err)
		return
	}

	log.Printf("Transcribing chunk %d: %d samples (%.1f sec), useDiarization=%v", chunk.Index, len(samples), float64(len(samples))/16000, useDiarization)

	// Детальная диагностика состояния диаризации
	pipelineExists := s.Pipeline != nil
	diarizationEnabled := pipelineExists && s.Pipeline.IsDiarizationEnabled()
	log.Printf("Diarization check: useDiarization=%v, pipelineExists=%v, diarizationEnabled=%v",
		useDiarization, pipelineExists, diarizationEnabled)

	// Используем Pipeline если доступен и диаризация запрошена
	if useDiarization && s.Pipeline != nil && s.Pipeline.IsDiarizationEnabled() {
		result, err := s.Pipeline.Process(samples)
		if err != nil {
			log.Printf("Pipeline error for chunk %d: %v", chunk.Index, err)
			s.SessionMgr.UpdateChunkTranscription(chunk.SessionID, chunk.ID, "", err)
			return
		}

		log.Printf("Pipeline complete for chunk %d: %d chars, %d speakers",
			chunk.Index, len(result.FullText), result.NumSpeakers)

		// Применяем гибридную транскрипцию если включена (режим full_compare)
		log.Printf("[Hybrid+Diarization] Checking: IsHybridEnabled=%v, HybridConfig=%v",
			s.IsHybridEnabled(), s.HybridConfig != nil)
		if s.HybridConfig != nil {
			log.Printf("[Hybrid+Diarization] Config: Mode=%s, SecondaryModel=%s, UseLLM=%v, OllamaModel=%s",
				s.HybridConfig.Mode, s.HybridConfig.SecondaryModelID, s.HybridConfig.UseLLMForMerge, s.HybridConfig.OllamaModel)
		}

		if s.IsHybridEnabled() && s.HybridConfig.Mode == ai.HybridModeFullCompare {
			log.Printf("[Hybrid+Diarization] Applying hybrid transcription to pipeline result")
			improvedResult := s.applyHybridToPipelineResult(samples, result)
			if improvedResult != nil {
				result = improvedResult
				log.Printf("[Hybrid+Diarization] Hybrid applied: %d chars", len(result.FullText))
			} else {
				log.Printf("[Hybrid+Diarization] No improvement from hybrid (nil result)")
			}
		} else {
			mode := "nil"
			if s.HybridConfig != nil {
				mode = string(s.HybridConfig.Mode)
			}
			log.Printf("[Hybrid+Diarization] Hybrid NOT applied: IsHybridEnabled=%v, Mode=%s",
				s.IsHybridEnabled(), mode)
		}

		// Конвертируем сегменты с информацией о спикерах
		sessionSegs := convertPipelineSegments(result.Segments, chunk.StartMs)
		s.SessionMgr.UpdateChunkWithDiarizedSegments(chunk.SessionID, chunk.ID, result.FullText, sessionSegs, nil)
		return
	}

	// Fallback: транскрипция с сегментами но без диаризации (спикеров)
	// Это даёт таймкоды и разбивку на предложения
	// Используем гибридную транскрипцию если включена
	segments, err := s.transcribeWithHybrid(samples)
	if err != nil {
		log.Printf("Transcription error for chunk %d: %v", chunk.Index, err)
		s.SessionMgr.UpdateChunkTranscription(chunk.SessionID, chunk.ID, "", err)
		return
	}

	// Собираем полный текст
	var texts []string
	for _, seg := range segments {
		texts = append(texts, seg.Text)
	}
	fullText := strings.Join(texts, " ")

	log.Printf("Transcription complete for chunk %d: %d chars, %d segments (no diarization)",
		chunk.Index, len(fullText), len(segments))

	// Конвертируем сегменты без спикеров (они останутся пустыми)
	sessionSegs := convertPipelineSegments(segments, chunk.StartMs)
	s.SessionMgr.UpdateChunkWithDiarizedSegments(chunk.SessionID, chunk.ID, fullText, sessionSegs, nil)
}

// convertPipelineSegments конвертирует сегменты из pipeline в формат session
func convertPipelineSegments(aiSegs []ai.TranscriptSegment, chunkStartMs int64) []session.TranscriptSegment {
	result := make([]session.TranscriptSegment, len(aiSegs))
	for i, seg := range aiSegs {
		result[i] = session.TranscriptSegment{
			Start:   seg.Start + chunkStartMs,
			End:     seg.End + chunkStartMs,
			Text:    seg.Text,
			Speaker: seg.Speaker, // Speaker уже заполнен из Pipeline
			Words:   convertWordsWithSpeaker(seg.Words, seg.Speaker, chunkStartMs),
		}
	}
	return result
}

// convertWordsWithSpeaker конвертирует слова сохраняя спикера из сегмента
func convertWordsWithSpeaker(aiWords []ai.TranscriptWord, speaker string, chunkStartMs int64) []session.TranscriptWord {
	if len(aiWords) == 0 {
		return nil
	}
	result := make([]session.TranscriptWord, len(aiWords))
	for i, word := range aiWords {
		result[i] = session.TranscriptWord{
			Start:   word.Start + chunkStartMs,
			End:     word.End + chunkStartMs,
			Text:    word.Text,
			P:       word.P,
			Speaker: speaker,
		}
	}
	return result
}

// Helpers

// NOTE: mapSegmentsToRealTime удалена - она ошибочно "расширяла" таймстемпы,
// предполагая что Whisper работает со "сжатым" аудио без пауз.
// На самом деле Whisper получает полное аудио чанка и возвращает правильные таймстемпы.

func convertSegmentsWithGlobalOffset(aiSegs []ai.TranscriptSegment, speaker string, chunkStartMs int64) []session.TranscriptSegment {
	result := make([]session.TranscriptSegment, len(aiSegs))
	for i, seg := range aiSegs {
		result[i] = session.TranscriptSegment{
			Start:   seg.Start + chunkStartMs,
			End:     seg.End + chunkStartMs,
			Text:    seg.Text,
			Speaker: speaker,
			Words:   convertWords(seg.Words, speaker, chunkStartMs),
		}
	}
	return result
}

func convertWords(aiWords []ai.TranscriptWord, speaker string, chunkStartMs int64) []session.TranscriptWord {
	if len(aiWords) == 0 {
		return nil
	}
	result := make([]session.TranscriptWord, len(aiWords))
	for i, word := range aiWords {
		result[i] = session.TranscriptWord{
			Start:   word.Start + chunkStartMs,
			End:     word.End + chunkStartMs,
			Text:    word.Text,
			P:       word.P,
			Speaker: speaker,
		}
	}
	return result
}

// applySpeakersToTranscriptSegments применяет спикеров из диаризации к сегментам транскрипции
// Если сегмент содержит word-level timestamps, разбивает его по границам диаризации
// Timestamps в обоих случаях должны быть в одной системе координат (оригинальное аудио)
func applySpeakersToTranscriptSegments(segments []ai.TranscriptSegment, speakerSegs []ai.SpeakerSegment) []ai.TranscriptSegment {
	if len(speakerSegs) == 0 {
		log.Printf("applySpeakersToTranscriptSegments: no speaker segments, returning original")
		return segments
	}

	// Логируем для отладки
	speakerSet := make(map[int]bool)
	for _, ss := range speakerSegs {
		speakerSet[ss.Speaker] = true
	}
	log.Printf("applySpeakersToTranscriptSegments: %d transcript segments, %d speaker segments, %d unique speakers",
		len(segments), len(speakerSegs), len(speakerSet))

	// Логируем первые несколько speaker segments для отладки
	for i, ss := range speakerSegs {
		if i < 5 {
			log.Printf("  SpeakerSeg[%d]: speaker=%d, start=%.2f, end=%.2f", i, ss.Speaker, ss.Start, ss.End)
		}
	}

	// Проверяем, есть ли word-level timestamps
	hasWords := false
	for _, seg := range segments {
		if len(seg.Words) > 0 {
			hasWords = true
			break
		}
	}

	// Если есть word-level timestamps, разбиваем сегменты по границам диаризации
	if hasWords {
		return splitSegmentsBySpeakers(segments, speakerSegs)
	}

	// Fallback: простое присвоение спикера целому сегменту
	return assignSpeakersToSegments(segments, speakerSegs)
}

// splitSegmentsBySpeakers разбивает сегменты транскрипции по границам диаризации
// используя word-level timestamps для точного разделения
func splitSegmentsBySpeakers(segments []ai.TranscriptSegment, speakerSegs []ai.SpeakerSegment) []ai.TranscriptSegment {
	var result []ai.TranscriptSegment

	for _, seg := range segments {
		if len(seg.Words) == 0 {
			// Нет слов - присваиваем спикера целому сегменту
			newSeg := seg
			newSeg.Speaker = getSpeakerForTimeRange(float32(seg.Start)/1000.0, float32(seg.End)/1000.0, speakerSegs)
			result = append(result, newSeg)
			continue
		}

		// Группируем слова по спикерам
		var currentWords []ai.TranscriptWord
		var currentSpeaker string
		var segStart, segEnd int64

		for i, word := range seg.Words {
			wordStartSec := float32(word.Start) / 1000.0
			wordEndSec := float32(word.End) / 1000.0
			wordSpeaker := getSpeakerForTimeRange(wordStartSec, wordEndSec, speakerSegs)

			if i == 0 {
				// Первое слово
				currentSpeaker = wordSpeaker
				currentWords = []ai.TranscriptWord{word}
				segStart = word.Start
				segEnd = word.End
				continue
			}

			if wordSpeaker == currentSpeaker {
				// Тот же спикер - добавляем слово
				currentWords = append(currentWords, word)
				segEnd = word.End
			} else {
				// Смена спикера - сохраняем текущий сегмент и начинаем новый
				if len(currentWords) > 0 {
					newSeg := createSegmentFromWords(currentWords, currentSpeaker, segStart, segEnd)
					result = append(result, newSeg)
				}

				// Начинаем новый сегмент
				currentSpeaker = wordSpeaker
				currentWords = []ai.TranscriptWord{word}
				segStart = word.Start
				segEnd = word.End
			}
		}

		// Сохраняем последний сегмент
		if len(currentWords) > 0 {
			newSeg := createSegmentFromWords(currentWords, currentSpeaker, segStart, segEnd)
			result = append(result, newSeg)
		}
	}

	log.Printf("splitSegmentsBySpeakers: split %d segments into %d segments by speaker boundaries",
		len(segments), len(result))

	return result
}

// createSegmentFromWords создаёт сегмент транскрипции из списка слов
func createSegmentFromWords(words []ai.TranscriptWord, speaker string, start, end int64) ai.TranscriptSegment {
	var texts []string
	for _, w := range words {
		texts = append(texts, w.Text)
	}

	return ai.TranscriptSegment{
		Start:   start,
		End:     end,
		Text:    strings.Join(texts, " "),
		Speaker: speaker,
		Words:   words,
	}
}

// getSpeakerForTimeRange находит спикера для заданного временного диапазона
// Возвращает спикера с максимальным перекрытием или ближайшего по времени
func getSpeakerForTimeRange(startSec, endSec float32, speakerSegs []ai.SpeakerSegment) string {
	midSec := (startSec + endSec) / 2.0

	// Ищем спикера с максимальным перекрытием
	bestSpeaker := -1
	bestOverlap := float32(0)

	for _, ss := range speakerSegs {
		// Вычисляем перекрытие
		overlapStart := startSec
		if ss.Start > overlapStart {
			overlapStart = ss.Start
		}
		overlapEnd := endSec
		if ss.End < overlapEnd {
			overlapEnd = ss.End
		}
		overlap := overlapEnd - overlapStart
		if overlap > 0 && overlap > bestOverlap {
			bestOverlap = overlap
			bestSpeaker = ss.Speaker
		}
	}

	// Если нет перекрытия, ищем ближайшего спикера по середине
	if bestSpeaker == -1 {
		minDist := float32(1e9)
		for _, ss := range speakerSegs {
			ssMid := (ss.Start + ss.End) / 2.0
			dist := midSec - ssMid
			if dist < 0 {
				dist = -dist
			}
			if dist < minDist {
				minDist = dist
				bestSpeaker = ss.Speaker
			}
		}
	}

	if bestSpeaker >= 0 {
		return fmt.Sprintf("Собеседник %d", bestSpeaker)
	}
	return "Собеседник"
}

// assignSpeakersToSegments присваивает спикеров сегментам без разбиения (fallback)
func assignSpeakersToSegments(segments []ai.TranscriptSegment, speakerSegs []ai.SpeakerSegment) []ai.TranscriptSegment {
	result := make([]ai.TranscriptSegment, len(segments))
	copy(result, segments)

	for i := range result {
		segStartSec := float32(result[i].Start) / 1000.0
		segEndSec := float32(result[i].End) / 1000.0
		result[i].Speaker = getSpeakerForTimeRange(segStartSec, segEndSec, speakerSegs)
	}

	return result
}

// convertSysSegmentsWithDiarization converts SYS channel segments with speaker labels
// "Speaker 0" -> "Собеседник 1", "Speaker 1" -> "Собеседник 2", etc.
// If no diarization speaker, defaults to "Собеседник"
func convertSysSegmentsWithDiarization(aiSegs []ai.TranscriptSegment, chunkStartMs int64) []session.TranscriptSegment {
	result := make([]session.TranscriptSegment, len(aiSegs))
	for i, seg := range aiSegs {
		speaker := seg.Speaker
		if speaker == "" {
			speaker = "Собеседник"
		} else if strings.HasPrefix(speaker, "Speaker ") {
			// "Speaker 0" -> "Собеседник 1", "Speaker 1" -> "Собеседник 2"
			numStr := strings.TrimPrefix(speaker, "Speaker ")
			if num, err := strconv.Atoi(numStr); err == nil {
				speaker = fmt.Sprintf("Собеседник %d", num+1)
			}
		}

		result[i] = session.TranscriptSegment{
			Start:   seg.Start + chunkStartMs,
			End:     seg.End + chunkStartMs,
			Text:    seg.Text,
			Speaker: speaker,
			Words:   convertWords(seg.Words, speaker, chunkStartMs),
		}
	}
	return result
}

// areChannelsSimilar проверяет, являются ли два канала идентичными (или очень похожими)
// Используется для детектирования "фейкового" стерео (дублированного моно)
//
// Улучшенный алгоритм: проверяет относительную разницу амплитуд,
// чтобы избежать ложного срабатывания когда один канал - тишина (0), а второй - тихая речь.
func areChannelsSimilar(c1, c2 []float32) bool {
	if len(c1) != len(c2) {
		return false
	}
	if len(c1) == 0 {
		return true
	}

	// Проверяем весь буфер (обычно 30 секунд), чтобы избежать ошибки "первых 5 секунд тишины"
	checkLen := len(c1)

	var sumDiff float64
	var sumAmp float64

	for i := 0; i < checkLen; i++ {
		val1 := float64(c1[i])
		val2 := float64(c2[i])
		sumDiff += math.Abs(val1 - val2)
		sumAmp += math.Abs(val1) + math.Abs(val2)
	}

	// 1. Если суммарная амплитуда очень мала (тишина в обоих каналах), считаем одинаковыми
	// Порог 0.01 для 30 секунд - это очень тихо.
	if sumAmp < 0.01 {
		return true
	}

	// 2. Относительная разница
	// diffRatio = sumDiff / sumAmp
	// Если каналы идентичны: sumDiff = 0 -> ratio = 0
	// Если каналы разные (один тишина): sumDiff = sumAmp -> ratio = 1
	// Если каналы разные (шум): ratio > 0.1
	diffRatio := sumDiff / sumAmp

	// Если относительная разница меньше 10%, считаем каналы одинаковыми (дублированное моно)
	return diffRatio < 0.1
}

// readWAVFile reads a WAV file and returns float32 samples (kept for compatibility)
func readWAVFile(path string) ([]float32, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Skip header (simple optimization, real implementation should parse header)
	// Assuming 44 header bytes for standard WAV
	if _, err := f.Seek(44, 0); err != nil {
		return nil, err
	}

	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}

	size := stat.Size() - 44
	samplesCount := size / 2 // 16-bit
	samples := make([]float32, samplesCount)

	// Read buffer
	buf := make([]byte, size)
	// Use ReadFull to ensure we read everything
	if _, err := io.ReadFull(f, buf); err != nil {
		return nil, err
	}

	// Convert 16-bit PCM to float32
	for i := 0; i < int(samplesCount); i++ {
		sample16 := int16(binary.LittleEndian.Uint16(buf[i*2 : i*2+2]))
		samples[i] = float32(sample16) / 32768.0
	}

	return samples, nil
}

// restoreAISegmentTimestamps восстанавливает оригинальные timestamps для ai.TranscriptSegment
// после транскрипции сжатого аудио (с удалённой тишиной)
func restoreAISegmentTimestamps(segments []ai.TranscriptSegment, regions []session.SpeechRegion) []ai.TranscriptSegment {
	if len(regions) == 0 {
		return segments
	}

	restored := make([]ai.TranscriptSegment, len(segments))
	for i, seg := range segments {
		restored[i] = ai.TranscriptSegment{
			Start:   session.MapWhisperTimeToRealTime(seg.Start, regions),
			End:     session.MapWhisperTimeToRealTime(seg.End, regions),
			Text:    seg.Text,
			Speaker: seg.Speaker,
		}

		// Восстанавливаем timestamps для слов
		if len(seg.Words) > 0 {
			restored[i].Words = make([]ai.TranscriptWord, len(seg.Words))
			for j, word := range seg.Words {
				restored[i].Words[j] = ai.TranscriptWord{
					Start: session.MapWhisperTimeToRealTime(word.Start, regions),
					End:   session.MapWhisperTimeToRealTime(word.End, regions),
					Text:  word.Text,
					P:     word.P,
				}
			}
		}
	}

	return restored
}
