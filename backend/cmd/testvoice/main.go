// Тест полного стека Voice Isolation
// Использует audio.Capture с Voice Isolation режимом
// и сравнивает старую (max) и новую (min) логику микширования
//
// Запуск: cd backend && go run ./cmd/testvoice
// Остановка: Ctrl+C
//
// Создаёт файлы:
// - /tmp/voice_fixed.wav - ИСПРАВЛЕННАЯ логика (min) - должен звучать чисто
// - /tmp/voice_broken.wav - СТАРАЯ логика (max) - звучит роботизированно
// - /tmp/voice_mic_only.wav - только микрофон (эталон)
// - /tmp/voice_sys_only.wav - только системный звук

package main

import (
	"aiwisper/audio"
	"encoding/binary"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

const (
	sampleRate    = 24000
	bitsPerSample = 16

	outputFileFixed  = "/tmp/voice_fixed.wav"
	outputFileBroken = "/tmp/voice_broken.wav"
	outputFileMic    = "/tmp/voice_mic_only.wav"
	outputFileSys    = "/tmp/voice_sys_only.wav"
)

type WAVWriter struct {
	file           *os.File
	samplesWritten int64
	channels       int
	mu             sync.Mutex
}

func NewWAVWriter(path string, channels int) (*WAVWriter, error) {
	file, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	w := &WAVWriter{file: file, channels: channels}
	w.writeHeader()
	return w, nil
}

func (w *WAVWriter) writeHeader() {
	byteRate := sampleRate * w.channels * bitsPerSample / 8
	blockAlign := w.channels * bitsPerSample / 8
	dataSize := uint32(w.samplesWritten * int64(bitsPerSample/8) * int64(w.channels))

	w.file.Seek(0, 0)
	w.file.WriteString("RIFF")
	binary.Write(w.file, binary.LittleEndian, uint32(36+dataSize))
	w.file.WriteString("WAVE")

	w.file.WriteString("fmt ")
	binary.Write(w.file, binary.LittleEndian, uint32(16))
	binary.Write(w.file, binary.LittleEndian, uint16(1)) // PCM
	binary.Write(w.file, binary.LittleEndian, uint16(w.channels))
	binary.Write(w.file, binary.LittleEndian, uint32(sampleRate))
	binary.Write(w.file, binary.LittleEndian, uint32(byteRate))
	binary.Write(w.file, binary.LittleEndian, uint16(blockAlign))
	binary.Write(w.file, binary.LittleEndian, uint16(bitsPerSample))

	w.file.WriteString("data")
	binary.Write(w.file, binary.LittleEndian, dataSize)
}

func (w *WAVWriter) WriteStereo(samples []float32) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	pcmData := make([]byte, len(samples)*2)
	for i, sample := range samples {
		if sample > 1.0 {
			sample = 1.0
		} else if sample < -1.0 {
			sample = -1.0
		}
		binary.LittleEndian.PutUint16(pcmData[i*2:], uint16(int16(sample*32767)))
	}

	_, err := w.file.Write(pcmData)
	if err != nil {
		return err
	}
	w.samplesWritten += int64(len(samples) / w.channels)
	return nil
}

func (w *WAVWriter) WriteMono(samples []float32) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	pcmData := make([]byte, len(samples)*2)
	for i, sample := range samples {
		if sample > 1.0 {
			sample = 1.0
		} else if sample < -1.0 {
			sample = -1.0
		}
		binary.LittleEndian.PutUint16(pcmData[i*2:], uint16(int16(sample*32767)))
	}

	_, err := w.file.Write(pcmData)
	if err != nil {
		return err
	}
	w.samplesWritten += int64(len(samples))
	return nil
}

func (w *WAVWriter) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.writeHeader() // обновляем размеры
	w.file.Close()
}

func (w *WAVWriter) SamplesWritten() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.samplesWritten
}

func main() {
	log.Println("=== Тест Voice Isolation: сравнение логики микширования ===")
	log.Println()
	log.Println("Создаём файлы:")
	log.Printf("  - %s (ИСПРАВЛЕННАЯ логика min - должен быть чистый)", outputFileFixed)
	log.Printf("  - %s (СТАРАЯ логика max - роботизированный звук)", outputFileBroken)
	log.Printf("  - %s (только микрофон - эталон)", outputFileMic)
	log.Printf("  - %s (только системный звук)", outputFileSys)
	log.Println()
	log.Println("Нажмите Ctrl+C для остановки...")

	// Создаём audio.Capture
	capture, err := audio.NewCapture()
	if err != nil {
		log.Fatalf("Ошибка создания audio.Capture: %v", err)
	}
	capture.EnableSystemCapture(true)

	// Создаём WAV файлы
	writerFixed, err := NewWAVWriter(outputFileFixed, 2) // стерео
	if err != nil {
		log.Fatalf("Ошибка создания %s: %v", outputFileFixed, err)
	}
	defer writerFixed.Close()

	writerBroken, err := NewWAVWriter(outputFileBroken, 2) // стерео
	if err != nil {
		log.Fatalf("Ошибка создания %s: %v", outputFileBroken, err)
	}
	defer writerBroken.Close()

	writerMic, err := NewWAVWriter(outputFileMic, 1) // моно
	if err != nil {
		log.Fatalf("Ошибка создания %s: %v", outputFileMic, err)
	}
	defer writerMic.Close()

	writerSys, err := NewWAVWriter(outputFileSys, 1) // моно
	if err != nil {
		log.Fatalf("Ошибка создания %s: %v", outputFileSys, err)
	}
	defer writerSys.Close()

	// Запускаем Voice Isolation mode
	if err := capture.StartScreenCaptureKitAudioWithMode("both"); err != nil {
		log.Fatalf("Ошибка запуска Voice Isolation: %v", err)
	}

	// Обработка сигнала остановки
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, syscall.SIGINT, syscall.SIGTERM)

	// Отдельные буферы для разных логик
	var micBufferFixed, sysBufferFixed []float32   // для исправленной логики
	var micBufferBroken, sysBufferBroken []float32 // для старой логики

	consume := func(buf []float32, n int) []float32 {
		if n >= len(buf) {
			return buf[:0]
		}
		return buf[n:]
	}

	startTime := time.Now()
	var totalMicSamples, totalSysSamples int64

	// Горутина для обработки аудио
	done := make(chan struct{})
	go func() {
		defer close(done)

		for {
			select {
			case <-stopChan:
				return

			case data, ok := <-capture.Data():
				if !ok {
					return
				}

				samples := data.Samples
				channel := data.Channel

				if channel == audio.ChannelMicrophone {
					micBufferFixed = append(micBufferFixed, samples...)
					micBufferBroken = append(micBufferBroken, samples...)
					totalMicSamples += int64(len(samples))

					// Пишем в mic-only файл
					writerMic.WriteMono(samples)
				} else {
					sysBufferFixed = append(sysBufferFixed, samples...)
					sysBufferBroken = append(sysBufferBroken, samples...)
					totalSysSamples += int64(len(samples))

					// Пишем в sys-only файл
					writerSys.WriteMono(samples)
				}

				// === ИСПРАВЛЕННАЯ ЛОГИКА (min) ===
				// Записываем только когда оба буфера имеют данные
				micLen := len(micBufferFixed)
				sysLen := len(sysBufferFixed)
				pairLen := micLen
				if sysLen < pairLen {
					pairLen = sysLen
				}

				if pairLen > 0 {
					stereo := make([]float32, pairLen*2)
					for i := 0; i < pairLen; i++ {
						stereo[i*2] = micBufferFixed[i]
						stereo[i*2+1] = sysBufferFixed[i]
					}
					writerFixed.WriteStereo(stereo)
					micBufferFixed = consume(micBufferFixed, pairLen)
					sysBufferFixed = consume(sysBufferFixed, pairLen)
				}

				// === СТАРАЯ ЛОГИКА (max) - создаёт дырки с нулями ===
				micLen = len(micBufferBroken)
				sysLen = len(sysBufferBroken)
				mixLen := micLen
				if sysLen > mixLen {
					mixLen = sysLen
				}

				if mixLen > 0 {
					stereo := make([]float32, mixLen*2)
					for i := 0; i < mixLen; i++ {
						var micSample, sysSample float32
						if i < micLen {
							micSample = micBufferBroken[i]
						}
						if i < sysLen {
							sysSample = sysBufferBroken[i]
						}
						stereo[i*2] = micSample
						stereo[i*2+1] = sysSample
					}
					writerBroken.WriteStereo(stereo)
					micBufferBroken = consume(micBufferBroken, mixLen)
					sysBufferBroken = consume(sysBufferBroken, mixLen)
				}
			}
		}
	}()

	// Ждём сигнала остановки
	<-stopChan
	log.Println("\nОстановка записи...")

	capture.Stop()
	time.Sleep(100 * time.Millisecond)

	// Ждём завершения горутины
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}

	// Статистика
	duration := time.Since(startTime)
	log.Println()
	log.Println("=== Статистика ===")
	log.Printf("Длительность записи: %.1f сек", duration.Seconds())
	log.Printf("Mic сэмплов: %d (%.1f сек)", totalMicSamples, float64(totalMicSamples)/sampleRate)
	log.Printf("Sys сэмплов: %d (%.1f сек)", totalSysSamples, float64(totalSysSamples)/sampleRate)
	log.Println()
	log.Printf("Fixed (min):  %d стерео сэмплов (%.1f сек)", writerFixed.SamplesWritten(), float64(writerFixed.SamplesWritten())/sampleRate)
	log.Printf("Broken (max): %d стерео сэмплов (%.1f сек)", writerBroken.SamplesWritten(), float64(writerBroken.SamplesWritten())/sampleRate)
	log.Println()
	log.Println("=== Сравните файлы ===")
	log.Printf("open %s  # Исправленный - должен быть чистый", outputFileFixed)
	log.Printf("open %s  # Сломанный - роботизированный звук", outputFileBroken)
	log.Printf("open %s  # Эталон микрофона", outputFileMic)
}
