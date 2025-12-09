//go:build darwin

package audio

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	screenCaptureCmd     *exec.Cmd
	screenCaptureMu      sync.Mutex
	screenCaptureRunning bool
	screenCaptureMode    string // "system", "mic", "both"
)

// getScreenCaptureBinaryPath возвращает путь к screencapture-audio binary
func getScreenCaptureBinaryPath() string {
	// Проверяем несколько возможных путей
	paths := []string{
		// Рядом с исполняемым файлом
		filepath.Join(filepath.Dir(os.Args[0]), "screencapture-audio"),
		// В директории backend/audio/screencapture
		"backend/audio/screencapture/.build/release/screencapture-audio",
		// Относительно текущей директории
		"audio/screencapture/.build/release/screencapture-audio",
		// Абсолютный путь для разработки
		"/Users/askid/Projects/AIWisper/backend/audio/screencapture/.build/release/screencapture-audio",
	}

	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}

	return "screencapture-audio" // Надеемся что в PATH
}

// ScreenCaptureKitAvailable проверяет доступность ScreenCaptureKit
func ScreenCaptureKitAvailable() bool {
	// macOS 13+ поддерживает ScreenCaptureKit
	// Проверяем наличие binary
	path := getScreenCaptureBinaryPath()
	_, err := os.Stat(path)
	return err == nil
}

// StartScreenCaptureKitAudio запускает захват аудио через ScreenCaptureKit
// mode: "system" - только системный звук, "mic" - только микрофон, "both" - оба с voice isolation
func (c *Capture) StartScreenCaptureKitAudio() error {
	return c.StartScreenCaptureKitAudioWithMode("system")
}

// StartScreenCaptureKitAudioWithMode запускает захват с указанным режимом
func (c *Capture) StartScreenCaptureKitAudioWithMode(mode string) error {
	screenCaptureMu.Lock()
	defer screenCaptureMu.Unlock()

	if screenCaptureRunning {
		return fmt.Errorf("audio capture already running")
	}

	binaryPath := getScreenCaptureBinaryPath()
	if _, err := os.Stat(binaryPath); err != nil {
		return fmt.Errorf("screencapture-audio binary not found at %s. Build it with: cd backend/audio/screencapture && swift build -c release", binaryPath)
	}

	// Запускаем процесс с режимом
	screenCaptureCmd = exec.Command(binaryPath, mode)
	screenCaptureMode = mode

	// Получаем stdout для чтения аудио данных
	stdout, err := screenCaptureCmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to get stdout pipe: %w", err)
	}

	// Получаем stderr для логов
	stderr, err := screenCaptureCmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("failed to get stderr pipe: %w", err)
	}

	// Запускаем процесс
	if err := screenCaptureCmd.Start(); err != nil {
		return fmt.Errorf("failed to start screencapture-audio: %w", err)
	}

	screenCaptureRunning = true

	// Горутина для чтения stderr (логи и статус)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "READY") {
				log.Printf("ScreenCaptureKit audio capture started (mode=%s)", mode)
			} else if strings.HasPrefix(line, "ERROR:") {
				log.Printf("ScreenCaptureKit: %s", line)
			} else {
				log.Printf("ScreenCaptureKit: %s", line)
			}
		}
	}()

	// Горутина для чтения аудио данных из stdout
	// Формат: [маркер 1 байт][размер 4 байта][float32 данные]
	go func() {
		defer func() {
			screenCaptureMu.Lock()
			screenCaptureRunning = false
			screenCaptureMu.Unlock()
		}()

		reader := bufio.NewReader(stdout)
		header := make([]byte, 5) // 1 байт маркер + 4 байта размер

		for {
			// Читаем заголовок
			_, err := io.ReadFull(reader, header)
			if err != nil {
				if err != io.EOF {
					log.Printf("Error reading header from screencapture-audio: %v", err)
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
					log.Printf("Error reading audio data: %v", err)
				}
				return
			}

			// Конвертируем bytes в float32
			samples := make([]float32, sampleCount)
			for i := uint32(0); i < sampleCount; i++ {
				bits := binary.LittleEndian.Uint32(data[i*4 : (i+1)*4])
				samples[i] = float32frombits(bits)
			}

			// Определяем канал по маркеру
			var channel AudioChannel
			switch marker {
			case 0x4D: // 'M' - микрофон
				channel = ChannelMicrophone
			case 0x53: // 'S' - системный звук
				channel = ChannelSystem
			default:
				log.Printf("Unknown channel marker: 0x%02X", marker)
				continue
			}

			// Отправляем в канал
			c.dataChan <- ChannelData{Channel: channel, Samples: samples}
		}
	}()

	return nil
}

// StopScreenCaptureKitAudio останавливает захват системного аудио
func (c *Capture) StopScreenCaptureKitAudio() {
	screenCaptureMu.Lock()
	defer screenCaptureMu.Unlock()

	if !screenCaptureRunning || screenCaptureCmd == nil {
		return
	}

	log.Println("Stopping ScreenCaptureKit audio capture...")

	// Отправляем SIGINT для graceful shutdown
	// Swift процесс должен корректно остановить SCStream и освободить audio tap
	if screenCaptureCmd.Process != nil {
		log.Println("Sending SIGINT to screencapture-audio process...")
		screenCaptureCmd.Process.Signal(os.Interrupt)

		// Ждём завершения с таймаутом 8 секунд
		// Swift cleanup: ~3 сек wait + 200ms delay + запас на обработку
		done := make(chan error, 1)
		go func() {
			done <- screenCaptureCmd.Wait()
		}()

		select {
		case err := <-done:
			if err != nil {
				// exit status 0 при SIGINT - это нормально
				if err.Error() != "signal: interrupt" {
					log.Printf("ScreenCaptureKit process exited with: %v", err)
				} else {
					log.Println("ScreenCaptureKit process stopped gracefully (SIGINT)")
				}
			} else {
				log.Println("ScreenCaptureKit process stopped gracefully")
			}
		case <-time.After(8 * time.Second):
			// Таймаут - убиваем принудительно
			log.Println("ScreenCaptureKit process didn't stop gracefully, killing...")
			screenCaptureCmd.Process.Kill()
			// Ждём завершения после kill
			<-done
		}
	}

	screenCaptureCmd = nil
	screenCaptureRunning = false

	// Дополнительная задержка для полного освобождения audio tap в macOS
	// Это критично для того, чтобы другие приложения могли захватить звук
	log.Println("Waiting for macOS to release audio resources...")
	time.Sleep(500 * time.Millisecond)

	log.Println("ScreenCaptureKit audio capture stopped, resources released")
}

// IsScreenCaptureKitRunning проверяет, запущен ли захват
func IsScreenCaptureKitRunning() bool {
	screenCaptureMu.Lock()
	defer screenCaptureMu.Unlock()
	return screenCaptureRunning
}
