package api

import (
	"aiwisper/ai"
	"aiwisper/audio"
	"aiwisper/internal/config"
	"aiwisper/internal/service"
	"aiwisper/models"
	"aiwisper/session"
	"aiwisper/voiceprint"
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
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
	Config                        *config.Config
	SessionMgr                    *session.Manager
	EngineMgr                     *ai.EngineManager
	ModelMgr                      *models.Manager
	Capture                       *audio.Capture
	TranscriptionService          *service.TranscriptionService
	RecordingService              *service.RecordingService
	LLMService                    *service.LLMService
	StreamingTranscriptionService *service.StreamingTranscriptionService // Real-time streaming транскрипция
	VoicePrintStore               *voiceprint.Store                      // Хранилище голосовых отпечатков
	VoicePrintMatcher             *voiceprint.Matcher                    // Matcher для поиска совпадений

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
	streamingSvc *service.StreamingTranscriptionService,
	vpStore *voiceprint.Store,
	vpMatcher *voiceprint.Matcher,
) *Server {
	s := &Server{
		Config:                        cfg,
		SessionMgr:                    sessMgr,
		EngineMgr:                     engMgr,
		ModelMgr:                      modMgr,
		Capture:                       cap,
		TranscriptionService:          transSvc,
		RecordingService:              recSvc,
		LLMService:                    llmSvc,
		StreamingTranscriptionService: streamingSvc,
		VoicePrintStore:               vpStore,
		VoicePrintMatcher:             vpMatcher,
		clients:                       make(map[transportClient]bool),
		retranscribeCancels:           make(map[string]func()),
	}
	s.setupCallbacks()
	return s
}

func (s *Server) Start() {
	go s.startGRPCServer()

	http.HandleFunc("/ws", s.handleWebSocket)
	http.HandleFunc("/api/sessions/", s.handleSessionsAPI)
	http.HandleFunc("/api/import", s.handleImportAudio)
	http.HandleFunc("/api/export/batch", s.handleBatchExport)

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

		// Audio Stream for Streaming Transcription
		s.RecordingService.OnAudioStream = func(samples []float32) {
			if s.StreamingTranscriptionService != nil && s.StreamingTranscriptionService.IsActive() {
				if err := s.StreamingTranscriptionService.StreamAudio(samples); err != nil {
					log.Printf("StreamingTranscription: failed to stream audio: %v", err)
				}
			}
		}
	}

	// Streaming Transcription Updates
	if s.StreamingTranscriptionService != nil {
		s.StreamingTranscriptionService.OnUpdate = func(update service.StreamingTranscriptionUpdate) {
			s.broadcast(Message{
				Type:                 "streaming_update",
				StreamingText:        update.Text,
				StreamingIsConfirmed: update.IsConfirmed,
				StreamingConfidence:  update.Confidence,
				StreamingTimestamp:   update.Timestamp.UnixMilli(),
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

	case "rename_session":
		if msg.SessionID == "" {
			send(Message{Type: "error", Data: "sessionId is required"})
			return
		}
		title := msg.Data // Используем поле Data для нового названия
		if title == "" {
			send(Message{Type: "error", Data: "title is required"})
			return
		}
		if err := s.SessionMgr.SetSessionTitle(msg.SessionID, title); err != nil {
			send(Message{Type: "error", Data: err.Error()})
			return
		}
		send(Message{Type: "session_renamed", SessionID: msg.SessionID, Data: title})
		// Отправляем обновлённый список сессий
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

	case "start_session":
		// Configure Engine Model first, then Language
		if s.EngineMgr != nil {
			if msg.Model != "" {
				if !s.ModelMgr.IsModelDownloaded(msg.Model) {
					log.Printf("start_session: model %s is not downloaded", msg.Model)
					send(Message{Type: "error", Data: fmt.Sprintf("Model %s is not downloaded", msg.Model)})
					return
				}

				// Получаем информацию о модели для отображения
				modelInfo := models.GetModelByID(msg.Model)
				modelName := msg.Model
				if modelInfo != nil {
					modelName = modelInfo.Name
				}

				// Проверяем, нужно ли загружать модель (если она ещё не активна)
				needsLoading := s.EngineMgr.GetActiveModelID() != msg.Model

				if needsLoading {
					// Отправляем событие начала загрузки модели
					send(Message{Type: "model_loading", ModelID: msg.Model, ModelName: modelName})
				}

				if err := s.EngineMgr.SetActiveModel(msg.Model); err != nil {
					log.Printf("start_session: failed to set active model %s: %v", msg.Model, err)
					send(Message{Type: "model_load_error", ModelID: msg.Model, ModelName: modelName, Error: err.Error()})
					send(Message{Type: "error", Data: fmt.Sprintf("Failed to load model %s: %v", msg.Model, err)})
					return
				}

				if needsLoading {
					// Отправляем событие успешной загрузки модели
					send(Message{Type: "model_loaded", ModelID: msg.Model, ModelName: modelName})
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
			// Set pause threshold if specified (for FluidASR segmentation)
			if msg.PauseThreshold > 0 {
				s.EngineMgr.SetPauseThreshold(msg.PauseThreshold)
				log.Printf("start_session: pause threshold set to %.2fs", msg.PauseThreshold)
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
			VADMethod:     session.VADMethod(msg.VADMethod),
		}

		// Echo Cancel default 0.4
		ec := float32(0.4)
		if msg.EchoCancel > 0 {
			ec = float32(msg.EchoCancel)
		}

		// Сбрасываем состояние диаризации (спикеров) перед новой сессией
		if s.TranscriptionService != nil {
			s.TranscriptionService.ResetDiarizationState()
			// Устанавливаем режим VAD и метод детекции
			s.TranscriptionService.SetVADMode(config.VADMode)
			s.TranscriptionService.SetVADMethod(config.VADMethod)

			// Настраиваем гибридную транскрипцию если включена
			if msg.HybridEnabled && msg.HybridSecondaryModelID != "" {
				hybridConfig := &ai.HybridTranscriptionConfig{
					Enabled:             true,
					SecondaryModelID:    msg.HybridSecondaryModelID,
					ConfidenceThreshold: float32(msg.HybridConfidenceThreshold),
					ContextWords:        msg.HybridContextWords,
					UseLLMForMerge:      msg.HybridUseLLMForMerge,
					Mode:                ai.HybridMode(msg.HybridMode),
				}
				// Устанавливаем дефолты если не указаны
				if hybridConfig.ConfidenceThreshold <= 0 {
					hybridConfig.ConfidenceThreshold = 0.7 // Повышен с 0.5 до 0.7
				}
				if hybridConfig.ContextWords <= 0 {
					hybridConfig.ContextWords = 3
				}
				if hybridConfig.Mode == "" {
					hybridConfig.Mode = ai.HybridModeFullCompare // По умолчанию - полное сравнение
				}
				s.TranscriptionService.SetHybridConfig(hybridConfig)
			} else {
				s.TranscriptionService.SetHybridConfig(nil)
			}
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

	case "set_hybrid_transcription":
		// Включение/отключение гибридной транскрипции
		if s.TranscriptionService == nil {
			send(Message{Type: "error", Data: "Transcription service not available"})
			return
		}
		if msg.HybridEnabled && msg.HybridSecondaryModelID != "" {
			hybridConfig := &ai.HybridTranscriptionConfig{
				Enabled:             true,
				SecondaryModelID:    msg.HybridSecondaryModelID,
				ConfidenceThreshold: float32(msg.HybridConfidenceThreshold),
				ContextWords:        msg.HybridContextWords,
				UseLLMForMerge:      msg.HybridUseLLMForMerge,
				Mode:                ai.HybridMode(msg.HybridMode),
			}
			if hybridConfig.ConfidenceThreshold <= 0 {
				hybridConfig.ConfidenceThreshold = 0.7 // Повышен с 0.5 до 0.7
			}
			if hybridConfig.ContextWords <= 0 {
				hybridConfig.ContextWords = 3
			}
			if hybridConfig.Mode == "" {
				hybridConfig.Mode = ai.HybridModeFullCompare // По умолчанию - полное сравнение
			}
			s.TranscriptionService.SetHybridConfig(hybridConfig)
			send(Message{
				Type:                      "hybrid_transcription_status",
				HybridEnabled:             true,
				HybridSecondaryModelID:    msg.HybridSecondaryModelID,
				HybridConfidenceThreshold: msg.HybridConfidenceThreshold,
				HybridContextWords:        msg.HybridContextWords,
				HybridUseLLMForMerge:      msg.HybridUseLLMForMerge,
				HybridMode:                msg.HybridMode,
			})
		} else {
			s.TranscriptionService.SetHybridConfig(nil)
			send(Message{Type: "hybrid_transcription_status", HybridEnabled: false})
		}
		log.Printf("Hybrid transcription: enabled=%v, secondaryModel=%s, threshold=%.2f, mode=%s",
			msg.HybridEnabled, msg.HybridSecondaryModelID, msg.HybridConfidenceThreshold, msg.HybridMode)

	case "get_hybrid_transcription_status":
		// Получить текущий статус гибридной транскрипции
		if s.TranscriptionService == nil || s.TranscriptionService.HybridConfig == nil {
			send(Message{Type: "hybrid_transcription_status", HybridEnabled: false})
			return
		}
		cfg := s.TranscriptionService.HybridConfig
		send(Message{
			Type:                      "hybrid_transcription_status",
			HybridEnabled:             cfg.Enabled,
			HybridSecondaryModelID:    cfg.SecondaryModelID,
			HybridConfidenceThreshold: float64(cfg.ConfidenceThreshold),
			HybridContextWords:        cfg.ContextWords,
			HybridUseLLMForMerge:      cfg.UseLLMForMerge,
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

	// === Streaming Transcription ===
	case "enable_streaming":
		if s.StreamingTranscriptionService == nil {
			send(Message{Type: "error", Data: "Streaming transcription service not available"})
			return
		}
		// Создаём конфигурацию из параметров сообщения
		streamingCfg := service.StreamingConfig{
			ChunkSeconds:          msg.StreamingChunkSeconds,
			ConfirmationThreshold: msg.StreamingConfirmationThreshold,
		}
		if err := s.StreamingTranscriptionService.StartWithConfig(streamingCfg); err != nil {
			log.Printf("Failed to enable streaming transcription: %v", err)
			send(Message{Type: "streaming_error", Error: err.Error()})
			return
		}
		send(Message{Type: "streaming_enabled"})
		log.Printf("Streaming transcription enabled (chunkSeconds=%.1f, confirmationThreshold=%.2f)",
			streamingCfg.ChunkSeconds, streamingCfg.ConfirmationThreshold)

	case "disable_streaming":
		if s.StreamingTranscriptionService == nil {
			send(Message{Type: "error", Data: "Streaming transcription service not available"})
			return
		}
		if err := s.StreamingTranscriptionService.Stop(); err != nil {
			log.Printf("Failed to disable streaming transcription: %v", err)
			send(Message{Type: "streaming_error", Error: err.Error()})
			return
		}
		send(Message{Type: "streaming_disabled"})
		log.Printf("Streaming transcription disabled")

	case "get_streaming_status":
		if s.StreamingTranscriptionService == nil {
			send(Message{Type: "streaming_status", Data: "false"})
			return
		}
		isActive := s.StreamingTranscriptionService.IsActive()
		status := "false"
		if isActive {
			status = "true"
		}
		send(Message{Type: "streaming_status", Data: status})

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

// handleImportAudio обрабатывает загрузку аудио файла для транскрипции
func (s *Server) handleImportAudio(w http.ResponseWriter, r *http.Request) {
	// CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Ограничение размера файла: 500MB
	r.ParseMultipartForm(500 << 20)

	file, header, err := r.FormFile("audio")
	if err != nil {
		log.Printf("Import: failed to get file: %v", err)
		http.Error(w, "Failed to get file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Получаем параметры
	modelID := r.FormValue("model")
	language := r.FormValue("language")
	if language == "" {
		language = "ru"
	}

	// Проверяем расширение файла
	ext := strings.ToLower(filepath.Ext(header.Filename))
	supportedFormats := map[string]bool{".mp3": true, ".wav": true, ".m4a": true, ".ogg": true, ".flac": true}
	if !supportedFormats[ext] {
		http.Error(w, "Unsupported audio format. Supported: mp3, wav, m4a, ogg, flac", http.StatusBadRequest)
		return
	}

	log.Printf("Import: received file %s (%d bytes), model=%s, language=%s",
		header.Filename, header.Size, modelID, language)

	// Создаём новую сессию для импорта (без активации)
	sess, err := s.SessionMgr.CreateImportSession(session.SessionConfig{
		Language: language,
		Model:    modelID,
	})
	if err != nil {
		log.Printf("Import: failed to create session: %v", err)
		http.Error(w, "Failed to create session", http.StatusInternalServerError)
		return
	}

	// Устанавливаем название из имени файла
	title := strings.TrimSuffix(header.Filename, ext)
	s.SessionMgr.SetSessionTitle(sess.ID, title)

	// Сохраняем файл во временную директорию
	tempPath := filepath.Join(sess.DataDir, "import"+ext)
	tempFile, err := os.Create(tempPath)
	if err != nil {
		log.Printf("Import: failed to create temp file: %v", err)
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}

	_, err = io.Copy(tempFile, file)
	tempFile.Close()
	if err != nil {
		log.Printf("Import: failed to save file: %v", err)
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}

	// Конвертируем в WAV если нужно
	wavPath := filepath.Join(sess.DataDir, "full.wav")
	mp3Path := filepath.Join(sess.DataDir, "full.mp3")

	// Используем ffmpeg для конвертации
	ffmpegPath := session.GetFFmpegPath()

	// Конвертируем в WAV (16kHz, mono для транскрипции)
	cmd := exec.Command(ffmpegPath,
		"-i", tempPath,
		"-ar", "16000",
		"-ac", "1",
		"-y", wavPath,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		log.Printf("Import: ffmpeg WAV conversion failed: %v, output: %s", err, string(output))
		http.Error(w, "Failed to convert audio", http.StatusInternalServerError)
		return
	}

	// Конвертируем в MP3 для воспроизведения (сохраняем оригинальные каналы)
	cmd = exec.Command(ffmpegPath,
		"-i", tempPath,
		"-codec:a", "libmp3lame",
		"-qscale:a", "2",
		"-y", mp3Path,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		log.Printf("Import: ffmpeg MP3 conversion failed: %v, output: %s", err, string(output))
		// Не критично, продолжаем
	}

	// Удаляем временный файл
	os.Remove(tempPath)

	// Получаем длительность
	durationMs, err := s.getAudioDuration(wavPath)
	if err != nil {
		log.Printf("Import: failed to get duration: %v", err)
		durationMs = 0
	}

	// Обновляем сессию
	sess.TotalDuration = time.Duration(durationMs) * time.Millisecond
	sess.Status = session.SessionStatusCompleted
	s.SessionMgr.SaveSessionMeta(sess)

	// Уведомляем клиентов о новой сессии
	s.broadcast(Message{
		Type:      "session_imported",
		SessionID: sess.ID,
		Session:   sess,
	})

	// Запускаем полную транскрипцию в фоне
	go func() {
		sessionID := sess.ID
		log.Printf("Import: starting transcription for session %s", sessionID)

		// Update engine with specified model/language
		if s.EngineMgr != nil {
			if language != "" {
				s.EngineMgr.SetLanguage(language)
			}
			if modelID != "" {
				if err := s.EngineMgr.SetActiveModel(modelID); err != nil {
					log.Printf("Import: failed to set model: %v", err)
				}
			}
		}

		// Уведомляем о начале транскрипции
		s.broadcast(Message{
			Type:      "full_transcription_started",
			SessionID: sessionID,
		})

		// Создаём один чанк для всего файла
		chunk := &session.Chunk{
			ID:        sessionID + "-0",
			SessionID: sessionID,
			Index:     0,
			Duration:  sess.TotalDuration,
			StartMs:   0,
			EndMs:     durationMs,
			Status:    session.ChunkStatusPending,
			FilePath:  wavPath,
			CreatedAt: time.Now(),
		}

		// Добавляем чанк в сессию
		if err := s.SessionMgr.AddChunk(sessionID, chunk); err != nil {
			log.Printf("Import: failed to add chunk: %v", err)
			s.broadcast(Message{
				Type:      "full_transcription_error",
				SessionID: sessionID,
				Error:     err.Error(),
			})
			return
		}

		// Отправляем прогресс
		s.broadcast(Message{
			Type:      "full_transcription_progress",
			SessionID: sessionID,
			Progress:  0.1,
			Data:      "Транскрипция аудио...",
		})

		// Транскрибируем чанк с включённой диаризацией (если доступна)
		// Для моно файлов это создаст сегментацию с таймкодами и определением спикеров
		if s.TranscriptionService != nil {
			s.TranscriptionService.HandleChunkSyncWithDiarization(chunk, true)
		}

		// Финальный прогресс
		s.broadcast(Message{
			Type:      "full_transcription_progress",
			SessionID: sessionID,
			Progress:  1.0,
			Data:      "Завершение...",
		})

		// Получаем обновлённую сессию
		updatedSess, _ := s.SessionMgr.GetSession(sessionID)

		s.broadcast(Message{
			Type:      "full_transcription_completed",
			SessionID: sessionID,
			Session:   updatedSess,
		})

		log.Printf("Import: transcription completed for session %s", sessionID)
	}()

	// Возвращаем информацию о созданной сессии
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"sessionId": sess.ID,
		"title":     title,
		"duration":  durationMs,
	})
}

// getAudioDuration получает длительность аудио файла в миллисекундах
func (s *Server) getAudioDuration(audioPath string) (int64, error) {
	cmd := exec.Command(session.GetFFmpegPath(),
		"-i", audioPath,
		"-f", "null", "-",
	)
	output, _ := cmd.CombinedOutput()

	// Парсим вывод ffmpeg для получения длительности
	// Duration: 00:01:23.45
	outputStr := string(output)
	if idx := strings.Index(outputStr, "Duration:"); idx != -1 {
		durationStr := outputStr[idx+10 : idx+21]
		parts := strings.Split(durationStr, ":")
		if len(parts) == 3 {
			var hours, mins int
			var secs float64
			fmt.Sscanf(parts[0], "%d", &hours)
			fmt.Sscanf(parts[1], "%d", &mins)
			fmt.Sscanf(parts[2], "%f", &secs)
			totalMs := int64((hours*3600+mins*60)*1000) + int64(secs*1000)
			return totalMs, nil
		}
	}
	return 0, fmt.Errorf("could not parse duration")
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
	_ = sess // Используется для валидации существования сессии

	// MIC канал (localID = -1 для "Вы") - всегда "mic"
	// SYS канал (localID >= 0) - всегда "sys"
	source := "sys"
	if localSpeakerID < 0 {
		source = "mic"
	}

	// Преобразуем localSpeakerID в globalSpeakerID
	// localSpeakerID: -1 для mic, 0+ для sys спикеров
	// globalSpeakerID в Pipeline: 1-based (1, 2, 3...)
	// UI показывает: "Собеседник 1" = localID 0 = globalID 1
	globalSpeakerID := localSpeakerID + 1

	// Для микрофона (localID = -1) нет embedding в Pipeline
	// Микрофон обрабатывается отдельно и не проходит через диаризацию
	if localSpeakerID < 0 {
		return nil, source, fmt.Errorf("microphone speaker does not have embedding in diarization pipeline")
	}

	// Получаем embedding из Pipeline
	embedding := s.TranscriptionService.Pipeline.GetSpeakerEmbedding(globalSpeakerID)
	if embedding == nil {
		return nil, source, fmt.Errorf("speaker %d not found in pipeline profiles", localSpeakerID)
	}

	return embedding, source, nil
}

// getSessionSpeakers возвращает список спикеров в сессии
func (s *Server) getSessionSpeakers(sessionID string) []voiceprint.SessionSpeaker {
	var speakers []voiceprint.SessionSpeaker

	sess, err := s.SessionMgr.GetSession(sessionID)
	if err != nil {
		return speakers
	}

	// Собираем информацию о спикерах из диалога
	// Спикеры могут быть в разных форматах:
	// - "mic" или "Вы" - микрофон пользователя
	// - "sys", "Speaker 0", "Speaker 1", "Собеседник", "Собеседник 1" - собеседники
	speakerMap := make(map[string]*voiceprint.SessionSpeaker)

	// Вспомогательная функция для обработки сегмента
	processSpeaker := func(speaker string, duration int64) {
		if speaker == "" {
			return
		}

		// Нормализуем ключ для группировки
		normalizedKey := speaker

		if _, ok := speakerMap[normalizedKey]; !ok {
			localID := 0
			isMic := false
			displayName := speaker

			// Определяем тип спикера и формируем displayName
			switch {
			case speaker == "mic" || speaker == "Вы":
				isMic = true
				localID = -1
				displayName = "Вы"

			case speaker == "sys" || speaker == "Собеседник":
				localID = 0
				displayName = "Собеседник 1"

			case strings.HasPrefix(speaker, "Speaker "):
				// "Speaker 0" -> localID = 0, displayName = "Собеседник 1"
				var num int
				fmt.Sscanf(speaker, "Speaker %d", &num)
				localID = num
				displayName = fmt.Sprintf("Собеседник %d", num+1)

			case strings.HasPrefix(speaker, "Собеседник "):
				// "Собеседник 1" -> localID = 0
				var num int
				fmt.Sscanf(speaker, "Собеседник %d", &num)
				localID = num - 1
				displayName = speaker // Уже в нужном формате

			default:
				// Кастомное имя (уже переименованный спикер)
				// Пытаемся определить localID по позиции
				localID = len(speakerMap) // Присваиваем следующий ID
				displayName = speaker
			}

			speakerMap[normalizedKey] = &voiceprint.SessionSpeaker{
				LocalID:      localID,
				DisplayName:  displayName,
				IsMic:        isMic,
				IsRecognized: false,
			}
		}

		sp := speakerMap[normalizedKey]
		sp.SegmentCount++
		sp.TotalDuration += float32(duration) / 1000.0 // мс -> сек
	}

	for _, chunk := range sess.Chunks {
		// 1. Сначала проверяем Dialogue (объединённый диалог)
		if len(chunk.Dialogue) > 0 {
			for _, seg := range chunk.Dialogue {
				processSpeaker(seg.Speaker, seg.End-seg.Start)
			}
		} else {
			// 2. Если Dialogue пустой, проверяем MicSegments и SysSegments
			// Это важно для сессий без диаризации, где есть только раздельные каналы
			for _, seg := range chunk.MicSegments {
				speaker := seg.Speaker
				if speaker == "" {
					speaker = "mic" // По умолчанию для mic канала
				}
				processSpeaker(speaker, seg.End-seg.Start)
			}
			for _, seg := range chunk.SysSegments {
				speaker := seg.Speaker
				if speaker == "" {
					speaker = "sys" // По умолчанию для sys канала
				}
				processSpeaker(speaker, seg.End-seg.Start)
			}
		}
	}

	for _, sp := range speakerMap {
		speakers = append(speakers, *sp)
	}

	return speakers
}

// renameSpeakerInSession переименовывает спикера во всех сегментах сессии
func (s *Server) renameSpeakerInSession(sessionID string, localSpeakerID int, newName string) error {
	// Определяем все возможные варианты старого имени по localSpeakerID
	// Спикер может быть в разных форматах в зависимости от источника
	var oldNames []string

	if localSpeakerID < 0 {
		oldNames = []string{"Вы", "mic"}
	} else {
		// Собеседники могут быть в форматах:
		// - "Speaker N" (из диаризации)
		// - "Собеседник N+1" (после конвертации)
		// - "sys" (если только один собеседник)
		// - "Собеседник" (без номера)
		oldNames = []string{
			fmt.Sprintf("Speaker %d", localSpeakerID),
			fmt.Sprintf("Собеседник %d", localSpeakerID+1),
		}
		if localSpeakerID == 0 {
			oldNames = append(oldNames, "sys", "Собеседник")
		}
	}

	// Пробуем переименовать каждый вариант
	var lastErr error
	renamed := false
	for _, oldName := range oldNames {
		err := s.SessionMgr.UpdateSpeakerName(sessionID, oldName, newName)
		if err == nil {
			renamed = true
			log.Printf("Renamed speaker '%s' -> '%s' in session %s", oldName, newName, sessionID)
		} else {
			lastErr = err
		}
	}

	if !renamed && lastErr != nil {
		return lastErr
	}
	return nil
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

// handleBatchExport обрабатывает экспорт нескольких сессий в ZIP архив
func (s *Server) handleBatchExport(w http.ResponseWriter, r *http.Request) {
	// CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Парсим JSON body
	var req struct {
		SessionIDs []string `json:"sessionIds"`
		Format     string   `json:"format"` // txt, srt, vtt, json, md
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if len(req.SessionIDs) == 0 {
		http.Error(w, "No sessions specified", http.StatusBadRequest)
		return
	}

	if req.Format == "" {
		req.Format = "txt"
	}

	log.Printf("Batch export: %d sessions, format=%s", len(req.SessionIDs), req.Format)

	// Создаём ZIP архив в памяти
	buf := new(bytes.Buffer)
	zipWriter := zip.NewWriter(buf)

	for _, sessionID := range req.SessionIDs {
		sess, err := s.SessionMgr.GetSession(sessionID)
		if err != nil {
			log.Printf("Batch export: session %s not found", sessionID)
			continue
		}

		// Генерируем контент в нужном формате
		content, ext := s.generateExportContent(sess, req.Format)
		if content == "" {
			continue
		}

		// Формируем имя файла
		filename := s.generateExportFilename(sess, ext)

		// Добавляем файл в ZIP
		fileWriter, err := zipWriter.Create(filename)
		if err != nil {
			log.Printf("Batch export: failed to create zip entry: %v", err)
			continue
		}
		fileWriter.Write([]byte(content))
	}

	if err := zipWriter.Close(); err != nil {
		http.Error(w, "Failed to create ZIP", http.StatusInternalServerError)
		return
	}

	// Отправляем ZIP
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"aiwisper-export-%s.zip\"", time.Now().Format("2006-01-02")))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", buf.Len()))
	w.Write(buf.Bytes())
}

// generateExportFilename генерирует имя файла для экспорта
func (s *Server) generateExportFilename(sess *session.Session, ext string) string {
	title := sess.Title
	if title == "" {
		title = sess.StartTime.Format("2006-01-02_15-04")
	}
	// Очищаем имя от недопустимых символов
	title = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|' {
			return '_'
		}
		return r
	}, title)
	return fmt.Sprintf("%s.%s", title, ext)
}

// generateExportContent генерирует контент для экспорта в указанном формате
func (s *Server) generateExportContent(sess *session.Session, format string) (string, string) {
	// Собираем диалог из всех чанков
	var dialogue []session.TranscriptSegment
	for _, chunk := range sess.Chunks {
		if chunk.Status != session.ChunkStatusCompleted {
			continue
		}
		if len(chunk.Dialogue) > 0 {
			dialogue = append(dialogue, chunk.Dialogue...)
		} else if len(chunk.MicSegments) > 0 || len(chunk.SysSegments) > 0 {
			dialogue = append(dialogue, chunk.MicSegments...)
			dialogue = append(dialogue, chunk.SysSegments...)
		}
	}

	// Сортируем по времени
	sort.Slice(dialogue, func(i, j int) bool {
		return dialogue[i].Start < dialogue[j].Start
	})

	switch format {
	case "txt":
		return s.exportToTXT(sess, dialogue), "txt"
	case "srt":
		return s.exportToSRT(dialogue), "srt"
	case "vtt":
		return s.exportToVTT(dialogue), "vtt"
	case "json":
		return s.exportToJSON(sess, dialogue), "json"
	case "md":
		return s.exportToMarkdown(sess, dialogue), "md"
	default:
		return s.exportToTXT(sess, dialogue), "txt"
	}
}

// exportToTXT экспортирует в текстовый формат
func (s *Server) exportToTXT(sess *session.Session, dialogue []session.TranscriptSegment) string {
	var sb strings.Builder

	// Заголовок
	title := sess.Title
	if title == "" {
		title = "Запись " + sess.StartTime.Format("02.01.2006 15:04")
	}
	sb.WriteString(title + "\n")
	sb.WriteString(strings.Repeat("=", len(title)) + "\n\n")

	// Диалог
	for _, seg := range dialogue {
		speaker := formatSpeakerName(seg.Speaker)
		timeStr := formatTimestamp(seg.Start)
		sb.WriteString(fmt.Sprintf("[%s] %s: %s\n", timeStr, speaker, seg.Text))
	}

	return sb.String()
}

// exportToSRT экспортирует в формат субтитров SRT
func (s *Server) exportToSRT(dialogue []session.TranscriptSegment) string {
	var sb strings.Builder

	for i, seg := range dialogue {
		sb.WriteString(fmt.Sprintf("%d\n", i+1))
		sb.WriteString(fmt.Sprintf("%s --> %s\n", formatSRTTime(seg.Start), formatSRTTime(seg.End)))
		speaker := formatSpeakerName(seg.Speaker)
		sb.WriteString(fmt.Sprintf("%s: %s\n\n", speaker, seg.Text))
	}

	return sb.String()
}

// exportToVTT экспортирует в формат WebVTT
func (s *Server) exportToVTT(dialogue []session.TranscriptSegment) string {
	var sb strings.Builder

	sb.WriteString("WEBVTT\n\n")

	for i, seg := range dialogue {
		sb.WriteString(fmt.Sprintf("%d\n", i+1))
		sb.WriteString(fmt.Sprintf("%s --> %s\n", formatVTTTime(seg.Start), formatVTTTime(seg.End)))
		speaker := formatSpeakerName(seg.Speaker)
		sb.WriteString(fmt.Sprintf("<v %s>%s\n\n", speaker, seg.Text))
	}

	return sb.String()
}

// exportToJSON экспортирует в формат JSON
func (s *Server) exportToJSON(sess *session.Session, dialogue []session.TranscriptSegment) string {
	export := map[string]interface{}{
		"id":        sess.ID,
		"title":     sess.Title,
		"startTime": sess.StartTime,
		"duration":  sess.TotalDuration / time.Millisecond,
		"dialogue":  dialogue,
	}

	data, err := json.MarshalIndent(export, "", "  ")
	if err != nil {
		return "{}"
	}
	return string(data)
}

// exportToMarkdown экспортирует в формат Markdown
func (s *Server) exportToMarkdown(sess *session.Session, dialogue []session.TranscriptSegment) string {
	var sb strings.Builder

	// Заголовок
	title := sess.Title
	if title == "" {
		title = "Запись " + sess.StartTime.Format("02.01.2006 15:04")
	}
	sb.WriteString(fmt.Sprintf("# %s\n\n", title))
	sb.WriteString(fmt.Sprintf("**Дата:** %s\n\n", sess.StartTime.Format("02.01.2006 15:04")))
	sb.WriteString("---\n\n")

	// Диалог
	var currentSpeaker string
	for _, seg := range dialogue {
		speaker := formatSpeakerName(seg.Speaker)
		if speaker != currentSpeaker {
			if currentSpeaker != "" {
				sb.WriteString("\n")
			}
			sb.WriteString(fmt.Sprintf("**%s:**\n", speaker))
			currentSpeaker = speaker
		}
		sb.WriteString(fmt.Sprintf("> %s\n", seg.Text))
	}

	return sb.String()
}

// formatSpeakerName форматирует имя спикера
func formatSpeakerName(speaker string) string {
	switch speaker {
	case "mic":
		return "Вы"
	case "sys":
		return "Собеседник"
	default:
		if strings.HasPrefix(speaker, "Speaker ") {
			num := strings.TrimPrefix(speaker, "Speaker ")
			return "Собеседник " + num
		}
		return speaker
	}
}

// formatTimestamp форматирует timestamp в MM:SS
func formatTimestamp(ms int64) string {
	totalSec := ms / 1000
	min := totalSec / 60
	sec := totalSec % 60
	return fmt.Sprintf("%02d:%02d", min, sec)
}

// formatSRTTime форматирует время для SRT (HH:MM:SS,mmm)
func formatSRTTime(ms int64) string {
	h := ms / 3600000
	m := (ms % 3600000) / 60000
	s := (ms % 60000) / 1000
	msec := ms % 1000
	return fmt.Sprintf("%02d:%02d:%02d,%03d", h, m, s, msec)
}

// formatVTTTime форматирует время для VTT (HH:MM:SS.mmm)
func formatVTTTime(ms int64) string {
	h := ms / 3600000
	m := (ms % 3600000) / 60000
	s := (ms % 60000) / 1000
	msec := ms % 1000
	return fmt.Sprintf("%02d:%02d:%02d.%03d", h, m, s, msec)
}
