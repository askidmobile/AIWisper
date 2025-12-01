package session

import (
	"encoding/binary"
	"fmt"
	"os"
	"sync"
)

// WAVWriter потоковый писатель WAV файлов
type WAVWriter struct {
	file           *os.File
	filePath       string
	sampleRate     int
	channels       int
	bitsPerSample  int
	samplesWritten int64
	headerWritten  bool
	mu             sync.Mutex
}

// NewWAVWriter создаёт новый WAV writer
func NewWAVWriter(filePath string, sampleRate, channels, bitsPerSample int) (*WAVWriter, error) {
	file, err := os.Create(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to create WAV file: %w", err)
	}

	w := &WAVWriter{
		file:          file,
		filePath:      filePath,
		sampleRate:    sampleRate,
		channels:      channels,
		bitsPerSample: bitsPerSample,
	}

	// Записываем placeholder header
	if err := w.writeHeader(); err != nil {
		file.Close()
		return nil, err
	}

	return w, nil
}

// writeHeader записывает WAV header
func (w *WAVWriter) writeHeader() error {
	w.file.Seek(0, 0)

	byteRate := w.sampleRate * w.channels * w.bitsPerSample / 8
	blockAlign := w.channels * w.bitsPerSample / 8
	dataSize := uint32(w.samplesWritten * int64(w.bitsPerSample/8))

	// RIFF header
	w.file.WriteString("RIFF")
	binary.Write(w.file, binary.LittleEndian, uint32(36+dataSize))
	w.file.WriteString("WAVE")

	// fmt chunk
	w.file.WriteString("fmt ")
	binary.Write(w.file, binary.LittleEndian, uint32(16))           // chunk size
	binary.Write(w.file, binary.LittleEndian, uint16(1))            // PCM
	binary.Write(w.file, binary.LittleEndian, uint16(w.channels))   // channels
	binary.Write(w.file, binary.LittleEndian, uint32(w.sampleRate)) // sample rate
	binary.Write(w.file, binary.LittleEndian, uint32(byteRate))     // byte rate
	binary.Write(w.file, binary.LittleEndian, uint16(blockAlign))   // block align
	binary.Write(w.file, binary.LittleEndian, uint16(w.bitsPerSample))

	// data chunk
	w.file.WriteString("data")
	binary.Write(w.file, binary.LittleEndian, dataSize)

	w.headerWritten = true
	return nil
}

// Write записывает float32 семплы в файл (конвертирует в PCM16)
func (w *WAVWriter) Write(samples []float32) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Конвертируем float32 в int16
	for _, s := range samples {
		// Clamp
		if s > 1.0 {
			s = 1.0
		} else if s < -1.0 {
			s = -1.0
		}
		sample := int16(s * 32767)
		if err := binary.Write(w.file, binary.LittleEndian, sample); err != nil {
			return err
		}
		w.samplesWritten++
	}

	return nil
}

// SamplesWritten возвращает количество записанных семплов
func (w *WAVWriter) SamplesWritten() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.samplesWritten
}

// Finalize завершает запись и обновляет header
func (w *WAVWriter) Finalize() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Обновляем header с правильным размером
	return w.writeHeader()
}

// FlushHeader обновляет header (для crash-safety)
func (w *WAVWriter) FlushHeader() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Сохраняем текущую позицию
	pos, err := w.file.Seek(0, 1)
	if err != nil {
		return err
	}

	// Обновляем header
	if err := w.writeHeader(); err != nil {
		return err
	}

	// Возвращаемся к концу файла
	_, err = w.file.Seek(pos, 0)
	return err
}

// Close закрывает файл
func (w *WAVWriter) Close() error {
	w.Finalize()
	return w.file.Close()
}

// FilePath возвращает путь к файлу
func (w *WAVWriter) FilePath() string {
	return w.filePath
}
