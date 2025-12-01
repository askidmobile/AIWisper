// Простой тест записи с микрофона
// Запуск: go run ./cmd/testmic
// Остановка: Ctrl+C

package main

import (
	"encoding/binary"
	"log"
	"math"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gen2brain/malgo"
)

const (
	sampleRate    = 48000
	channels      = 1
	bitsPerSample = 16
	outputFile    = "test_mic.wav"
)

func main() {
	log.Println("=== Тест записи с микрофона ===")
	log.Printf("Выходной файл: %s", outputFile)
	log.Printf("Формат: %dHz, %d каналов, %d бит", sampleRate, channels, bitsPerSample)
	log.Println("Нажмите Ctrl+C для остановки...")

	// Инициализируем miniaudio
	ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		log.Fatalf("Ошибка инициализации контекста: %v", err)
	}
	defer ctx.Uninit()
	defer ctx.Free()

	// Создаём WAV файл
	file, err := os.Create(outputFile)
	if err != nil {
		log.Fatalf("Ошибка создания файла: %v", err)
	}
	defer file.Close()

	// Пишем placeholder header
	var samplesWritten int64
	var mu sync.Mutex
	writeWAVHeader(file, samplesWritten)

	// Настраиваем устройство захвата
	deviceConfig := malgo.DefaultDeviceConfig(malgo.Capture)
	deviceConfig.Capture.Format = malgo.FormatF32
	deviceConfig.Capture.Channels = channels
	deviceConfig.SampleRate = sampleRate
	deviceConfig.Alsa.NoMMap = 1

	startTime := time.Now()
	var totalBytes int64

	onRecvFrames := func(pOutputSample, pInputSamples []byte, framecount uint32) {
		sampleCount := int(framecount) * channels

		if len(pInputSamples) != sampleCount*4 {
			return
		}

		// Конвертируем float32 в int16
		pcmData := make([]byte, sampleCount*2)
		for i := 0; i < sampleCount; i++ {
			bits := uint32(pInputSamples[i*4]) | uint32(pInputSamples[i*4+1])<<8 | uint32(pInputSamples[i*4+2])<<16 | uint32(pInputSamples[i*4+3])<<24
			floatVal := math.Float32frombits(bits)

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
		samplesWritten += int64(sampleCount)
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

	device, err := malgo.InitDevice(ctx.Context, deviceConfig, malgo.DeviceCallbacks{
		Data: onRecvFrames,
	})
	if err != nil {
		log.Fatalf("Ошибка инициализации устройства: %v", err)
	}
	defer device.Uninit()

	if err := device.Start(); err != nil {
		log.Fatalf("Ошибка запуска устройства: %v", err)
	}

	log.Println("Запись началась...")

	// Обработка сигнала остановки
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, syscall.SIGINT, syscall.SIGTERM)

	<-stopChan
	log.Println("\nОстановка записи...")

	device.Stop()

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
