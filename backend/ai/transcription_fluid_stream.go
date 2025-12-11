// Package ai provides streaming transcription engine using FluidAudio Parakeet TDT v3
package ai

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os/exec"
	"sync"
	"time"
)

// StreamingFluidASREngine реализует streaming транскрипцию через FluidAudio
type StreamingFluidASREngine struct {
	config         StreamingFluidASRConfig
	cmd            *exec.Cmd
	stdin          io.WriteCloser
	stdout         io.ReadCloser
	stderr         io.ReadCloser
	scanner        *bufio.Scanner
	mu             sync.Mutex
	isRunning      bool
	updateCallback func(StreamingTranscriptionUpdate)
	errorCallback  func(error)
}

// StreamingFluidASRConfig конфигурация streaming движка
type StreamingFluidASRConfig struct {
	ModelCacheDir         string  // Путь к кэшу моделей
	ChunkSeconds          float64 // Размер чанка в секундах (default: 15.0)
	ConfirmationThreshold float64 // Порог подтверждения (default: 0.85)
}

// StreamingTranscriptionUpdate обновление транскрипции
type StreamingTranscriptionUpdate struct {
	Text         string           // Текст транскрипции
	IsConfirmed  bool             // Подтверждённый (true) или volatile (false)
	Confidence   float32          // Уверенность модели (0.0-1.0)
	Timestamp    time.Time        // Время обновления
	TokenTimings []TranscriptWord // Token-level timestamps
}

// streamCommand команда для Swift CLI
type streamCommand struct {
	Command               string    `json:"command"`
	ModelCacheDir         *string   `json:"model_cache_dir,omitempty"`
	Samples               []float32 `json:"samples,omitempty"`
	SamplesBase64         *string   `json:"samples_base64,omitempty"`
	ChunkSeconds          *float64  `json:"chunk_seconds,omitempty"`
	ConfirmationThreshold *float64  `json:"confirmation_threshold,omitempty"`
}

// streamResponse ответ от Swift CLI
type streamResponse struct {
	Type         string            `json:"type"`
	Text         *string           `json:"text,omitempty"`
	IsConfirmed  *bool             `json:"is_confirmed,omitempty"`
	Confidence   *float32          `json:"confidence,omitempty"`
	Timestamp    *float64          `json:"timestamp,omitempty"`
	Duration     *float64          `json:"duration,omitempty"`
	Message      *string           `json:"message,omitempty"`
	TokenTimings []tokenTimingJSON `json:"token_timings,omitempty"`
}

type tokenTimingJSON struct {
	Token      string  `json:"token"`
	Start      float64 `json:"start"`
	End        float64 `json:"end"`
	Confidence float32 `json:"confidence"`
}

// NewStreamingFluidASREngine создаёт новый streaming движок
func NewStreamingFluidASREngine(config StreamingFluidASRConfig) (*StreamingFluidASREngine, error) {
	// Проверяем наличие бинарника
	binaryPath := "./backend/audio/transcription-stream/transcription-fluid-stream"

	engine := &StreamingFluidASREngine{
		config: config,
	}

	// Запускаем subprocess
	engine.cmd = exec.Command(binaryPath)

	var err error
	engine.stdin, err = engine.cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	engine.stdout, err = engine.cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	engine.stderr, err = engine.cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	// Запускаем процесс
	if err := engine.cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start subprocess: %w", err)
	}

	engine.scanner = bufio.NewScanner(engine.stdout)
	engine.isRunning = true

	// Запускаем горутину для чтения stderr (логи)
	go engine.readStderr()

	// Запускаем горутину для чтения обновлений
	go engine.readUpdates()

	// Инициализируем
	if err := engine.initialize(); err != nil {
		engine.Close()
		return nil, fmt.Errorf("failed to initialize: %w", err)
	}

	return engine, nil
}

// initialize отправляет команду init и ждёт ready
func (e *StreamingFluidASREngine) initialize() error {
	cmd := streamCommand{
		Command:       "init",
		ModelCacheDir: &e.config.ModelCacheDir,
	}

	if e.config.ChunkSeconds > 0 {
		cmd.ChunkSeconds = &e.config.ChunkSeconds
	}
	if e.config.ConfirmationThreshold > 0 {
		cmd.ConfirmationThreshold = &e.config.ConfirmationThreshold
	}

	if err := e.sendCommand(cmd); err != nil {
		return err
	}

	// Ждём ready (с таймаутом 60 секунд для первой загрузки модели)
	timeout := time.After(60 * time.Second)
	readyChan := make(chan bool, 1)

	// Временно перехватываем обновления для поиска ready
	originalCallback := e.updateCallback
	e.updateCallback = func(update StreamingTranscriptionUpdate) {
		// Пропускаем, ждём только ready
	}

	go func() {
		for e.isRunning {
			if e.scanner.Scan() {
				line := e.scanner.Text()
				var resp streamResponse
				if err := json.Unmarshal([]byte(line), &resp); err == nil {
					if resp.Type == "ready" {
						readyChan <- true
						return
					}
				}
			}
		}
	}()

	select {
	case <-readyChan:
		e.updateCallback = originalCallback
		log.Printf("StreamingFluidASREngine: initialized successfully")
		return nil
	case <-timeout:
		return fmt.Errorf("initialization timeout")
	}
}

// StreamAudio отправляет аудио чанк для обработки
func (e *StreamingFluidASREngine) StreamAudio(samples []float32) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.isRunning {
		return fmt.Errorf("engine not running")
	}

	// Для больших чанков используем base64
	useBase64 := len(samples) > 1000

	cmd := streamCommand{
		Command: "stream",
	}

	if useBase64 {
		// Конвертируем в base64
		buf := new(bytes.Buffer)
		binary.Write(buf, binary.LittleEndian, samples)
		encoded := base64.StdEncoding.EncodeToString(buf.Bytes())
		cmd.SamplesBase64 = &encoded
	} else {
		cmd.Samples = samples
	}

	return e.sendCommand(cmd)
}

// Finish завершает streaming и возвращает финальный текст
func (e *StreamingFluidASREngine) Finish() (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.isRunning {
		return "", fmt.Errorf("engine not running")
	}

	cmd := streamCommand{
		Command: "finish",
	}

	if err := e.sendCommand(cmd); err != nil {
		return "", err
	}

	// Ждём final response
	timeout := time.After(10 * time.Second)
	finalChan := make(chan string, 1)
	errorChan := make(chan error, 1)

	go func() {
		for e.scanner.Scan() {
			line := e.scanner.Text()
			var resp streamResponse
			if err := json.Unmarshal([]byte(line), &resp); err != nil {
				continue
			}

			if resp.Type == "final" && resp.Text != nil {
				finalChan <- *resp.Text
				return
			} else if resp.Type == "error" && resp.Message != nil {
				errorChan <- fmt.Errorf(*resp.Message)
				return
			}
		}
	}()

	select {
	case text := <-finalChan:
		return text, nil
	case err := <-errorChan:
		return "", err
	case <-timeout:
		return "", fmt.Errorf("finish timeout")
	}
}

// Reset сбрасывает состояние для новой сессии
func (e *StreamingFluidASREngine) Reset() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.isRunning {
		return fmt.Errorf("engine not running")
	}

	cmd := streamCommand{
		Command: "reset",
	}

	return e.sendCommand(cmd)
}

// SetUpdateCallback устанавливает callback для обновлений
func (e *StreamingFluidASREngine) SetUpdateCallback(callback func(StreamingTranscriptionUpdate)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.updateCallback = callback
}

// SetErrorCallback устанавливает callback для ошибок
func (e *StreamingFluidASREngine) SetErrorCallback(callback func(error)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.errorCallback = callback
}

// Close закрывает движок и освобождает ресурсы
func (e *StreamingFluidASREngine) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.isRunning {
		return nil
	}

	e.isRunning = false

	// Отправляем exit
	cmd := streamCommand{
		Command: "exit",
	}
	e.sendCommand(cmd)

	// Закрываем stdin
	if e.stdin != nil {
		e.stdin.Close()
	}

	// Ждём завершения процесса
	if e.cmd != nil && e.cmd.Process != nil {
		e.cmd.Wait()
	}

	log.Printf("StreamingFluidASREngine: closed")
	return nil
}

// sendCommand отправляет команду в subprocess
func (e *StreamingFluidASREngine) sendCommand(cmd streamCommand) error {
	data, err := json.Marshal(cmd)
	if err != nil {
		return fmt.Errorf("failed to marshal command: %w", err)
	}

	_, err = e.stdin.Write(append(data, '\n'))
	if err != nil {
		return fmt.Errorf("failed to write command: %w", err)
	}

	return nil
}

// readUpdates читает обновления из stdout
func (e *StreamingFluidASREngine) readUpdates() {
	for e.isRunning && e.scanner.Scan() {
		line := e.scanner.Text()

		var resp streamResponse
		if err := json.Unmarshal([]byte(line), &resp); err != nil {
			log.Printf("StreamingFluidASREngine: failed to parse response: %v", err)
			continue
		}

		switch resp.Type {
		case "update":
			if resp.Text != nil && resp.IsConfirmed != nil && resp.Confidence != nil && resp.Timestamp != nil {
				update := StreamingTranscriptionUpdate{
					Text:        *resp.Text,
					IsConfirmed: *resp.IsConfirmed,
					Confidence:  *resp.Confidence,
					Timestamp:   time.Unix(int64(*resp.Timestamp), 0),
				}

				// Конвертируем token timings
				if len(resp.TokenTimings) > 0 {
					update.TokenTimings = make([]TranscriptWord, len(resp.TokenTimings))
					for i, tt := range resp.TokenTimings {
						update.TokenTimings[i] = TranscriptWord{
							Text:  tt.Token,
							Start: int64(tt.Start * 1000),
							End:   int64(tt.End * 1000),
							P:     tt.Confidence,
						}
					}
				}

				if e.updateCallback != nil {
					e.updateCallback(update)
				}
			}

		case "error":
			if resp.Message != nil {
				err := fmt.Errorf("streaming error: %s", *resp.Message)
				log.Printf("StreamingFluidASREngine: %v", err)
				if e.errorCallback != nil {
					e.errorCallback(err)
				}
			}

		case "ready", "final":
			// Обрабатываются в других местах

		default:
			log.Printf("StreamingFluidASREngine: unknown response type: %s", resp.Type)
		}
	}

	if err := e.scanner.Err(); err != nil {
		log.Printf("StreamingFluidASREngine: scanner error: %v", err)
	}
}

// readStderr читает stderr (логи) из subprocess
func (e *StreamingFluidASREngine) readStderr() {
	scanner := bufio.NewScanner(e.stderr)
	for scanner.Scan() {
		log.Printf("[transcription-fluid-stream] %s", scanner.Text())
	}
}
