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
	coreAudioCmd     *exec.Cmd
	coreAudioMu      sync.Mutex
	coreAudioRunning bool
)

// getCoreAudioBinaryPath возвращает путь к coreaudio-tap binary
func getCoreAudioBinaryPath() string {
	// Проверяем несколько возможных путей
	paths := []string{
		// Рядом с исполняемым файлом
		filepath.Join(filepath.Dir(os.Args[0]), "coreaudio-tap"),
		// В директории backend/audio/coreaudio
		"backend/audio/coreaudio/.build/release/coreaudio-tap",
		// Относительно текущей директории
		"audio/coreaudio/.build/release/coreaudio-tap",
		// Абсолютный путь для разработки
		"/Users/askid/Projects/AIWisper/backend/audio/coreaudio/.build/release/coreaudio-tap",
	}

	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}

	return "coreaudio-tap" // Надеемся что в PATH
}

// CoreAudioTapAvailable проверяет доступность Core Audio tap (macOS 14.2+)
func CoreAudioTapAvailable() bool {
	// Проверяем наличие binary
	path := getCoreAudioBinaryPath()
	_, err := os.Stat(path)
	if err != nil {
		return false
	}

	// Проверяем версию macOS через sw_vers
	// Core Audio Process Tap требует macOS 14.2+
	cmd := exec.Command("sw_vers", "-productVersion")
	output, err := cmd.Output()
	if err != nil {
		return false
	}

	version := strings.TrimSpace(string(output))
	parts := strings.Split(version, ".")
	if len(parts) < 2 {
		return false
	}

	major := 0
	minor := 0
	fmt.Sscanf(parts[0], "%d", &major)
	if len(parts) > 1 {
		fmt.Sscanf(parts[1], "%d", &minor)
	}

	// macOS 14.2+ = Sonoma 14.2+
	return major > 14 || (major == 14 && minor >= 2)
}

// StartCoreAudioTap запускает захват системного аудио через Core Audio Process Tap
// Это альтернатива ScreenCaptureKit для macOS 14.2+
// НЕ требует разрешения Screen Recording, работает в shared mode
func (c *Capture) StartCoreAudioTap() error {
	coreAudioMu.Lock()
	defer coreAudioMu.Unlock()

	if coreAudioRunning {
		return fmt.Errorf("Core Audio tap already running")
	}

	binaryPath := getCoreAudioBinaryPath()
	if _, err := os.Stat(binaryPath); err != nil {
		return fmt.Errorf("coreaudio-tap binary not found at %s. Build it with: cd backend/audio/coreaudio && swift build -c release", binaryPath)
	}

	// Запускаем процесс
	coreAudioCmd = exec.Command(binaryPath)

	// Получаем stdout для чтения аудио данных
	stdout, err := coreAudioCmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to get stdout pipe: %w", err)
	}

	// Получаем stderr для логов
	stderr, err := coreAudioCmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("failed to get stderr pipe: %w", err)
	}

	// Запускаем процесс
	if err := coreAudioCmd.Start(); err != nil {
		return fmt.Errorf("failed to start coreaudio-tap: %w", err)
	}

	coreAudioRunning = true

	// Горутина для чтения stderr (логи и статус)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "READY") {
				log.Printf("Core Audio tap started (mode=system)")
			} else if strings.HasPrefix(line, "ERROR:") {
				log.Printf("Core Audio tap: %s", line)
			} else {
				log.Printf("Core Audio tap: %s", line)
			}
		}
	}()

	// Горутина для чтения аудио данных из stdout
	// Формат: [маркер 1 байт][размер 4 байта][float32 данные]
	go func() {
		defer func() {
			coreAudioMu.Lock()
			coreAudioRunning = false
			coreAudioMu.Unlock()
		}()

		reader := bufio.NewReader(stdout)
		header := make([]byte, 5) // 1 байт маркер + 4 байта размер

		for {
			// Читаем заголовок
			_, err := io.ReadFull(reader, header)
			if err != nil {
				if err != io.EOF {
					log.Printf("Error reading header from coreaudio-tap: %v", err)
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

			// Определяем канал по маркеру (Core Audio tap только системный звук)
			var channel AudioChannel
			switch marker {
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

// StopCoreAudioTap останавливает захват системного аудио через Core Audio tap
func (c *Capture) StopCoreAudioTap() {
	coreAudioMu.Lock()
	defer coreAudioMu.Unlock()

	if !coreAudioRunning || coreAudioCmd == nil {
		return
	}

	log.Println("Stopping Core Audio tap...")

	// Отправляем SIGINT для graceful shutdown
	if coreAudioCmd.Process != nil {
		log.Println("Sending SIGINT to coreaudio-tap process...")
		coreAudioCmd.Process.Signal(os.Interrupt)

		// Ждём завершения с таймаутом 5 секунд
		done := make(chan error, 1)
		go func() {
			done <- coreAudioCmd.Wait()
		}()

		select {
		case err := <-done:
			if err != nil {
				if err.Error() != "signal: interrupt" {
					log.Printf("Core Audio tap process exited with: %v", err)
				} else {
					log.Println("Core Audio tap process stopped gracefully (SIGINT)")
				}
			} else {
				log.Println("Core Audio tap process stopped gracefully")
			}
		case <-time.After(5 * time.Second):
			log.Println("Core Audio tap process didn't stop gracefully, killing...")
			coreAudioCmd.Process.Kill()
			<-done
		}
	}

	coreAudioCmd = nil
	coreAudioRunning = false

	// Короткая задержка для освобождения ресурсов
	time.Sleep(200 * time.Millisecond)

	log.Println("Core Audio tap stopped")
}

// IsCoreAudioTapRunning проверяет, запущен ли Core Audio tap
func IsCoreAudioTapRunning() bool {
	coreAudioMu.Lock()
	defer coreAudioMu.Unlock()
	return coreAudioRunning
}
