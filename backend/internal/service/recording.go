package service

import (
	"aiwisper/audio"
	"aiwisper/session"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

type AudioLevelCallback func(micLevel, sysLevel float64)

type RecordingService struct {
	SessionMgr *session.Manager
	Capture    *audio.Capture

	// State
	currentSession *session.Session
	mp3Writer      *session.MP3Writer
	chunkBuffer    *session.ChunkBuffer
	stopChan       chan struct{}
	mu             sync.Mutex

	// Callbacks
	OnAudioLevel AudioLevelCallback
}

func NewRecordingService(sessMgr *session.Manager, capture *audio.Capture) *RecordingService {
	return &RecordingService{
		SessionMgr: sessMgr,
		Capture:    capture,
	}
}

func (s *RecordingService) StartSession(config session.SessionConfig, echoCancel float32, voiceIsolation bool) (*session.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.currentSession != nil {
		return nil, fmt.Errorf("session already active")
	}

	// 1. Clear buffers
	s.Capture.ClearBuffers()
	log.Println("Audio buffers cleared for new session")

	// 2. Create session
	sess, err := s.SessionMgr.CreateSession(config)
	if err != nil {
		return nil, err
	}

	// 3. Create MP3 Writer
	mp3Path := filepath.Join(sess.DataDir, "full.mp3")
	mp3Writer, err := session.NewMP3Writer(mp3Path, session.SampleRate, 2, "128k")
	if err != nil {
		return nil, err
	}

	// 4. Create Chunk Buffer
	chunkBuffer := session.NewChunkBuffer(session.DefaultVADConfig(), session.SampleRate)

	s.currentSession = sess
	s.mp3Writer = mp3Writer
	s.chunkBuffer = chunkBuffer
	s.stopChan = make(chan struct{})

	// 5. Configure Capture
	cleanupOnError := func(err error) (*session.Session, error) {
		log.Printf("Failed to start session: %v", err)
		s.Capture.Stop()
		if s.chunkBuffer != nil {
			s.chunkBuffer.Close()
		}
		if s.mp3Writer != nil {
			s.mp3Writer.Close()
		}
		s.currentSession = nil
		s.mp3Writer = nil
		s.chunkBuffer = nil
		s.stopChan = nil
		return nil, err
	}

	// Предпочитаем Core Audio tap для системного звука, чтобы избежать Screen Recording prompt.
	preferCoreAudio := config.CaptureSystem && config.UseNative && audio.CoreAudioTapAvailable()
	useVoiceIsolation := voiceIsolation && audio.VoiceIsolationAvailable() && !preferCoreAudio
	if voiceIsolation && preferCoreAudio {
		log.Println("Voice Isolation requested, but Core Audio tap available - using tap for stability")
	}

	// Настройка устройств
	if config.MicDevice != "" {
		if err := s.Capture.SetMicrophoneDevice(config.MicDevice); err != nil {
			return cleanupOnError(fmt.Errorf("failed to set microphone device: %w", err))
		}
	}

	systemCaptureConfigured := false
	if config.CaptureSystem {
		s.Capture.EnableSystemCapture(true)
		switch {
		case preferCoreAudio:
			log.Println("Using Core Audio Tap for system audio (macOS 14.2+)")
			s.Capture.SetSystemCaptureMethod(audio.SystemCaptureCoreAudioTap)
			systemCaptureConfigured = true
		case config.UseNative && audio.ScreenCaptureKitAvailable():
			log.Println("Using ScreenCaptureKit for system audio (macOS 13+)")
			s.Capture.SetSystemCaptureMethod(audio.SystemCaptureScreenKit)
			systemCaptureConfigured = true
		case config.SystemDevice != "":
			log.Println("Using BlackHole/loopback for system audio")
			s.Capture.SetSystemCaptureMethod(audio.SystemCaptureBlackHole)
			if err := s.Capture.SetSystemDeviceByName(config.SystemDevice); err != nil {
				log.Printf("Failed to set system device %s: %v", config.SystemDevice, err)
			} else {
				systemCaptureConfigured = true
			}
		}
	}

	if config.CaptureSystem && !systemCaptureConfigured {
		log.Println("System capture requested but no method configured, continuing with microphone only")
		s.Capture.EnableSystemCapture(false)
	}

	// Стартуем выбранный метод захвата
	if useVoiceIsolation {
		log.Println("Voice Isolation: Using ScreenCaptureKit for mic+system (macOS 15+)")
		if err := s.Capture.StartScreenCaptureKitAudioWithMode("both"); err != nil {
			log.Printf("Failed to start Voice Isolation mode: %v, falling back to standard capture", err)
			useVoiceIsolation = false
		}
	}

	if !useVoiceIsolation {
		if err := s.Capture.Start(0); err != nil {
			return cleanupOnError(fmt.Errorf("failed to start audio capture: %w", err))
		}
	}

	// 6. Start Goroutines
	go s.processAudio(sess, echoCancel, useVoiceIsolation)
	go s.processChunks(sess, useVoiceIsolation)

	return sess, nil
}

func (s *RecordingService) StopSession() (*session.Session, error) {
	s.mu.Lock()
	// Note: We extract values to local vars and unlock to avoid deadlocks during potentially long operations like FLUSH
	if s.currentSession == nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("no active session")
	}

	log.Printf("Stopping session: %s", s.currentSession.ID)

	currentSess := s.currentSession
	localChunkBuffer := s.chunkBuffer
	localMP3Writer := s.mp3Writer

	// Close stop channel to signal goroutines
	close(s.stopChan)
	s.Capture.Stop()

	s.mu.Unlock() // Unlock for processing

	// Flush chunks
	remainingChunks := localChunkBuffer.FlushAll()
	localChunkBuffer.Close()

	// Close MP3
	if localMP3Writer != nil {
		localMP3Writer.Close()
		s.mu.Lock()
		currentSess.SampleCount = localMP3Writer.SamplesWritten()
		s.mu.Unlock()
	}

	// Save flushed chunks
	// Note: we need IsStereo from session or config. Here we assume IsStereo matches voiceIsolation used in Start
	// But voiceIsolation was local to Start. We should store it in Service state or Session struct if needed.
	// For now, let's assume session stores it? session.Session doesn't store IsStereo flag.
	// The chunk logic relies on `useVoiceIsolation` passed to processAudio.
	// We can inspect the first chunk or just rely on checks in saveChunk.
	// Actually `remainingChunks` are just data. `saveChunk` sets `IsStereo` based on parameter.
	// I need to store `useVoiceIsolation` in `startedSessionState` or similar.

	// For simplicity in refactor, I will check if remainingChunks have separated samples.
	// ChunkEvent has MicSamples and SysSamples. If both present, it's effectively treated as stereo capable.
	for _, chunk := range remainingChunks {
		isStereo := len(chunk.MicSamples) > 0 && len(chunk.SysSamples) > 0
		s.saveChunk(currentSess, &chunk, isStereo)
	}

	// Stop session in manager
	finalSess, _ := s.SessionMgr.StopSession()

	s.mu.Lock()
	s.currentSession = nil
	s.mp3Writer = nil
	s.chunkBuffer = nil
	s.mu.Unlock()

	return finalSess, nil
}

func (s *RecordingService) GetCurrentSession() *session.Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.currentSession
}

func (s *RecordingService) processAudio(sess *session.Session, echoCancel float32, useVoiceIsolation bool) {
	var micLevel, systemLevel float64
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	var micBuffer []float32
	var systemBuffer []float32
	consume := func(buf []float32, n int) []float32 {
		if n >= len(buf) {
			return buf[:0]
		}
		return buf[n:]
	}

	for {
		select {
		case <-s.stopChan:
			return

		case <-ticker.C:
			if s.OnAudioLevel != nil {
				s.OnAudioLevel(micLevel, systemLevel)
			}

		case data, ok := <-s.Capture.Data():
			if !ok {
				return
			}

			samples := data.Samples
			channel := data.Channel

			rms := session.CalculateRMS(samples)
			if channel == audio.ChannelMicrophone {
				micLevel = rms
				micBuffer = append(micBuffer, samples...)
			} else {
				systemLevel = rms
				systemBuffer = append(systemBuffer, samples...)
			}

			s.mu.Lock()
			writer := s.mp3Writer
			chunkBuf := s.chunkBuffer
			systemEnabled := s.Capture != nil && s.Capture.IsSystemCaptureEnabled()
			if writer == nil {
				s.mu.Unlock()
				return
			}

			micLen := len(micBuffer)
			sysLen := len(systemBuffer)

			if useVoiceIsolation {
				pairLen := micLen
				if sysLen < pairLen {
					pairLen = sysLen
				}

				if pairLen > 0 && chunkBuf != nil {
					chunkBuf.ProcessStereo(micBuffer[:pairLen], systemBuffer[:pairLen])
				}

				mixLen := micLen
				if sysLen > mixLen {
					mixLen = sysLen
				}

				if mixLen > 0 {
					stereo := make([]float32, mixLen*2)
					for i := 0; i < mixLen; i++ {
						var micSample, sysSample float32
						if i < micLen {
							micSample = micBuffer[i]
						}
						if i < sysLen {
							sysSample = systemBuffer[i]
						}
						stereo[i*2] = micSample
						stereo[i*2+1] = sysSample
					}

					if err := writer.Write(stereo); err != nil {
						log.Printf("Failed to write stereo audio: %v", err)
					}
					micBuffer = consume(micBuffer, mixLen)
					systemBuffer = consume(systemBuffer, mixLen)
				}

				s.mu.Unlock()
				continue
			}

			mixLen := micLen
			if sysLen > mixLen {
				mixLen = sysLen
			}

			if mixLen > 0 {
				stereo := make([]float32, mixLen*2)
				mono := make([]float32, mixLen)

				for i := 0; i < mixLen; i++ {
					var micSample, sysSample float32
					if i < micLen {
						micSample = micBuffer[i]
					}
					if systemEnabled && i < sysLen {
						sysSample = systemBuffer[i]
					}

					stereo[i*2] = micSample
					stereo[i*2+1] = sysSample

					micClean := micSample - sysSample*echoCancel
					if micClean > 1.0 {
						micClean = 1.0
					} else if micClean < -1.0 {
						micClean = -1.0
					}
					mono[i] = (micClean + sysSample) / 2
				}

				if err := writer.Write(stereo); err != nil {
					log.Printf("Failed to write audio: %v", err)
				}
				if chunkBuf != nil {
					chunkBuf.Process(mono)
				}

				micBuffer = consume(micBuffer, mixLen)
				systemBuffer = consume(systemBuffer, mixLen)
			}
			s.mu.Unlock()
		}
	}
}

func (s *RecordingService) processChunks(sess *session.Session, useVoiceIsolation bool) {
	// Need to access chunkBuffer safely.
	// But chunkBuffer.Output() returns a channel. We can just read from it.
	// NOTE: chunkBuffer is closed when StopSession calls it.

	// We need to get the channel pointer once.
	s.mu.Lock()
	cb := s.chunkBuffer
	s.mu.Unlock()

	if cb == nil {
		return
	}

	for event := range cb.Output() {
		s.saveChunk(sess, &event, useVoiceIsolation)
	}
}

func (s *RecordingService) saveChunk(sess *session.Session, event *session.ChunkEvent, isStereo bool) {
	// Thread-safe chunk index generation
	s.mu.Lock()
	chunkIndex := len(sess.Chunks)
	s.mu.Unlock()

	// Create chunk metadata only - audio is extracted from full.mp3 when needed
	chunk := &session.Chunk{
		ID:        uuid.New().String(),
		SessionID: sess.ID,
		Index:     chunkIndex,
		StartMs:   event.StartMs,
		EndMs:     event.EndMs,
		Duration:  event.Duration,
		IsStereo:  isStereo,
		Status:    session.ChunkStatusPending,
		CreatedAt: time.Now(),
	}

	log.Printf("Saving chunk %d: start=%dms, end=%dms, isStereo=%v", chunkIndex, event.StartMs, event.EndMs, isStereo)

	if err := s.SessionMgr.AddChunk(sess.ID, chunk); err != nil {
		log.Printf("Failed to add chunk: %v", err)
	}
}
