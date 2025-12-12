// Package ai предоставляет EngineManager для управления движками транскрипции
package ai

import (
	"aiwisper/models"
	"fmt"
	"log"
	"sync"
)

// EngineManager управляет движками транскрипции
// Позволяет переключаться между Whisper и GigaAM
type EngineManager struct {
	modelsManager *models.Manager
	activeEngine  TranscriptionEngine
	activeModelID string
	mu            sync.RWMutex
}

// NewEngineManager создаёт новый менеджер движков
func NewEngineManager(modelsManager *models.Manager) *EngineManager {
	return &EngineManager{
		modelsManager: modelsManager,
	}
}

// GetActiveEngine возвращает активный движок
func (em *EngineManager) GetActiveEngine() TranscriptionEngine {
	em.mu.RLock()
	defer em.mu.RUnlock()
	return em.activeEngine
}

// GetActiveModelID возвращает ID активной модели
func (em *EngineManager) GetActiveModelID() string {
	em.mu.RLock()
	defer em.mu.RUnlock()
	return em.activeModelID
}

// SetActiveModel устанавливает активную модель и создаёт соответствующий движок
func (em *EngineManager) SetActiveModel(modelID string) error {
	em.mu.Lock()
	defer em.mu.Unlock()

	// Если уже активна эта модель - ничего не делаем
	if em.activeModelID == modelID && em.activeEngine != nil {
		return nil
	}

	// Получаем информацию о модели
	modelInfo := models.GetModelByID(modelID)
	if modelInfo == nil {
		return fmt.Errorf("unknown model: %s", modelID)
	}

	// Проверяем что модель скачана
	if !em.modelsManager.IsModelDownloaded(modelID) {
		return fmt.Errorf("model %s is not downloaded", modelID)
	}

	// Создаём новый движок в зависимости от типа
	var newEngine TranscriptionEngine
	var err error

	switch modelInfo.Engine {
	case models.EngineTypeWhisper:
		modelPath := em.modelsManager.GetModelPath(modelID)
		newEngine, err = NewWhisperEngine(modelPath)
		if err != nil {
			return fmt.Errorf("failed to create Whisper engine: %w", err)
		}

	case models.EngineTypeGigaAM:
		modelPath := em.modelsManager.GetModelPath(modelID)
		vocabPath := em.modelsManager.GetVocabPath(modelID)
		if vocabPath == "" {
			return fmt.Errorf("vocab path not found for GigaAM model %s", modelID)
		}

		// Проверяем, является ли модель RNNT
		if modelInfo.IsRNNT {
			newEngine, err = NewGigaAMRNNTEngine(modelPath, vocabPath)
			if err != nil {
				return fmt.Errorf("failed to create GigaAM RNNT engine: %w", err)
			}
		} else {
			newEngine, err = NewGigaAMEngine(modelPath, vocabPath)
			if err != nil {
				return fmt.Errorf("failed to create GigaAM engine: %w", err)
			}
		}

	case models.EngineTypeFluidASR:
		// FluidAudio использует кастомный кэш моделей
		modelCacheDir := em.modelsManager.GetModelsDir()
		newEngine, err = NewFluidASREngine(FluidASRConfig{
			ModelCacheDir: modelCacheDir,
		})
		if err != nil {
			return fmt.Errorf("failed to create FluidASR engine: %w", err)
		}

	default:
		return fmt.Errorf("unsupported engine type: %s", modelInfo.Engine)
	}

	// Закрываем старый движок
	if em.activeEngine != nil {
		em.activeEngine.Close()
	}

	em.activeEngine = newEngine
	em.activeModelID = modelID

	// Обновляем активную модель в models.Manager
	if err := em.modelsManager.SetActiveModel(modelID); err != nil {
		log.Printf("Warning: failed to set active model in models manager: %v", err)
	}

	log.Printf("EngineManager: switched to model %s (engine: %s)", modelID, modelInfo.Engine)
	return nil
}

// SetLanguage устанавливает язык для активного движка
func (em *EngineManager) SetLanguage(lang string) {
	em.mu.RLock()
	engine := em.activeEngine
	em.mu.RUnlock()

	if engine != nil {
		engine.SetLanguage(lang)
	}
}

// SetPauseThreshold устанавливает порог паузы для сегментации (только для FluidASR)
func (em *EngineManager) SetPauseThreshold(threshold float64) {
	em.mu.RLock()
	engine := em.activeEngine
	em.mu.RUnlock()

	if engine != nil {
		// Проверяем, поддерживает ли движок SetPauseThreshold
		if fluidEngine, ok := engine.(*FluidASREngine); ok {
			fluidEngine.SetPauseThreshold(threshold)
		}
	}
}

// Transcribe транскрибирует аудио через активный движок
func (em *EngineManager) Transcribe(samples []float32, useContext bool) (string, error) {
	em.mu.RLock()
	engine := em.activeEngine
	em.mu.RUnlock()

	if engine == nil {
		return "", fmt.Errorf("no active engine")
	}

	return engine.Transcribe(samples, useContext)
}

// TranscribeWithSegments транскрибирует аудио с сегментами
func (em *EngineManager) TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error) {
	em.mu.RLock()
	engine := em.activeEngine
	em.mu.RUnlock()

	if engine == nil {
		return nil, fmt.Errorf("no active engine")
	}

	return engine.TranscribeWithSegments(samples)
}

// TranscribeHighQuality выполняет высококачественную транскрипцию
func (em *EngineManager) TranscribeHighQuality(samples []float32) ([]TranscriptSegment, error) {
	em.mu.RLock()
	engine := em.activeEngine
	em.mu.RUnlock()

	if engine == nil {
		return nil, fmt.Errorf("no active engine")
	}

	return engine.TranscribeHighQuality(samples)
}

// Close закрывает активный движок
func (em *EngineManager) Close() {
	em.mu.Lock()
	defer em.mu.Unlock()

	if em.activeEngine != nil {
		em.activeEngine.Close()
		em.activeEngine = nil
	}
	em.activeModelID = ""
}

// GetEngineInfo возвращает информацию об активном движке
func (em *EngineManager) GetEngineInfo() map[string]interface{} {
	em.mu.RLock()
	defer em.mu.RUnlock()

	info := map[string]interface{}{
		"activeModelID": em.activeModelID,
		"hasEngine":     em.activeEngine != nil,
	}

	if em.activeEngine != nil {
		info["engineName"] = em.activeEngine.Name()
		info["supportedLanguages"] = em.activeEngine.SupportedLanguages()
	}

	return info
}

// IsGigaAMActive проверяет, активен ли GigaAM движок (CTC или RNNT)
func (em *EngineManager) IsGigaAMActive() bool {
	em.mu.RLock()
	defer em.mu.RUnlock()

	if em.activeEngine == nil {
		return false
	}
	name := em.activeEngine.Name()
	return name == "gigaam" || name == "gigaam-rnnt"
}

// IsWhisperActive проверяет, активен ли Whisper движок
func (em *EngineManager) IsWhisperActive() bool {
	em.mu.RLock()
	defer em.mu.RUnlock()

	if em.activeEngine == nil {
		return false
	}
	return em.activeEngine.Name() == "whisper"
}

// CreateEngineForModel создаёт движок для указанной модели без установки его как активного
// Используется для гибридной транскрипции (вторичная модель)
func (em *EngineManager) CreateEngineForModel(modelID string) (TranscriptionEngine, error) {
	// Получаем информацию о модели
	modelInfo := models.GetModelByID(modelID)
	if modelInfo == nil {
		return nil, fmt.Errorf("unknown model: %s", modelID)
	}

	// Проверяем что модель скачана
	if !em.modelsManager.IsModelDownloaded(modelID) {
		return nil, fmt.Errorf("model %s is not downloaded", modelID)
	}

	// Создаём движок в зависимости от типа
	var engine TranscriptionEngine
	var err error

	switch modelInfo.Engine {
	case models.EngineTypeWhisper:
		modelPath := em.modelsManager.GetModelPath(modelID)
		engine, err = NewWhisperEngine(modelPath)
		if err != nil {
			return nil, fmt.Errorf("failed to create Whisper engine: %w", err)
		}

	case models.EngineTypeGigaAM:
		modelPath := em.modelsManager.GetModelPath(modelID)
		vocabPath := em.modelsManager.GetVocabPath(modelID)
		if vocabPath == "" {
			return nil, fmt.Errorf("vocab path not found for GigaAM model %s", modelID)
		}

		if modelInfo.IsRNNT {
			engine, err = NewGigaAMRNNTEngine(modelPath, vocabPath)
			if err != nil {
				return nil, fmt.Errorf("failed to create GigaAM RNNT engine: %w", err)
			}
		} else {
			engine, err = NewGigaAMEngine(modelPath, vocabPath)
			if err != nil {
				return nil, fmt.Errorf("failed to create GigaAM engine: %w", err)
			}
		}

	case models.EngineTypeFluidASR:
		modelCacheDir := em.modelsManager.GetModelsDir()
		engine, err = NewFluidASREngine(FluidASRConfig{
			ModelCacheDir: modelCacheDir,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to create FluidASR engine: %w", err)
		}

	default:
		return nil, fmt.Errorf("unsupported engine type: %s", modelInfo.Engine)
	}

	log.Printf("EngineManager: created secondary engine for model %s (engine: %s)", modelID, modelInfo.Engine)
	return engine, nil
}

// GetRecommendedModelForLanguage возвращает рекомендуемую модель для языка
func GetRecommendedModelForLanguage(lang string) string {
	switch lang {
	case "ru":
		// Для русского языка рекомендуем GigaAM v3 E2E CTC (быстрая + пунктуация)
		return "gigaam-v3-e2e-ctc"
	default:
		// Для остальных языков - Whisper Large V3 Turbo
		return "ggml-large-v3-turbo"
	}
}
