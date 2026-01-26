package session

import (
	"aiwisper/ai"
	"aiwisper/models"
	"context"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// SileroVADWrapper обёртка для Silero VAD в пакете session
type SileroVADWrapper struct {
	vad *ai.SileroVAD
}

// Глобальный кэшированный экземпляр Silero VAD
var (
	globalSileroVAD     *SileroVADWrapper
	globalSileroVADOnce sync.Once
	globalSileroVADErr  error
)

// getSileroModelPath возвращает путь к модели Silero VAD
func getSileroModelPath() string {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(homeDir, "Library/Application Support/aiwisper/models/silero_vad.onnx")
}

// ensureSileroModelDownloaded проверяет и скачивает модель если нужно
func ensureSileroModelDownloaded() (string, error) {
	modelPath := getSileroModelPath()

	// Проверяем существует ли модель
	if _, err := os.Stat(modelPath); err == nil {
		return modelPath, nil
	}

	// Модель не найдена - скачиваем
	log.Printf("Silero VAD model not found, downloading...")

	// Получаем информацию о модели из registry
	modelInfo := models.GetModelByID("silero-vad-v5")
	if modelInfo == nil {
		return "", os.ErrNotExist
	}

	// Создаём директорию
	dir := filepath.Dir(modelPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}

	// Скачиваем модель
	ctx := context.Background()
	err := models.DownloadFile(ctx, modelInfo.DownloadURL, modelPath, modelInfo.SizeBytes, func(progress float64) {
		log.Printf("Downloading Silero VAD: %.1f%%", progress)
	})
	if err != nil {
		return "", err
	}

	log.Printf("Silero VAD model downloaded successfully")
	return modelPath, nil
}

// GetGlobalSileroVAD возвращает глобальный кэшированный экземпляр Silero VAD
// Создаёт его при первом вызове, автоматически скачивает модель если нужно
func GetGlobalSileroVAD() (*SileroVADWrapper, error) {
	globalSileroVADOnce.Do(func() {
		// Проверяем/скачиваем модель
		modelPath, err := ensureSileroModelDownloaded()
		if err != nil {
			globalSileroVADErr = err
			return
		}

		// Создаём VAD
		config := ai.DefaultSileroVADConfig()
		config.ModelPath = modelPath

		vad, err := ai.NewSileroVAD(config)
		if err != nil {
			globalSileroVADErr = err
			return
		}

		globalSileroVAD = &SileroVADWrapper{vad: vad}
		log.Printf("Global Silero VAD initialized successfully")
	})

	return globalSileroVAD, globalSileroVADErr
}

// ResetGlobalSileroVAD сбрасывает глобальный экземпляр (для тестов)
func ResetGlobalSileroVAD() {
	if globalSileroVAD != nil {
		globalSileroVAD.Close()
		globalSileroVAD = nil
	}
	globalSileroVADOnce = sync.Once{}
	globalSileroVADErr = nil
}

// NewSileroVADWrapper создаёт новый Silero VAD wrapper
// Автоматически ищет модель в стандартном расположении
func NewSileroVADWrapper() (*SileroVADWrapper, error) {
	// Проверяем/скачиваем модель
	modelPath, err := ensureSileroModelDownloaded()
	if err != nil {
		return nil, err
	}

	config := ai.DefaultSileroVADConfig()
	config.ModelPath = modelPath

	vad, err := ai.NewSileroVAD(config)
	if err != nil {
		return nil, err
	}

	return &SileroVADWrapper{vad: vad}, nil
}

// NewSileroVADWrapperWithPath создаёт Silero VAD с указанным путём к модели
func NewSileroVADWrapperWithPath(modelPath string) (*SileroVADWrapper, error) {
	config := ai.DefaultSileroVADConfig()
	config.ModelPath = modelPath

	vad, err := ai.NewSileroVAD(config)
	if err != nil {
		return nil, err
	}

	return &SileroVADWrapper{vad: vad}, nil
}

// DetectSpeechRegions определяет участки речи используя Silero VAD
// Возвращает SpeechRegion совместимые с существующим API
func (w *SileroVADWrapper) DetectSpeechRegions(samples []float32, sampleRate int) []SpeechRegion {
	if w.vad == nil {
		log.Printf("SileroVADWrapper: VAD not initialized, falling back to energy-based")
		return DetectSpeechRegions(samples, sampleRate)
	}

	// Silero VAD работает только с 16kHz
	if sampleRate != 16000 {
		// Ресемплируем
		samples = resampleLinear(samples, sampleRate, 16000)
		sampleRate = 16000
	}

	// Используем Silero VAD
	sileroSegments, err := w.vad.DetectSpeechRegions(samples)
	if err != nil {
		log.Printf("SileroVADWrapper: Silero VAD failed: %v, falling back to energy-based", err)
		return DetectSpeechRegions(samples, sampleRate)
	}

	// Конвертируем в SpeechRegion
	regions := make([]SpeechRegion, len(sileroSegments))
	for i, seg := range sileroSegments {
		regions[i] = SpeechRegion{
			StartMs: seg.StartMs,
			EndMs:   seg.EndMs,
		}
	}

	log.Printf("SileroVADWrapper: detected %d speech regions using Silero VAD", len(regions))
	return regions
}

// Close освобождает ресурсы
func (w *SileroVADWrapper) Close() {
	if w.vad != nil {
		w.vad.Close()
		w.vad = nil
	}
}

// DetectSpeechRegionsSilero глобальная функция для определения речи через Silero VAD
// Использует глобальный кэшированный экземпляр для эффективности
func DetectSpeechRegionsSilero(samples []float32, sampleRate int) ([]SpeechRegion, error) {
	wrapper, err := GetGlobalSileroVAD()
	if err != nil {
		return nil, err
	}

	return wrapper.DetectSpeechRegions(samples, sampleRate), nil
}

// DetectSpeechRegionsWithMethod определяет участки речи указанным методом
func DetectSpeechRegionsWithMethod(samples []float32, sampleRate int, method VADMethod) []SpeechRegion {
	switch method {
	case VADMethodSilero:
		regions, err := DetectSpeechRegionsSilero(samples, sampleRate)
		if err != nil {
			log.Printf("Silero VAD failed: %v, falling back to energy-based", err)
			return DetectSpeechRegions(samples, sampleRate)
		}
		return regions
	case VADMethodEnergy:
		return DetectSpeechRegions(samples, sampleRate)
	case VADMethodAuto:
		// Автовыбор: пробуем Silero, если не получается - Energy
		regions, err := DetectSpeechRegionsSilero(samples, sampleRate)
		if err != nil {
			log.Printf("Silero VAD not available: %v, using energy-based", err)
			return DetectSpeechRegions(samples, sampleRate)
		}
		return regions
	default:
		return DetectSpeechRegions(samples, sampleRate)
	}
}
