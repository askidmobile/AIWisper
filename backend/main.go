package main

import (
	"aiwisper/ai"
	"aiwisper/audio"
	"aiwisper/session"
	"flag"
	"fmt"
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
	flag.Parse()

	log.Printf("Model path: %s", *modelPath)
	log.Printf("Data directory: %s", *dataDir)

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

	// Initialize AI
	log.Println("Loading Whisper model...")
	whisperEngine, err := ai.NewEngine(*modelPath)
	if err != nil {
		log.Printf("Warning: Failed to load Whisper model: %v", err)
	} else {
		log.Println("Whisper model loaded successfully")
		defer whisperEngine.Close()
	}

	// HTTP handlers
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("Upgrade:", err)
			return
		}
		defer conn.Close()
		handleConnection(conn, capture, whisperEngine, sessionMgr)
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

func handleConnection(conn *websocket.Conn, capture *audio.Capture, engine *ai.Engine, sessionMgr *session.Manager) {
	var mu sync.Mutex
	var currentSession *session.Session
	var mp3Writer *session.MP3Writer // MP3 вместо WAV для экономии места
	var chunkBuffer *session.ChunkBuffer
	var stopChan chan struct{}
	var sessionUseVoiceIsolation bool // Флаг режима Voice Isolation для текущей сессии

	// Callback для готовых чанков - транскрибируем
	sessionMgr.SetOnChunkReady(func(chunk *session.Chunk) {
		if engine == nil {
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

				// Определяем offset начала речи для каждого канала
				var micOffsetMs, sysOffsetMs int64
				if micErr == nil && len(micSamples) > 0 {
					micOffsetMs = session.DetectSpeechStart(micSamples, session.SampleRate)
					log.Printf("Mic speech starts at: %d ms", micOffsetMs)
				}
				if sysErr == nil && len(sysSamples) > 0 {
					sysOffsetMs = session.DetectSpeechStart(sysSamples, session.SampleRate)
					log.Printf("Sys speech starts at: %d ms", sysOffsetMs)
				}

				// Транскрипция микрофона
				go func() {
					defer wg.Done()
					if micErr != nil {
						return
					}
					log.Printf("Transcribing mic channel: %d samples", len(micSamples))
					micSegments, micErr = engine.TranscribeWithSegments(micSamples)
					if micErr != nil {
						log.Printf("Mic transcription error: %v", micErr)
					} else {
						// Применяем offset к таймстемпам
						for i := range micSegments {
							micSegments[i].Start += micOffsetMs
							micSegments[i].End += micOffsetMs
						}

						var texts []string
						for _, seg := range micSegments {
							texts = append(texts, seg.Text)
						}
						micText = strings.Join(texts, " ")
						log.Printf("Mic transcription: %d chars, %d segments (offset: %dms)", len(micText), len(micSegments), micOffsetMs)
					}
				}()

				// Транскрипция системного звука
				go func() {
					defer wg.Done()
					if sysErr != nil {
						return
					}
					log.Printf("Transcribing sys channel: %d samples", len(sysSamples))
					sysSegments, sysErr = engine.TranscribeWithSegments(sysSamples)
					if sysErr != nil {
						log.Printf("Sys transcription error: %v", sysErr)
					} else {
						// Применяем offset к таймстемпам
						for i := range sysSegments {
							sysSegments[i].Start += sysOffsetMs
							sysSegments[i].End += sysOffsetMs
						}

						var texts []string
						for _, seg := range sysSegments {
							texts = append(texts, seg.Text)
						}
						sysText = strings.Join(texts, " ")
						log.Printf("Sys transcription: %d chars, %d segments (offset: %dms)", len(sysText), len(sysSegments), sysOffsetMs)
					}
				}()

				wg.Wait()

				// Определяем общую ошибку
				var finalErr error
				if micErr != nil && sysErr != nil {
					finalErr = fmt.Errorf("mic: %v, sys: %v", micErr, sysErr)
				}

				// Конвертируем сегменты ai -> session
				sessionMicSegs := convertSegments(micSegments, "mic")
				sessionSysSegs := convertSegments(sysSegments, "sys")

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

				text, err := engine.Transcribe(samples, false)
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

					// Определяем offset начала речи для каждого канала
					micOffsetMs := session.DetectSpeechStart(micSamples, session.WhisperSampleRate)
					sysOffsetMs := session.DetectSpeechStart(sysSamples, session.WhisperSampleRate)
					log.Printf("MP3 extract: Mic offset=%dms, Sys offset=%dms", micOffsetMs, sysOffsetMs)

					var micText, sysText string
					var micSegments, sysSegments []ai.TranscriptSegment
					var wg sync.WaitGroup
					var micErr, sysErr error

					wg.Add(2)
					go func() {
						defer wg.Done()
						micSegments, micErr = engine.TranscribeWithSegments(micSamples)
						if micErr == nil {
							// Применяем offset
							for i := range micSegments {
								micSegments[i].Start += micOffsetMs
								micSegments[i].End += micOffsetMs
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
						sysSegments, sysErr = engine.TranscribeWithSegments(sysSamples)
						if sysErr == nil {
							// Применяем offset
							for i := range sysSegments {
								sysSegments[i].Start += sysOffsetMs
								sysSegments[i].End += sysOffsetMs
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
					sessionMicSegs := convertSegments(micSegments, "mic")
					sessionSysSegs := convertSegments(sysSegments, "sys")
					sessionMgr.UpdateChunkStereoWithSegments(sessID, chunkID, micText, sysText, sessionMicSegs, sessionSysSegs, finalErr)
				} else {
					samples, err := session.ExtractSegment(mp3Path, chunk.StartMs, chunk.EndMs, session.WhisperSampleRate)
					if err != nil {
						log.Printf("Failed to extract from MP3: %v", err)
						sessionMgr.UpdateChunkTranscription(sessID, chunkID, "", err)
						return
					}
					text, err := engine.Transcribe(samples, false)
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
			if engine != nil {
				if msg.Language != "" {
					engine.SetLanguage(msg.Language)
					log.Printf("Language set to: %s", msg.Language)
				}
				if msg.Model != "" {
					if err := engine.SetModel(msg.Model); err != nil {
						log.Printf("Failed to set model %s: %v", msg.Model, err)
					} else {
						log.Printf("Model set to: %s", msg.Model)
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
				// Пробуем загрузить модель, если путь не существует - используем текущую
				modelPath := msg.Model
				if _, err := os.Stat(modelPath); os.IsNotExist(err) {
					// Пробуем найти модель в текущей директории по имени файла
					modelName := filepath.Base(modelPath)
					alternativePaths := []string{
						modelName,
						filepath.Join("backend", modelName),
						filepath.Join("..", "backend", modelName),
					}

					found := false
					for _, altPath := range alternativePaths {
						if _, err := os.Stat(altPath); err == nil {
							modelPath = altPath
							found = true
							log.Printf("Model found at alternative path: %s", altPath)
							break
						}
					}

					if !found {
						log.Printf("Model %s not found, using current model", msg.Model)
						// Не меняем модель, используем текущую
						modelPath = ""
					}
				}

				if modelPath != "" {
					if err := engine.SetModel(modelPath); err != nil {
						log.Printf("Failed to set model %s: %v", modelPath, err)
						conn.WriteJSON(Message{Type: "error", Data: fmt.Sprintf("Failed to load model: %v", err)})
						continue
					}
					log.Printf("Model switched to: %s", modelPath)
				}
			}
			if msg.Language != "" {
				engine.SetLanguage(msg.Language)
				log.Printf("Language set to: %s", msg.Language)
			}

			// Обновляем статус чанка
			targetChunk.Status = session.ChunkStatusTranscribing
			conn.WriteJSON(Message{
				Type:      "chunk_transcribed",
				SessionID: sess.ID,
				Chunk:     targetChunk,
			})

			// Перетранскрибируем
			go func(chunk *session.Chunk, sessID string, dataDir string) {
				log.Printf("Retranscribing chunk %d with current model settings", chunk.Index)

				// Извлекаем аудио из MP3
				mp3Path := filepath.Join(dataDir, "full.mp3")
				samples, err := session.ExtractSegment(mp3Path, chunk.StartMs, chunk.EndMs, session.WhisperSampleRate)
				if err != nil {
					log.Printf("Failed to extract segment for retranscription: %v", err)
					sessionMgr.UpdateChunkTranscription(sessID, chunk.ID, "", err)
					return
				}

				text, err := engine.Transcribe(samples, false)
				if err != nil {
					log.Printf("Retranscription failed: %v", err)
				} else {
					log.Printf("Retranscription complete: %d chars", len(text))
				}
				sessionMgr.UpdateChunkTranscription(sessID, chunk.ID, text, err)
			}(targetChunk, sess.ID, sess.DataDir)
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
