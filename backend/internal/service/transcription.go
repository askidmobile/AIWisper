package service

import (
	"aiwisper/ai"
	"aiwisper/session"
	"encoding/binary"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// TranscriptionService handles the core transcription logic
type TranscriptionService struct {
	SessionMgr *session.Manager
	EngineMgr  *ai.EngineManager
	Pipeline   *ai.AudioPipeline // Опционально: пайплайн с диаризацией
	// Callbacks for UI updates
	OnChunkTranscribed func(chunk *session.Chunk)
}

func NewTranscriptionService(sessionMgr *session.Manager, engineMgr *ai.EngineManager) *TranscriptionService {
	return &TranscriptionService{
		SessionMgr: sessionMgr,
		EngineMgr:  engineMgr,
	}
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

// HandleChunk processes a new audio chunk: VAD, transcription, mapping
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

		if chunk.IsStereo {
			s.processStereoFromMP3(chunk)
		} else {
			s.processMonoFromMP3(chunk)
		}
	}()
}

// processStereoFromMP3 extracts stereo channels from full.mp3 and transcribes separately
func (s *TranscriptionService) processStereoFromMP3(chunk *session.Chunk) {
	// Get session to find MP3 path
	sess, err := s.SessionMgr.GetSession(chunk.SessionID)
	if err != nil {
		log.Printf("Failed to get session: %v", err)
		s.SessionMgr.UpdateChunkStereoWithSegments(chunk.SessionID, chunk.ID, "", "", nil, nil, err)
		return
	}

	mp3Path := filepath.Join(sess.DataDir, "full.mp3")

	// Extract stereo channels from MP3
	log.Printf("Extracting stereo segment from MP3: %s (start=%dms, end=%dms)", mp3Path, chunk.StartMs, chunk.EndMs)
	micSamples, sysSamples, err := session.ExtractSegmentStereo(mp3Path, chunk.StartMs, chunk.EndMs, session.WhisperSampleRate)
	if err != nil {
		log.Printf("Failed to extract stereo segment: %v", err)
		s.SessionMgr.UpdateChunkStereoWithSegments(chunk.SessionID, chunk.ID, "", "", nil, nil, err)
		return
	}

	log.Printf("Extracted: mic=%d samples (%.1fs), sys=%d samples (%.1fs)",
		len(micSamples), float64(len(micSamples))/16000,
		len(sysSamples), float64(len(sysSamples))/16000)

	var micText, sysText string
	var micSegments, sysSegments []ai.TranscriptSegment
	var micErr, sysErr error

	// VAD processing
	var micRegions, sysRegions []session.SpeechRegion
	if len(micSamples) > 0 {
		micRegions = session.DetectSpeechRegions(micSamples, session.WhisperSampleRate)
		log.Printf("VAD: Mic has %d speech regions", len(micRegions))
	}
	if len(sysSamples) > 0 {
		sysRegions = session.DetectSpeechRegions(sysSamples, session.WhisperSampleRate)
		log.Printf("VAD: Sys has %d speech regions", len(sysRegions))
	}

	// Transcribe Mic FIRST (sequential - Whisper doesn't support parallel)
	if len(micSamples) > 0 {
		log.Printf("Transcribing mic channel: %d samples (%.1f sec)", len(micSamples), float64(len(micSamples))/16000)
		micSegments, micErr = s.EngineMgr.TranscribeWithSegments(micSamples)
		if micErr != nil {
			log.Printf("Mic transcription error: %v", micErr)
		} else {
			micSegments = mapSegmentsToRealTime(micSegments, micRegions)
			var texts []string
			for _, seg := range micSegments {
				texts = append(texts, seg.Text)
			}
			micText = strings.Join(texts, " ")
			log.Printf("Mic transcription complete: %d chars, %d segments", len(micText), len(micSegments))
		}
	}

	// Transcribe Sys SECOND (sequential)
	if len(sysSamples) > 0 {
		log.Printf("Transcribing sys channel: %d samples (%.1f sec)", len(sysSamples), float64(len(sysSamples))/16000)
		sysSegments, sysErr = s.EngineMgr.TranscribeWithSegments(sysSamples)
		if sysErr != nil {
			log.Printf("Sys transcription error: %v", sysErr)
		} else {
			sysSegments = mapSegmentsToRealTime(sysSegments, sysRegions)
			var texts []string
			for _, seg := range sysSegments {
				texts = append(texts, seg.Text)
			}
			sysText = strings.Join(texts, " ")
			log.Printf("Sys transcription complete: %d chars, %d segments", len(sysText), len(sysSegments))
		}
	}

	var finalErr error
	if micErr != nil && sysErr != nil {
		finalErr = fmt.Errorf("mic: %v, sys: %v", micErr, sysErr)
	}

	log.Printf("Applying global chunk offset: %d ms to all segments", chunk.StartMs)
	sessionMicSegs := convertSegmentsWithGlobalOffset(micSegments, "mic", chunk.StartMs)
	sessionSysSegs := convertSegmentsWithGlobalOffset(sysSegments, "sys", chunk.StartMs)

	s.SessionMgr.UpdateChunkStereoWithSegments(chunk.SessionID, chunk.ID, micText, sysText, sessionMicSegs, sessionSysSegs, finalErr)

	log.Printf("Transcription complete for chunk %d", chunk.Index)
}

// processMonoFromMP3 extracts mono audio from full.mp3 and transcribes
func (s *TranscriptionService) processMonoFromMP3(chunk *session.Chunk) {
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

	log.Printf("Transcribing chunk %d: %d samples (%.1f sec)", chunk.Index, len(samples), float64(len(samples))/16000)

	// Используем Pipeline если доступен (с диаризацией)
	if s.Pipeline != nil && s.Pipeline.IsDiarizationEnabled() {
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

func mapSegmentsToRealTime(segments []ai.TranscriptSegment, regions []session.SpeechRegion) []ai.TranscriptSegment {
	if len(segments) == 0 || len(regions) == 0 {
		return segments
	}

	whisperStarts := make([]int64, len(segments))
	for i, seg := range segments {
		whisperStarts[i] = seg.Start
	}

	realStarts := session.MapWhisperSegmentsToRealTime(whisperStarts, regions)

	for i := range segments {
		duration := segments[i].End - segments[i].Start
		segments[i].Start = realStarts[i]
		segments[i].End = realStarts[i] + duration

		for j := range segments[i].Words {
			wordDuration := segments[i].Words[j].End - segments[i].Words[j].Start
			segments[i].Words[j].Start = session.MapWhisperTimeToRealTime(segments[i].Words[j].Start, regions)
			segments[i].Words[j].End = segments[i].Words[j].Start + wordDuration
		}
	}
	return segments
}

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
	if _, err := f.Read(buf); err != nil {
		return nil, err
	}

	// Convert 16-bit PCM to float32
	for i := 0; i < int(samplesCount); i++ {
		sample16 := int16(binary.LittleEndian.Uint16(buf[i*2 : i*2+2]))
		samples[i] = float32(sample16) / 32768.0
	}

	return samples, nil
}
