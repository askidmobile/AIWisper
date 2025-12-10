package api

import (
	"aiwisper/ai"
	"aiwisper/audio"
	"aiwisper/internal/config"
	"aiwisper/internal/service"
	"aiwisper/models"
	"aiwisper/session"
	"aiwisper/voiceprint"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type sendFunc func(Message) error

type transportClient interface {
	Send(Message) error
	Close() error
}

type wsClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *wsClient) Send(msg Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(msg)
}

func (c *wsClient) Close() error {
	return c.conn.Close()
}

type grpcClient struct {
	stream Control_StreamServer
	mu     sync.Mutex
}

func (c *grpcClient) Send(msg Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stream.Send(&msg)
}

func (c *grpcClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	// gRPC поток закрывается на стороне клиента или через контекст
	return nil
}

type Server struct {
	Config               *config.Config
	SessionMgr           *session.Manager
	EngineMgr            *ai.EngineManager
	ModelMgr             *models.Manager
	Capture              *audio.Capture
	TranscriptionService *service.TranscriptionService
	RecordingService     *service.RecordingService
	LLMService           *service.LLMService
	VoicePrintStore      *voiceprint.Store   // Хранилище голосовых отпечатков
	VoicePrintMatcher    *voiceprint.Matcher // Matcher для поиска совпадений

	clients map[transportClient]bool
	mu      sync.Mutex

	// Отмена полной ретранскрипции по sessionID
	retranscribeCancels   map[string]func()
	retranscribeCancelsMu sync.Mutex
}

func NewServer(
	cfg *config.Config,
	sessMgr *session.Manager,
	engMgr *ai.EngineManager,
	modMgr *models.Manager,
	cap *audio.Capture,
	transSvc *service.TranscriptionService,
	recSvc *service.RecordingService,
	llmSvc *service.LLMService,
	vpStore *voiceprint.Store,
	vpMatcher *voiceprint.Matcher,
) *Server {
	s := &Server{
		Config:               cfg,
		SessionMgr:           sessMgr,
		EngineMgr:            engMgr,
		ModelMgr:             modMgr,
		Capture:              cap,
		TranscriptionService: transSvc,
		RecordingService:     recSvc,
		LLMService:           llmSvc,
		VoicePrintStore:      vpStore,
		VoicePrintMatcher:    vpMatcher,
		clients:              make(map[transportClient]bool),
		retranscribeCancels:  make(map[string]func()),
	}
	s.setupCallbacks()
	return s
}

func (s *Server) Start() {
	go s.startGRPCServer()

	http.HandleFunc("/ws", s.handleWebSocket)
	http.HandleFunc("/api/sessions/", s.handleSessionsAPI)

	log.Printf("Backend listening on HTTP :%s and gRPC %s", s.Config.Port, s.Config.GRPCAddr)
	if err := http.ListenAndServe(":"+s.Config.Port, nil); err != nil {
		log.Fatal("ListenAndServe:", err)
	}
}

func (s *Server) setupCallbacks() {
	// Model Progress
	s.ModelMgr.SetProgressCallback(func(modelID string, progress float64, status models.ModelStatus, err error) {
		errStr := ""
		if err != nil {
			errStr = err.Error()
		}
		s.broadcast(Message{
			Type:     "model_progress",
			ModelID:  modelID,
			Progress: progress,
			Data:     string(status),
			Error:    errStr,
		})
	})

	// Audio Levels from Recording Service
	if s.RecordingService != nil {
		s.RecordingService.OnAudioLevel = func(micLevel, sysLevel float64) {
			s.broadcast(Message{
				Type:        "audio_level",
				MicLevel:    micLevel,
				SystemLevel: sysLevel,
			})
		}
	}

	// Chunk Ready -> Notify & Transcribe
	s.SessionMgr.SetOnChunkReady(func(chunk *session.Chunk) {
		// 1. Notify Frontend
		s.broadcast(Message{
			Type:      "chunk_created",
			SessionID: chunk.SessionID,
			Chunk:     chunk,
		})

		// 2. Transcribe
		if s.TranscriptionService != nil {
			s.TranscriptionService.HandleChunk(chunk)
		}
	})

	// Chunk Transcribed -> Notify
	s.SessionMgr.SetOnChunkTranscribed(func(chunk *session.Chunk) {
		log.Printf("Sending transcription result for chunk %d to frontend", chunk.Index)
		s.broadcast(Message{
			Type:      "chunk_transcribed",
			SessionID: chunk.SessionID,
			Chunk:     chunk,
		})
	})
}

func (s *Server) broadcast(msg Message) {
	s.mu.Lock()
	if len(s.clients) == 0 {
		s.mu.Unlock()
		return
	}
	targets := make([]transportClient, 0, len(s.clients))
	for c := range s.clients {
		targets = append(targets, c)
	}
	s.mu.Unlock()

	for _, c := range targets {
		if err := c.Send(msg); err != nil {
			log.Printf("Send error: %v", err)
			s.removeClient(c)
		}
	}
}

func (s *Server) addClient(c transportClient) {
	s.mu.Lock()
	s.clients[c] = true
	s.mu.Unlock()
}

func (s *Server) removeClient(c transportClient) {
	s.mu.Lock()
	if _, ok := s.clients[c]; ok {
		delete(s.clients, c)
	}
	s.mu.Unlock()
	_ = c.Close()
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade:", err)
		return
	}

	client := &wsClient{conn: conn}
	s.addClient(client)

	defer func() {
		s.removeClient(client)
	}()

	for {
		var msg Message
		err := conn.ReadJSON(&msg)
		if err != nil {
			log.Println("Read:", err)
			break
		}
		s.processMessage(client.Send, msg)
	}
}

// Stream реализует gRPC bidirectional поток, повторяя поведение WebSocket.
func (s *Server) Stream(stream Control_StreamServer) error {
	client := &grpcClient{stream: stream}
	s.addClient(client)
	defer s.removeClient(client)

	for {
		msg, err := stream.Recv()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			log.Printf("gRPC recv error: %v", err)
			return err
		}
		if msg == nil {
			continue
		}
		s.processMessage(client.Send, *msg)
	}
}

func (s *Server) processMessage(send sendFunc, msg Message) {
	switch msg.Type {
	case "get_devices":
		devices, err := s.Capture.ListDevices()
		if err != nil {
			send(Message{Type: "error", Data: err.Error()})
			return
		}
		send(Message{
			Type:                      "devices",
			Devices:                   devices,
			ScreenCaptureKitAvailable: audio.ScreenCaptureKitAvailable(),
		})

	case "get_models":
		modelStates := s.ModelMgr.GetAllModelsState()
		send(Message{
			Type:   "models_list",
			Models: modelStates,
		})

	case "download_model":
		if msg.ModelID == "" {
			send(Message{Type: "error", Data: "modelId is required"})
			return
		}
		if err := s.ModelMgr.DownloadModel(msg.ModelID); err != nil {
			send(Message{Type: "error", Data: err.Error()})
			return
		}
		send(Message{Type: "download_started", ModelID: msg.ModelID})

	case "cancel_download":
		if msg.ModelID == "" {
			send(Message{Type: "error", Data: "modelId is required"})
			return
		}
		s.ModelMgr.CancelDownload(msg.ModelID)
		send(Message{Type: "download_cancelled", ModelID: msg.ModelID})

	case "delete_model":
		if msg.ModelID == "" {
			send(Message{Type: "error", Data: "modelId is required"})
			return
		}
		s.ModelMgr.DeleteModel(msg.ModelID)
		send(Message{Type: "model_deleted", ModelID: msg.ModelID})
		send(Message{Type: "models_list", Models: s.ModelMgr.GetAllModelsState()})

	case "set_active_model":
		if msg.ModelID == "" {
			send(Message{Type: "error", Data: "modelId is required"})
			return
		}
		if !s.ModelMgr.IsModelDownloaded(msg.ModelID) {
			send(Message{Type: "error", Data: "model not downloaded"})
			return
		}
		if s.EngineMgr != nil {
			if err := s.EngineMgr.SetActiveModel(msg.ModelID); err != nil {
				send(Message{Type: "error", Data: err.Error()})
				return
			}
			// Обновляем transcriber в Pipeline если диаризация включена
			s.updatePipelineTranscriber()
		}
		send(Message{Type: "active_model_changed", ModelID: msg.ModelID})
		send(Message{Type: "models_list", Models: s.ModelMgr.GetAllModelsState()})

	case "get_sessions":
		sessions := s.SessionMgr.ListSessions()
		infos := make([]*SessionInfo, len(sessions))
		for i, sess := range sessions {
			infos[i] = &SessionInfo{
				ID: sess.ID, StartTime: sess.StartTime, Status: string(sess.Status),
				TotalDuration: int64(sess.TotalDuration / time.Millisecond),
				ChunksCount:   len(sess.Chunks), Title: sess.Title,
			}
		}
		send(Message{Type: "sessions_list", Sessions: infos})

	case "get_session":
		sess, err := s.SessionMgr.GetSession(msg.SessionID)
		if err != nil {
			send(Message{Type: "error", Data: err.Error()})
			return
		}
		send(Message{Type: "session_details", Session: sess})

	case "delete_session":
		s.SessionMgr.DeleteSession(msg.SessionID)
		send(Message{Type: "session_deleted", SessionID: msg.SessionID})

	case "start_session":
		// Configure Engine Model first, then Language
		if s.EngineMgr != nil {
			if msg.Model != "" {
				if !s.ModelMgr.IsModelDownloaded(msg.Model) {
					log.Printf("start_session: model %s is not downloaded", msg.Model)
					send(Message{Type: "error", Data: fmt.Sprintf("Model %s is not downloaded", msg.Model)})
					return
				}
				if err := s.EngineMgr.SetActiveModel(msg.Model); err != nil {
					log.Printf("start_session: failed to set active model %s: %v", msg.Model, err)
					send(Message{Type: "error", Data: fmt.Sprintf("Failed to load model %s: %v", msg.Model, err)})
					return
				}
				log.Printf("start_session: model %s activated successfully", msg.Model)
				// Обновляем transcriber в Pipeline если диаризация включена
				s.updatePipelineTranscriber()
			} else {
				// Если модель не указана, проверяем есть ли активный движок
				if s.EngineMgr.GetActiveEngine() == nil {
					log.Printf("start_session: no model specified and no active engine")
					send(Message{Type: "error", Data: "No model selected. Please select a model in settings."})
					return
				}
			}
			// Set language AFTER model is loaded (important: SetActiveModel creates new engine)
			if msg.Language != "" {
				s.EngineMgr.SetLanguage(msg.Language)
				log.Printf("start_session: language set to %s", msg.Language)
			}
		}

		config := session.SessionConfig{
			Language:      msg.Language,
			Model:         msg.Model,
			MicDevice:     msg.MicDevice,
			SystemDevice:  msg.SystemDevice,
			CaptureSystem: msg.CaptureSystem,
			UseNative:     msg.UseNative,
			VADMode:       session.VADMode(msg.VADMode),
		}

		// Echo Cancel default 0.4
		ec := float32(0.4)
		if msg.EchoCancel > 0 {
			ec = float32(msg.EchoCancel)
		}

		// Сбрасываем состояние диаризации (спикеров) перед новой сессией
		if s.TranscriptionService != nil {
			s.TranscriptionService.ResetDiarizationState()
			// Устанавливаем режим VAD
			s.TranscriptionService.SetVADMode(config.VADMode)
		}

		sess, err := s.RecordingService.StartSession(config, ec, msg.UseVoiceIsolation)
		if err != nil {
			send(Message{Type: "error", Data: err.Error()})
			return
		}
		send(Message{Type: "session_started", Session: sess})

	case "stop_session":
		sess, err := s.RecordingService.StopSession()
		if err != nil {
			send(Message{Type: "error", Data: err.Error()})
			return
		}
		send(Message{Type: "session_stopped", Session: sess})

	case "generate_summary":
		if s.LLMService == nil {
			send(Message{Type: "error", Data: "LLM Service not available"})
			return
		}

		send(Message{Type: "summary_started", SessionID: msg.SessionID})

		// Fetch transcription text helper
		sess, _ := s.SessionMgr.GetSession(msg.SessionID)
		var text strings.Builder
		for _, chunk := range sess.Chunks {
			if chunk.Transcription != "" {
				text.WriteString(chunk.Transcription + "\n")
			}
		}

		go func() {
			summary, err := s.LLMService.GenerateSummaryWithLLM(text.String(), msg.OllamaModel, msg.OllamaUrl)
			if err != nil {
				s.broadcast(Message{Type: "summary_error", SessionID: msg.SessionID, Error: err.Error()})
				return
			}
			s.SessionMgr.SetSessionSummary(msg.SessionID, summary)
			s.broadcast(Message{Type: "summary_completed", SessionID: msg.SessionID, Summary: summary})
		}()

	case "set_auto_improve":
		// Включение/отключение автоматического улучшения транскрипции через LLM
		if s.TranscriptionService == nil {
			send(Message{Type: "error", Data: "Transcription service not available"})
			return
		}
		if msg.AutoImproveEnabled {
			url := msg.OllamaUrl
			if url == "" {
				url = "http://localhost:11434"
			}
			model := msg.OllamaModel
			if model == "" {
				model = "llama3.2"
			}
			s.TranscriptionService.EnableAutoImprove(url, model)
			send(Message{Type: "auto_improve_status", AutoImproveEnabled: true, OllamaModel: model, OllamaUrl: url})
		} else {
			s.TranscriptionService.DisableAutoImprove()
			send(Message{Type: "auto_improve_status", AutoImproveEnabled: false})
		}
		log.Printf("Auto-improve: enabled=%v, model=%s, url=%s", msg.AutoImproveEnabled, msg.OllamaModel, msg.OllamaUrl)

	case "get_auto_improve_status":
		// Получить текущий статус автоулучшения
		if s.TranscriptionService == nil {
			send(Message{Type: "auto_improve_status", AutoImproveEnabled: false})
			return
		}
		send(Message{
			Type:               "auto_improve_status",
			AutoImproveEnabled: s.TranscriptionService.AutoImproveWithLLM,
			OllamaModel:        s.TranscriptionService.OllamaModel,
			OllamaUrl:          s.TranscriptionService.OllamaURL,
		})

	case "get_ollama_models":
		if s.LLMService == nil {
			send(Message{Type: "error", Data: "LLM Service not available"})
			return
		}
		url := msg.OllamaUrl
		if url == "" {
			url = "http://localhost:11434"
		}
		models, err := s.LLMService.GetOllamaModels(url)
		if err != nil {
			send(Message{Type: "ollama_models", Error: err.Error()})
			return
		}

		// Convert service.OllamaModel to api.OllamaModel
		var apiModels []OllamaModel
		for _, m := range models {
			apiModels = append(apiModels, OllamaModel{
				Name:       m.Name,
				Size:       m.Size,
				Family:     m.Details.Family,
				Parameters: m.Details.ParameterSize,
			})
		}
		send(Message{Type: "ollama_models", OllamaModels: apiModels})

	case "improve_transcription":
		if s.LLMService == nil {
			send(Message{Type: "error", Data: "LLM Service not available"})
			return
		}
		send(Message{Type: "improve_started", SessionID: msg.SessionID})

		sess, _ := s.SessionMgr.GetSession(msg.SessionID)
		var dialogue []session.TranscriptSegment
		for _, c := range sess.Chunks {
			if len(c.Dialogue) > 0 {
				dialogue = append(dialogue, c.Dialogue...)
			}
		}

		go func() {
			improved, err := s.LLMService.ImproveTranscriptionWithLLM(dialogue, msg.OllamaModel, msg.OllamaUrl)
			if err != nil {
				s.broadcast(Message{Type: "improve_error", SessionID: msg.SessionID, Error: err.Error()})
				return
			}
			s.SessionMgr.UpdateImprovedDialogue(msg.SessionID, improved)
			updatedSess, _ := s.SessionMgr.GetSession(msg.SessionID)
			s.broadcast(Message{Type: "improve_completed", SessionID: msg.SessionID, Session: updatedSess})
		}()

	case "diarize_with_llm":
		// Диаризация всего текста с помощью LLM - разбивает "Собеседник" на "Собеседник 1", "Собеседник 2" и т.д.
		if s.LLMService == nil {
			send(Message{Type: "error", Data: "LLM Service not available"})
			return
		}
		send(Message{Type: "diarize_started", SessionID: msg.SessionID})

		sess, err := s.SessionMgr.GetSession(msg.SessionID)
		if err != nil {
			send(Message{Type: "diarize_error", SessionID: msg.SessionID, Error: "Session not found"})
			return
		}

		var dialogue []session.TranscriptSegment
		for _, c := range sess.Chunks {
			if len(c.Dialogue) > 0 {
				dialogue = append(dialogue, c.Dialogue...)
			}
		}

		if len(dialogue) == 0 {
			send(Message{Type: "diarize_error", SessionID: msg.SessionID, Error: "No dialogue to diarize"})
			return
		}

		go func() {
			diarized, err := s.LLMService.DiarizeWithLLM(dialogue, msg.OllamaModel, msg.OllamaUrl)
			if err != nil {
				s.broadcast(Message{Type: "diarize_error", SessionID: msg.SessionID, Error: err.Error()})
				return
			}
			s.SessionMgr.UpdateImprovedDialogue(msg.SessionID, diarized)
			updatedSess, _ := s.SessionMgr.GetSession(msg.SessionID)
			s.broadcast(Message{Type: "diarize_completed", SessionID: msg.SessionID, Session: updatedSess})
		}()

	case "retranscribe_chunk":
		log.Printf("Received retranscribe_chunk: sessionId=%s, chunkId=%s, model=%s, language=%s",
			msg.SessionID, msg.Data, msg.Model, msg.Language)

		if msg.SessionID == "" || msg.Data == "" {
			send(Message{Type: "error", Data: "sessionId and chunkId (data) are required"})
			return
		}

		// Update engine with specified model/language
		if s.EngineMgr != nil {
			if msg.Language != "" {
				s.EngineMgr.SetLanguage(msg.Language)
			}
			if msg.Model != "" {
				if err := s.EngineMgr.SetActiveModel(msg.Model); err != nil {
					log.Printf("Failed to set model: %v", err)
				} else {
					// Обновляем transcriber в Pipeline если диаризация включена
					s.updatePipelineTranscriber()
				}
			}
		}

		go func() {
			chunkID := msg.Data
			sess, err := s.SessionMgr.GetSession(msg.SessionID)
			if err != nil {
				s.broadcast(Message{Type: "chunk_transcribed", SessionID: msg.SessionID, Error: err.Error()})
				return
			}

			var targetChunk *session.Chunk
			for _, c := range sess.Chunks {
				if c.ID == chunkID {
					targetChunk = c
					break
				}
			}

			if targetChunk == nil {
				s.broadcast(Message{Type: "chunk_transcribed", SessionID: msg.SessionID, Error: "chunk not found: " + chunkID})
				return
			}

			log.Printf("Retranscribing chunk %d (id=%s)", targetChunk.Index, targetChunk.ID)
			s.TranscriptionService.HandleChunk(targetChunk)
		}()

	case "retranscribe_full":
		log.Printf("Received retranscribe_full: sessionId=%s, model=%s, language=%s, diarization=%v",
			msg.SessionID, msg.Model, msg.Language, msg.DiarizationEnabled)

		if msg.SessionID == "" {
			send(Message{Type: "error", Data: "sessionId is required"})
			return
		}

		// Update engine with specified model/language
		if s.EngineMgr != nil {
			if msg.Language != "" {
				s.EngineMgr.SetLanguage(msg.Language)
			}
			if msg.Model != "" {
				if err := s.EngineMgr.SetActiveModel(msg.Model); err != nil {
					log.Printf("Failed to set model: %v", err)
				} else {
					// Обновляем transcriber в Pipeline если диаризация включена
					s.updatePipelineTranscriber()
				}
			}
		}

		// Проверяем сессию заранее для определения количества чанков
		sess, err := s.SessionMgr.GetSession(msg.SessionID)
		if err != nil {
			log.Printf("Full retranscription error: %v", err)
			send(Message{Type: "full_transcription_error", SessionID: msg.SessionID, Error: err.Error()})
			return
		}

		totalChunks := len(sess.Chunks)

		// Определяем использование диаризации
		// ВАЖНО: sherpa-onnx имеет известную утечку памяти при многократных вызовах
		// (https://github.com/k2-fsa/sherpa-onnx/issues/974, #1939)
		// Ограничиваем диаризацию только короткими сессиями (до 10 чанков = 5 минут)
		const maxChunksForDiarization = 10
		useDiarization := msg.DiarizationEnabled && s.TranscriptionService.IsDiarizationEnabled()

		if useDiarization && totalChunks > maxChunksForDiarization {
			log.Printf("WARNING: Disabling diarization for batch retranscription (%d chunks > %d max) due to sherpa-onnx memory leak",
				totalChunks, maxChunksForDiarization)
			useDiarization = false
			// Уведомляем пользователя
			s.broadcast(Message{
				Type:      "diarization_warning",
				SessionID: msg.SessionID,
				Data:      fmt.Sprintf("Диаризация отключена для длинных сессий (>%d чанков) из-за известной проблемы с памятью", maxChunksForDiarization),
			})
		}

		// Сбрасываем состояние диаризации (спикеров) перед полной ретранскрипцией
		if useDiarization {
			s.TranscriptionService.ResetDiarizationState()
		}

		// Создаём context для отмены
		ctx, cancel := context.WithCancel(context.Background())
		sessionID := msg.SessionID

		// Сохраняем cancel функцию
		s.retranscribeCancelsMu.Lock()
		// Отменяем предыдущую ретранскрипцию если была
		if prevCancel, exists := s.retranscribeCancels[sessionID]; exists {
			prevCancel()
		}
		s.retranscribeCancels[sessionID] = cancel
		s.retranscribeCancelsMu.Unlock()

		// Отправляем через broadcast для всех клиентов
		log.Printf("Sending full_transcription_started for session %s (diarization=%v)", sessionID, useDiarization)
		s.broadcast(Message{Type: "full_transcription_started", SessionID: sessionID})

		go func() {
			defer func() {
				// Удаляем cancel функцию после завершения
				s.retranscribeCancelsMu.Lock()
				delete(s.retranscribeCancels, sessionID)
				s.retranscribeCancelsMu.Unlock()
			}()

			if totalChunks == 0 {
				log.Printf("Full retranscription: no chunks to process")
				s.broadcast(Message{Type: "full_transcription_completed", SessionID: sessionID, Session: sess})
				return
			}

			log.Printf("Full retranscription: processing %d chunks (diarization=%v)", totalChunks, useDiarization)

			for i, chunk := range sess.Chunks {
				// Проверяем отмену перед каждым чанком
				select {
				case <-ctx.Done():
					log.Printf("Full retranscription cancelled for session %s at chunk %d/%d", sessionID, i+1, totalChunks)
					s.broadcast(Message{
						Type:      "full_transcription_cancelled",
						SessionID: sessionID,
						Data:      fmt.Sprintf("Отменено на чанке %d из %d", i+1, totalChunks),
					})
					return
				default:
				}

				// Отправляем прогресс
				progress := float64(i) / float64(totalChunks)
				log.Printf("Full retranscription progress: %d/%d (%.1f%%)", i+1, totalChunks, progress*100)
				s.broadcast(Message{
					Type:      "full_transcription_progress",
					SessionID: sessionID,
					Progress:  progress,
					Data:      fmt.Sprintf("Обработка чанка %d из %d...", i+1, totalChunks),
				})

				log.Printf("Retranscribing chunk %d/%d (id=%s, diarization=%v)", i+1, totalChunks, chunk.ID, useDiarization)
				// Используем синхронный метод с явным флагом диаризации
				s.TranscriptionService.HandleChunkSyncWithDiarization(chunk, useDiarization)
			}

			// Финальный прогресс 100%
			s.broadcast(Message{
				Type:      "full_transcription_progress",
				SessionID: sessionID,
				Progress:  1.0,
				Data:      "Завершение...",
			})

			updatedSess, _ := s.SessionMgr.GetSession(sessionID)
			log.Printf("Full retranscription completed for session %s", sessionID)
			s.broadcast(Message{Type: "full_transcription_completed", SessionID: sessionID, Session: updatedSess})
		}()

	case "cancel_full_transcription":
		sessionID := msg.SessionID
		if sessionID == "" {
			send(Message{Type: "error", Data: "sessionId is required"})
			return
		}

		log.Printf("Received cancel_full_transcription for session %s", sessionID)

		s.retranscribeCancelsMu.Lock()
		if cancel, exists := s.retranscribeCancels[sessionID]; exists {
			cancel()
			delete(s.retranscribeCancels, sessionID)
			log.Printf("Full retranscription cancel signal sent for session %s", sessionID)
		} else {
			log.Printf("No active retranscription found for session %s", sessionID)
		}
		s.retranscribeCancelsMu.Unlock()

	case "enable_diarization":
		// Provider: "auto" (default), "cpu", "coreml", "cuda"
		// "auto" автоматически выберет лучший: coreml на Apple Silicon, cpu иначе
		provider := msg.DiarizationProvider
		if provider == "" {
			provider = "auto"
		}
		// Backend: "sherpa" (default), "fluid" (FluidAudio/CoreML - рекомендуется для macOS)
		backend := msg.DiarizationBackend
		if backend == "" {
			backend = "fluid" // По умолчанию используем FluidAudio на macOS
		}
		log.Printf("Received enable_diarization: backend=%s, provider=%s, segmentation=%s, embedding=%s",
			backend, provider, msg.SegmentationModelPath, msg.EmbeddingModelPath)

		// Для FluidAudio не нужны пути к моделям (они скачиваются автоматически)
		if backend != "fluid" && (msg.SegmentationModelPath == "" || msg.EmbeddingModelPath == "") {
			send(Message{Type: "diarization_error", Error: "segmentationModelPath and embeddingModelPath are required for Sherpa backend"})
			return
		}

		// Проверяем есть ли активный engine, если нет - пробуем загрузить активную модель
		if s.EngineMgr != nil && s.EngineMgr.GetActiveEngine() == nil {
			// Пробуем загрузить активную модель из ModelMgr
			activeModelID := ""
			if s.ModelMgr != nil {
				activeModelID = s.ModelMgr.GetActiveModel()
			}
			if activeModelID != "" {
				log.Printf("enable_diarization: loading active model %s before enabling diarization", activeModelID)
				if err := s.EngineMgr.SetActiveModel(activeModelID); err != nil {
					log.Printf("enable_diarization: failed to load model %s: %v", activeModelID, err)
					send(Message{Type: "diarization_error", Error: fmt.Sprintf("Не удалось загрузить модель транскрипции: %v", err)})
					return
				}
			} else {
				send(Message{Type: "diarization_error", Error: "Не выбрана модель транскрипции. Выберите модель в настройках."})
				return
			}
		}

		err := s.TranscriptionService.EnableDiarizationWithBackend(
			msg.SegmentationModelPath, msg.EmbeddingModelPath, provider, backend)
		if err != nil {
			log.Printf("Failed to enable diarization: %v", err)
			send(Message{Type: "diarization_error", Error: err.Error()})
			return
		}

		actualProvider := s.TranscriptionService.GetDiarizationProvider()
		send(Message{
			Type:                "diarization_enabled",
			DiarizationEnabled:  true,
			DiarizationProvider: actualProvider,
			DiarizationBackend:  backend,
		})

	case "disable_diarization":
		log.Printf("Received disable_diarization")
		s.TranscriptionService.DisableDiarization()
		send(Message{Type: "diarization_disabled", DiarizationEnabled: false})

	case "get_diarization_status":
		enabled := s.TranscriptionService.IsDiarizationEnabled()
		provider := s.TranscriptionService.GetDiarizationProvider()
		send(Message{
			Type:                "diarization_status",
			DiarizationEnabled:  enabled,
			DiarizationProvider: provider,
		})

	// === VoicePrint (глобальные спикеры) ===
	case "get_voiceprints":
		if s.VoicePrintStore == nil {
			send(Message{Type: "voiceprints_list", VoicePrints: []voiceprint.VoicePrint{}})
			return
		}
		voiceprints := s.VoicePrintStore.GetAll()
		send(Message{Type: "voiceprints_list", VoicePrints: voiceprints})

	case "save_voiceprint":
		if s.VoicePrintStore == nil {
			send(Message{Type: "voiceprint_error", Error: "VoicePrint store not available"})
			return
		}
		if msg.SessionID == "" || msg.SpeakerName == "" {
			send(Message{Type: "voiceprint_error", Error: "sessionId and speakerName are required"})
			return
		}

		// Получаем embedding спикера из сессии
		embedding, source, err := s.getSpeakerEmbedding(msg.SessionID, msg.LocalSpeakerID)
		if err != nil {
			send(Message{Type: "voiceprint_error", Error: err.Error()})
			return
		}

		// Сохраняем voiceprint
		vp, err := s.VoicePrintStore.Add(msg.SpeakerName, embedding, source)
		if err != nil {
			send(Message{Type: "voiceprint_error", Error: err.Error()})
			return
		}

		send(Message{Type: "voiceprint_saved", VoicePrint: vp})
		log.Printf("[VoicePrint] Saved: %s (%s)", vp.Name, vp.ID[:8])

	case "update_voiceprint":
		if s.VoicePrintStore == nil {
			send(Message{Type: "voiceprint_error", Error: "VoicePrint store not available"})
			return
		}
		if msg.VoicePrintID == "" {
			send(Message{Type: "voiceprint_error", Error: "voiceprintId is required"})
			return
		}

		if msg.SpeakerName != "" {
			if err := s.VoicePrintStore.UpdateName(msg.VoicePrintID, msg.SpeakerName); err != nil {
				send(Message{Type: "voiceprint_error", Error: err.Error()})
				return
			}
		}

		vp, _ := s.VoicePrintStore.Get(msg.VoicePrintID)
		send(Message{Type: "voiceprint_updated", VoicePrint: vp})

	case "delete_voiceprint":
		if s.VoicePrintStore == nil {
			send(Message{Type: "voiceprint_error", Error: "VoicePrint store not available"})
			return
		}
		if msg.VoicePrintID == "" {
			send(Message{Type: "voiceprint_error", Error: "voiceprintId is required"})
			return
		}

		if err := s.VoicePrintStore.Delete(msg.VoicePrintID); err != nil {
			send(Message{Type: "voiceprint_error", Error: err.Error()})
			return
		}

		send(Message{Type: "voiceprint_deleted", VoicePrintID: msg.VoicePrintID})

	case "get_session_speakers":
		if msg.SessionID == "" {
			send(Message{Type: "error", Data: "sessionId is required"})
			return
		}

		speakers := s.getSessionSpeakers(msg.SessionID)
		send(Message{Type: "session_speakers", SessionID: msg.SessionID, SessionSpeakers: speakers})

	case "rename_session_speaker":
		if msg.SessionID == "" || msg.SpeakerName == "" {
			send(Message{Type: "error", Data: "sessionId and speakerName are required"})
			return
		}

		// Переименовываем спикера в сессии
		if err := s.renameSpeakerInSession(msg.SessionID, msg.LocalSpeakerID, msg.SpeakerName); err != nil {
			send(Message{Type: "error", Data: err.Error()})
			return
		}

		// Если запрошено сохранение в глобальную базу
		var voiceprintID string
		if msg.SaveAsVoiceprint && s.VoicePrintStore != nil {
			embedding, source, err := s.getSpeakerEmbedding(msg.SessionID, msg.LocalSpeakerID)
			if err == nil && len(embedding) > 0 {
				vp, err := s.VoicePrintStore.Add(msg.SpeakerName, embedding, source)
				if err == nil {
					voiceprintID = vp.ID
					log.Printf("[VoicePrint] Saved from rename: %s (%s)", vp.Name, vp.ID[:8])
				}
			}
		}

		send(Message{
			Type:           "speaker_renamed",
			SessionID:      msg.SessionID,
			LocalSpeakerID: msg.LocalSpeakerID,
			SpeakerName:    msg.SpeakerName,
			VoicePrintID:   voiceprintID,
		})

		// Обновляем сессию для всех клиентов
		if updatedSess, err := s.SessionMgr.GetSession(msg.SessionID); err == nil {
			s.broadcast(Message{Type: "session_details", Session: updatedSess})
		}
	}
}

func (s *Server) handleSessionsAPI(w http.ResponseWriter, r *http.Request) {
	// CORS headers for dev mode (Vite runs on different port)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	path := r.URL.Path[len("/api/sessions/"):]

	if path == "" {
		// List
		sessions := s.SessionMgr.ListSessions()
		infos := make([]*SessionInfo, len(sessions))
		for i, sess := range sessions {
			infos[i] = &SessionInfo{
				ID: sess.ID, StartTime: sess.StartTime, Status: string(sess.Status),
				TotalDuration: int64(sess.TotalDuration / time.Millisecond),
				ChunksCount:   len(sess.Chunks), Title: sess.Title,
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(infos)
		return
	}

	// File serving logic
	// Simplified validation
	if len(path) < 36 {
		http.NotFound(w, r)
		return
	}
	sessionID := path[:36]
	sess, err := s.SessionMgr.GetSession(sessionID)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	requestedFile := path[37:]

	// Chunk MP3 extraction
	if strings.HasPrefix(requestedFile, "chunk/") {
		chunkPart := strings.TrimPrefix(requestedFile, "chunk/")
		chunkPart = strings.TrimSuffix(chunkPart, ".mp3")
		var chunkIndex int
		fmt.Sscanf(chunkPart, "%d", &chunkIndex)

		var targetChunk *session.Chunk
		for _, c := range sess.Chunks {
			if c.Index == chunkIndex {
				targetChunk = c
				break
			}
		}
		if targetChunk == nil {
			http.NotFound(w, r)
			return
		}

		mp3Path := filepath.Join(sess.DataDir, "full.mp3")
		startSec := float64(targetChunk.StartMs) / 1000.0
		endSec := float64(targetChunk.EndMs) / 1000.0
		duration := endSec - startSec

		cmd := exec.Command(session.GetFFmpegPath(),
			"-ss", fmt.Sprintf("%.3f", startSec),
			"-i", mp3Path,
			"-t", fmt.Sprintf("%.3f", duration),
			"-c:a", "copy", "-f", "mp3", "pipe:1",
		)
		output, _ := cmd.Output()
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Write(output)
		return
	}

	filePath := filepath.Join(sess.DataDir, requestedFile)
	if strings.HasSuffix(filePath, ".wav") {
		// Try mp3 fallback
		if _, err := os.Stat(filepath.Join(sess.DataDir, "full.mp3")); err == nil {
			// serve mp3 instead? or raw file?
			// Main logic checked for existence.
		}
	}
	http.ServeFile(w, r, filePath)
}

// getSpeakerEmbedding получает embedding спикера из сессии
// Возвращает embedding, source ("mic" или "sys"), error
func (s *Server) getSpeakerEmbedding(sessionID string, localSpeakerID int) ([]float32, string, error) {
	// Получаем Pipeline для доступа к текущим профилям спикеров
	if s.TranscriptionService == nil || s.TranscriptionService.Pipeline == nil {
		return nil, "", fmt.Errorf("pipeline not available")
	}

	// Получаем сессию для определения source
	sess, err := s.SessionMgr.GetSession(sessionID)
	if err != nil {
		return nil, "", err
	}

	// MIC канал (localID = -1 для "Вы") - всегда "mic"
	// SYS канал (localID >= 0) - всегда "sys"
	source := "sys"
	if localSpeakerID < 0 {
		source = "mic"
	}

	// TODO: Получить embedding из Pipeline.speakerProfiles
	// Сейчас Pipeline хранит speakerProfiles приватно, нужно добавить метод GetSpeakerEmbedding
	// Временное решение: вернём ошибку
	_ = sess

	return nil, source, fmt.Errorf("speaker embedding retrieval not implemented yet")
}

// getSessionSpeakers возвращает список спикеров в сессии
func (s *Server) getSessionSpeakers(sessionID string) []voiceprint.SessionSpeaker {
	var speakers []voiceprint.SessionSpeaker

	sess, err := s.SessionMgr.GetSession(sessionID)
	if err != nil {
		return speakers
	}

	// Собираем информацию о спикерах из диалога
	speakerMap := make(map[string]*voiceprint.SessionSpeaker)

	for _, chunk := range sess.Chunks {
		for _, seg := range chunk.Dialogue {
			speaker := seg.Speaker
			if speaker == "" {
				continue
			}

			if _, ok := speakerMap[speaker]; !ok {
				localID := -1 // По умолчанию для "Вы"
				isMic := false

				if speaker == "Вы" {
					isMic = true
				} else if strings.HasPrefix(speaker, "Собеседник ") {
					// "Собеседник 1" -> localID = 0
					var num int
					fmt.Sscanf(speaker, "Собеседник %d", &num)
					localID = num - 1
				}

				speakerMap[speaker] = &voiceprint.SessionSpeaker{
					LocalID:      localID,
					DisplayName:  speaker,
					IsMic:        isMic,
					IsRecognized: false,
				}
			}

			sp := speakerMap[speaker]
			sp.SegmentCount++
			sp.TotalDuration += float32(seg.End-seg.Start) / 1000.0 // мс -> сек
		}
	}

	for _, sp := range speakerMap {
		speakers = append(speakers, *sp)
	}

	return speakers
}

// renameSpeakerInSession переименовывает спикера во всех сегментах сессии
func (s *Server) renameSpeakerInSession(sessionID string, localSpeakerID int, newName string) error {
	// Определяем старое имя по localSpeakerID
	oldName := ""
	if localSpeakerID < 0 {
		oldName = "Вы"
	} else {
		oldName = fmt.Sprintf("Собеседник %d", localSpeakerID+1)
	}

	// Используем метод SessionManager для переименования
	return s.SessionMgr.UpdateSpeakerName(sessionID, oldName, newName)
}

// updatePipelineTranscriber обновляет transcriber в Pipeline после смены модели
// Это необходимо потому что Pipeline хранит ссылку на engine, который закрывается при смене модели
func (s *Server) updatePipelineTranscriber() {
	if s.TranscriptionService == nil || s.TranscriptionService.Pipeline == nil {
		return
	}
	if s.EngineMgr == nil {
		return
	}
	newEngine := s.EngineMgr.GetActiveEngine()
	if newEngine == nil {
		return
	}
	s.TranscriptionService.Pipeline.SetTranscriber(newEngine)
	log.Printf("Pipeline transcriber updated to new engine")
}
