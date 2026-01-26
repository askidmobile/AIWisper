package session

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os"

	"github.com/hajimehoshi/go-mp3"
)

// MP3Reader читает MP3 файлы используя чистый Go (без FFmpeg)
type MP3Reader struct {
	decoder    *mp3.Decoder
	file       *os.File
	sampleRate int
	channels   int
	length     int64 // длина в байтах (signed 16-bit PCM)
}

// NewMP3Reader открывает MP3 файл для чтения
func NewMP3Reader(filePath string) (*MP3Reader, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open MP3 file: %w", err)
	}

	decoder, err := mp3.NewDecoder(file)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("failed to create MP3 decoder: %w", err)
	}

	// go-mp3 возвращает длину в байтах (signed 16-bit stereo = 4 bytes per sample)
	return &MP3Reader{
		decoder:    decoder,
		file:       file,
		sampleRate: decoder.SampleRate(),
		channels:   2, // go-mp3 всегда декодирует в стерео
		length:     decoder.Length(),
	}, nil
}

// SampleRate возвращает частоту дискретизации
func (r *MP3Reader) SampleRate() int {
	return r.sampleRate
}

// Channels возвращает количество каналов
func (r *MP3Reader) Channels() int {
	return r.channels
}

// Duration возвращает длительность в секундах
func (r *MP3Reader) Duration() float64 {
	// length в байтах, 4 байта на сэмпл (16-bit stereo)
	samples := r.length / 4
	return float64(samples) / float64(r.sampleRate)
}

// ReadAllStereo читает весь файл и возвращает отдельные каналы (left, right)
// Возвращает float32 сэмплы с исходной частотой дискретизации
func (r *MP3Reader) ReadAllStereo() ([]float32, []float32, error) {
	// Читаем весь PCM (signed 16-bit stereo, interleaved)
	pcmData := make([]byte, r.length)
	n, err := io.ReadFull(r.decoder, pcmData)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return nil, nil, fmt.Errorf("failed to read PCM data: %w", err)
	}
	pcmData = pcmData[:n]

	// Количество сэмплов на канал
	numSamples := n / 4 // 2 bytes per sample * 2 channels

	left := make([]float32, numSamples)
	right := make([]float32, numSamples)

	for i := 0; i < numSamples; i++ {
		// Читаем signed 16-bit little-endian
		leftSample := int16(binary.LittleEndian.Uint16(pcmData[i*4:]))
		rightSample := int16(binary.LittleEndian.Uint16(pcmData[i*4+2:]))

		// Конвертируем в float32 [-1.0, 1.0]
		left[i] = float32(leftSample) / 32768.0
		right[i] = float32(rightSample) / 32768.0
	}

	return left, right, nil
}

// ReadAllMono читает весь файл и возвращает моно (среднее каналов)
func (r *MP3Reader) ReadAllMono() ([]float32, error) {
	left, right, err := r.ReadAllStereo()
	if err != nil {
		return nil, err
	}

	mono := make([]float32, len(left))
	for i := 0; i < len(left); i++ {
		mono[i] = (left[i] + right[i]) / 2.0
	}

	return mono, nil
}

// Close закрывает файл
func (r *MP3Reader) Close() error {
	return r.file.Close()
}

// resampleLinear выполняет линейную интерполяцию для ресемплинга
func resampleLinear(samples []float32, srcRate, dstRate int) []float32 {
	if srcRate == dstRate {
		return samples
	}

	ratio := float64(srcRate) / float64(dstRate)
	newLen := int(float64(len(samples)) / ratio)
	resampled := make([]float32, newLen)

	for i := 0; i < newLen; i++ {
		srcPos := float64(i) * ratio
		srcIdx := int(srcPos)
		frac := float32(srcPos - float64(srcIdx))

		if srcIdx+1 < len(samples) {
			resampled[i] = samples[srcIdx]*(1-frac) + samples[srcIdx+1]*frac
		} else if srcIdx < len(samples) {
			resampled[i] = samples[srcIdx]
		}
	}

	return resampled
}

// ExtractSegmentGo извлекает фрагмент из MP3 файла и возвращает моно PCM samples
// Чистый Go, без FFmpeg!
// startMs, endMs - время в миллисекундах
// targetSampleRate - целевая частота (обычно 16000 для Whisper)
func ExtractSegmentGo(mp3Path string, startMs, endMs int64, targetSampleRate int) ([]float32, error) {
	reader, err := NewMP3Reader(mp3Path)
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	// Читаем весь файл (go-mp3 не поддерживает seek)
	left, right, err := reader.ReadAllStereo()
	if err != nil {
		return nil, err
	}

	srcRate := reader.SampleRate()

	// Вычисляем индексы для извлечения сегмента
	startSample := int(float64(startMs) * float64(srcRate) / 1000.0)
	endSample := int(float64(endMs) * float64(srcRate) / 1000.0)

	if startSample < 0 {
		startSample = 0
	}
	if endSample > len(left) {
		endSample = len(left)
	}
	if startSample >= endSample {
		return nil, fmt.Errorf("invalid segment: start=%d, end=%d", startSample, endSample)
	}

	// Извлекаем сегмент и делаем моно
	segLen := endSample - startSample
	mono := make([]float32, segLen)
	for i := 0; i < segLen; i++ {
		mono[i] = (left[startSample+i] + right[startSample+i]) / 2.0
	}

	// Ресемплинг до целевой частоты
	if srcRate != targetSampleRate {
		mono = resampleLinear(mono, srcRate, targetSampleRate)
	}

	log.Printf("ExtractSegmentGo: %s [%.1f-%.1f sec] -> %d samples (pure Go, no FFmpeg)",
		mp3Path, float64(startMs)/1000, float64(endMs)/1000, len(mono))

	return mono, nil
}

// ExtractSegmentStereoGo извлекает стерео фрагмент из MP3 и возвращает раздельные каналы
// Чистый Go, без FFmpeg!
// Возвращает: leftSamples (mic), rightSamples (sys)
func ExtractSegmentStereoGo(mp3Path string, startMs, endMs int64, targetSampleRate int) ([]float32, []float32, error) {
	reader, err := NewMP3Reader(mp3Path)
	if err != nil {
		return nil, nil, err
	}
	defer reader.Close()

	// Читаем весь файл
	left, right, err := reader.ReadAllStereo()
	if err != nil {
		return nil, nil, err
	}

	srcRate := reader.SampleRate()

	// Вычисляем индексы для извлечения сегмента
	startSample := int(float64(startMs) * float64(srcRate) / 1000.0)
	endSample := int(float64(endMs) * float64(srcRate) / 1000.0)

	if startSample < 0 {
		startSample = 0
	}
	if endSample > len(left) {
		endSample = len(left)
	}
	if startSample >= endSample {
		return nil, nil, fmt.Errorf("invalid segment: start=%d, end=%d", startSample, endSample)
	}

	// Извлекаем сегменты
	segLen := endSample - startSample
	leftSeg := make([]float32, segLen)
	rightSeg := make([]float32, segLen)
	copy(leftSeg, left[startSample:endSample])
	copy(rightSeg, right[startSample:endSample])

	// Ресемплинг до целевой частоты
	if srcRate != targetSampleRate {
		leftSeg = resampleLinear(leftSeg, srcRate, targetSampleRate)
		rightSeg = resampleLinear(rightSeg, srcRate, targetSampleRate)
	}

	log.Printf("ExtractSegmentStereoGo: %s [%.1f-%.1f sec] -> L:%d R:%d samples (pure Go, no FFmpeg)",
		mp3Path, float64(startMs)/1000, float64(endMs)/1000, len(leftSeg), len(rightSeg))

	return leftSeg, rightSeg, nil
}
