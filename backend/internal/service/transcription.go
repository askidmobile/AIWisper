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
)

// TranscriptionService handles the core transcription logic
type TranscriptionService struct {
	SessionMgr *session.Manager
	EngineMgr  *ai.EngineManager
	Pipeline   *ai.AudioPipeline // Опционально: пайплайн с диаризацией

	// LLM для автоматического улучшения транскрипции
	LLMService         *LLMService
	AutoImproveWithLLM bool   // Автоматически улучшать через LLM после транскрипции
	OllamaURL          string // URL Ollama API
	OllamaModel        string // Модель для улучшения

	// Callbacks for UI updates
	OnChunkTranscribed func(chunk *session.Chunk)
}

func NewTranscriptionService(sessionMgr *session.Manager, engineMgr *ai.EngineManager) *TranscriptionService {
	return &TranscriptionService{
		SessionMgr:  sessionMgr,
		EngineMgr:   engineMgr,
		OllamaURL:   "http://localhost:11434",
		OllamaModel: "llama3.2",
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
		Provider:              provider, // "auto" = автоопределение
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
	log.Printf("Diarization enabled: provider=%s, segmentation=%s, embedding=%s",
		actualProvider, segmentationPath, embeddingPath)
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
	// Get session to find MP3 path
	sess, err := s.SessionMgr.GetSession(chunk.SessionID)
	if err != nil {
		log.Printf("Failed to get session: %v", err)
		s.SessionMgr.UpdateChunkStereoWithSegments(chunk.SessionID, chunk.ID, "", "", nil, nil, err)
		return
	}

	mp3Path := filepath.Join(sess.DataDir, "full.mp3")

	// Create temp files for channel extraction
	micWav := filepath.Join(os.TempDir(), fmt.Sprintf("mic_%s_%s.wav", chunk.SessionID, chunk.ID))
	sysWav := filepath.Join(os.TempDir(), fmt.Sprintf("sys_%s_%s.wav", chunk.SessionID, chunk.ID))

	// Ensure cleanup
	defer func() {
		os.Remove(micWav)
		os.Remove(sysWav)
	}()

	log.Printf("Extracting stereo segment to WAV files: %s (start=%dms, end=%dms)", mp3Path, chunk.StartMs, chunk.EndMs)

	// Extract Left (Mic)
	if err := session.ExtractChannelToWAV(mp3Path, micWav, 0, chunk.StartMs, chunk.EndMs); err != nil {
		log.Printf("Failed to extract mic channel: %v, falling back to mono", err)
		s.processMonoFromMP3Impl(chunk, useDiarizationFallback)
		return
	}

	// Extract Right (Sys)
	if err := session.ExtractChannelToWAV(mp3Path, sysWav, 1, chunk.StartMs, chunk.EndMs); err != nil {
		log.Printf("Failed to extract sys channel: %v, falling back to mono", err)
		s.processMonoFromMP3Impl(chunk, useDiarizationFallback)
		return
	}

	// Read files back to memory
	micSamples, err := readWAVFile(micWav)
	if err != nil {
		log.Printf("Failed to read mic wav: %v", err)
		s.processMonoFromMP3Impl(chunk, useDiarizationFallback)
		return
	}

	sysSamples, err := readWAVFile(sysWav)
	if err != nil {
		log.Printf("Failed to read sys wav: %v", err)
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

	var micText, sysText string
	var micSegments, sysSegments []ai.TranscriptSegment
	var micErr, sysErr error

	// 1. VAD preprocessing: сжимаем аудио, удаляя тишину
	micCompressed := session.CompressSpeech(micSamples, 16000)
	sysCompressed := session.CompressSpeech(sysSamples, 16000)

	log.Printf("VAD compression: mic %.1f%% speech, sys %.1f%% speech",
		float64(micCompressed.TotalSpeechMs)*100/float64(max(micCompressed.OriginalDurationMs, 1)),
		float64(sysCompressed.TotalSpeechMs)*100/float64(max(sysCompressed.OriginalDurationMs, 1)))

	// 2. Transcribe MIC channel - always "Вы" (single speaker, no diarization)
	if len(micCompressed.CompressedSamples) > 0 {
		log.Printf("Transcribing MIC channel (Вы): %d samples (%.1f sec, compressed from %.1f sec)",
			len(micCompressed.CompressedSamples),
			float64(len(micCompressed.CompressedSamples))/16000,
			float64(len(micSamples))/16000)

		micSegments, micErr = s.EngineMgr.TranscribeWithSegments(micCompressed.CompressedSamples)
		if micErr != nil {
			log.Printf("MIC transcription error: %v", micErr)
		} else {
			// Восстанавливаем оригинальные timestamps
			micSegments = restoreAISegmentTimestamps(micSegments, micCompressed.Regions)

			var texts []string
			for _, seg := range micSegments {
				texts = append(texts, seg.Text)
			}
			micText = strings.Join(texts, " ")
			log.Printf("MIC transcription complete: %d chars, %d segments", len(micText), len(micSegments))
		}
	}

	// 3. Transcribe SYS channel WITH DIARIZATION (multiple speakers possible)
	if len(sysCompressed.CompressedSamples) > 0 {
		log.Printf("Transcribing SYS channel with diarization: %d samples (%.1f sec, compressed from %.1f sec)",
			len(sysCompressed.CompressedSamples),
			float64(len(sysCompressed.CompressedSamples))/16000,
			float64(len(sysSamples))/16000)

		// Try to use Pipeline with diarization if available
		if s.Pipeline != nil && s.Pipeline.IsDiarizationEnabled() {
			log.Printf("Using Pipeline with diarization for SYS channel")
			result, err := s.Pipeline.Process(sysCompressed.CompressedSamples)
			if err != nil {
				log.Printf("Pipeline diarization error: %v, falling back to simple transcription", err)
				sysSegments, sysErr = s.EngineMgr.TranscribeWithSegments(sysCompressed.CompressedSamples)
			} else {
				sysSegments = result.Segments
				sysText = result.FullText
				log.Printf("SYS diarization complete: %d chars, %d segments, %d speakers",
					len(sysText), len(sysSegments), result.NumSpeakers)
			}
		} else {
			// Fallback: simple transcription without diarization
			log.Printf("Diarization not enabled, using simple transcription for SYS")
			sysSegments, sysErr = s.EngineMgr.TranscribeWithSegments(sysCompressed.CompressedSamples)
		}

		if sysErr != nil {
			log.Printf("SYS transcription error: %v", sysErr)
		} else {
			// Восстанавливаем оригинальные timestamps
			sysSegments = restoreAISegmentTimestamps(sysSegments, sysCompressed.Regions)

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

	// Extract mono segment from MP3
	log.Printf("Extracting mono segment from MP3: %s (start=%dms, end=%dms)", mp3Path, chunk.StartMs, chunk.EndMs)
	samples, err := session.ExtractSegment(mp3Path, chunk.StartMs, chunk.EndMs, session.WhisperSampleRate)
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

		// Конвертируем сегменты с информацией о спикерах
		sessionSegs := convertPipelineSegments(result.Segments, chunk.StartMs)
		s.SessionMgr.UpdateChunkWithDiarizedSegments(chunk.SessionID, chunk.ID, result.FullText, sessionSegs, nil)
		return
	}

	// Fallback: обычная транскрипция без диаризации
	text, err := s.EngineMgr.Transcribe(samples, false)
	if err != nil {
		log.Printf("Transcription error for chunk %d: %v", chunk.Index, err)
		s.SessionMgr.UpdateChunkTranscription(chunk.SessionID, chunk.ID, "", err)
		return
	}

	log.Printf("Transcription complete for chunk %d: %d chars", chunk.Index, len(text))
	s.SessionMgr.UpdateChunkTranscription(chunk.SessionID, chunk.ID, text, nil)
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
