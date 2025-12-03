package main

import (
	"aiwisper/ai"
	"aiwisper/audio"
	"aiwisper/models"
	"aiwisper/session"
	"bytes"
	"encoding/json"
	"flag"
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

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// convertSegments конвертирует сегменты из ai в session
func convertSegments(aiSegs []ai.TranscriptSegment, speaker string) []session.TranscriptSegment {
	result := make([]session.TranscriptSegment, len(aiSegs))
	for i, seg := range aiSegs {
		result[i] = session.TranscriptSegment{
			Start:   seg.Start,
			End:     seg.End,
			Text:    seg.Text,
			Speaker: speaker,
			Words:   convertWords(seg.Words, speaker, 0),
		}
	}
	return result
}

// convertSegmentsWithGlobalOffset конвертирует сегменты из ai в session с добавлением глобального offset чанка
// chunkStartMs - время начала чанка относительно начала всей записи (в миллисекундах)
// Это критически важно для правильного отображения временных меток в диалоге
func convertSegmentsWithGlobalOffset(aiSegs []ai.TranscriptSegment, speaker string, chunkStartMs int64) []session.TranscriptSegment {
	result := make([]session.TranscriptSegment, len(aiSegs))
	for i, seg := range aiSegs {
		result[i] = session.TranscriptSegment{
			Start:   seg.Start + chunkStartMs, // Добавляем глобальный offset
			End:     seg.End + chunkStartMs,   // Добавляем глобальный offset
			Text:    seg.Text,
			Speaker: speaker,
			Words:   convertWords(seg.Words, speaker, chunkStartMs),
		}
	}
	return result
}

// convertWords конвертирует слова из ai в session с добавлением глобального offset
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

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Message WebSocket сообщение
type Message struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`

	// Для start_session
	Language          string  `json:"language,omitempty"`
	Model             string  `json:"model,omitempty"`
	MicDevice         string  `json:"micDevice,omitempty"`
	SystemDevice      string  `json:"systemDevice,omitempty"`
	CaptureSystem     bool    `json:"captureSystem,omitempty"`
	UseNative         bool    `json:"useNativeCapture,omitempty"`
	UseVoiceIsolation bool    `json:"useVoiceIsolation,omitempty"` // Использовать Voice Isolation (macOS 15+)
	EchoCancel        float64 `json:"echoCancel,omitempty"`        // Коэффициент эхоподавления 0.0-1.0

	// Для ответов
	Session   *session.Session `json:"session,omitempty"`
	Sessions  []*SessionInfo   `json:"sessions,omitempty"`
	Chunk     *session.Chunk   `json:"chunk,omitempty"`
	SessionID string           `json:"sessionId,omitempty"`

	// Audio levels
	MicLevel    float64 `json:"micLevel,omitempty"`
	SystemLevel float64 `json:"systemLevel,omitempty"`

	// Devices
	Devices                   []audio.AudioDevice `json:"devices,omitempty"`
	ScreenCaptureKitAvailable bool                `json:"screenCaptureKitAvailable,omitempty"`

	// Models
	Models   []models.ModelState `json:"models,omitempty"`
	ModelID  string              `json:"modelId,omitempty"`
	Progress float64             `json:"progress,omitempty"`
	Error    string              `json:"error,omitempty"`

	// Summary
	Summary string `json:"summary,omitempty"`

	// Ollama settings
	OllamaModel  string        `json:"ollamaModel,omitempty"`
	OllamaUrl    string        `json:"ollamaUrl,omitempty"`
	OllamaModels []OllamaModel `json:"ollamaModels,omitempty"` // Список доступных моделей Ollama
}

// OllamaModel информация о модели Ollama
type OllamaModel struct {
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	IsCloud    bool   `json:"isCloud"`    // Cloud модель (remote)
	Family     string `json:"family"`     // Семейство модели
	Parameters string `json:"parameters"` // Размер параметров (3.2B, 8B, etc)
}

// SessionInfo краткая информация о сессии для списка
type SessionInfo struct {
	ID            string    `json:"id"`
	StartTime     time.Time `json:"startTime"`
	Status        string    `json:"status"`
	TotalDuration int64     `json:"totalDuration"`
	ChunksCount   int       `json:"chunksCount"`
}

func main() {
	log.Println("AIWisper backend starting...")

	modelPath := flag.String("model", "ggml-base.bin", "Path to Whisper model")
	dataDir := flag.String("data", "data/sessions", "Directory for session data")
	modelsDir := flag.String("models", "", "Directory for downloaded models (default: dataDir/../models)")
	flag.Parse()

	log.Printf("Model path: %s", *modelPath)
	log.Printf("Data directory: %s", *dataDir)

	// Определяем директорию для моделей
	modelsDirPath := *modelsDir
	if modelsDirPath == "" {
		modelsDirPath = filepath.Join(filepath.Dir(*dataDir), "models")
	}
	log.Printf("Models directory: %s", modelsDirPath)

	// Initialize Audio
	log.Println("Initializing audio capture...")
	capture, err := audio.NewCapture()
	if err != nil {
		log.Fatalf("Failed to init audio: %v", err)
	}

	// Initialize Session Manager
	log.Println("Initializing session manager...")
	sessionMgr, err := session.NewManager(*dataDir)
	if err != nil {
		log.Fatalf("Failed to init session manager: %v", err)
	}
	log.Println("Session manager initialized")

	// Initialize Model Manager
	log.Println("Initializing model manager...")
	modelMgr, err := models.NewManager(modelsDirPath)
	if err != nil {
		log.Fatalf("Failed to init model manager: %v", err)
	}
	log.Println("Model manager initialized")

	// Initialize Engine Manager
	log.Println("Initializing engine manager...")
	engineMgr := ai.NewEngineManager(modelMgr)
	defer engineMgr.Close()

	// Пытаемся загрузить модель по умолчанию
	log.Println("Loading default model...")
	if _, err := os.Stat(*modelPath); err == nil {
		// Если указанный путь существует - это legacy режим с прямым путём к модели
		whisperEngine, err := ai.NewWhisperEngine(*modelPath)
		if err != nil {
			log.Printf("Warning: Failed to load Whisper model from path: %v", err)
		} else {
			log.Println("Whisper model loaded successfully (legacy mode)")
			// В legacy режиме используем прямой движок
			// TODO: интегрировать в EngineManager
			_ = whisperEngine
		}
	}

	// Пробуем загрузить рекомендуемую модель из менеджера
	activeModelID := modelMgr.GetActiveModel()
	if activeModelID == "" {
		// Ищем первую скачанную модель
		for _, state := range modelMgr.GetAllModelsState() {
			if state.Status == models.ModelStatusDownloaded || state.Status == models.ModelStatusActive {
				activeModelID = state.ID
				break
			}
		}
	}

	if activeModelID != "" {
		if err := engineMgr.SetActiveModel(activeModelID); err != nil {
			log.Printf("Warning: Failed to activate model %s: %v", activeModelID, err)
		} else {
			log.Printf("Model %s activated successfully", activeModelID)
		}
	} else {
		log.Println("No downloaded models found. Please download a model first.")
	}

	// HTTP handlers
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("Upgrade:", err)
			return
		}
		defer conn.Close()
		handleConnection(conn, capture, engineMgr, sessionMgr, modelMgr)
	})

	// Static file serving for audio files
	http.HandleFunc("/api/sessions/", func(w http.ResponseWriter, r *http.Request) {
		handleSessionsAPI(w, r, sessionMgr)
	})

	port := "8080"
	fmt.Printf("Backend listening on :%s\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal("ListenAndServe:", err)
	}
}

func handleSessionsAPI(w http.ResponseWriter, r *http.Request, mgr *session.Manager) {
	// File server для аудио файлов (MP3 и WAV для совместимости)
	path := r.URL.Path[len("/api/sessions/"):]

	// Если path пустой - это запрос списка сессий
	if path == "" {
		handleSessionsList(w, r, mgr)
		return
	}

	// Парсим путь: {sessionId}/full.mp3 или {sessionId}/chunk/{chunkIndex}.mp3
	if len(path) < 36 {
		http.NotFound(w, r)
		return
	}

	sessionID := path[:36]
	sess, err := mgr.GetSession(sessionID)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	requestedFile := path[37:] // Всё после ID сессии

	// Проверяем запрос на конкретный чанк: chunk/{index}.mp3
	if strings.HasPrefix(requestedFile, "chunk/") {
		// Извлекаем номер чанка
		chunkPart := strings.TrimPrefix(requestedFile, "chunk/")
		chunkPart = strings.TrimSuffix(chunkPart, ".mp3")

		var chunkIndex int
		if _, err := fmt.Sscanf(chunkPart, "%d", &chunkIndex); err != nil {
			http.NotFound(w, r)
			return
		}

		// Ищем чанк по индексу
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

		// Извлекаем фрагмент из full.mp3 и отдаём как MP3
		mp3Path := filepath.Join(sess.DataDir, "full.mp3")
		if _, err := os.Stat(mp3Path); os.IsNotExist(err) {
			http.NotFound(w, r)
			return
		}

		// Извлекаем фрагмент через FFmpeg и отдаём напрямую
		startSec := float64(targetChunk.StartMs) / 1000.0
		endSec := float64(targetChunk.EndMs) / 1000.0
		duration := endSec - startSec

		cmd := exec.Command(session.GetFFmpegPath(),
			"-ss", fmt.Sprintf("%.3f", startSec),
			"-i", mp3Path,
			"-t", fmt.Sprintf("%.3f", duration),
			"-c:a", "copy", // копируем без перекодирования
			"-f", "mp3",
			"pipe:1",
		)

		output, err := cmd.Output()
		if err != nil {
			log.Printf("Failed to extract chunk %d: %v", chunkIndex, err)
			http.Error(w, "Failed to extract chunk", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(output)))
		w.Write(output)
		return
	}

	// Обычный файл (full.mp3 или full.wav)
	filePath := filepath.Join(sess.DataDir, requestedFile)

	// Если запрашивают WAV но есть только MP3, отдаём MP3
	if strings.HasSuffix(requestedFile, ".wav") {
		mp3Path := strings.TrimSuffix(filePath, ".wav") + ".mp3"
		if _, err := os.Stat(mp3Path); err == nil {
			filePath = mp3Path
		}
	}

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		http.NotFound(w, r)
		return
	}

	// Определяем Content-Type
	contentType := "audio/wav"
	if strings.HasSuffix(filePath, ".mp3") {
		contentType = "audio/mpeg"
	}

	w.Header().Set("Content-Type", contentType)
	http.ServeFile(w, r, filePath)
}

// handleSessionsList возвращает список всех сессий в JSON формате
func handleSessionsList(w http.ResponseWriter, r *http.Request, mgr *session.Manager) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sessions := mgr.ListSessions()
	infos := make([]*SessionInfo, len(sessions))
	for i, s := range sessions {
		infos[i] = &SessionInfo{
			ID:            s.ID,
			StartTime:     s.StartTime,
			Status:        string(s.Status),
			TotalDuration: int64(s.TotalDuration / time.Millisecond),
			ChunksCount:   len(s.Chunks),
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(infos)
}

func handleConnection(conn *websocket.Conn, capture *audio.Capture, engineMgr *ai.EngineManager, sessionMgr *session.Manager, modelMgr *models.Manager) {
	var mu sync.Mutex
	var currentSession *session.Session
	var mp3Writer *session.MP3Writer // MP3 вместо WAV для экономии места
	var chunkBuffer *session.ChunkBuffer
	var stopChan chan struct{}
	var sessionUseVoiceIsolation bool // Флаг режима Voice Isolation для текущей сессии

	// Семафор для ограничения параллельных транскрипций (только 1 одновременно)
	// Это предотвращает перегрузку GPU/CPU при использовании тяжёлых моделей
	transcriptionSem := make(chan struct{}, 1)

	// Канал для отмены полной ретранскрипции и WaitGroup для ожидания завершения
	var fullTranscriptionCancel chan struct{}
	var fullTranscriptionMu sync.Mutex
	var fullTranscriptionWg sync.WaitGroup

	// Callback для прогресса скачивания моделей
	modelMgr.SetProgressCallback(func(modelID string, progress float64, status models.ModelStatus, err error) {
		errStr := ""
		if err != nil {
			errStr = err.Error()
		}
		conn.WriteJSON(Message{
			Type:     "model_progress",
			ModelID:  modelID,
			Progress: progress,
			Data:     string(status),
			Error:    errStr,
		})
	})

	// Callback для готовых чанков - транскрибируем
	sessionMgr.SetOnChunkReady(func(chunk *session.Chunk) {
		if engineMgr == nil {
			log.Printf("Engine is nil, skipping transcription for chunk %s", chunk.ID)
			return
		}

		sessID := chunk.SessionID
		chunkID := chunk.ID

		// Отправляем уведомление о новом чанке
		conn.WriteJSON(Message{
			Type:      "chunk_created",
			SessionID: sessID,
			Chunk:     chunk,
		})

		// Проверяем наличие WAV файлов (созданы во время записи)
		hasSeparateWAV := chunk.MicFilePath != "" && chunk.SysFilePath != ""
		hasMixWAV := chunk.FilePath != ""

		// Транскрибируем асинхронно
		go func() {
			log.Printf("Starting transcription for chunk %d (session %s), separate=%v, mix=%v",
				chunk.Index, sessID, hasSeparateWAV, hasMixWAV)

			if hasSeparateWAV {
				// Раздельная транскрипция mic и system из WAV файлов
				var micText, sysText string
				var micSegments, sysSegments []ai.TranscriptSegment
				var wg sync.WaitGroup
				var micErr, sysErr error

				wg.Add(2)

				// Считываем оба канала сначала для определения offset
				micSamples, err := readWAVFile(chunk.MicFilePath)
				if err != nil {
					log.Printf("Failed to read mic WAV: %v", err)
					micErr = err
				}
				sysSamples, err2 := readWAVFile(chunk.SysFilePath)
				if err2 != nil {
					log.Printf("Failed to read sys WAV: %v", err2)
					sysErr = err2
				}

				// Определяем ВСЕ участки речи для каждого канала с помощью VAD
				// Это нужно для правильного маппинга таймстемпов Whisper на реальное время
				// Whisper "сжимает" паузы и возвращает таймстемпы относительно речи, а не аудио
				var micRegions, sysRegions []session.SpeechRegion
				if micErr == nil && len(micSamples) > 0 {
					micRegions = session.DetectSpeechRegions(micSamples, session.WhisperSampleRate)
					log.Printf("VAD: Mic has %d speech regions", len(micRegions))
				}
				if sysErr == nil && len(sysSamples) > 0 {
					sysRegions = session.DetectSpeechRegions(sysSamples, session.WhisperSampleRate)
					log.Printf("VAD: Sys has %d speech regions", len(sysRegions))
				}

				// Транскрипция микрофона
				go func() {
					defer wg.Done()
					if micErr != nil {
						return
					}
					log.Printf("Transcribing mic channel: %d samples (%.1f sec)", len(micSamples), float64(len(micSamples))/16000)
					micSegments, micErr = engineMgr.TranscribeWithSegments(micSamples)
					if micErr != nil {
						log.Printf("Mic transcription error: %v", micErr)
					} else {
						// Логируем оригинальные таймстемпы от Whisper
						for i, seg := range micSegments {
							log.Printf("Mic segment %d from Whisper: start=%dms end=%dms text=%q",
								i, seg.Start, seg.End, seg.Text)
						}

						// Маппим таймстемпы Whisper на реальное время с учётом пауз
						if len(micSegments) > 0 && len(micRegions) > 0 {
							whisperStarts := make([]int64, len(micSegments))
							for i, seg := range micSegments {
								whisperStarts[i] = seg.Start
							}
							realStarts := session.MapWhisperSegmentsToRealTime(whisperStarts, micRegions)
							for i := range micSegments {
								// Вычисляем длительность сегмента и применяем к новому началу
								duration := micSegments[i].End - micSegments[i].Start
								micSegments[i].Start = realStarts[i]
								micSegments[i].End = realStarts[i] + duration

								// Маппим также слова внутри сегмента
								for j := range micSegments[i].Words {
									wordDuration := micSegments[i].Words[j].End - micSegments[i].Words[j].Start
									micSegments[i].Words[j].Start = session.MapWhisperTimeToRealTime(micSegments[i].Words[j].Start, micRegions)
									micSegments[i].Words[j].End = micSegments[i].Words[j].Start + wordDuration
								}
							}
						}

						var texts []string
						for _, seg := range micSegments {
							texts = append(texts, seg.Text)
						}
						micText = strings.Join(texts, " ")
						log.Printf("Mic transcription: %d chars, %d segments", len(micText), len(micSegments))
					}
				}()

				// Транскрипция системного звука
				go func() {
					defer wg.Done()
					if sysErr != nil {
						return
					}
					log.Printf("Transcribing sys channel: %d samples (%.1f sec)", len(sysSamples), float64(len(sysSamples))/16000)
					sysSegments, sysErr = engineMgr.TranscribeWithSegments(sysSamples)
					if sysErr != nil {
						log.Printf("Sys transcription error: %v", sysErr)
					} else {
						// Логируем оригинальные таймстемпы от Whisper
						for i, seg := range sysSegments {
							log.Printf("Sys segment %d from Whisper: start=%dms end=%dms text=%q",
								i, seg.Start, seg.End, seg.Text)
						}

						// Маппим таймстемпы Whisper на реальное время с учётом пауз
						if len(sysSegments) > 0 && len(sysRegions) > 0 {
							whisperStarts := make([]int64, len(sysSegments))
							for i, seg := range sysSegments {
								whisperStarts[i] = seg.Start
							}
							realStarts := session.MapWhisperSegmentsToRealTime(whisperStarts, sysRegions)
							for i := range sysSegments {
								duration := sysSegments[i].End - sysSegments[i].Start
								sysSegments[i].Start = realStarts[i]
								sysSegments[i].End = realStarts[i] + duration

								// Маппим также слова внутри сегмента
								for j := range sysSegments[i].Words {
									wordDuration := sysSegments[i].Words[j].End - sysSegments[i].Words[j].Start
									sysSegments[i].Words[j].Start = session.MapWhisperTimeToRealTime(sysSegments[i].Words[j].Start, sysRegions)
									sysSegments[i].Words[j].End = sysSegments[i].Words[j].Start + wordDuration
								}
							}
						}

						var texts []string
						for _, seg := range sysSegments {
							texts = append(texts, seg.Text)
						}
						sysText = strings.Join(texts, " ")
						log.Printf("Sys transcription: %d chars, %d segments", len(sysText), len(sysSegments))
					}
				}()

				wg.Wait()

				// Определяем общую ошибку
				var finalErr error
				if micErr != nil && sysErr != nil {
					finalErr = fmt.Errorf("mic: %v, sys: %v", micErr, sysErr)
				}

				// Конвертируем сегменты ai -> session С ДОБАВЛЕНИЕМ ГЛОБАЛЬНОГО OFFSET ЧАНКА
				// chunk.StartMs - это время начала чанка относительно начала всей записи
				// Это критически важно для правильного отображения временных меток в диалоге
				log.Printf("Applying global chunk offset: %d ms to all segments", chunk.StartMs)
				sessionMicSegs := convertSegmentsWithGlobalOffset(micSegments, "mic", chunk.StartMs)
				sessionSysSegs := convertSegmentsWithGlobalOffset(sysSegments, "sys", chunk.StartMs)

				sessionMgr.UpdateChunkStereoWithSegments(sessID, chunkID, micText, sysText, sessionMicSegs, sessionSysSegs, finalErr)

				// Удаляем временные WAV файлы после транскрипции
				os.Remove(chunk.MicFilePath)
				os.Remove(chunk.SysFilePath)
				log.Printf("Cleaned up temporary WAV files for chunk %d", chunk.Index)

			} else if hasMixWAV {
				// Моно режим: читаем микс из WAV
				samples, err := readWAVFile(chunk.FilePath)
				if err != nil {
					log.Printf("Failed to read chunk WAV: %v", err)
					sessionMgr.UpdateChunkTranscription(sessID, chunkID, "", err)
					return
				}

				log.Printf("Transcribing chunk %d: %d samples (%.1f sec)", chunk.Index, len(samples), float64(len(samples))/16000)

				text, err := engineMgr.Transcribe(samples, false)
				if err != nil {
					log.Printf("Transcription error for chunk %d: %v", chunk.Index, err)
					sessionMgr.UpdateChunkTranscription(sessID, chunkID, "", err)
					return
				}

				log.Printf("Transcription complete for chunk %d: %d chars", chunk.Index, len(text))
				sessionMgr.UpdateChunkTranscription(sessID, chunkID, text, nil)

				// Удаляем временный WAV файл
				os.Remove(chunk.FilePath)
				log.Printf("Cleaned up temporary WAV file for chunk %d", chunk.Index)

			} else {
				// Fallback: извлекаем из MP3 (только после остановки записи)
				sess, err := sessionMgr.GetSession(sessID)
				if err != nil {
					log.Printf("Failed to get session: %v", err)
					sessionMgr.UpdateChunkTranscription(sessID, chunkID, "", err)
					return
				}
				mp3Path := filepath.Join(sess.DataDir, "full.mp3")

				if chunk.IsStereo {
					micSamples, sysSamples, err := session.ExtractSegmentStereo(mp3Path, chunk.StartMs, chunk.EndMs, session.WhisperSampleRate)
					if err != nil {
						log.Printf("Failed to extract stereo from MP3: %v", err)
						sessionMgr.UpdateChunkTranscription(sessID, chunkID, "", err)
						return
					}

					log.Printf("MP3 extract: mic samples=%d, sys samples=%d", len(micSamples), len(sysSamples))

					// Определяем ВСЕ участки речи с помощью VAD
					micRegions := session.DetectSpeechRegions(micSamples, session.WhisperSampleRate)
					sysRegions := session.DetectSpeechRegions(sysSamples, session.WhisperSampleRate)
					log.Printf("MP3 VAD: mic has %d regions, sys has %d regions", len(micRegions), len(sysRegions))

					var micText, sysText string
					var micSegments, sysSegments []ai.TranscriptSegment
					var wg sync.WaitGroup
					var micErr, sysErr error

					wg.Add(2)
					go func() {
						defer wg.Done()
						micSegments, micErr = engineMgr.TranscribeWithSegments(micSamples)
						if micErr == nil {
							for i, seg := range micSegments {
								log.Printf("MP3 Mic segment %d: start=%dms end=%dms text=%q", i, seg.Start, seg.End, seg.Text)
							}
							// Маппим таймстемпы на реальное время
							if len(micSegments) > 0 && len(micRegions) > 0 {
								whisperStarts := make([]int64, len(micSegments))
								for i, seg := range micSegments {
									whisperStarts[i] = seg.Start
								}
								realStarts := session.MapWhisperSegmentsToRealTime(whisperStarts, micRegions)
								for i := range micSegments {
									duration := micSegments[i].End - micSegments[i].Start
									micSegments[i].Start = realStarts[i]
									micSegments[i].End = realStarts[i] + duration

									// Маппим также слова внутри сегмента
									for j := range micSegments[i].Words {
										wordDuration := micSegments[i].Words[j].End - micSegments[i].Words[j].Start
										micSegments[i].Words[j].Start = session.MapWhisperTimeToRealTime(micSegments[i].Words[j].Start, micRegions)
										micSegments[i].Words[j].End = micSegments[i].Words[j].Start + wordDuration
									}
								}
							}
							var texts []string
							for _, seg := range micSegments {
								texts = append(texts, seg.Text)
							}
							micText = strings.Join(texts, " ")
						}
					}()
					go func() {
						defer wg.Done()
						sysSegments, sysErr = engineMgr.TranscribeWithSegments(sysSamples)
						if sysErr == nil {
							for i, seg := range sysSegments {
								log.Printf("MP3 Sys segment %d: start=%dms end=%dms text=%q", i, seg.Start, seg.End, seg.Text)
							}
							// Маппим таймстемпы на реальное время
							if len(sysSegments) > 0 && len(sysRegions) > 0 {
								whisperStarts := make([]int64, len(sysSegments))
								for i, seg := range sysSegments {
									whisperStarts[i] = seg.Start
								}
								realStarts := session.MapWhisperSegmentsToRealTime(whisperStarts, sysRegions)
								for i := range sysSegments {
									duration := sysSegments[i].End - sysSegments[i].Start
									sysSegments[i].Start = realStarts[i]
									sysSegments[i].End = realStarts[i] + duration

									// Маппим также слова внутри сегмента
									for j := range sysSegments[i].Words {
										wordDuration := sysSegments[i].Words[j].End - sysSegments[i].Words[j].Start
										sysSegments[i].Words[j].Start = session.MapWhisperTimeToRealTime(sysSegments[i].Words[j].Start, sysRegions)
										sysSegments[i].Words[j].End = sysSegments[i].Words[j].Start + wordDuration
									}
								}
							}
							var texts []string
							for _, seg := range sysSegments {
								texts = append(texts, seg.Text)
							}
							sysText = strings.Join(texts, " ")
						}
					}()
					wg.Wait()

					var finalErr error
					if micErr != nil && sysErr != nil {
						finalErr = fmt.Errorf("mic: %v, sys: %v", micErr, sysErr)
					}
					// Добавляем глобальный offset чанка к временным меткам
					log.Printf("MP3 fallback: Applying global chunk offset: %d ms", chunk.StartMs)
					sessionMicSegs := convertSegmentsWithGlobalOffset(micSegments, "mic", chunk.StartMs)
					sessionSysSegs := convertSegmentsWithGlobalOffset(sysSegments, "sys", chunk.StartMs)
					sessionMgr.UpdateChunkStereoWithSegments(sessID, chunkID, micText, sysText, sessionMicSegs, sessionSysSegs, finalErr)
				} else {
					samples, err := session.ExtractSegment(mp3Path, chunk.StartMs, chunk.EndMs, session.WhisperSampleRate)
					if err != nil {
						log.Printf("Failed to extract from MP3: %v", err)
						sessionMgr.UpdateChunkTranscription(sessID, chunkID, "", err)
						return
					}
					text, err := engineMgr.Transcribe(samples, false)
					sessionMgr.UpdateChunkTranscription(sessID, chunkID, text, err)
				}
			}
		}()
	})

	// Callback для транскрибированных чанков
	sessionMgr.SetOnChunkTranscribed(func(chunk *session.Chunk) {
		// Отправляем уведомление независимо от того, активна ли сессия
		// (транскрипция может завершиться после остановки записи)
		log.Printf("Sending transcription result for chunk %d to frontend", chunk.Index)

		conn.WriteJSON(Message{
			Type:      "chunk_transcribed",
			SessionID: chunk.SessionID,
			Chunk:     chunk,
		})
	})

	for {
		var msg Message
		err := conn.ReadJSON(&msg)
		if err != nil {
			log.Println("Read:", err)
			break
		}

		switch msg.Type {
		case "get_devices":
			devices, err := capture.ListDevices()
			if err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}
			conn.WriteJSON(Message{
				Type:                      "devices",
				Devices:                   devices,
				ScreenCaptureKitAvailable: audio.ScreenCaptureKitAvailable(),
			})

		// ===== Model Management =====
		case "get_models":
			// Получить список всех моделей с их статусами
			modelStates := modelMgr.GetAllModelsState()
			conn.WriteJSON(Message{
				Type:   "models_list",
				Models: modelStates,
			})

		case "download_model":
			// Скачать модель
			modelID := msg.ModelID
			if modelID == "" {
				conn.WriteJSON(Message{Type: "error", Data: "modelId is required"})
				continue
			}
			if err := modelMgr.DownloadModel(modelID); err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}
			conn.WriteJSON(Message{
				Type:    "download_started",
				ModelID: modelID,
			})

		case "cancel_download":
			// Отменить скачивание
			modelID := msg.ModelID
			if modelID == "" {
				conn.WriteJSON(Message{Type: "error", Data: "modelId is required"})
				continue
			}
			if err := modelMgr.CancelDownload(modelID); err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}
			conn.WriteJSON(Message{
				Type:    "download_cancelled",
				ModelID: modelID,
			})

		case "delete_model":
			// Удалить модель
			modelID := msg.ModelID
			if modelID == "" {
				conn.WriteJSON(Message{Type: "error", Data: "modelId is required"})
				continue
			}
			if err := modelMgr.DeleteModel(modelID); err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}
			conn.WriteJSON(Message{
				Type:    "model_deleted",
				ModelID: modelID,
			})
			// Отправляем обновлённый список
			conn.WriteJSON(Message{
				Type:   "models_list",
				Models: modelMgr.GetAllModelsState(),
			})

		case "set_active_model":
			// Установить активную модель
			modelID := msg.ModelID
			if modelID == "" {
				conn.WriteJSON(Message{Type: "error", Data: "modelId is required"})
				continue
			}

			// Получаем путь к модели
			// Проверяем что модель существует
			if models.GetModelByID(modelID) == nil {
				conn.WriteJSON(Message{Type: "error", Data: "unknown model"})
				continue
			}

			// Проверяем что модель скачана
			if !modelMgr.IsModelDownloaded(modelID) {
				conn.WriteJSON(Message{Type: "error", Data: "model not downloaded"})
				continue
			}

			// Активируем модель через EngineManager (он сам обновит modelMgr)
			if engineMgr != nil {
				if err := engineMgr.SetActiveModel(modelID); err != nil {
					conn.WriteJSON(Message{Type: "error", Data: fmt.Sprintf("failed to load model: %v", err)})
					continue
				}
			}

			conn.WriteJSON(Message{
				Type:    "active_model_changed",
				ModelID: modelID,
			})
			// Отправляем обновлённый список
			conn.WriteJSON(Message{
				Type:   "models_list",
				Models: modelMgr.GetAllModelsState(),
			})

		case "get_sessions":
			sessions := sessionMgr.ListSessions()
			infos := make([]*SessionInfo, len(sessions))
			for i, s := range sessions {
				infos[i] = &SessionInfo{
					ID:            s.ID,
					StartTime:     s.StartTime,
					Status:        string(s.Status),
					TotalDuration: int64(s.TotalDuration / time.Millisecond),
					ChunksCount:   len(s.Chunks),
				}
			}
			conn.WriteJSON(Message{
				Type:     "sessions_list",
				Sessions: infos,
			})

		case "get_session":
			sess, err := sessionMgr.GetSession(msg.SessionID)
			if err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}
			conn.WriteJSON(Message{
				Type:    "session_details",
				Session: sess,
			})

		case "start_session":
			mu.Lock()
			if currentSession != nil {
				mu.Unlock()
				conn.WriteJSON(Message{Type: "error", Data: "Session already active"})
				continue
			}

			// Очищаем буферы от старых данных перед началом новой записи
			capture.ClearBuffers()
			log.Println("Audio buffers cleared for new session")

			// Создаём сессию
			sess, err := sessionMgr.CreateSession(session.SessionConfig{
				Language:      msg.Language,
				Model:         msg.Model,
				MicDevice:     msg.MicDevice,
				SystemDevice:  msg.SystemDevice,
				CaptureSystem: msg.CaptureSystem,
				UseNative:     msg.UseNative,
			})
			if err != nil {
				mu.Unlock()
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}

			// Создаём MP3 writer для полной записи (48kHz стерео: L=mic, R=system)
			mp3Path := filepath.Join(sess.DataDir, "full.mp3")
			mp3Writer, err = session.NewMP3Writer(mp3Path, session.SampleRate, 2, "128k")
			if err != nil {
				mu.Unlock()
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}

			// Создаём chunk buffer
			chunkBuffer = session.NewChunkBuffer(session.DefaultVADConfig(), session.SampleRate)

			currentSession = sess
			stopChan = make(chan struct{})
			mu.Unlock()

			// Настраиваем язык и модель
			if engineMgr != nil {
				if msg.Language != "" {
					engineMgr.SetLanguage(msg.Language)
					log.Printf("Language set to: %s", msg.Language)
				}
				if msg.Model != "" {
					// msg.Model может быть ID модели или путём к файлу
					// Пробуем сначала как ID модели
					if models.GetModelByID(msg.Model) != nil {
						if err := engineMgr.SetActiveModel(msg.Model); err != nil {
							log.Printf("Failed to set model %s: %v", msg.Model, err)
						} else {
							log.Printf("Model set to: %s", msg.Model)
						}
					} else {
						log.Printf("Unknown model ID: %s, ignoring", msg.Model)
					}
				}
			}

			// Настраиваем устройства и режим захвата
			useVoiceIsolation := msg.UseVoiceIsolation && msg.CaptureSystem && audio.ScreenCaptureKitAvailable()
			sessionUseVoiceIsolation = useVoiceIsolation // Сохраняем для использования при остановке

			if msg.UseVoiceIsolation && !audio.ScreenCaptureKitAvailable() {
				log.Println("⚠️  Voice Isolation requested but ScreenCaptureKit is not available")
			}

			if useVoiceIsolation {
				// Режим Voice Isolation: используем только ScreenCaptureKit для mic+system
				// Это даёт встроенное эхоподавление и шумоподавление на уровне macOS
				log.Println("🎙️  STEREO MODE: Voice Isolation enabled - mic and system will be transcribed separately")
				capture.EnableScreenCaptureKit(true)
				capture.EnableSystemCapture(true)
				// Запускаем в режиме "both" - микрофон и системный звук через ScreenCaptureKit
				if err := capture.StartScreenCaptureKitAudioWithMode("both"); err != nil {
					log.Printf("Failed to start Voice Isolation mode: %v, falling back to standard", err)
					useVoiceIsolation = false
					sessionUseVoiceIsolation = false
				}
			}

			if !useVoiceIsolation {
				// Стандартный режим: malgo для микрофона + опционально ScreenCaptureKit для системного
				log.Println("🎙️  MONO MODE: Standard capture - mic and system will be mixed into single transcription")
				if msg.MicDevice != "" {
					capture.SetMicrophoneDevice(msg.MicDevice)
				}
				if msg.CaptureSystem {
					capture.EnableSystemCapture(true)
					if msg.UseNative && audio.ScreenCaptureKitAvailable() {
						capture.EnableScreenCaptureKit(true)
					} else if msg.SystemDevice != "" {
						capture.EnableScreenCaptureKit(false)
						capture.SetSystemDeviceByName(msg.SystemDevice)
					}
				}

				// Запускаем захват
				capture.Start(0)
			}

			// Коэффициент эхоподавления (по умолчанию 0.4)
			echoCancel := float32(0.4)
			if msg.EchoCancel > 0 {
				echoCancel = float32(msg.EchoCancel)
			}

			// Горутина для обработки аудио
			go processAudio(capture, mp3Writer, chunkBuffer, sessionMgr, sess, conn, stopChan, &mu, echoCancel, useVoiceIsolation)

			// Горутина для обработки чанков
			go processChunks(chunkBuffer, sessionMgr, sess, &mu, useVoiceIsolation)

			conn.WriteJSON(Message{
				Type:    "session_started",
				Session: sess,
			})

			log.Printf("Session started: %s", sess.ID)

		case "stop_session":
			log.Println("Received stop_session request")
			mu.Lock()
			if currentSession == nil {
				mu.Unlock()
				conn.WriteJSON(Message{Type: "error", Data: "No active session"})
				continue
			}

			sessID := currentSession.ID
			log.Printf("Stopping session: %s", sessID)

			// Останавливаем захват
			log.Println("Closing stop channel...")
			close(stopChan)
			log.Println("Stopping audio capture...")
			capture.Stop()
			log.Println("Audio capture stopped")

			// Сохраняем ссылки на объекты перед освобождением мьютекса
			localSession := currentSession
			localMP3Writer := mp3Writer
			localChunkBuffer := chunkBuffer
			mu.Unlock() // Освобождаем мьютекс ПЕРЕД FlushAll и saveChunk

			// Получаем метаданные чанков (БЕЗ добавления в сессию)
			log.Println("Flushing remaining chunks...")
			remainingChunks := localChunkBuffer.FlushAll()
			log.Printf("Flushed %d remaining chunks", len(remainingChunks))

			// Закрываем chunk buffer
			log.Println("Closing chunk buffer...")
			localChunkBuffer.Close()

			// ВАЖНО: Сначала закрываем MP3, потом создаём чанки
			// Иначе FFmpeg не сможет прочитать незавершённый файл
			if localMP3Writer != nil {
				log.Println("Closing MP3 writer...")
				localMP3Writer.Close()
				mu.Lock()
				localSession.SampleCount = localMP3Writer.SamplesWritten()
				mu.Unlock()
				log.Println("MP3 writer closed")
			}

			// Теперь создаём чанки (это вызовет onChunkReady и транскрипцию)
			log.Println("Creating chunks and starting transcription...")
			for _, chunk := range remainingChunks {
				saveChunk(sessionMgr, localSession, &chunk, &mu, sessionUseVoiceIsolation)
			}

			// Останавливаем сессию
			log.Println("Finalizing session in manager...")
			sess, _ := sessionMgr.StopSession()

			mu.Lock()
			currentSession = nil
			mp3Writer = nil
			chunkBuffer = nil
			mu.Unlock()

			log.Println("Sending session_stopped to frontend...")
			conn.WriteJSON(Message{
				Type:    "session_stopped",
				Session: sess,
			})

			log.Printf("Session stopped successfully: %s", sess.ID)

		case "delete_session":
			if err := sessionMgr.DeleteSession(msg.SessionID); err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}
			conn.WriteJSON(Message{Type: "session_deleted", SessionID: msg.SessionID})

		case "retranscribe_chunk":
			sess, err := sessionMgr.GetSession(msg.SessionID)
			if err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}

			// Находим чанк
			var targetChunk *session.Chunk
			for _, c := range sess.Chunks {
				if c.ID == msg.Data { // chunk ID в Data
					targetChunk = c
					break
				}
			}
			if targetChunk == nil {
				conn.WriteJSON(Message{Type: "error", Data: "Chunk not found"})
				continue
			}

			// Применяем модель и язык из запроса (если указаны)
			if msg.Model != "" {
				// msg.Model теперь должен быть ID модели из реестра
				if models.GetModelByID(msg.Model) != nil && modelMgr.IsModelDownloaded(msg.Model) {
					if err := engineMgr.SetActiveModel(msg.Model); err != nil {
						log.Printf("Failed to set model %s: %v", msg.Model, err)
						conn.WriteJSON(Message{Type: "error", Data: fmt.Sprintf("Failed to load model: %v", err)})
						continue
					}
					log.Printf("Model switched to: %s", msg.Model)
				} else {
					log.Printf("Model %s not found or not downloaded, using current model", msg.Model)
				}
			}
			if msg.Language != "" {
				engineMgr.SetLanguage(msg.Language)
				log.Printf("Language set to: %s", msg.Language)
			}

			// Обновляем статус чанка
			targetChunk.Status = session.ChunkStatusTranscribing
			conn.WriteJSON(Message{
				Type:      "chunk_transcribed",
				SessionID: sess.ID,
				Chunk:     targetChunk,
			})

			// Перетранскрибируем (с очередью - только 1 транскрипция одновременно)
			go func(chunk *session.Chunk, sessID string, dataDir string, isStereo bool) {
				// Захватываем семафор (ждём если уже идёт транскрипция)
				log.Printf("Chunk %d: waiting for transcription slot...", chunk.Index)
				transcriptionSem <- struct{}{}
				defer func() { <-transcriptionSem }()

				log.Printf("Chunk %d: starting retranscription, stereo=%v", chunk.Index, isStereo)

				mp3Path := filepath.Join(dataDir, "full.mp3")

				if isStereo {
					// Стерео: извлекаем раздельные каналы и транскрибируем ПОСЛЕДОВАТЕЛЬНО
					// (не параллельно, чтобы не перегружать GPU)
					micSamples, sysSamples, err := session.ExtractSegmentStereo(mp3Path, chunk.StartMs, chunk.EndMs, session.WhisperSampleRate)
					if err != nil {
						log.Printf("Failed to extract stereo segment for retranscription: %v", err)
						sessionMgr.UpdateChunkTranscription(sessID, chunk.ID, "", err)
						return
					}

					// Определяем ВСЕ участки речи с помощью VAD для каждого канала
					micRegions := session.DetectSpeechRegions(micSamples, session.WhisperSampleRate)
					sysRegions := session.DetectSpeechRegions(sysSamples, session.WhisperSampleRate)
					log.Printf("Retranscription VAD: mic has %d speech regions, sys has %d speech regions", len(micRegions), len(sysRegions))

					// Транскрибируем каналы последовательно
					var micSegments, sysSegments []ai.TranscriptSegment
					var micErr, sysErr error

					log.Printf("Chunk %d: transcribing mic channel (%d samples)...", chunk.Index, len(micSamples))
					micSegments, micErr = engineMgr.TranscribeWithSegments(micSamples)

					log.Printf("Chunk %d: transcribing sys channel (%d samples)...", chunk.Index, len(sysSamples))
					sysSegments, sysErr = engineMgr.TranscribeWithSegments(sysSamples)

					if micErr != nil && sysErr != nil {
						log.Printf("Retranscription failed for both channels: mic=%v, sys=%v", micErr, sysErr)
						sessionMgr.UpdateChunkTranscription(sessID, chunk.ID, "", micErr)
						return
					}

					// Логируем оригинальные таймстемпы от Whisper для mic
					for i, seg := range micSegments {
						log.Printf("Retrans Mic segment %d from Whisper: start=%dms end=%dms text=%q", i, seg.Start, seg.End, seg.Text)
					}

					// Маппим таймстемпы Whisper на реальное время с учётом пауз для mic
					if len(micSegments) > 0 && len(micRegions) > 0 {
						whisperStarts := make([]int64, len(micSegments))
						for i, seg := range micSegments {
							whisperStarts[i] = seg.Start
						}
						realStarts := session.MapWhisperSegmentsToRealTime(whisperStarts, micRegions)
						for i := range micSegments {
							duration := micSegments[i].End - micSegments[i].Start
							micSegments[i].Start = realStarts[i]
							micSegments[i].End = realStarts[i] + duration

							// Маппим также слова внутри сегмента
							for j := range micSegments[i].Words {
								wordDuration := micSegments[i].Words[j].End - micSegments[i].Words[j].Start
								micSegments[i].Words[j].Start = session.MapWhisperTimeToRealTime(micSegments[i].Words[j].Start, micRegions)
								micSegments[i].Words[j].End = micSegments[i].Words[j].Start + wordDuration
							}
						}
					}

					// Логируем оригинальные таймстемпы от Whisper для sys
					for i, seg := range sysSegments {
						log.Printf("Retrans Sys segment %d from Whisper: start=%dms end=%dms text=%q", i, seg.Start, seg.End, seg.Text)
					}

					// Маппим таймстемпы Whisper на реальное время с учётом пауз для sys
					if len(sysSegments) > 0 && len(sysRegions) > 0 {
						whisperStarts := make([]int64, len(sysSegments))
						for i, seg := range sysSegments {
							whisperStarts[i] = seg.Start
						}
						realStarts := session.MapWhisperSegmentsToRealTime(whisperStarts, sysRegions)
						for i := range sysSegments {
							duration := sysSegments[i].End - sysSegments[i].Start
							sysSegments[i].Start = realStarts[i]
							sysSegments[i].End = realStarts[i] + duration

							// Маппим также слова внутри сегмента
							for j := range sysSegments[i].Words {
								wordDuration := sysSegments[i].Words[j].End - sysSegments[i].Words[j].Start
								sysSegments[i].Words[j].Start = session.MapWhisperTimeToRealTime(sysSegments[i].Words[j].Start, sysRegions)
								sysSegments[i].Words[j].End = sysSegments[i].Words[j].Start + wordDuration
							}
						}
					}

					// Собираем текст из сегментов
					var micText, sysText string
					for _, seg := range micSegments {
						micText += seg.Text + " "
					}
					for _, seg := range sysSegments {
						sysText += seg.Text + " "
					}

					log.Printf("Retranscription complete: mic=%d chars, sys=%d chars", len(micText), len(sysText))
					// Добавляем глобальный offset чанка к временным меткам при ретранскрипции
					log.Printf("Retranscription: Applying global chunk offset: %d ms", chunk.StartMs)
					sessionMgr.UpdateChunkStereoWithSegments(sessID, chunk.ID, micText, sysText,
						convertSegmentsWithGlobalOffset(micSegments, "mic", chunk.StartMs),
						convertSegmentsWithGlobalOffset(sysSegments, "sys", chunk.StartMs), nil)
				} else {
					// Моно: простая транскрипция
					samples, err := session.ExtractSegment(mp3Path, chunk.StartMs, chunk.EndMs, session.WhisperSampleRate)
					if err != nil {
						log.Printf("Failed to extract segment for retranscription: %v", err)
						sessionMgr.UpdateChunkTranscription(sessID, chunk.ID, "", err)
						return
					}

					text, err := engineMgr.Transcribe(samples, false)
					if err != nil {
						log.Printf("Retranscription failed: %v", err)
					} else {
						log.Printf("Retranscription complete: %d chars", len(text))
					}
					sessionMgr.UpdateChunkTranscription(sessID, chunk.ID, text, err)
				}
			}(targetChunk, sess.ID, sess.DataDir, targetChunk.IsStereo)

		case "cancel_full_transcription":
			// Отмена полной ретранскрипции
			fullTranscriptionMu.Lock()
			if fullTranscriptionCancel != nil {
				close(fullTranscriptionCancel)
				fullTranscriptionCancel = nil
			}
			fullTranscriptionMu.Unlock()

			// Ждём завершения горутины (с таймаутом)
			done := make(chan struct{})
			go func() {
				fullTranscriptionWg.Wait()
				close(done)
			}()

			select {
			case <-done:
				log.Printf("Full transcription cancelled and stopped for session %s", msg.SessionID)
			case <-time.After(30 * time.Second):
				log.Printf("Warning: transcription goroutine did not stop in time for session %s", msg.SessionID)
			}

			conn.WriteJSON(Message{
				Type:      "full_transcription_cancelled",
				SessionID: msg.SessionID,
			})

		case "retranscribe_full":
			// Полная ретранскрипция всего файла (без чанков)
			sess, err := sessionMgr.GetSession(msg.SessionID)
			if err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}

			// Отменяем предыдущую транскрипцию если она идёт
			fullTranscriptionMu.Lock()
			if fullTranscriptionCancel != nil {
				close(fullTranscriptionCancel)
				fullTranscriptionCancel = nil
			}
			fullTranscriptionMu.Unlock()

			// Ждём завершения предыдущей горутины
			fullTranscriptionWg.Wait()

			// Создаём новый канал отмены
			fullTranscriptionMu.Lock()
			fullTranscriptionCancel = make(chan struct{})
			cancelChan := fullTranscriptionCancel
			fullTranscriptionMu.Unlock()

			// Применяем модель и язык из запроса
			if msg.Model != "" {
				// msg.Model теперь должен быть ID модели из реестра
				if models.GetModelByID(msg.Model) != nil && modelMgr.IsModelDownloaded(msg.Model) {
					if err := engineMgr.SetActiveModel(msg.Model); err != nil {
						conn.WriteJSON(Message{Type: "error", Data: fmt.Sprintf("Failed to load model: %v", err)})
						continue
					}
				} else {
					log.Printf("Model %s not found or not downloaded, using current model", msg.Model)
				}
			}
			if msg.Language != "" {
				engineMgr.SetLanguage(msg.Language)
			}

			// Отправляем уведомление о начале полной транскрипции
			conn.WriteJSON(Message{
				Type:      "full_transcription_started",
				SessionID: sess.ID,
			})

			// Запускаем полную транскрипцию асинхронно
			fullTranscriptionWg.Add(1)
			go func(sess *session.Session, cancelChan chan struct{}) {
				defer fullTranscriptionWg.Done()

				// Вспомогательная функция для проверки отмены
				isCancelled := func() bool {
					select {
					case <-cancelChan:
						return true
					default:
						return false
					}
				}

				// Очистка при завершении
				defer func() {
					fullTranscriptionMu.Lock()
					if fullTranscriptionCancel == cancelChan {
						fullTranscriptionCancel = nil
					}
					fullTranscriptionMu.Unlock()
				}()

				mp3Path := filepath.Join(sess.DataDir, "full.mp3")

				// Проверяем наличие файла
				if _, err := os.Stat(mp3Path); os.IsNotExist(err) {
					conn.WriteJSON(Message{
						Type:      "full_transcription_error",
						SessionID: sess.ID,
						Error:     "Audio file not found",
					})
					return
				}

				// Определяем режим (стерео или моно)
				isStereo := len(sess.Chunks) > 0 && sess.Chunks[0].IsStereo

				log.Printf("Starting full file transcription for session %s, stereo=%v", sess.ID, isStereo)

				// Константа: максимальная длина сегмента для транскрипции (20 минут) - используется как fallback
				const maxSegmentDurationMs int64 = 20 * 60 * 1000 // 20 минут в миллисекундах

				if isStereo {
					// Получаем длительность файла
					totalDurationMs := sess.TotalDuration.Milliseconds()
					if totalDurationMs == 0 {
						// Fallback: используем SampleCount
						totalDurationMs = int64(sess.SampleCount) * 1000 / int64(session.SampleRate)
					}

					log.Printf("Full file duration: %d ms (%.1f min)", totalDurationMs, float64(totalDurationMs)/60000)

					// Проверяем наличие существующих чанков с валидными границами
					// Чанки уже нарезаны по естественным паузам речи - используем их
					hasValidChunks := false
					for _, chunk := range sess.Chunks {
						if chunk.StartMs > 0 || chunk.EndMs > 0 {
							hasValidChunks = true
							break
						}
					}

					// Структура для хранения информации о сегменте (чанк или 20-мин сегмент)
					type ProcessingSegment struct {
						Index   int
						StartMs int64
						EndMs   int64
						ChunkID string // Пустой для fallback-сегментов
					}

					var segments []ProcessingSegment

					if hasValidChunks && len(sess.Chunks) > 0 {
						// Используем существующие чанки - они уже нарезаны по естественным границам речи
						log.Printf("Using %d existing chunks (natural speech boundaries)", len(sess.Chunks))
						for i, chunk := range sess.Chunks {
							segments = append(segments, ProcessingSegment{
								Index:   i,
								StartMs: chunk.StartMs,
								EndMs:   chunk.EndMs,
								ChunkID: chunk.ID,
							})
							log.Printf("  chunk[%d] %s: %d-%d ms (%.1f sec)",
								i, chunk.ID, chunk.StartMs, chunk.EndMs, float64(chunk.EndMs-chunk.StartMs)/1000)
						}
					} else {
						// Fallback: нарезаем на 20-минутные сегменты (для старых сессий без чанков)
						log.Printf("No valid chunks found, falling back to %d-minute segments", maxSegmentDurationMs/60000)
						numSegments := int((totalDurationMs + maxSegmentDurationMs - 1) / maxSegmentDurationMs)
						if numSegments < 1 {
							numSegments = 1
						}
						for i := 0; i < numSegments; i++ {
							startMs := int64(i) * maxSegmentDurationMs
							endMs := startMs + maxSegmentDurationMs
							if endMs > totalDurationMs {
								endMs = totalDurationMs
							}
							segments = append(segments, ProcessingSegment{
								Index:   i,
								StartMs: startMs,
								EndMs:   endMs,
								ChunkID: "",
							})
						}
					}

					log.Printf("Will process %d segment(s)", len(segments))

					var allMicSegments, allSysSegments []ai.TranscriptSegment

					// Обрабатываем каждый сегмент (чанк или 20-мин сегмент)
					for segIdx, seg := range segments {
						// Проверяем отмену перед каждым сегментом
						if isCancelled() {
							log.Printf("Full transcription cancelled at segment %d/%d", segIdx+1, len(segments))
							conn.WriteJSON(Message{
								Type:      "full_transcription_cancelled",
								SessionID: sess.ID,
							})
							return
						}

						segStartMs := seg.StartMs
						segEndMs := seg.EndMs
						segDurationMs := segEndMs - segStartMs

						segLabel := fmt.Sprintf("сегмент %d/%d", segIdx+1, len(segments))
						if seg.ChunkID != "" {
							segLabel = fmt.Sprintf("чанк %d/%d", segIdx+1, len(segments))
						}

						log.Printf("Processing %s: %d-%d ms (%.1f sec)",
							segLabel, segStartMs, segEndMs, float64(segDurationMs)/1000)

						// Прогресс: извлечение аудио для этого сегмента
						baseProgress := float64(segIdx) / float64(len(segments))
						segmentProgress := 1.0 / float64(len(segments))

						conn.WriteJSON(Message{
							Type:      "full_transcription_progress",
							SessionID: sess.ID,
							Progress:  baseProgress + segmentProgress*0.1,
							Data:      fmt.Sprintf("Извлечение аудио (%s)...", segLabel),
						})

						// Извлекаем сегмент аудио
						micSamples, sysSamples, err := session.ExtractSegmentStereo(mp3Path, segStartMs, segEndMs, session.WhisperSampleRate)
						if err != nil {
							log.Printf("Failed to extract %s: %v", segLabel, err)
							conn.WriteJSON(Message{
								Type:      "full_transcription_error",
								SessionID: sess.ID,
								Error:     fmt.Sprintf("Failed to extract audio %s: %v", segLabel, err),
							})
							return
						}

						log.Printf("%s: extracted mic=%d samples (%.1f sec), sys=%d samples (%.1f sec)",
							segLabel,
							len(micSamples), float64(len(micSamples))/float64(session.WhisperSampleRate),
							len(sysSamples), float64(len(sysSamples))/float64(session.WhisperSampleRate))

						// VAD: используем унифицированные регионы для синхронизации каналов
						conn.WriteJSON(Message{
							Type:      "full_transcription_progress",
							SessionID: sess.ID,
							Progress:  baseProgress + segmentProgress*0.2,
							Data:      fmt.Sprintf("Анализ речи (%s)...", segLabel),
						})

						// Создаём единую карту речевых регионов для обоих каналов
						// Это решает проблему рассинхронизации timestamps между mic и sys
						unifiedRegions := session.CreateUnifiedSpeechRegions(micSamples, sysSamples, session.WhisperSampleRate)
						log.Printf("%s VAD: unified=%d regions", segLabel, len(unifiedRegions))

						// Транскрипция микрофона
						conn.WriteJSON(Message{
							Type:      "full_transcription_progress",
							SessionID: sess.ID,
							Progress:  baseProgress + segmentProgress*0.4,
							Data:      fmt.Sprintf("Распознавание микрофона (%s)...", segLabel),
						})

						log.Printf("%s: transcribing mic channel (%d samples)", segLabel, len(micSamples))
						micSegments, micErr := engineMgr.TranscribeHighQuality(micSamples)
						log.Printf("%s mic result: segments=%d, err=%v", segLabel, len(micSegments), micErr)
						if micErr != nil {
							log.Printf("%s mic transcription error: %v", segLabel, micErr)
						} else {
							// Маппим таймстемпы на реальное время используя унифицированные регионы
							if len(micSegments) > 0 && len(unifiedRegions) > 0 {
								whisperStarts := make([]int64, len(micSegments))
								for i, s := range micSegments {
									whisperStarts[i] = s.Start
								}
								realStarts := session.MapWhisperSegmentsToRealTime(whisperStarts, unifiedRegions)
								for i := range micSegments {
									duration := micSegments[i].End - micSegments[i].Start
									// Добавляем offset сегмента/чанка к реальному времени
									micSegments[i].Start = realStarts[i] + segStartMs
									micSegments[i].End = realStarts[i] + segStartMs + duration
									// Маппим слова
									for j := range micSegments[i].Words {
										wordDuration := micSegments[i].Words[j].End - micSegments[i].Words[j].Start
										mappedStart := session.MapWhisperTimeToRealTime(micSegments[i].Words[j].Start, unifiedRegions)
										micSegments[i].Words[j].Start = mappedStart + segStartMs
										micSegments[i].Words[j].End = mappedStart + segStartMs + wordDuration
									}
								}
							} else {
								// Если нет VAD регионов, просто добавляем offset сегмента
								for i := range micSegments {
									micSegments[i].Start += segStartMs
									micSegments[i].End += segStartMs
									for j := range micSegments[i].Words {
										micSegments[i].Words[j].Start += segStartMs
										micSegments[i].Words[j].End += segStartMs
									}
								}
							}
							log.Printf("%s mic: %d segments", segLabel, len(micSegments))
							allMicSegments = append(allMicSegments, micSegments...)
						}

						// Транскрипция системного звука
						conn.WriteJSON(Message{
							Type:      "full_transcription_progress",
							SessionID: sess.ID,
							Progress:  baseProgress + segmentProgress*0.7,
							Data:      fmt.Sprintf("Распознавание собеседника (%s)...", segLabel),
						})

						log.Printf("%s: transcribing sys channel (%d samples)", segLabel, len(sysSamples))
						sysSegments, sysErr := engineMgr.TranscribeHighQuality(sysSamples)
						log.Printf("%s sys result: segments=%d, err=%v", segLabel, len(sysSegments), sysErr)
						if sysErr != nil {
							log.Printf("%s sys transcription error: %v", segLabel, sysErr)
						} else {
							// Маппим таймстемпы на реальное время используя те же унифицированные регионы
							if len(sysSegments) > 0 && len(unifiedRegions) > 0 {
								whisperStarts := make([]int64, len(sysSegments))
								for i, s := range sysSegments {
									whisperStarts[i] = s.Start
								}
								realStarts := session.MapWhisperSegmentsToRealTime(whisperStarts, unifiedRegions)
								for i := range sysSegments {
									duration := sysSegments[i].End - sysSegments[i].Start
									// Добавляем offset сегмента/чанка к реальному времени
									sysSegments[i].Start = realStarts[i] + segStartMs
									sysSegments[i].End = realStarts[i] + segStartMs + duration
									// Маппим слова
									for j := range sysSegments[i].Words {
										wordDuration := sysSegments[i].Words[j].End - sysSegments[i].Words[j].Start
										mappedStart := session.MapWhisperTimeToRealTime(sysSegments[i].Words[j].Start, unifiedRegions)
										sysSegments[i].Words[j].Start = mappedStart + segStartMs
										sysSegments[i].Words[j].End = mappedStart + segStartMs + wordDuration
									}
								}
							} else {
								// Если нет VAD регионов, просто добавляем offset сегмента
								for i := range sysSegments {
									sysSegments[i].Start += segStartMs
									sysSegments[i].End += segStartMs
									for j := range sysSegments[i].Words {
										sysSegments[i].Words[j].Start += segStartMs
										sysSegments[i].Words[j].End += segStartMs
									}
								}
							}
							log.Printf("%s sys: %d segments", segLabel, len(sysSegments))
							allSysSegments = append(allSysSegments, sysSegments...)
						}
					}

					// Используем собранные сегменты
					micSegments := allMicSegments
					sysSegments := allSysSegments

					log.Printf("Total transcription result: mic=%d segments, sys=%d segments", len(micSegments), len(sysSegments))

					if len(micSegments) == 0 && len(sysSegments) == 0 {
						log.Printf("ERROR: No segments produced from %d segment(s). Check audio file and logs above.", len(segments))
						conn.WriteJSON(Message{
							Type:      "full_transcription_error",
							SessionID: sess.ID,
							Error:     fmt.Sprintf("Транскрипция не дала результатов. Проверьте, что аудиофайл содержит речь. Обработано сегментов: %d", len(segments)),
						})
						return
					}

					// Формируем диалог
					conn.WriteJSON(Message{
						Type:      "full_transcription_progress",
						SessionID: sess.ID,
						Progress:  0.9,
						Data:      "Формирование диалога...",
					})

					// Конвертируем сегменты
					sessionMicSegs := convertSegments(micSegments, "mic")
					sessionSysSegs := convertSegments(sysSegments, "sys")

					log.Printf("Converted segments: mic=%d, sys=%d", len(sessionMicSegs), len(sessionSysSegs))
					for i, seg := range sessionMicSegs {
						log.Printf("  mic[%d]: start=%dms text=%q words=%d", i, seg.Start, seg.Text, len(seg.Words))
					}
					for i, seg := range sessionSysSegs {
						log.Printf("  sys[%d]: start=%dms text=%q words=%d", i, seg.Start, seg.Text, len(seg.Words))
					}

					// Обновляем сессию с полной транскрипцией
					// Создаём один "виртуальный" чанк с полной транскрипцией
					if err := sessionMgr.UpdateFullTranscription(sess.ID, sessionMicSegs, sessionSysSegs); err != nil {
						log.Printf("UpdateFullTranscription error: %v", err)
						conn.WriteJSON(Message{
							Type:      "full_transcription_error",
							SessionID: sess.ID,
							Error:     fmt.Sprintf("Failed to update transcription: %v", err),
						})
						return
					}

					// Получаем обновлённую сессию
					updatedSess, err := sessionMgr.GetSession(sess.ID)
					if err != nil {
						log.Printf("GetSession error after update: %v", err)
						conn.WriteJSON(Message{
							Type:      "full_transcription_error",
							SessionID: sess.ID,
							Error:     fmt.Sprintf("Failed to get updated session: %v", err),
						})
						return
					}

					// Логируем что отправляем
					log.Printf("Sending full_transcription_completed: session=%s chunks=%d", updatedSess.ID, len(updatedSess.Chunks))
					if len(updatedSess.Chunks) > 0 {
						chunk := updatedSess.Chunks[0]
						log.Printf("  chunk[0]: dialogue=%d micSegs=%d sysSegs=%d micText=%d sysText=%d",
							len(chunk.Dialogue), len(chunk.MicSegments), len(chunk.SysSegments),
							len(chunk.MicText), len(chunk.SysText))
					}

					conn.WriteJSON(Message{
						Type:      "full_transcription_completed",
						SessionID: sess.ID,
						Session:   updatedSess,
					})

					log.Printf("Full transcription completed for session %s", sess.ID)

				} else {
					// Моно режим с сегментацией для длинных файлов
					totalDurationMs := sess.TotalDuration.Milliseconds()
					if totalDurationMs == 0 {
						totalDurationMs = int64(sess.SampleCount) * 1000 / int64(session.SampleRate)
					}

					log.Printf("Mono mode: total duration %d ms (%.1f min)", totalDurationMs, float64(totalDurationMs)/60000)

					// Определяем количество сегментов
					numSegments := int((totalDurationMs + maxSegmentDurationMs - 1) / maxSegmentDurationMs)
					if numSegments < 1 {
						numSegments = 1
					}
					log.Printf("Mono: will process in %d segment(s)", numSegments)

					var allTexts []string

					for segIdx := 0; segIdx < numSegments; segIdx++ {
						// Проверяем отмену перед каждым сегментом
						if isCancelled() {
							log.Printf("Mono transcription cancelled at segment %d/%d", segIdx+1, numSegments)
							conn.WriteJSON(Message{
								Type:      "full_transcription_cancelled",
								SessionID: sess.ID,
							})
							return
						}

						segStartMs := int64(segIdx) * maxSegmentDurationMs
						segEndMs := segStartMs + maxSegmentDurationMs
						if segEndMs > totalDurationMs {
							segEndMs = totalDurationMs
						}

						baseProgress := float64(segIdx) / float64(numSegments)
						segmentProgress := 1.0 / float64(numSegments)

						conn.WriteJSON(Message{
							Type:      "full_transcription_progress",
							SessionID: sess.ID,
							Progress:  baseProgress + segmentProgress*0.3,
							Data:      fmt.Sprintf("Извлечение аудио (сегмент %d/%d)...", segIdx+1, numSegments),
						})

						samples, err := session.ExtractSegment(mp3Path, segStartMs, segEndMs, session.WhisperSampleRate)
						if err != nil {
							conn.WriteJSON(Message{
								Type:      "full_transcription_error",
								SessionID: sess.ID,
								Error:     fmt.Sprintf("Failed to extract audio segment %d: %v", segIdx+1, err),
							})
							return
						}

						conn.WriteJSON(Message{
							Type:      "full_transcription_progress",
							SessionID: sess.ID,
							Progress:  baseProgress + segmentProgress*0.7,
							Data:      fmt.Sprintf("Распознавание речи (сегмент %d/%d)...", segIdx+1, numSegments),
						})

						segments, err := engineMgr.TranscribeHighQuality(samples)
						if err != nil {
							log.Printf("Mono segment %d transcription error: %v", segIdx+1, err)
							continue
						}

						for _, seg := range segments {
							if seg.Text != "" {
								allTexts = append(allTexts, seg.Text)
							}
						}
						log.Printf("Mono segment %d: %d text pieces", segIdx+1, len(segments))
					}

					text := strings.Join(allTexts, " ")
					log.Printf("Mono total: %d chars", len(text))

					// Обновляем транскрипцию в сессии
					sessionMgr.UpdateFullTranscriptionMono(sess.ID, text)

					updatedSess, _ := sessionMgr.GetSession(sess.ID)

					conn.WriteJSON(Message{
						Type:      "full_transcription_completed",
						SessionID: sess.ID,
						Session:   updatedSess,
					})
				}
			}(sess, cancelChan)

		case "get_ollama_models":
			// Получить список моделей Ollama
			ollamaUrl := msg.OllamaUrl
			if ollamaUrl == "" {
				ollamaUrl = "http://localhost:11434"
			}

			ollamaModels, err := getOllamaModels(ollamaUrl)
			if err != nil {
				conn.WriteJSON(Message{
					Type:  "ollama_models",
					Error: err.Error(),
				})
				continue
			}

			conn.WriteJSON(Message{
				Type:         "ollama_models",
				OllamaModels: ollamaModels,
			})

		case "generate_summary":
			// Генерация summary для сессии
			sess, err := sessionMgr.GetSession(msg.SessionID)
			if err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}

			// Собираем текст транскрипции
			var transcriptText strings.Builder
			for _, chunk := range sess.Chunks {
				if chunk.Status != session.ChunkStatusCompleted {
					continue
				}
				if len(chunk.Dialogue) > 0 {
					for _, seg := range chunk.Dialogue {
						speaker := "Вы"
						if seg.Speaker == "sys" {
							speaker = "Собеседник"
						}
						transcriptText.WriteString(fmt.Sprintf("%s: %s\n", speaker, seg.Text))
					}
				} else if chunk.MicText != "" || chunk.SysText != "" {
					if chunk.MicText != "" {
						transcriptText.WriteString(fmt.Sprintf("Вы: %s\n", chunk.MicText))
					}
					if chunk.SysText != "" {
						transcriptText.WriteString(fmt.Sprintf("Собеседник: %s\n", chunk.SysText))
					}
				} else if chunk.Transcription != "" {
					transcriptText.WriteString(chunk.Transcription + "\n")
				}
			}

			if transcriptText.Len() == 0 {
				conn.WriteJSON(Message{Type: "error", Data: "No transcription available"})
				continue
			}

			// Отправляем уведомление о начале генерации
			conn.WriteJSON(Message{
				Type:      "summary_started",
				SessionID: sess.ID,
			})

			// Получаем настройки Ollama из запроса
			ollamaModel := msg.OllamaModel
			ollamaUrl := msg.OllamaUrl
			if ollamaModel == "" {
				ollamaModel = "llama3.2"
			}
			if ollamaUrl == "" {
				ollamaUrl = "http://localhost:11434"
			}

			// Генерируем summary асинхронно
			go func(sessID string, text string, model string, url string) {
				summary, err := generateSummaryWithLLM(text, model, url)
				if err != nil {
					log.Printf("Summary generation error: %v", err)
					conn.WriteJSON(Message{
						Type:      "summary_error",
						SessionID: sessID,
						Error:     err.Error(),
					})
					return
				}

				// Сохраняем summary в сессию
				sessionMgr.SetSessionSummary(sessID, summary)

				conn.WriteJSON(Message{
					Type:      "summary_completed",
					SessionID: sessID,
					Summary:   summary,
				})
			}(sess.ID, transcriptText.String(), ollamaModel, ollamaUrl)

		case "improve_transcription":
			// Улучшение транскрипции с помощью LLM
			sess, err := sessionMgr.GetSession(msg.SessionID)
			if err != nil {
				conn.WriteJSON(Message{Type: "error", Data: err.Error()})
				continue
			}

			// Собираем диалог из всех чанков
			var dialogue []session.TranscriptSegment
			for _, chunk := range sess.Chunks {
				if chunk.Status == session.ChunkStatusCompleted && len(chunk.Dialogue) > 0 {
					dialogue = append(dialogue, chunk.Dialogue...)
				}
			}

			if len(dialogue) == 0 {
				conn.WriteJSON(Message{Type: "error", Data: "No dialogue to improve"})
				continue
			}

			// Отправляем уведомление о начале улучшения
			conn.WriteJSON(Message{
				Type:      "improve_started",
				SessionID: sess.ID,
			})

			// Получаем настройки Ollama
			ollamaModel := msg.OllamaModel
			ollamaUrl := msg.OllamaUrl
			if ollamaModel == "" {
				ollamaModel = "llama3.2"
			}
			if ollamaUrl == "" {
				ollamaUrl = "http://localhost:11434"
			}

			// Улучшаем транскрипцию асинхронно
			go func(sessID string, dialogue []session.TranscriptSegment, model string, url string) {
				improved, err := improveTranscriptionWithLLM(dialogue, model, url)
				if err != nil {
					log.Printf("Transcription improvement error: %v", err)
					conn.WriteJSON(Message{
						Type:      "improve_error",
						SessionID: sessID,
						Error:     err.Error(),
					})
					return
				}

				// Обновляем диалог в сессии
				if err := sessionMgr.UpdateImprovedDialogue(sessID, improved); err != nil {
					log.Printf("Failed to update improved dialogue: %v", err)
					conn.WriteJSON(Message{
						Type:      "improve_error",
						SessionID: sessID,
						Error:     err.Error(),
					})
					return
				}

				// Получаем обновлённую сессию
				updatedSess, _ := sessionMgr.GetSession(sessID)

				conn.WriteJSON(Message{
					Type:      "improve_completed",
					SessionID: sessID,
					Session:   updatedSess,
				})
			}(sess.ID, dialogue, ollamaModel, ollamaUrl)
		}
	}

	// Cleanup при отключении
	mu.Lock()
	if currentSession != nil {
		close(stopChan)
		capture.Stop()
		if mp3Writer != nil {
			mp3Writer.Close()
		}
		if chunkBuffer != nil {
			chunkBuffer.Close()
		}
		sessionMgr.StopSession()
	}
	mu.Unlock()
}

func processAudio(capture *audio.Capture, mp3Writer *session.MP3Writer, chunkBuffer *session.ChunkBuffer,
	sessionMgr *session.Manager, sess *session.Session, conn *websocket.Conn, stopChan chan struct{}, mu *sync.Mutex, echoCancel float32, useVoiceIsolation bool) {

	var micLevel, systemLevel float64
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	// Буферы для стерео записи (L=mic, R=system)
	var micBuffer []float32
	var systemBuffer []float32

	log.Printf("Audio processing started with echo cancellation: %.0f%%", echoCancel*100)

	for {
		select {
		case <-stopChan:
			return

		case <-ticker.C:
			// Отправляем уровни громкости
			conn.WriteJSON(Message{
				Type:        "audio_level",
				MicLevel:    micLevel,
				SystemLevel: systemLevel,
			})

		case data, ok := <-capture.Data():
			if !ok {
				return
			}

			samples := data.Samples
			channel := data.Channel

			// Вычисляем RMS для индикации
			rms := session.CalculateRMS(samples)
			if channel == audio.ChannelMicrophone {
				micLevel = rms
				micBuffer = append(micBuffer, samples...)
			} else {
				systemLevel = rms
				systemBuffer = append(systemBuffer, samples...)
			}

			// Записываем стерео когда есть данные в обоих каналах
			mu.Lock()
			minLen := len(micBuffer)
			if len(systemBuffer) < minLen {
				minLen = len(systemBuffer)
			}

			if minLen > 0 && mp3Writer != nil {
				// Интерливим: L R L R L R...
				stereo := make([]float32, minLen*2)
				for i := 0; i < minLen; i++ {
					stereo[i*2] = micBuffer[i]      // Left = mic
					stereo[i*2+1] = systemBuffer[i] // Right = system
				}
				mp3Writer.Write(stereo)

				if useVoiceIsolation {
					// В режиме Voice Isolation сохраняем каналы раздельно для независимой транскрипции
					if chunkBuffer != nil {
						chunkBuffer.ProcessStereo(micBuffer[:minLen], systemBuffer[:minLen])
					}
				} else {
					// Стандартный режим: эхоподавление и микс
					mono := make([]float32, minLen)
					for i := 0; i < minLen; i++ {
						// Вычитаем эхо системного звука из микрофона
						micClean := micBuffer[i] - systemBuffer[i]*echoCancel

						// Clamp
						if micClean > 1.0 {
							micClean = 1.0
						} else if micClean < -1.0 {
							micClean = -1.0
						}

						// Смешиваем очищенный микрофон с системным звуком
						mono[i] = (micClean + systemBuffer[i]) / 2
					}
					if chunkBuffer != nil {
						chunkBuffer.Process(mono)
					}
				}

				// Очищаем использованные данные
				micBuffer = micBuffer[minLen:]
				systemBuffer = systemBuffer[minLen:]
			}
			mu.Unlock()
		}
	}
}

func processChunks(chunkBuffer *session.ChunkBuffer, sessionMgr *session.Manager, sess *session.Session, mu *sync.Mutex, useVoiceIsolation bool) {
	for event := range chunkBuffer.Output() {
		saveChunk(sessionMgr, sess, &event, mu, useVoiceIsolation)
	}
}

func saveChunk(sessionMgr *session.Manager, sess *session.Session, event *session.ChunkEvent, mu *sync.Mutex, useVoiceIsolation bool) {
	mu.Lock()
	chunkIndex := len(sess.Chunks)
	mu.Unlock()

	// Создаём временные WAV файлы для транскрипции
	// (MP3 файл ещё записывается, поэтому нельзя из него извлекать)
	chunksDir := filepath.Join(sess.DataDir, "chunks")

	chunk := &session.Chunk{
		ID:        uuid.New().String(),
		SessionID: sess.ID,
		Index:     chunkIndex,
		StartMs:   event.StartMs,
		EndMs:     event.EndMs,
		Duration:  event.Duration,
		IsStereo:  useVoiceIsolation,
		Status:    session.ChunkStatusPending,
		CreatedAt: time.Now(),
	}

	if useVoiceIsolation && len(event.MicSamples) > 0 && len(event.SysSamples) > 0 {
		// Сохраняем раздельные каналы во временные WAV файлы
		micPath := filepath.Join(chunksDir, fmt.Sprintf("%03d_mic.wav", chunkIndex))
		sysPath := filepath.Join(chunksDir, fmt.Sprintf("%03d_sys.wav", chunkIndex))

		if err := saveWAVFile(micPath, event.MicSamples, session.SampleRate); err != nil {
			log.Printf("Failed to save mic WAV: %v", err)
		} else {
			chunk.MicFilePath = micPath
		}

		if err := saveWAVFile(sysPath, event.SysSamples, session.SampleRate); err != nil {
			log.Printf("Failed to save sys WAV: %v", err)
		} else {
			chunk.SysFilePath = sysPath
		}

		log.Printf("Created chunk %d with separate WAV files: [%d-%d ms] (%.1f sec)",
			chunkIndex, event.StartMs, event.EndMs, event.Duration.Seconds())
	} else if len(event.Samples) > 0 {
		// Сохраняем микс во временный WAV файл
		mixPath := filepath.Join(chunksDir, fmt.Sprintf("%03d.wav", chunkIndex))
		if err := saveWAVFile(mixPath, event.Samples, session.SampleRate); err != nil {
			log.Printf("Failed to save mix WAV: %v", err)
		} else {
			chunk.FilePath = mixPath
		}

		log.Printf("Created chunk %d with mix WAV: [%d-%d ms] (%.1f sec)",
			chunkIndex, event.StartMs, event.EndMs, event.Duration.Seconds())
	}

	// Добавляем чанк (это вызовет callback onChunkReady для транскрипции)
	if err := sessionMgr.AddChunk(sess.ID, chunk); err != nil {
		log.Printf("Failed to add chunk: %v", err)
	}
}

// saveWAVFile сохраняет float32 samples в WAV файл
func saveWAVFile(path string, samples []float32, sampleRate int) error {
	wavWriter, err := session.NewWAVWriter(path, sampleRate, 1, 16)
	if err != nil {
		return err
	}
	if err := wavWriter.Write(samples); err != nil {
		wavWriter.Close()
		return err
	}
	return wavWriter.Close()
}

// readWAVFile читает WAV файл и возвращает float32 samples (16kHz для Whisper)
func readWAVFile(path string) ([]float32, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	// Пропускаем WAV header (44 байта)
	if len(data) < 44 {
		return nil, fmt.Errorf("invalid WAV file")
	}

	// Читаем параметры из header
	channels := int(data[22]) | int(data[23])<<8
	sampleRate := int(data[24]) | int(data[25])<<8 | int(data[26])<<16 | int(data[27])<<24

	pcmData := data[44:]

	// Читаем все семплы
	totalSamples := len(pcmData) / 2
	rawSamples := make([]float32, totalSamples)
	for i := 0; i < totalSamples; i++ {
		sample := int16(pcmData[i*2]) | int16(pcmData[i*2+1])<<8
		rawSamples[i] = float32(sample) / 32768.0
	}

	// Конвертируем стерео в моно
	var monoSamples []float32
	if channels == 2 {
		frameCount := totalSamples / 2
		monoSamples = make([]float32, frameCount)
		for i := 0; i < frameCount; i++ {
			monoSamples[i] = (rawSamples[i*2] + rawSamples[i*2+1]) / 2
		}
	} else {
		monoSamples = rawSamples
	}

	// Ресемплинг до 16kHz для Whisper
	if sampleRate != session.WhisperSampleRate {
		monoSamples = resample(monoSamples, sampleRate, session.WhisperSampleRate)
	}

	return monoSamples, nil
}

// resample выполняет ресемплинг с линейной интерполяцией
func resample(samples []float32, fromRate, toRate int) []float32 {
	if fromRate == toRate {
		return samples
	}

	ratio := float64(fromRate) / float64(toRate)
	newLen := int(float64(len(samples)) / ratio)
	result := make([]float32, newLen)

	for i := 0; i < newLen; i++ {
		srcPos := float64(i) * ratio
		srcIdx := int(srcPos)
		frac := float32(srcPos - float64(srcIdx))

		if srcIdx+1 < len(samples) {
			result[i] = samples[srcIdx]*(1-frac) + samples[srcIdx+1]*frac
		} else if srcIdx < len(samples) {
			result[i] = samples[srcIdx]
		}
	}

	return result
}

// generateSummaryWithLLM генерирует краткое содержание транскрипции с помощью LLM
// Поддерживает: Ollama API (настраиваемая модель и URL)
func generateSummaryWithLLM(transcriptText string, ollamaModel string, ollamaUrl string) (string, error) {
	// Пробуем Ollama с указанными настройками
	summary, err := generateSummaryWithOllama(transcriptText, ollamaModel, ollamaUrl)
	if err == nil && summary != "" {
		return summary, nil
	}
	log.Printf("Ollama not available: %v, using fallback...", err)

	// Fallback: простая статистика
	return generateSummaryFallback(transcriptText)
}

// generateSummaryWithOllama использует Ollama API для генерации summary
func generateSummaryWithOllama(transcriptText string, model string, baseUrl string) (string, error) {
	// Проверяем доступность Ollama
	resp, err := http.Get(baseUrl + "/api/tags")
	if err != nil {
		return "", fmt.Errorf("Ollama не запущен по адресу %s. Запустите: ollama serve", baseUrl)
	}
	resp.Body.Close()

	// Ограничиваем текст для контекста (примерно 4000 токенов ~ 16000 символов)
	maxChars := 16000
	text := transcriptText
	if len(text) > maxChars {
		text = text[:maxChars] + "\n...[текст обрезан]..."
	}

	// Системный промпт с чёткими инструкциями
	systemPrompt := `Ты — ассистент для создания кратких резюме деловых разговоров и встреч.

ТВОЯ ЗАДАЧА: Проанализировать транскрипцию и создать структурированное резюме.

ФОРМАТ ОТВЕТА (строго в Markdown):

## 📋 Тема встречи
[1-2 предложения: о чём был разговор]

## 🎯 Ключевые моменты
- [пункт 1]
- [пункт 2]
- [пункт 3]

## ✅ Решения и договорённости
- [что решили / согласовали]

## 📌 Следующие шаги
- [действие 1]
- [действие 2]

ПРАВИЛА:
1. Пиши ТОЛЬКО резюме, без вступлений и объяснений
2. Используй Markdown форматирование
3. Если раздел пустой (нет информации) — пропусти его
4. Будь краток: максимум 5 пунктов в каждом разделе
5. Отвечай на русском языке
6. НЕ цитируй транскрипцию дословно, а обобщай смысл
7. Игнорируй технические фразы ("проверка записи", "алло" и т.п.)`

	userPrompt := fmt.Sprintf("Вот транскрипция разговора:\n\n%s", text)

	// Используем /api/chat для поддержки system prompt
	// num_predict увеличен до 4096 для полных ответов от больших моделей (Gemini, GPT и др.)
	reqBody := map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"stream": false,
		"options": map[string]interface{}{
			"temperature": 0.3,
			"num_predict": 4096, // Увеличено для полных ответов
		},
	}

	log.Printf("Generating summary with Ollama model=%s url=%s, transcript length=%d chars", model, baseUrl, len(text))
	jsonBody, _ := json.Marshal(reqBody)

	// Создаём HTTP клиент с увеличенным таймаутом (3 минуты для больших моделей)
	client := &http.Client{
		Timeout: 180 * time.Second,
	}

	resp, err = client.Post(baseUrl+"/api/chat", "application/json", bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", fmt.Errorf("Ошибка запроса к Ollama: %v", err)
	}
	defer resp.Body.Close()

	// Читаем полный ответ для диагностики
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("Ошибка чтения ответа Ollama: %v", err)
	}

	log.Printf("Ollama response status=%d, body length=%d bytes", resp.StatusCode, len(bodyBytes))

	var result struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		Error      string `json:"error"`
		Done       bool   `json:"done"`
		DoneReason string `json:"done_reason"`
	}
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		log.Printf("Failed to parse Ollama response: %s", string(bodyBytes[:min(500, len(bodyBytes))]))
		return "", fmt.Errorf("Ошибка парсинга ответа Ollama: %v", err)
	}

	// Логируем статус завершения
	log.Printf("Ollama done=%v, done_reason=%s, content length=%d chars", result.Done, result.DoneReason, len(result.Message.Content))

	if result.Error != "" {
		// Более понятные сообщения об ошибках
		if strings.Contains(result.Error, "model runner has unexpectedly stopped") {
			return "", fmt.Errorf("Модель '%s' упала. Попробуйте:\n1. Переустановить: ollama rm %s && ollama pull %s\n2. Использовать другую модель", model, model, model)
		}
		if strings.Contains(result.Error, "not found") {
			return "", fmt.Errorf("Модель '%s' не найдена. Установите: ollama pull %s", model, model)
		}
		return "", fmt.Errorf("Ошибка Ollama: %s", result.Error)
	}

	response := strings.TrimSpace(result.Message.Content)
	if response == "" {
		return "", fmt.Errorf("Ollama вернул пустой ответ. Попробуйте другую модель.")
	}

	return response, nil
}

// improveTranscriptionWithLLM улучшает транскрипцию с помощью LLM
// Исправляет ошибки распознавания, пунктуацию и форматирование
func improveTranscriptionWithLLM(dialogue []session.TranscriptSegment, ollamaModel string, ollamaUrl string) ([]session.TranscriptSegment, error) {
	// Проверяем доступность Ollama
	resp, err := http.Get(ollamaUrl + "/api/tags")
	if err != nil {
		return nil, fmt.Errorf("Ollama не запущен по адресу %s", ollamaUrl)
	}
	resp.Body.Close()

	// Формируем текст для улучшения
	var dialogueText strings.Builder
	for _, seg := range dialogue {
		speaker := "Вы"
		if seg.Speaker == "sys" {
			speaker = "Собеседник"
		}
		dialogueText.WriteString(fmt.Sprintf("[%s] %s\n", speaker, seg.Text))
	}

	text := dialogueText.String()
	// Ограничиваем текст
	maxChars := 12000
	if len(text) > maxChars {
		text = text[:maxChars] + "\n...[текст обрезан]..."
	}

	systemPrompt := `Ты — эксперт по редактированию транскрипций речи.

ТВОЯ ЗАДАЧА: Улучшить качество транскрипции, исправив ошибки распознавания.

ПРАВИЛА:
1. Исправляй очевидные ошибки распознавания (например: "привет" вместо "привед")
2. Добавляй правильную пунктуацию (точки, запятые, вопросительные знаки)
3. Исправляй регистр букв (начало предложений с заглавной)
4. НЕ меняй смысл сказанного
5. НЕ добавляй слова, которых не было
6. НЕ удаляй слова
7. Сохраняй формат: [Спикер] Текст
8. Отвечай ТОЛЬКО исправленным текстом, без комментариев

ФОРМАТ ОТВЕТА:
[Вы] Исправленный текст реплики
[Собеседник] Исправленный текст реплики
...`

	userPrompt := fmt.Sprintf("Улучши эту транскрипцию:\n\n%s", text)

	reqBody := map[string]interface{}{
		"model": ollamaModel,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"stream": false,
		"options": map[string]interface{}{
			"temperature": 0.1, // Низкая температура для точности
			"num_predict": 8192,
		},
	}

	log.Printf("Improving transcription with Ollama model=%s, dialogue length=%d chars", ollamaModel, len(text))
	jsonBody, _ := json.Marshal(reqBody)

	client := &http.Client{
		Timeout: 300 * time.Second, // 5 минут для длинных текстов
	}

	resp, err = client.Post(ollamaUrl+"/api/chat", "application/json", bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("Ошибка запроса к Ollama: %v", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("Ошибка чтения ответа Ollama: %v", err)
	}

	var result struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("Ошибка парсинга ответа Ollama: %v", err)
	}

	if result.Error != "" {
		return nil, fmt.Errorf("Ошибка Ollama: %s", result.Error)
	}

	improvedText := strings.TrimSpace(result.Message.Content)
	if improvedText == "" {
		return nil, fmt.Errorf("Ollama вернул пустой ответ")
	}

	// Парсим улучшенный текст обратно в сегменты
	improvedDialogue := parseImprovedDialogue(improvedText, dialogue)

	log.Printf("Transcription improved: %d segments", len(improvedDialogue))
	return improvedDialogue, nil
}

// parseImprovedDialogue парсит улучшенный текст и сопоставляет с оригинальными сегментами
func parseImprovedDialogue(improvedText string, originalDialogue []session.TranscriptSegment) []session.TranscriptSegment {
	lines := strings.Split(improvedText, "\n")
	var improved []session.TranscriptSegment

	// Регулярное выражение для парсинга формата [Спикер] Текст
	lineIdx := 0
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var speaker, text string

		// Парсим формат [Вы] или [Собеседник]
		if strings.HasPrefix(line, "[Вы]") {
			speaker = "mic"
			text = strings.TrimSpace(strings.TrimPrefix(line, "[Вы]"))
		} else if strings.HasPrefix(line, "[Собеседник]") {
			speaker = "sys"
			text = strings.TrimSpace(strings.TrimPrefix(line, "[Собеседник]"))
		} else {
			// Пробуем альтернативные форматы
			if strings.HasPrefix(line, "Вы:") {
				speaker = "mic"
				text = strings.TrimSpace(strings.TrimPrefix(line, "Вы:"))
			} else if strings.HasPrefix(line, "Собеседник:") {
				speaker = "sys"
				text = strings.TrimSpace(strings.TrimPrefix(line, "Собеседник:"))
			} else {
				continue // Пропускаем неизвестные строки
			}
		}

		if text == "" {
			continue
		}

		// Берём timestamps из оригинального сегмента, если он есть
		var start, end int64
		if lineIdx < len(originalDialogue) {
			start = originalDialogue[lineIdx].Start
			end = originalDialogue[lineIdx].End
		}

		improved = append(improved, session.TranscriptSegment{
			Start:   start,
			End:     end,
			Text:    text,
			Speaker: speaker,
		})
		lineIdx++
	}

	// Если не удалось распарсить, возвращаем оригинал
	if len(improved) == 0 {
		return originalDialogue
	}

	return improved
}

// generateSummaryFallback создаёт базовое summary без LLM
func generateSummaryFallback(transcriptText string) (string, error) {
	lines := strings.Split(transcriptText, "\n")
	if len(lines) == 0 {
		return "", fmt.Errorf("empty transcript")
	}

	// Подсчитываем статистику
	var youLines, otherLines int
	var totalWords int
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		words := strings.Fields(line)
		totalWords += len(words)
		if strings.HasPrefix(line, "Вы:") {
			youLines++
		} else if strings.HasPrefix(line, "Собеседник:") {
			otherLines++
		}
	}

	// Генерируем простое summary
	summary := fmt.Sprintf(`📊 Статистика записи:
• Реплик "Вы": %d
• Реплик "Собеседник": %d  
• Всего слов: %d

📝 Краткое содержание:
Диалог между двумя участниками. `, youLines, otherLines, totalWords)

	if youLines > otherLines*2 {
		summary += "Вы говорили значительно больше собеседника."
	} else if otherLines > youLines*2 {
		summary += "Собеседник говорил значительно больше вас."
	} else {
		summary += "Диалог был примерно равномерным."
	}

	summary += `

💡 Для полноценного AI-анализа:
   1. Установите Ollama: brew install ollama
   2. Скачайте модель: ollama pull deepseek-r1:8b
   3. Запустите: ollama serve
   4. Укажите модель в настройках AIWisper`

	return summary, nil
}

// getOllamaModels получает список доступных моделей из Ollama API
func getOllamaModels(baseUrl string) ([]OllamaModel, error) {
	client := &http.Client{Timeout: 5 * time.Second}

	resp, err := client.Get(baseUrl + "/api/tags")
	if err != nil {
		return nil, fmt.Errorf("Ollama не запущен. Запустите: ollama serve")
	}
	defer resp.Body.Close()

	var tagsResp struct {
		Models []struct {
			Name        string `json:"name"`
			Size        int64  `json:"size"`
			RemoteModel string `json:"remote_model"` // Если есть - это cloud модель
			Details     struct {
				Family        string `json:"family"`
				ParameterSize string `json:"parameter_size"`
			} `json:"details"`
		} `json:"models"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&tagsResp); err != nil {
		return nil, fmt.Errorf("Ошибка парсинга ответа Ollama: %v", err)
	}

	var models []OllamaModel

	// Сначала добавляем cloud модели (они быстрее)
	for _, m := range tagsResp.Models {
		isCloud := m.RemoteModel != "" || strings.HasSuffix(m.Name, "-cloud") || strings.Contains(m.Name, ":cloud")
		if isCloud {
			models = append(models, OllamaModel{
				Name:       m.Name,
				Size:       m.Size,
				IsCloud:    true,
				Family:     m.Details.Family,
				Parameters: m.Details.ParameterSize,
			})
		}
	}

	// Затем локальные модели
	for _, m := range tagsResp.Models {
		isCloud := m.RemoteModel != "" || strings.HasSuffix(m.Name, "-cloud") || strings.Contains(m.Name, ":cloud")
		if !isCloud {
			models = append(models, OllamaModel{
				Name:       m.Name,
				Size:       m.Size,
				IsCloud:    false,
				Family:     m.Details.Family,
				Parameters: m.Details.ParameterSize,
			})
		}
	}

	return models, nil
}
