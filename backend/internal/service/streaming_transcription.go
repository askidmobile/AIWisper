package service

import (
	"aiwisper/ai"
	"aiwisper/models"
	"log"
	"sync"
	"time"
)

// StreamingTranscriptionService управляет real-time streaming транскрипцией
type StreamingTranscriptionService struct {
	modelMgr *models.Manager
	engine   *ai.StreamingFluidASREngine
	mu       sync.Mutex
	isActive bool

	// Callback для отправки обновлений в UI
	OnUpdate func(update StreamingTranscriptionUpdate)
}

// StreamingTranscriptionUpdate обновление транскрипции для UI
type StreamingTranscriptionUpdate struct {
	Text        string
	IsConfirmed bool
	Confidence  float32
	Timestamp   time.Time
}

// NewStreamingTranscriptionService создаёт новый сервис
func NewStreamingTranscriptionService(modelMgr *models.Manager) *StreamingTranscriptionService {
	return &StreamingTranscriptionService{
		modelMgr: modelMgr,
	}
}

// Start запускает streaming транскрипцию
func (s *StreamingTranscriptionService) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.isActive {
		return nil // Уже запущен
	}

	// Создаём streaming engine
	config := ai.StreamingFluidASRConfig{
		ModelCacheDir:         s.modelMgr.GetModelsDir(),
		ChunkSeconds:          15.0,
		ConfirmationThreshold: 0.85,
	}

	engine, err := ai.NewStreamingFluidASREngine(config)
	if err != nil {
		return err
	}

	// Устанавливаем callback
	engine.SetUpdateCallback(func(update ai.StreamingTranscriptionUpdate) {
		if s.OnUpdate != nil {
			s.OnUpdate(StreamingTranscriptionUpdate{
				Text:        update.Text,
				IsConfirmed: update.IsConfirmed,
				Confidence:  update.Confidence,
				Timestamp:   update.Timestamp,
			})
		}
	})

	// Устанавливаем error callback
	engine.SetErrorCallback(func(err error) {
		log.Printf("StreamingTranscriptionService: error: %v", err)
	})

	s.engine = engine
	s.isActive = true

	log.Printf("StreamingTranscriptionService: started")
	return nil
}

// StreamAudio отправляет аудио чанк для обработки
func (s *StreamingTranscriptionService) StreamAudio(samples []float32) error {
	s.mu.Lock()
	engine := s.engine
	s.mu.Unlock()

	if engine == nil {
		return nil // Не активен, пропускаем
	}

	return engine.StreamAudio(samples)
}

// Finish завершает streaming и возвращает финальный текст
func (s *StreamingTranscriptionService) Finish() (string, error) {
	s.mu.Lock()
	engine := s.engine
	s.mu.Unlock()

	if engine == nil {
		return "", nil
	}

	return engine.Finish()
}

// Reset сбрасывает состояние для новой сессии
func (s *StreamingTranscriptionService) Reset() error {
	s.mu.Lock()
	engine := s.engine
	s.mu.Unlock()

	if engine == nil {
		return nil
	}

	return engine.Reset()
}

// Stop останавливает streaming транскрипцию
func (s *StreamingTranscriptionService) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.isActive {
		return nil
	}

	if s.engine != nil {
		s.engine.Close()
		s.engine = nil
	}

	s.isActive = false
	log.Printf("StreamingTranscriptionService: stopped")
	return nil
}

// IsActive возвращает true если streaming активен
func (s *StreamingTranscriptionService) IsActive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.isActive
}
