// Test: запись аудио через Go (чтение из screencapture-audio pipe)
// Запуск: go run ./cmd/testrecord/main.go
package main

import (
	"bufio"
	"encoding/binary"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

const (
	sampleRate = 24000
	channels   = 1
	outputPath = "/tmp/go_pipe_test.wav"
)

// WAVWriter для записи float32 в WAV (PCM16)
type WAVWriter struct {
	file           *os.File
	samplesWritten int64
}

func NewWAVWriter(path string) (*WAVWriter, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	w := &WAVWriter{file: f}
	w.writeHeader() // placeholder
	return w, nil
}

func (w *WAVWriter) writeHeader() {
	w.file.Seek(0, 0)

	bitsPerSample := 16
	byteRate := sampleRate * channels * bitsPerSample / 8
	blockAlign := channels * bitsPerSample / 8
	dataSize := uint32(w.samplesWritten * 2)

	// RIFF header
	w.file.WriteString("RIFF")
	binary.Write(w.file, binary.LittleEndian, uint32(36+dataSize))
	w.file.WriteString("WAVE")

	// fmt chunk
	w.file.WriteString("fmt ")
	binary.Write(w.file, binary.LittleEndian, uint32(16))
	binary.Write(w.file, binary.LittleEndian, uint16(1)) // PCM
	binary.Write(w.file, binary.LittleEndian, uint16(channels))
	binary.Write(w.file, binary.LittleEndian, uint32(sampleRate))
	binary.Write(w.file, binary.LittleEndian, uint32(byteRate))
	binary.Write(w.file, binary.LittleEndian, uint16(blockAlign))
	binary.Write(w.file, binary.LittleEndian, uint16(bitsPerSample))

	// data chunk
	w.file.WriteString("data")
	binary.Write(w.file, binary.LittleEndian, dataSize)
}

func (w *WAVWriter) Write(samples []float32) error {
	for _, s := range samples {
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

func (w *WAVWriter) Close() error {
	w.writeHeader() // update with final size
	duration := float64(w.samplesWritten) / float64(sampleRate)
	log.Printf("WAV closed: samples=%d, duration=%.2fs", w.samplesWritten, duration)
	return w.file.Close()
}

func float32frombits(b uint32) float32 {
	return math.Float32frombits(b)
}

func main() {
	log.Println("=== GO PIPE TEST ===")
	log.Printf("Output: %s", outputPath)
	log.Println("Recording for 5 seconds...")
	log.Println(">>> SPEAK NOW! <<<")

	// Запускаем screencapture-audio
	screenCapturePath := "/Users/askid/Projects/AIWisper/backend/audio/screencapture/.build/release/screencapture-audio"
	cmd := exec.Command(screenCapturePath, "mic")

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Fatalf("Failed to get stdout: %v", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		log.Fatalf("Failed to get stderr: %v", err)
	}

	if err := cmd.Start(); err != nil {
		log.Fatalf("Failed to start: %v", err)
	}

	// Логируем stderr
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			log.Printf("[Swift] %s", scanner.Text())
		}
	}()

	// Создаём WAV writer
	wavWriter, err := NewWAVWriter(outputPath)
	if err != nil {
		log.Fatalf("Failed to create WAV: %v", err)
	}

	// Читаем данные из pipe
	reader := bufio.NewReader(stdout)
	header := make([]byte, 5)

	done := make(chan struct{})
	var totalSamples int

	startTime := time.Now()

	go func() {
		defer close(done)
		for {
			// Таймаут по времени
			if time.Since(startTime) > 5*time.Second {
				return
			}

			// Читаем заголовок: [marker 1 byte][size 4 bytes]
			_, err := io.ReadFull(reader, header)
			if err != nil {
				if err != io.EOF {
					log.Printf("Error reading header: %v", err)
				}
				return
			}

			marker := header[0]
			sampleCount := binary.LittleEndian.Uint32(header[1:5])

			if sampleCount == 0 || sampleCount > 1000000 {
				log.Printf("Invalid sample count: %d", sampleCount)
				continue
			}

			// Читаем данные
			dataSize := int(sampleCount) * 4
			data := make([]byte, dataSize)
			_, err = io.ReadFull(reader, data)
			if err != nil {
				if err != io.EOF {
					log.Printf("Error reading data: %v", err)
				}
				return
			}

			// Конвертируем bytes в float32
			samples := make([]float32, sampleCount)
			for i := uint32(0); i < sampleCount; i++ {
				bits := binary.LittleEndian.Uint32(data[i*4 : (i+1)*4])
				samples[i] = float32frombits(bits)
			}

			// Пишем в WAV
			if marker == 0x4D { // 'M' = микрофон
				if err := wavWriter.Write(samples); err != nil {
					log.Printf("Error writing WAV: %v", err)
				}
				totalSamples += len(samples)
			}
		}
	}()

	// Ждём сигнал или таймаут
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-time.After(6 * time.Second): // чуть больше чтобы дождаться всех данных
		log.Println("Timeout reached, stopping...")
	case <-sigChan:
		log.Println("Signal received, stopping...")
	}

	// Останавливаем screencapture
	cmd.Process.Signal(syscall.SIGINT)
	time.Sleep(500 * time.Millisecond)
	<-done

	wavWriter.Close()
	cmd.Wait()

	log.Printf("Total samples received: %d", totalSamples)
	expectedSamples := 5 * sampleRate
	log.Printf("Expected samples (5 sec): %d", expectedSamples)
	log.Printf("Ratio: %.2f%%", float64(totalSamples)/float64(expectedSamples)*100)
	log.Println("=== Test Complete ===")
	log.Printf("Check file: %s", outputPath)
	log.Printf("Play with: afplay %s", outputPath)
}
