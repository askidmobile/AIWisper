// Тест полного стека записи через RecordingService
// Максимально близко к реальному приложению
//
// Запуск: cd backend && go run ./cmd/testfull
// Остановка: Ctrl+C
//
// Создаёт сессию в /tmp/testfull_session/

package main

import (
	"aiwisper/audio"
	"aiwisper/internal/service"
	"aiwisper/session"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	log.Println("=== Тест полного стека записи (RecordingService) ===")
	log.Println()
	log.Println("Этот тест использует RecordingService - тот же код что и приложение")
	log.Println("Сессия будет создана в /tmp/testfull_session/")
	log.Println()
	log.Println("Нажмите Ctrl+C для остановки...")

	// Удаляем старую тестовую сессию
	os.RemoveAll("/tmp/testfull_session")

	// Создаём SessionManager с тестовой директорией
	sessMgr, err := session.NewManager("/tmp/testfull_session")
	if err != nil {
		log.Fatalf("Ошибка создания SessionManager: %v", err)
	}

	// Создаём audio.Capture
	capture, err := audio.NewCapture()
	if err != nil {
		log.Fatalf("Ошибка создания audio.Capture: %v", err)
	}

	// Создаём RecordingService
	recService := service.NewRecordingService(sessMgr, capture)

	// Callback для уровней звука
	recService.OnAudioLevel = func(micLevel, sysLevel float64) {
		// Логируем каждые ~1 сек
		log.Printf("Audio levels: mic=%.3f, sys=%.3f", micLevel, sysLevel)
	}

	// Конфигурация сессии - Voice Isolation (без системного захвата чтобы не использовать Core Audio tap)
	config := session.SessionConfig{
		CaptureSystem: false, // ОТКЛЮЧАЕМ системный захват чтобы использовать чистый Voice Isolation
		UseNative:     true,
	}

	// Запускаем сессию с Voice Isolation
	log.Println("Запуск сессии с Voice Isolation (только микрофон)...")
	sess, err := recService.StartSession(config, 0, true) // voiceIsolation=true
	if err != nil {
		log.Fatalf("Ошибка запуска сессии: %v", err)
	}

	log.Printf("Сессия запущена: %s", sess.ID)
	log.Printf("Директория: %s", sess.DataDir)

	// Обработка сигнала остановки
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, syscall.SIGINT, syscall.SIGTERM)

	startTime := time.Now()

	// Ждём сигнала остановки
	<-stopChan
	log.Println("\nОстановка записи...")

	duration := time.Since(startTime)

	// Останавливаем сессию
	finalSess, err := recService.StopSession()
	if err != nil {
		log.Printf("Ошибка остановки сессии: %v", err)
	}

	log.Println()
	log.Println("=== Результаты ===")
	log.Printf("Длительность записи: %.1f сек", duration.Seconds())
	if finalSess != nil {
		log.Printf("Чанков: %d", len(finalSess.Chunks))
		log.Printf("Семплов: %d", finalSess.SampleCount)
		expectedSamples := int64(duration.Seconds() * 24000)
		log.Printf("Ожидаемо семплов: %d", expectedSamples)
		if finalSess.SampleCount > 0 {
			ratio := float64(finalSess.SampleCount) / float64(expectedSamples) * 100
			log.Printf("Соотношение: %.1f%%", ratio)
		}
	}

	log.Println()
	log.Println("=== Проверьте файлы ===")
	log.Printf("WAV: %s/full.wav", sess.DataDir)
	log.Printf("MP3: %s/full.mp3", sess.DataDir)
	log.Println()
	log.Println("Откройте WAV файл и проверьте звучит ли он роботизированно:")
	log.Printf("open %s/full.wav", sess.DataDir)
}
