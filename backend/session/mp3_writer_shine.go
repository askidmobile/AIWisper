package session

import (
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/braheezy/shine-mp3/pkg/mp3"
)

// ShineMP3Writer стриминговый писатель MP3 через shine-mp3 (чистый Go, без FFmpeg)
type ShineMP3Writer struct {
	file       *os.File
	encoder    *mp3.Encoder
	filePath   string
	sampleRate int
	channels   int

	// Буфер для накопления сэмплов (shine требует определённое количество)
	buffer []int16

	samplesWritten int64
	startTime      time.Time
	mu             sync.Mutex
	closed         bool
}

// NewShineMP3Writer создаёт новый MP3 writer через shine-mp3 (без FFmpeg!)
func NewShineMP3Writer(filePath string, sampleRate, channels int) (*ShineMP3Writer, error) {
	file, err := os.Create(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to create file: %w", err)
	}

	encoder := mp3.NewEncoder(sampleRate, channels)

	log.Printf("ShineMP3Writer started: %s (rate=%d, ch=%d) - NO FFMPEG!", filePath, sampleRate, channels)

	return &ShineMP3Writer{
		file:       file,
		encoder:    encoder,
		filePath:   filePath,
		sampleRate: sampleRate,
		channels:   channels,
		buffer:     make([]int16, 0, 8192),
		startTime:  time.Now(),
	}, nil
}

// Write записывает float32 семплы
func (w *ShineMP3Writer) Write(samples []float32) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return fmt.Errorf("writer is closed")
	}

	// Конвертируем float32 в int16
	for _, s := range samples {
		// Clamp
		if s > 1.0 {
			s = 1.0
		} else if s < -1.0 {
			s = -1.0
		}
		w.buffer = append(w.buffer, int16(s*32767))
	}

	w.samplesWritten += int64(len(samples))

	// Shine кодирует блоками по 1152 сэмплов на канал для MP3 Layer III
	// Пишем когда накопилось достаточно данных (например, 4608 сэмплов = 4 блока)
	minBufferSize := 1152 * w.channels * 4
	if len(w.buffer) >= minBufferSize {
		// Записываем накопленные данные
		w.encoder.Write(w.file, w.buffer)
		w.buffer = w.buffer[:0] // Очищаем буфер, сохраняя capacity
	}

	return nil
}

// WriteStereoInterleaved записывает стерео семплы (left, right чередуются)
func (w *ShineMP3Writer) WriteStereoInterleaved(leftSamples, rightSamples []float32) error {
	if len(leftSamples) != len(rightSamples) {
		return fmt.Errorf("left and right channel lengths don't match")
	}

	// Интерливим каналы: L0, R0, L1, R1, ...
	interleaved := make([]float32, len(leftSamples)*2)
	for i := 0; i < len(leftSamples); i++ {
		interleaved[i*2] = leftSamples[i]
		interleaved[i*2+1] = rightSamples[i]
	}

	return w.Write(interleaved)
}

// SamplesWritten возвращает количество записанных семплов
func (w *ShineMP3Writer) SamplesWritten() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.samplesWritten
}

// Duration возвращает длительность записи
func (w *ShineMP3Writer) Duration() time.Duration {
	w.mu.Lock()
	defer w.mu.Unlock()
	frames := w.samplesWritten / int64(w.channels)
	return time.Duration(frames) * time.Second / time.Duration(w.sampleRate)
}

// Close завершает запись
func (w *ShineMP3Writer) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	w.mu.Unlock()

	// Записываем оставшиеся данные из буфера
	if len(w.buffer) > 0 {
		// Дополняем до размера блока нулями
		blockSize := 1152 * w.channels
		for len(w.buffer)%blockSize != 0 {
			w.buffer = append(w.buffer, 0)
		}
		w.encoder.Write(w.file, w.buffer)
	}

	if err := w.file.Close(); err != nil {
		return fmt.Errorf("failed to close file: %w", err)
	}

	duration := w.Duration()
	log.Printf("ShineMP3Writer closed: %s (duration=%v)", w.filePath, duration)

	return nil
}

// FilePath возвращает путь к файлу
func (w *ShineMP3Writer) FilePath() string {
	return w.filePath
}
