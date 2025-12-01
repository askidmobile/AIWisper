// Простой тест записи системного аудио через ScreenCaptureKit
// Запуск: go run ./cmd/testrecord
// Остановка: Ctrl+C

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
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const (
	sampleRate    = 48000
	channels      = 1 // mono от ScreenCaptureKit
	bitsPerSample = 16
	outputFile    = "test_recording.wav"
)

func main() {
	log.Println("=== Тест записи системного аудио ===")
	log.Printf("Выходной файл: %s", outputFile)
	log.Printf("Формат: %dHz, %d каналов, %d бит", sampleRate, channels, bitsPerSample)
	log.Println("Нажмите Ctrl+C для остановки...")

	// Находим screencapture-audio binary
	binaryPath := findBinary()
	if binaryPath == "" {
		log.Fatal("screencapture-audio не найден. Соберите: cd backend/audio/screencapture && swift build -c release")
	}
	log.Printf("Используем: %s", binaryPath)

	// Создаём WAV файл
	file, err := os.Create(outputFile)
	if err != nil {
		log.Fatalf("Ошибка создания файла: %v", err)
	}
	defer file.Close()

	// Пишем placeholder header
	var samplesWritten int64
	writeWAVHeader(file, samplesWritten)

	// Запускаем screencapture-audio
	cmd := exec.Command(binaryPath)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Fatalf("Ошибка получения stdout: %v", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		log.Fatalf("Ошибка получения stderr: %v", err)
	}

	if err := cmd.Start(); err != nil {
		log.Fatalf("Ошибка запуска: %v", err)
	}

	// Читаем stderr для логов
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			log.Printf("[ScreenCaptureKit] %s", scanner.Text())
		}
	}()

	// Обработка сигнала остановки
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, syscall.SIGINT, syscall.SIGTERM)

	var mu sync.Mutex
	done := make(chan struct{})

	// Горутина для чтения аудио данных
	go func() {
		defer close(done)

		buf := make([]byte, 4*4800) // 100ms при 48kHz
		var totalBytes int64
		startTime := time.Now()

		for {
			n, err := stdout.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("Ошибка чтения: %v", err)
				}
				return
			}

			if n == 0 {
				continue
			}

			// Конвертируем float32 в int16 и пишем
			numSamples := n / 4
			pcmData := make([]byte, numSamples*2)

			for i := 0; i < numSamples; i++ {
				bits := binary.LittleEndian.Uint32(buf[i*4 : (i+1)*4])
				floatVal := float32frombits(bits)

				// Clamp
				if floatVal > 1.0 {
					floatVal = 1.0
				} else if floatVal < -1.0 {
					floatVal = -1.0
				}

				sample := int16(floatVal * 32767)
				binary.LittleEndian.PutUint16(pcmData[i*2:], uint16(sample))
			}

			mu.Lock()
			file.Write(pcmData)
			samplesWritten += int64(numSamples)
			totalBytes += int64(len(pcmData))
			mu.Unlock()

			// Логируем прогресс каждые 5 секунд
			elapsed := time.Since(startTime)
			if int(elapsed.Seconds())%5 == 0 && elapsed.Seconds() > 0 {
				expectedBytes := int64(elapsed.Seconds()) * sampleRate * 2
				ratio := float64(totalBytes) / float64(expectedBytes) * 100
				log.Printf("Записано: %.1f сек, %d байт (%.1f%% от ожидаемого)",
					elapsed.Seconds(), totalBytes, ratio)
			}
		}
	}()

	// Ждём сигнал остановки
	<-stopChan
	log.Println("\nОстановка записи...")

	// Останавливаем процесс
	cmd.Process.Signal(syscall.SIGTERM)
	cmd.Wait()

	// Ждём завершения чтения
	<-done

	// Обновляем WAV header
	mu.Lock()
	file.Seek(0, 0)
	writeWAVHeader(file, samplesWritten)
	mu.Unlock()

	duration := float64(samplesWritten) / float64(sampleRate)
	log.Printf("Готово! Записано %.1f секунд (%d семплов)", duration, samplesWritten)
	log.Printf("Файл: %s", outputFile)
}

func writeWAVHeader(file *os.File, samples int64) {
	byteRate := sampleRate * channels * bitsPerSample / 8
	blockAlign := channels * bitsPerSample / 8
	dataSize := uint32(samples * int64(bitsPerSample/8))

	file.WriteString("RIFF")
	binary.Write(file, binary.LittleEndian, uint32(36+dataSize))
	file.WriteString("WAVE")

	file.WriteString("fmt ")
	binary.Write(file, binary.LittleEndian, uint32(16))
	binary.Write(file, binary.LittleEndian, uint16(1)) // PCM
	binary.Write(file, binary.LittleEndian, uint16(channels))
	binary.Write(file, binary.LittleEndian, uint32(sampleRate))
	binary.Write(file, binary.LittleEndian, uint32(byteRate))
	binary.Write(file, binary.LittleEndian, uint16(blockAlign))
	binary.Write(file, binary.LittleEndian, uint16(bitsPerSample))

	file.WriteString("data")
	binary.Write(file, binary.LittleEndian, dataSize)
}

func float32frombits(b uint32) float32 {
	return math.Float32frombits(b)
}

func findBinary() string {
	paths := []string{
		"audio/screencapture/.build/release/screencapture-audio",
		"backend/audio/screencapture/.build/release/screencapture-audio",
		"../audio/screencapture/.build/release/screencapture-audio",
	}

	// Получаем директорию исполняемого файла
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		paths = append(paths, filepath.Join(dir, "screencapture-audio"))
	}

	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}

	return ""
}
