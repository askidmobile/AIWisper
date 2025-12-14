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

	// Кэш переименований спикеров для полной ретранскрипции
	// Ключ: sessionID, значение: map[стандартное_имя]пользовательское_имя
	speakerRenamesCache   map[string]map[string]string
	speakerRenamesCacheMu sync.RWMutex

	// Флаг активной полной ретранскрипции (не применять переименования после каждого чанка)
	fullRetranscribeActive   map[string]bool
	fullRetranscribeActiveMu sync.RWMutex

	// Кэш спикеров сессии для оптимизации производительности
	sessionSpeakersCache   map[string]sessionSpeakersCacheEntry
	sessionSpeakersCacheMu sync.RWMutex
}

// sessionSpeakersCacheEntry хранит кэшированные данные о спикерах
type sessionSpeakersCacheEntry struct {
	speakers   []voiceprint.SessionSpeaker
	chunkCount int       // Количество чанков на момент кэширования
	cachedAt   time.Time // Время кэширования
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
		speakerRenamesCache:           make(map[string]map[string]string),
		fullRetranscribeActive:        make(map[string]bool),
		sessionSpeakersCache:          make(map[string]sessionSpeakersCacheEntry),
	}
	s.setupCallbacks()
	return s
}

func (s *Server) Start() {
	go s.startGRPCServer()

	http.HandleFunc("/ws", s.handleWebSocket)
	http.HandleFunc("/api/sessions/", s.handleSessionsAPI)
	http.HandleFunc("/api/waveform/", s.handleWaveformAPI)
	http.HandleFunc("/api/import", s.handleImportAudio)
	http.HandleFunc("/api/export/batch", s.handleBatchExport)
	http.HandleFunc("/api/speaker-sample/", s.handleSpeakerSampleAPI)
	http.HandleFunc("/api/voiceprints/", s.handleVoiceprintsAPI)
	http.HandleFunc("/api/voiceprints", s.handleVoiceprintsAPI)

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
		// Проверяем, идёт ли полная ретранскрипция
		// Если да - не применяем переименования после каждого чанка (будет применено в конце)
		s.fullRetranscribeActiveMu.RLock()
		isFullRetranscribe := s.fullRetranscribeActive[chunk.SessionID]
		s.fullRetranscribeActiveMu.RUnlock()

		if !isFullRetranscribe {
			// Для одиночной ретранскрипции - применяем переименования сразу
			s.applyExistingSpeakerRenames(chunk.SessionID)

			// Перечитываем чанк после применения переименований
			if sess, err := s.SessionMgr.GetSession(chunk.SessionID); err == nil {
				for _, c := range sess.Chunks {
					if c.ID == chunk.ID {
						chunk = c
						break
					}
				}
			}
		}

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
		s.invalidateSessionSpeakersCache(msg.SessionID)
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

	case "search_sessions":
		params := session.SearchParams{
			Query: msg.SearchQuery,
		}
		results, total := s.SessionMgr.SearchSessions(params)
		searchResults := make([]SearchSessionInfo, len(results))
		for i, r := range results {
			searchResults[i] = SearchSessionInfo{
				SessionInfo: SessionInfo{
					ID:            r.Session.ID,
					StartTime:     r.Session.StartTime,
					Status:        string(r.Session.Status),
					TotalDuration: int64(r.Session.TotalDuration / time.Millisecond),
					ChunksCount:   len(r.Session.Chunks),
					Title:         r.Session.Title,
				},
				MatchedText:  r.MatchedText,
				MatchContext: r.MatchContext,
			}
		}
		send(Message{Type: "search_results", SearchResults: searchResults, TotalCount: total})

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
					OllamaModel:         msg.HybridOllamaModel,
					OllamaURL:           msg.HybridOllamaURL,
					Hotwords:            msg.HybridHotwords,
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
				// Дефолты для Ollama
				if hybridConfig.OllamaModel == "" {
					hybridConfig.OllamaModel = msg.OllamaModel // Берём из общих настроек
				}
				if hybridConfig.OllamaURL == "" {
					hybridConfig.OllamaURL = msg.OllamaUrl
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
				OllamaModel:         msg.HybridOllamaModel,
				OllamaURL:           msg.HybridOllamaURL,
				Hotwords:            msg.HybridHotwords,
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
			// Дефолты для Ollama
			if hybridConfig.OllamaModel == "" {
				hybridConfig.OllamaModel = msg.OllamaModel
			}
			if hybridConfig.OllamaURL == "" {
				hybridConfig.OllamaURL = msg.OllamaUrl
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
		log.Printf("Hybrid transcription: enabled=%v, secondaryModel=%s, threshold=%.2f, mode=%s, ollamaModel=%s, hotwords=%d",
			msg.HybridEnabled, msg.HybridSecondaryModelID, msg.HybridConfidenceThreshold, msg.HybridMode, msg.HybridOllamaModel, len(msg.HybridHotwords))

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
		log.Printf("Received retranscribe_chunk: sessionId=%s, chunkId=%s, model=%s, language=%s, hybrid=%v",
			msg.SessionID, msg.Data, msg.Model, msg.Language, msg.HybridEnabled)

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

		// Настраиваем гибридную транскрипцию если включена
		if msg.HybridEnabled && msg.HybridSecondaryModelID != "" {
			hybridConfig := &ai.HybridTranscriptionConfig{
				Enabled:             true,
				SecondaryModelID:    msg.HybridSecondaryModelID,
				ConfidenceThreshold: float32(msg.HybridConfidenceThreshold),
				ContextWords:        msg.HybridContextWords,
				UseLLMForMerge:      msg.HybridUseLLMForMerge,
				Mode:                ai.HybridMode(msg.HybridMode),
				OllamaModel:         msg.HybridOllamaModel,
				OllamaURL:           msg.HybridOllamaURL,
				Hotwords:            msg.HybridHotwords,
			}
			if hybridConfig.ConfidenceThreshold <= 0 {
				hybridConfig.ConfidenceThreshold = 0.7
			}
			if hybridConfig.ContextWords <= 0 {
				hybridConfig.ContextWords = 3
			}
			if hybridConfig.Mode == "" {
				hybridConfig.Mode = ai.HybridModeFullCompare
			}
			// Дефолты для Ollama
			if hybridConfig.OllamaModel == "" {
				hybridConfig.OllamaModel = msg.OllamaModel
			}
			if hybridConfig.OllamaURL == "" {
				hybridConfig.OllamaURL = msg.OllamaUrl
			}
			s.TranscriptionService.SetHybridConfig(hybridConfig)
			log.Printf("Hybrid transcription configured for retranscribe: mode=%s, secondary=%s, ollamaModel=%s, hotwords=%d",
				hybridConfig.Mode, hybridConfig.SecondaryModelID, hybridConfig.OllamaModel, len(hybridConfig.Hotwords))
		} else {
			s.TranscriptionService.SetHybridConfig(nil)
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

			// Кэшируем существующие переименования спикеров ПЕРЕД очисткой профилей
			// чтобы применить их в конце ретранскрипции
			cachedRenames := s.getExistingSpeakerRenames(sessionID)
			if len(cachedRenames) > 0 {
				s.speakerRenamesCacheMu.Lock()
				s.speakerRenamesCache[sessionID] = cachedRenames
				s.speakerRenamesCacheMu.Unlock()
				log.Printf("Full retranscription: cached %d speaker renames for session %s", len(cachedRenames), sessionID[:8])
			}

			// Устанавливаем флаг активной полной ретранскрипции
			s.fullRetranscribeActiveMu.Lock()
			s.fullRetranscribeActive[sessionID] = true
			s.fullRetranscribeActiveMu.Unlock()

			// Очищаем профили спикеров для сессии при полной ретранскрипции
			// чтобы начать сопоставление с чистого листа
			s.TranscriptionService.ClearSessionSpeakerProfiles(sessionID)

			if totalChunks == 0 {
				log.Printf("Full retranscription: no chunks to process")
				s.fullRetranscribeActiveMu.Lock()
				delete(s.fullRetranscribeActive, sessionID)
				s.fullRetranscribeActiveMu.Unlock()
				s.broadcast(Message{Type: "full_transcription_completed", SessionID: sessionID, Session: sess})
				return
			}

			log.Printf("Full retranscription: processing %d chunks (diarization=%v)", totalChunks, useDiarization)

			for i, chunk := range sess.Chunks {
				// Проверяем отмену перед каждым чанком
				select {
				case <-ctx.Done():
					log.Printf("Full retranscription cancelled for session %s at chunk %d/%d", sessionID, i+1, totalChunks)
					// Очищаем флаг и кэш при отмене
					s.fullRetranscribeActiveMu.Lock()
					delete(s.fullRetranscribeActive, sessionID)
					s.fullRetranscribeActiveMu.Unlock()
					s.speakerRenamesCacheMu.Lock()
					delete(s.speakerRenamesCache, sessionID)
					s.speakerRenamesCacheMu.Unlock()
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
				Data:      "Применение имён спикеров...",
			})

			// Снимаем флаг активной ретранскрипции
			s.fullRetranscribeActiveMu.Lock()
			delete(s.fullRetranscribeActive, sessionID)
			s.fullRetranscribeActiveMu.Unlock()

			// Применяем кэшированные переименования спикеров
			s.speakerRenamesCacheMu.RLock()
			finalRenames := s.speakerRenamesCache[sessionID]
			s.speakerRenamesCacheMu.RUnlock()

			if len(finalRenames) > 0 {
				log.Printf("Full retranscription: applying %d cached speaker renames", len(finalRenames))
				for oldName, newName := range finalRenames {
					if err := s.SessionMgr.UpdateSpeakerName(sessionID, oldName, newName); err == nil {
						log.Printf("Full retranscription: applied rename '%s' -> '%s'", oldName, newName)
					}
				}
				// Очищаем кэш переименований
				s.speakerRenamesCacheMu.Lock()
				delete(s.speakerRenamesCache, sessionID)
				s.speakerRenamesCacheMu.Unlock()
				// Инвалидируем кэш спикеров
				s.invalidateSessionSpeakersCache(sessionID)
			}

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

		// Очищаем флаг и кэш при отмене
		s.fullRetranscribeActiveMu.Lock()
		delete(s.fullRetranscribeActive, sessionID)
		s.fullRetranscribeActiveMu.Unlock()
		s.speakerRenamesCacheMu.Lock()
		delete(s.speakerRenamesCache, sessionID)
		s.speakerRenamesCacheMu.Unlock()

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
		log.Printf("get_session_speakers: sessionID=%s, found %d speakers", msg.SessionID, len(speakers))
		for i, sp := range speakers {
			log.Printf("  speaker[%d]: localID=%d, name=%s, isMic=%v, segments=%d, duration=%.1fs",
				i, sp.LocalID, sp.DisplayName, sp.IsMic, sp.SegmentCount, sp.TotalDuration)
		}
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

		// Инвалидируем кэш спикеров после переименования
		s.invalidateSessionSpeakersCache(msg.SessionID)

		// Если запрошено сохранение в глобальную базу
		var voiceprintID string
		if msg.SaveAsVoiceprint && s.VoicePrintStore != nil {
			log.Printf("[VoicePrint] Attempting to save voiceprint for speaker %d in session %s", msg.LocalSpeakerID, msg.SessionID)
			embedding, source, err := s.getSpeakerEmbedding(msg.SessionID, msg.LocalSpeakerID)
			if err != nil {
				log.Printf("[VoicePrint] Failed to get embedding: %v", err)
			} else if len(embedding) == 0 {
				log.Printf("[VoicePrint] Empty embedding returned")
			} else {
				vp, err := s.VoicePrintStore.Add(msg.SpeakerName, embedding, source)
				if err != nil {
					log.Printf("[VoicePrint] Failed to save: %v", err)
				} else {
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

// handleWaveformAPI обрабатывает GET/POST запросы для кешированных waveform данных
// GET /api/waveform/{sessionId} - получить кешированный waveform
// POST /api/waveform/{sessionId} - сохранить waveform в кеш
func (s *Server) handleWaveformAPI(w http.ResponseWriter, r *http.Request) {
	// CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	path := r.URL.Path[len("/api/waveform/"):]
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

	switch r.Method {
	case "GET":
		// Возвращаем кешированный waveform если есть
		if sess.Waveform == nil {
			w.WriteHeader(http.StatusNoContent) // 204 - нет кеша
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(sess.Waveform)

	case "POST":
		// Сохраняем waveform в кеш
		var waveform session.WaveformData
		if err := json.NewDecoder(r.Body).Decode(&waveform); err != nil {
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		sess.Waveform = &waveform
		// Сохраняем метаданные сессии на диск
		if err := s.SessionMgr.SaveSessionMeta(sess); err != nil {
			log.Printf("Failed to save waveform cache: %v", err)
			http.Error(w, "Failed to save", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
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
	if s.TranscriptionService == nil {
		return nil, "", fmt.Errorf("transcription service not available")
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

	// Для микрофона (localID = -1) нет embedding в диаризации
	// Микрофон обрабатывается отдельно и не проходит через диаризацию
	if localSpeakerID < 0 {
		return nil, source, fmt.Errorf("microphone speaker does not have embedding in diarization pipeline")
	}

	// Преобразуем localSpeakerID в globalSpeakerID
	// localSpeakerID: 0+ для sys спикеров (UI: "Собеседник 1" = localID 0)
	// globalSpeakerID в профилях: 1-based (1, 2, 3...)
	globalSpeakerID := localSpeakerID + 1

	// Сначала пробуем получить из сохранённых профилей сессии (память или диск)
	profiles, err := s.TranscriptionService.LoadSessionSpeakerProfiles(sessionID)
	if err != nil {
		log.Printf("[VoicePrint] getSpeakerEmbedding: failed to load profiles: %v", err)
	}
	for _, profile := range profiles {
		if profile.SpeakerID == globalSpeakerID {
			if len(profile.Embedding) > 0 {
				log.Printf("[VoicePrint] getSpeakerEmbedding: found embedding in session profiles for speaker %d", localSpeakerID)
				return profile.Embedding, source, nil
			}
		}
	}

	// Fallback: пробуем получить из Pipeline (если транскрипция ещё активна)
	if s.TranscriptionService.Pipeline != nil {
		embedding := s.TranscriptionService.Pipeline.GetSpeakerEmbedding(globalSpeakerID)
		if embedding != nil {
			log.Printf("[VoicePrint] getSpeakerEmbedding: found embedding in pipeline for speaker %d", localSpeakerID)
			return embedding, source, nil
		}
	}

	return nil, source, fmt.Errorf("speaker %d not found in session profiles or pipeline", localSpeakerID)
}

// getSessionSpeakers возвращает список спикеров в сессии (с кэшированием)
func (s *Server) getSessionSpeakers(sessionID string) []voiceprint.SessionSpeaker {
	sess, err := s.SessionMgr.GetSession(sessionID)
	if err != nil {
		return nil
	}

	chunkCount := len(sess.Chunks)

	// Проверяем кэш
	s.sessionSpeakersCacheMu.RLock()
	cached, ok := s.sessionSpeakersCache[sessionID]
	s.sessionSpeakersCacheMu.RUnlock()

	// Кэш валиден если количество чанков не изменилось и прошло менее 5 секунд
	if ok && cached.chunkCount == chunkCount && time.Since(cached.cachedAt) < 5*time.Second {
		return cached.speakers
	}

	// Вычисляем спикеров
	speakers := s.computeSessionSpeakers(sess, sessionID)

	// Сохраняем в кэш
	s.sessionSpeakersCacheMu.Lock()
	s.sessionSpeakersCache[sessionID] = sessionSpeakersCacheEntry{
		speakers:   speakers,
		chunkCount: chunkCount,
		cachedAt:   time.Now(),
	}
	s.sessionSpeakersCacheMu.Unlock()

	return speakers
}

// invalidateSessionSpeakersCache инвалидирует кэш спикеров для сессии
func (s *Server) invalidateSessionSpeakersCache(sessionID string) {
	s.sessionSpeakersCacheMu.Lock()
	delete(s.sessionSpeakersCache, sessionID)
	s.sessionSpeakersCacheMu.Unlock()
}

// computeSessionSpeakers вычисляет список спикеров (без кэширования)
func (s *Server) computeSessionSpeakers(sess *session.Session, sessionID string) []voiceprint.SessionSpeaker {
	var speakers []voiceprint.SessionSpeaker
	speakerMap := make(map[string]*voiceprint.SessionSpeaker)

	// Кэшируем профили спикеров один раз
	var profiles []service.SessionSpeakerProfile
	if s.TranscriptionService != nil {
		profiles = s.TranscriptionService.GetSessionSpeakerProfiles(sessionID)
	}

	// Вспомогательная функция для обработки сегмента
	processSpeaker := func(speaker string, duration int64) {
		if speaker == "" {
			return
		}

		localID := 0
		isMic := false
		displayName := speaker
		normalizedKey := speaker

		switch {
		case speaker == "mic" || speaker == "Вы":
			isMic = true
			localID = -1
			displayName = "Вы"
			normalizedKey = "mic"

		case speaker == "sys" || speaker == "Собеседник":
			localID = 0
			displayName = "Собеседник 1"
			normalizedKey = "speaker_0"

		case strings.HasPrefix(speaker, "Speaker "):
			var num int
			fmt.Sscanf(speaker, "Speaker %d", &num)
			localID = num
			displayName = fmt.Sprintf("Собеседник %d", num+1)
			normalizedKey = fmt.Sprintf("speaker_%d", num)

		case strings.HasPrefix(speaker, "Собеседник "):
			var num int
			fmt.Sscanf(speaker, "Собеседник %d", &num)
			localID = num - 1
			displayName = speaker
			normalizedKey = fmt.Sprintf("speaker_%d", num-1)

		default:
			// Кастомное имя - ищем в кэшированных профилях
			localID = -999
			displayName = speaker

			for _, profile := range profiles {
				if profile.RecognizedName == speaker {
					localID = profile.SpeakerID - 1
					normalizedKey = fmt.Sprintf("speaker_%d", localID)
					break
				}
			}

			if localID == -999 {
				existingSpeakerCount := 0
				for key := range speakerMap {
					if key != "mic" {
						existingSpeakerCount++
					}
				}
				localID = existingSpeakerCount
				normalizedKey = fmt.Sprintf("custom_%s", speaker)
			}
		}

		if _, ok := speakerMap[normalizedKey]; !ok {
			speakerMap[normalizedKey] = &voiceprint.SessionSpeaker{
				LocalID:      localID,
				DisplayName:  displayName,
				IsMic:        isMic,
				IsRecognized: false,
			}
		}

		sp := speakerMap[normalizedKey]
		sp.SegmentCount++
		sp.TotalDuration += float32(duration) / 1000.0
	}

	for _, chunk := range sess.Chunks {
		if len(chunk.Dialogue) > 0 {
			for _, seg := range chunk.Dialogue {
				processSpeaker(seg.Speaker, seg.End-seg.Start)
			}
		} else {
			for _, seg := range chunk.MicSegments {
				speaker := seg.Speaker
				if speaker == "" {
					speaker = "mic"
				}
				processSpeaker(speaker, seg.End-seg.Start)
			}
			for _, seg := range chunk.SysSegments {
				speaker := seg.Speaker
				if speaker == "" {
					speaker = "sys"
				}
				processSpeaker(speaker, seg.End-seg.Start)
			}
		}
	}

	// Проверяем распознанные имена
	for _, sp := range speakerMap {
		sp.HasSample = sp.TotalDuration >= 2.0

		if !sp.IsMic && s.TranscriptionService != nil {
			recognizedName := s.TranscriptionService.GetRecognizedSpeakerName(sessionID, sp.LocalID)
			if recognizedName != "" {
				sp.DisplayName = recognizedName
				sp.IsRecognized = true
			}
		}

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

	// ВАЖНО: Ищем текущее кастомное имя спикера через getSessionSpeakers
	// Это позволяет переименовывать уже переименованных спикеров
	speakers := s.getSessionSpeakers(sessionID)
	for _, sp := range speakers {
		if sp.LocalID == localSpeakerID && sp.DisplayName != "" && sp.DisplayName != newName {
			// Добавляем текущее имя первым в список для поиска
			oldNames = append([]string{sp.DisplayName}, oldNames...)
			log.Printf("renameSpeakerInSession: found current name '%s' for localID %d", sp.DisplayName, localSpeakerID)
			break
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

// getExistingSpeakerRenames возвращает map переименований спикеров в сессии
// Ключ: стандартное имя ("Собеседник 1", "Собеседник 2", etc.)
// Значение: пользовательское имя (если было переименовано)
func (s *Server) getExistingSpeakerRenames(sessionID string) map[string]string {
	renames := make(map[string]string)

	sess, err := s.SessionMgr.GetSession(sessionID)
	if err != nil {
		return renames
	}

	// Стандартные имена, которые мы ищем
	standardNames := map[string]bool{
		"Собеседник":   true,
		"Собеседник 1": true,
		"Собеседник 2": true,
		"Собеседник 3": true,
		"Собеседник 4": true,
		"Собеседник 5": true,
	}

	// Собираем все уникальные имена спикеров из диалогов
	speakerNames := make(map[string]bool)
	for _, chunk := range sess.Chunks {
		for _, seg := range chunk.Dialogue {
			if seg.Speaker != "" && seg.Speaker != "Вы" && seg.Speaker != "mic" {
				speakerNames[seg.Speaker] = true
			}
		}
	}

	// Стратегия 1: Используем профили спикеров из TranscriptionService
	// Профили содержат RecognizedName если спикер был распознан из voiceprint
	if s.TranscriptionService != nil {
		profiles := s.TranscriptionService.GetSessionSpeakerProfiles(sessionID)
		for _, profile := range profiles {
			if profile.RecognizedName != "" {
				// Спикер был распознан - это переименование
				standardName := fmt.Sprintf("Собеседник %d", profile.SpeakerID)
				renames[standardName] = profile.RecognizedName
				log.Printf("getExistingSpeakerRenames: from profile '%s' -> '%s'", standardName, profile.RecognizedName)
			}
		}
	}

	// Стратегия 2: Ищем пользовательские имена, которые заменили стандартные
	// Если есть пользовательское имя и нет соответствующего стандартного,
	// значит стандартное было переименовано
	for name := range speakerNames {
		if !standardNames[name] {
			// Это пользовательское имя
			// Пытаемся определить какой "Собеседник N" оно заменило
			// Проверяем какие стандартные имена отсутствуют
			for i := 1; i <= 5; i++ {
				standardName := fmt.Sprintf("Собеседник %d", i)
				if !speakerNames[standardName] {
					// Стандартное имя отсутствует - возможно оно было переименовано
					// Но только если у нас ещё нет переименования для этого стандартного имени
					if _, exists := renames[standardName]; !exists {
						renames[standardName] = name
						log.Printf("getExistingSpeakerRenames: inferred '%s' -> '%s'", standardName, name)
						break // Одно пользовательское имя может заменить только одно стандартное
					}
				}
			}
		}
	}

	return renames
}

// applyExistingSpeakerRenames применяет существующие переименования к сессии
// Вызывается после ретранскрипции чанка для восстановления пользовательских имён
func (s *Server) applyExistingSpeakerRenames(sessionID string) {
	renames := s.getExistingSpeakerRenames(sessionID)
	if len(renames) == 0 {
		return
	}

	// Применяем каждое переименование через UpdateSpeakerName
	for oldName, newName := range renames {
		if err := s.SessionMgr.UpdateSpeakerName(sessionID, oldName, newName); err == nil {
			log.Printf("applyExistingSpeakerRenames: applied rename '%s' -> '%s'", oldName, newName)
		}
	}

	// Инвалидируем кэш спикеров после применения переименований
	s.invalidateSessionSpeakersCache(sessionID)
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

// handleSpeakerSampleAPI отдаёт аудио-сэмпл спикера для прослушивания
// URL: /api/speaker-sample/{sessionID}/{localSpeakerID}
// Возвращает MP3 файл с первыми 5-10 секундами речи спикера
func (s *Server) handleSpeakerSampleAPI(w http.ResponseWriter, r *http.Request) {
	// CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Парсим URL: /api/speaker-sample/{sessionID}/{localSpeakerID}
	path := strings.TrimPrefix(r.URL.Path, "/api/speaker-sample/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 {
		http.Error(w, "Invalid path. Expected: /api/speaker-sample/{sessionID}/{localSpeakerID}", http.StatusBadRequest)
		return
	}

	sessionID := parts[0]
	var localSpeakerID int
	if _, err := fmt.Sscanf(parts[1], "%d", &localSpeakerID); err != nil {
		http.Error(w, "Invalid speaker ID", http.StatusBadRequest)
		return
	}

	log.Printf("Speaker sample request: session=%s, speaker=%d", sessionID, localSpeakerID)

	// Получаем сессию
	sess, err := s.SessionMgr.GetSession(sessionID)
	if err != nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	// Находим первый сегмент этого спикера для извлечения аудио
	var targetSegment *session.TranscriptSegment
	speakerNames := s.getSpeakerNamesForLocalIDInSession(sessionID, localSpeakerID)
	log.Printf("Looking for speaker sample with names: %v", speakerNames)

	for _, chunk := range sess.Chunks {
		for i := range chunk.Dialogue {
			seg := &chunk.Dialogue[i]
			for _, name := range speakerNames {
				if seg.Speaker == name && (seg.End-seg.Start) >= 2000 { // Минимум 2 секунды
					targetSegment = seg
					break
				}
			}
			if targetSegment != nil {
				break
			}
		}
		if targetSegment != nil {
			break
		}
	}

	if targetSegment == nil {
		http.Error(w, "No audio sample found for this speaker", http.StatusNotFound)
		return
	}

	// Извлекаем аудио сегмент из full.mp3
	mp3Path := filepath.Join(sess.DataDir, "full.mp3")
	if _, err := os.Stat(mp3Path); os.IsNotExist(err) {
		http.Error(w, "Audio file not found", http.StatusNotFound)
		return
	}

	// Ограничиваем длительность сэмпла до 10 секунд
	startMs := targetSegment.Start
	endMs := targetSegment.End
	if endMs-startMs > 10000 {
		endMs = startMs + 10000
	}

	startSec := float64(startMs) / 1000.0
	duration := float64(endMs-startMs) / 1000.0

	log.Printf("Extracting speaker sample: %.2fs - %.2fs (%.2fs duration)", startSec, startSec+duration, duration)

	// Используем ffmpeg для извлечения сегмента
	cmd := exec.Command(session.GetFFmpegPath(),
		"-ss", fmt.Sprintf("%.3f", startSec),
		"-i", mp3Path,
		"-t", fmt.Sprintf("%.3f", duration),
		"-c:a", "libmp3lame",
		"-q:a", "4", // Качество VBR
		"-f", "mp3",
		"pipe:1",
	)

	output, err := cmd.Output()
	if err != nil {
		log.Printf("FFmpeg error extracting speaker sample: %v", err)
		http.Error(w, "Failed to extract audio sample", http.StatusInternalServerError)
		return
	}

	// Отправляем MP3
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(output)))
	w.Header().Set("Cache-Control", "public, max-age=3600") // Кэшируем на час
	w.Write(output)
}

// getSpeakerNamesForLocalID возвращает все возможные имена спикера по localID
func (s *Server) getSpeakerNamesForLocalID(localSpeakerID int) []string {
	if localSpeakerID < 0 {
		return []string{"Вы", "mic"}
	}
	return []string{
		fmt.Sprintf("Speaker %d", localSpeakerID),
		fmt.Sprintf("Собеседник %d", localSpeakerID+1),
		"Собеседник", // Для случая единственного собеседника
		"sys",
	}
}

// getSpeakerNamesForLocalIDInSession возвращает все возможные имена спикера по localID,
// включая кастомные имена из сессии
func (s *Server) getSpeakerNamesForLocalIDInSession(sessionID string, localSpeakerID int) []string {
	// Начинаем со стандартных имён
	names := s.getSpeakerNamesForLocalID(localSpeakerID)

	// ВАЖНО: Используем getSessionSpeakers для получения правильного маппинга localID -> displayName
	// Это гарантирует корректное сопоставление даже для переименованных спикеров
	speakers := s.getSessionSpeakers(sessionID)
	for _, sp := range speakers {
		if sp.LocalID == localSpeakerID && sp.DisplayName != "" {
			// Добавляем актуальное имя первым в список для поиска
			// Это обеспечивает приоритет кастомного имени над стандартными
			found := false
			for _, existing := range names {
				if existing == sp.DisplayName {
					found = true
					break
				}
			}
			if !found {
				names = append([]string{sp.DisplayName}, names...)
				log.Printf("getSpeakerNamesForLocalIDInSession: added displayName '%s' for localID %d", sp.DisplayName, localSpeakerID)
			}
			break
		}
	}

	return names
}

// handleVoiceprintsAPI обрабатывает HTTP запросы для управления голосовыми отпечатками
// GET /api/voiceprints - получить список всех voiceprints
// GET /api/voiceprints/{id} - получить конкретный voiceprint
// PATCH /api/voiceprints/{id} - обновить voiceprint (переименовать)
// DELETE /api/voiceprints/{id} - удалить voiceprint
func (s *Server) handleVoiceprintsAPI(w http.ResponseWriter, r *http.Request) {
	// CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Проверяем наличие VoicePrintStore
	if s.VoicePrintStore == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{"voiceprints": []interface{}{}})
		return
	}

	// Парсим путь: /api/voiceprints или /api/voiceprints/{id}
	path := strings.TrimPrefix(r.URL.Path, "/api/voiceprints")
	path = strings.TrimPrefix(path, "/")

	switch r.Method {
	case "GET":
		if path == "" {
			// GET /api/voiceprints - список всех
			voiceprints := s.VoicePrintStore.GetAll()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{"voiceprints": voiceprints})
		} else {
			// GET /api/voiceprints/{id} - конкретный voiceprint
			vp, err := s.VoicePrintStore.Get(path)
			if err != nil {
				http.Error(w, "Voiceprint not found", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(vp)
		}

	case "PATCH":
		if path == "" {
			http.Error(w, "Voiceprint ID required", http.StatusBadRequest)
			return
		}
		// Парсим тело запроса
		var req struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}
		if req.Name == "" {
			http.Error(w, "Name is required", http.StatusBadRequest)
			return
		}
		// Обновляем имя
		if err := s.VoicePrintStore.UpdateName(path, req.Name); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Возвращаем обновлённый voiceprint
		vp, _ := s.VoicePrintStore.Get(path)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(vp)

	case "DELETE":
		if path == "" {
			http.Error(w, "Voiceprint ID required", http.StatusBadRequest)
			return
		}
		if err := s.VoicePrintStore.Delete(path); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}
