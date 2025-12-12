package session

import (
	"aiwisper/ai"
	"log"
	"os"
	"path/filepath"
)

// SileroVADWrapper обёртка для Silero VAD в пакете session
type SileroVADWrapper struct {
	vad *ai.SileroVAD
}

// NewSileroVADWrapper создаёт новый Silero VAD wrapper
// Автоматически ищет модель в стандартном расположении
func NewSileroVADWrapper() (*SileroVADWrapper, error) {
	// Ищем модель в стандартном расположении
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	modelPath := filepath.Join(homeDir, "Library/Application Support/aiwisper/models/silero_vad.onnx")

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
// Создаёт временный экземпляр VAD для одноразового использования
// Для частого использования лучше создать SileroVADWrapper и переиспользовать
func DetectSpeechRegionsSilero(samples []float32, sampleRate int) ([]SpeechRegion, error) {
	wrapper, err := NewSileroVADWrapper()
	if err != nil {
		return nil, err
	}
	defer wrapper.Close()

	return wrapper.DetectSpeechRegions(samples, sampleRate), nil
}

// VADMethod тип метода VAD
type VADMethod string

const (
	VADMethodEnergy VADMethod = "energy" // Энергетический VAD (быстрый, менее точный)
	VADMethodSilero VADMethod = "silero" // Silero VAD (точный, требует модель)
)

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
		fallthrough
	default:
		return DetectSpeechRegions(samples, sampleRate)
	}
}
