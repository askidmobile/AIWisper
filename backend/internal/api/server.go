package api

import (
	"aiwisper/ai"
	"aiwisper/audio"
	"aiwisper/internal/config"
	"aiwisper/internal/service"
	"aiwisper/models"
	"aiwisper/session"
	"encoding/json"
	"fmt"
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

type Server struct {
	Config               *config.Config
	SessionMgr           *session.Manager
	EngineMgr            *ai.EngineManager
	ModelMgr             *models.Manager
	Capture              *audio.Capture
	TranscriptionService *service.TranscriptionService
	RecordingService     *service.RecordingService
	LLMService           *service.LLMService

	clients map[*websocket.Conn]bool
	mu      sync.Mutex
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
		clients:              make(map[*websocket.Conn]bool),
	}
	s.setupCallbacks()
	return s
}

func (s *Server) Start() {
	http.HandleFunc("/ws", s.handleWebSocket)
	http.HandleFunc("/api/sessions/", s.handleSessionsAPI)

	log.Printf("Backend listening on :%s", s.Config.Port)
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
	defer s.mu.Unlock()

	// Fast path check
	if len(s.clients) == 0 {
		return
	}

	// Broadcast
	for conn := range s.clients {
		// Gorilla websocket WriteJSON is not concurrent safe per connection,
		// but here we serve strict separation or we need locks per conn if writing concurrently?
		// WriteJSON locks internally? No.
		// BUT we are in s.mu.Lock(), so we serialize writes to ALL clients.
		// Ideally we should have a write pump per client.
		// For now, simple implementation logic from main.go (which was single threaded per conn).
		// Since we have multiple sources (callbacks), we need protection.
		// The simplest way is global lock for broadcast which we have.

		if err := conn.WriteJSON(msg); err != nil {
			log.Printf("Write error: %v", err)
			conn.Close()
			delete(s.clients, conn)
		}
	}
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade:", err)
		return
	}

	s.mu.Lock()
	s.clients[conn] = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.clients, conn)
		s.mu.Unlock()
		conn.Close()
	}()

	for {
		var msg Message
		err := conn.ReadJSON(&msg)
		if err != nil {
			log.Println("Read:", err)
			break
		}
		s.processMessage(conn, msg)
	}
}

func (s *Server) processMessage(conn *websocket.Conn, msg Message) {
	switch msg.Type {
	case "get_devices":
		devices, err := s.Capture.ListDevices()
		if err != nil {
			conn.WriteJSON(Message{Type: "error", Data: err.Error()})
			return
		}
		conn.WriteJSON(Message{
			Type:                      "devices",
			Devices:                   devices,
			ScreenCaptureKitAvailable: audio.ScreenCaptureKitAvailable(),
		})

	case "get_models":
		modelStates := s.ModelMgr.GetAllModelsState()
		conn.WriteJSON(Message{
			Type:   "models_list",
			Models: modelStates,
		})

	case "download_model":
		if msg.ModelID == "" {
			conn.WriteJSON(Message{Type: "error", Data: "modelId is required"})
			return
		}
		if err := s.ModelMgr.DownloadModel(msg.ModelID); err != nil {
			conn.WriteJSON(Message{Type: "error", Data: err.Error()})
			return
		}
		conn.WriteJSON(Message{Type: "download_started", ModelID: msg.ModelID})

	case "cancel_download":
		if msg.ModelID == "" {
			conn.WriteJSON(Message{Type: "error", Data: "modelId is required"})
			return
		}
		s.ModelMgr.CancelDownload(msg.ModelID)
		conn.WriteJSON(Message{Type: "download_cancelled", ModelID: msg.ModelID})

	case "delete_model":
		if msg.ModelID == "" {
			conn.WriteJSON(Message{Type: "error", Data: "modelId is required"})
			return
		}
		s.ModelMgr.DeleteModel(msg.ModelID)
		conn.WriteJSON(Message{Type: "model_deleted", ModelID: msg.ModelID})
		conn.WriteJSON(Message{Type: "models_list", Models: s.ModelMgr.GetAllModelsState()})

	case "set_active_model":
		if msg.ModelID == "" {
			conn.WriteJSON(Message{Type: "error", Data: "modelId is required"})
			return
		}
		if !s.ModelMgr.IsModelDownloaded(msg.ModelID) {
			conn.WriteJSON(Message{Type: "error", Data: "model not downloaded"})
			return
		}
		if s.EngineMgr != nil {
			if err := s.EngineMgr.SetActiveModel(msg.ModelID); err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				return
			}
			// Обновляем transcriber в Pipeline если диаризация включена
			s.updatePipelineTranscriber()
		}
		conn.WriteJSON(Message{Type: "active_model_changed", ModelID: msg.ModelID})
		conn.WriteJSON(Message{Type: "models_list", Models: s.ModelMgr.GetAllModelsState()})

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
		conn.WriteJSON(Message{Type: "sessions_list", Sessions: infos})

	case "get_session":
		sess, err := s.SessionMgr.GetSession(msg.SessionID)
		if err != nil {
			conn.WriteJSON(Message{Type: "error", Data: err.Error()})
			return
		}
		conn.WriteJSON(Message{Type: "session_details", Session: sess})

	case "delete_session":
		s.SessionMgr.DeleteSession(msg.SessionID)
		conn.WriteJSON(Message{Type: "session_deleted", SessionID: msg.SessionID})

	case "start_session":
		// Configure Engine Model first, then Language
		if s.EngineMgr != nil {
			if msg.Model != "" {
				if !s.ModelMgr.IsModelDownloaded(msg.Model) {
					log.Printf("start_session: model %s is not downloaded", msg.Model)
					conn.WriteJSON(Message{Type: "error", Data: fmt.Sprintf("Model %s is not downloaded", msg.Model)})
					return
				}
				if err := s.EngineMgr.SetActiveModel(msg.Model); err != nil {
					log.Printf("start_session: failed to set active model %s: %v", msg.Model, err)
					conn.WriteJSON(Message{Type: "error", Data: fmt.Sprintf("Failed to load model %s: %v", msg.Model, err)})
					return
				}
				log.Printf("start_session: model %s activated successfully", msg.Model)
				// Обновляем transcriber в Pipeline если диаризация включена
				s.updatePipelineTranscriber()
			} else {
				// Если модель не указана, проверяем есть ли активный движок
				if s.EngineMgr.GetActiveEngine() == nil {
					log.Printf("start_session: no model specified and no active engine")
					conn.WriteJSON(Message{Type: "error", Data: "No model selected. Please select a model in settings."})
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
			DisableVAD:    msg.DisableVAD,
		}

		// Echo Cancel default 0.4
		ec := float32(0.4)
		if msg.EchoCancel > 0 {
			ec = float32(msg.EchoCancel)
		}

		// Сбрасываем состояние диаризации (спикеров) перед новой сессией
		if s.TranscriptionService != nil {
			s.TranscriptionService.ResetDiarizationState()
		}

		sess, err := s.RecordingService.StartSession(config, ec, msg.UseVoiceIsolation)
		if err != nil {
			conn.WriteJSON(Message{Type: "error", Data: err.Error()})
			return
		}
		conn.WriteJSON(Message{Type: "session_started", Session: sess})

	case "stop_session":
		sess, err := s.RecordingService.StopSession()
		if err != nil {
			conn.WriteJSON(Message{Type: "error", Data: err.Error()})
			return
		}
		conn.WriteJSON(Message{Type: "session_stopped", Session: sess})

	case "generate_summary":
		if s.LLMService == nil {
			conn.WriteJSON(Message{Type: "error", Data: "LLM Service not available"})
			return
		}

		conn.WriteJSON(Message{Type: "summary_started", SessionID: msg.SessionID})

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
			conn.WriteJSON(Message{Type: "error", Data: "Transcription service not available"})
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
			conn.WriteJSON(Message{Type: "auto_improve_status", AutoImproveEnabled: true, OllamaModel: model, OllamaUrl: url})
		} else {
			s.TranscriptionService.DisableAutoImprove()
			conn.WriteJSON(Message{Type: "auto_improve_status", AutoImproveEnabled: false})
		}
		log.Printf("Auto-improve: enabled=%v, model=%s, url=%s", msg.AutoImproveEnabled, msg.OllamaModel, msg.OllamaUrl)

	case "get_auto_improve_status":
		// Получить текущий статус автоулучшения
		if s.TranscriptionService == nil {
			conn.WriteJSON(Message{Type: "auto_improve_status", AutoImproveEnabled: false})
			return
		}
		conn.WriteJSON(Message{
			Type:               "auto_improve_status",
			AutoImproveEnabled: s.TranscriptionService.AutoImproveWithLLM,
			OllamaModel:        s.TranscriptionService.OllamaModel,
			OllamaUrl:          s.TranscriptionService.OllamaURL,
		})

	case "get_ollama_models":
		if s.LLMService == nil {
			conn.WriteJSON(Message{Type: "error", Data: "LLM Service not available"})
			return
		}
		url := msg.OllamaUrl
		if url == "" {
			url = "http://localhost:11434"
		}
		models, err := s.LLMService.GetOllamaModels(url)
		if err != nil {
			conn.WriteJSON(Message{Type: "ollama_models", Error: err.Error()})
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
		conn.WriteJSON(Message{Type: "ollama_models", OllamaModels: apiModels})

	case "improve_transcription":
		if s.LLMService == nil {
			conn.WriteJSON(Message{Type: "error", Data: "LLM Service not available"})
			return
		}
		conn.WriteJSON(Message{Type: "improve_started", SessionID: msg.SessionID})

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

	case "retranscribe_chunk":
		log.Printf("Received retranscribe_chunk: sessionId=%s, chunkId=%s, model=%s, language=%s",
			msg.SessionID, msg.Data, msg.Model, msg.Language)

		if msg.SessionID == "" || msg.Data == "" {
			conn.WriteJSON(Message{Type: "error", Data: "sessionId and chunkId (data) are required"})
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
			conn.WriteJSON(Message{Type: "error", Data: "sessionId is required"})
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

		// Сохраняем флаг использования диаризации для ретранскрибации
		useDiarization := msg.DiarizationEnabled && s.TranscriptionService.IsDiarizationEnabled()

		// Сбрасываем состояние диаризации (спикеров) перед полной ретранскрипцией
		if useDiarization {
			s.TranscriptionService.ResetDiarizationState()
		}

		// Отправляем через broadcast для всех клиентов
		log.Printf("Sending full_transcription_started for session %s (diarization=%v)", msg.SessionID, useDiarization)
		s.broadcast(Message{Type: "full_transcription_started", SessionID: msg.SessionID})

		go func() {
			sess, err := s.SessionMgr.GetSession(msg.SessionID)
			if err != nil {
				log.Printf("Full retranscription error: %v", err)
				s.broadcast(Message{Type: "full_transcription_error", SessionID: msg.SessionID, Error: err.Error()})
				return
			}

			totalChunks := len(sess.Chunks)
			if totalChunks == 0 {
				log.Printf("Full retranscription: no chunks to process")
				s.broadcast(Message{Type: "full_transcription_completed", SessionID: msg.SessionID, Session: sess})
				return
			}

			log.Printf("Full retranscription: processing %d chunks (diarization=%v)", totalChunks, useDiarization)

			for i, chunk := range sess.Chunks {
				// Отправляем прогресс
				progress := float64(i) / float64(totalChunks)
				log.Printf("Full retranscription progress: %d/%d (%.1f%%)", i+1, totalChunks, progress*100)
				s.broadcast(Message{
					Type:      "full_transcription_progress",
					SessionID: msg.SessionID,
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
				SessionID: msg.SessionID,
				Progress:  1.0,
				Data:      "Завершение...",
			})

			updatedSess, _ := s.SessionMgr.GetSession(msg.SessionID)
			log.Printf("Full retranscription completed for session %s", msg.SessionID)
			s.broadcast(Message{Type: "full_transcription_completed", SessionID: msg.SessionID, Session: updatedSess})
		}()

	case "enable_diarization":
		// Provider: "auto" (default), "cpu", "coreml", "cuda"
		// "auto" автоматически выберет лучший: coreml на Apple Silicon, cpu иначе
		provider := msg.DiarizationProvider
		if provider == "" {
			provider = "auto"
		}
		log.Printf("Received enable_diarization: provider=%s, segmentation=%s, embedding=%s",
			provider, msg.SegmentationModelPath, msg.EmbeddingModelPath)

		if msg.SegmentationModelPath == "" || msg.EmbeddingModelPath == "" {
			conn.WriteJSON(Message{Type: "diarization_error", Error: "segmentationModelPath and embeddingModelPath are required"})
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
					conn.WriteJSON(Message{Type: "diarization_error", Error: fmt.Sprintf("Не удалось загрузить модель транскрипции: %v", err)})
					return
				}
			} else {
				conn.WriteJSON(Message{Type: "diarization_error", Error: "Не выбрана модель транскрипции. Выберите модель в настройках."})
				return
			}
		}

		err := s.TranscriptionService.EnableDiarizationWithProvider(
			msg.SegmentationModelPath, msg.EmbeddingModelPath, provider)
		if err != nil {
			log.Printf("Failed to enable diarization: %v", err)
			conn.WriteJSON(Message{Type: "diarization_error", Error: err.Error()})
			return
		}

		actualProvider := s.TranscriptionService.GetDiarizationProvider()
		conn.WriteJSON(Message{
			Type:                "diarization_enabled",
			DiarizationEnabled:  true,
			DiarizationProvider: actualProvider,
		})

	case "disable_diarization":
		log.Printf("Received disable_diarization")
		s.TranscriptionService.DisableDiarization()
		conn.WriteJSON(Message{Type: "diarization_disabled", DiarizationEnabled: false})

	case "get_diarization_status":
		enabled := s.TranscriptionService.IsDiarizationEnabled()
		provider := s.TranscriptionService.GetDiarizationProvider()
		conn.WriteJSON(Message{
			Type:                "diarization_status",
			DiarizationEnabled:  enabled,
			DiarizationProvider: provider,
		})
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
