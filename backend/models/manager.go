package models

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// ProgressCallback функция обратного вызова для прогресса
type ProgressCallback func(modelID string, progress float64, status ModelStatus, err error)

// Manager менеджер моделей
type Manager struct {
	modelsDir   string
	activeModel string
	downloads   map[string]context.CancelFunc // Активные загрузки
	mu          sync.RWMutex
	onProgress  ProgressCallback
}

// NewManager создаёт новый менеджер моделей
func NewManager(modelsDir string) (*Manager, error) {
	// Создаём директорию если не существует
	if err := os.MkdirAll(modelsDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create models directory: %w", err)
	}

	return &Manager{
		modelsDir: modelsDir,
		downloads: make(map[string]context.CancelFunc),
	}, nil
}

// SetProgressCallback устанавливает callback для прогресса
func (m *Manager) SetProgressCallback(cb ProgressCallback) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onProgress = cb
}

// GetModelsDir возвращает путь к директории моделей
func (m *Manager) GetModelsDir() string {
	return m.modelsDir
}

// GetModelPath возвращает путь к модели
func (m *Manager) GetModelPath(modelID string) string {
	info := GetModelByID(modelID)
	if info == nil {
		return ""
	}

	// Для архивных моделей диаризации - ищем .onnx файл в распакованной директории
	if info.IsArchive && info.Engine == EngineTypeDiarization {
		extractDir := filepath.Join(m.modelsDir, modelID)
		onnxPath, err := FindOnnxModelInDir(extractDir)
		if err == nil {
			return onnxPath
		}
		// Fallback на стандартный путь
		return filepath.Join(extractDir, "model.onnx")
	}

	// Расширение зависит от типа модели
	switch info.Type {
	case ModelTypeONNX:
		return filepath.Join(m.modelsDir, modelID+".onnx")
	default:
		return filepath.Join(m.modelsDir, modelID+".bin")
	}
}

// GetVocabPath возвращает путь к словарю (для ONNX моделей)
func (m *Manager) GetVocabPath(modelID string) string {
	info := GetModelByID(modelID)
	if info == nil || info.VocabURL == "" {
		return ""
	}
	return filepath.Join(m.modelsDir, modelID+"_vocab.txt")
}

// IsModelDownloaded проверяет, скачана ли модель
func (m *Manager) IsModelDownloaded(modelID string) bool {
	info := GetModelByID(modelID)
	if info == nil {
		return false
	}

	// Для CoreML моделей (FluidAudio) - модели скачиваются автоматически при первом использовании
	// Считаем что модель всегда "доступна"
	if info.Type == ModelTypeCoreML {
		return true
	}

	// Для архивных моделей проверяем существование директории
	if info.IsArchive {
		extractDir := filepath.Join(m.modelsDir, modelID)
		if stat, err := os.Stat(extractDir); err != nil || !stat.IsDir() {
			return false
		}
		// Проверяем наличие .onnx файла внутри
		_, err := FindOnnxModelInDir(extractDir)
		return err == nil
	}

	modelPath := m.GetModelPath(modelID)
	if modelPath == "" {
		return false
	}

	// Проверяем существование основного файла модели
	stat, err := os.Stat(modelPath)
	if err != nil {
		return false
	}
	// Проверяем что файл не пустой и примерно соответствует размеру
	if stat.Size() < 1000000 { // < 1MB
		return false
	}

	// Для ONNX моделей проверяем также наличие словаря
	if info.Type == ModelTypeONNX && info.VocabURL != "" {
		vocabPath := m.GetVocabPath(modelID)
		if _, err := os.Stat(vocabPath); err != nil {
			return false
		}
	}

	return true
}

// GetActiveModel возвращает ID активной модели
func (m *Manager) GetActiveModel() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.activeModel
}

// SetActiveModel устанавливает активную модель
func (m *Manager) SetActiveModel(modelID string) error {
	if !m.IsModelDownloaded(modelID) {
		return fmt.Errorf("model %s is not downloaded", modelID)
	}

	m.mu.Lock()
	m.activeModel = modelID
	m.mu.Unlock()

	log.Printf("Active model set to: %s", modelID)
	return nil
}

// GetAllModelsState возвращает состояние всех моделей
func (m *Manager) GetAllModelsState() []ModelState {
	m.mu.RLock()
	activeModel := m.activeModel
	downloads := make(map[string]bool)
	for id := range m.downloads {
		downloads[id] = true
	}
	m.mu.RUnlock()

	states := make([]ModelState, len(Registry))
	for i, info := range Registry {
		state := ModelState{
			ModelInfo: info,
			Path:      m.GetModelPath(info.ID),
		}

		if downloads[info.ID] {
			state.Status = ModelStatusDownloading
		} else if m.IsModelDownloaded(info.ID) {
			if info.ID == activeModel {
				state.Status = ModelStatusActive
			} else {
				state.Status = ModelStatusDownloaded
			}
		} else {
			state.Status = ModelStatusNotDownloaded
		}

		states[i] = state
	}

	return states
}

// DownloadModel скачивает модель
func (m *Manager) DownloadModel(modelID string) error {
	info := GetModelByID(modelID)
	if info == nil {
		return fmt.Errorf("unknown model: %s", modelID)
	}

	// Проверяем, не скачивается ли уже
	m.mu.Lock()
	if _, exists := m.downloads[modelID]; exists {
		m.mu.Unlock()
		return fmt.Errorf("model %s is already downloading", modelID)
	}

	// Создаём контекст с возможностью отмены
	ctx, cancel := context.WithCancel(context.Background())
	m.downloads[modelID] = cancel
	m.mu.Unlock()

	// Запускаем скачивание в горутине
	go func() {
		defer func() {
			m.mu.Lock()
			delete(m.downloads, modelID)
			m.mu.Unlock()
		}()

		// Для архивных моделей (tar.bz2) - скачиваем и распаковываем
		if info.IsArchive {
			progressCb := func(progress float64) {
				m.notifyProgress(modelID, progress, ModelStatusDownloading, nil)
			}

			extractDir := filepath.Join(m.modelsDir, modelID)
			err := DownloadAndExtractTarBz2(ctx, info.DownloadURL, extractDir, info.SizeBytes, progressCb)

			if err != nil {
				if ctx.Err() == context.Canceled {
					log.Printf("Download cancelled for model: %s", modelID)
					m.notifyProgress(modelID, 0, ModelStatusNotDownloaded, nil)
					m.cleanupPartialDownload(modelID)
				} else {
					log.Printf("Download failed for model %s: %v", modelID, err)
					m.notifyProgress(modelID, 0, ModelStatusError, err)
				}
				return
			}

			log.Printf("Download and extraction completed for model: %s", modelID)
			m.notifyProgress(modelID, 100, ModelStatusDownloaded, nil)
			return
		}

		// Для ONNX моделей с vocab - скачиваем оба файла
		hasVocab := info.Type == ModelTypeONNX && info.VocabURL != ""
		totalSize := info.SizeBytes
		if hasVocab {
			totalSize += 1000 // ~1KB для vocab файла
		}

		var downloadedSize int64

		progressCb := func(progress float64) {
			// Пересчитываем общий прогресс
			if hasVocab {
				// Модель составляет ~99.9% от общего размера
				modelProgress := progress * 0.999
				m.notifyProgress(modelID, modelProgress, ModelStatusDownloading, nil)
			} else {
				m.notifyProgress(modelID, progress, ModelStatusDownloading, nil)
			}
		}

		// Скачиваем основной файл модели
		destPath := m.GetModelPath(modelID)
		err := DownloadFile(ctx, info.DownloadURL, destPath, info.SizeBytes, progressCb)

		if err != nil {
			if ctx.Err() == context.Canceled {
				log.Printf("Download cancelled for model: %s", modelID)
				m.notifyProgress(modelID, 0, ModelStatusNotDownloaded, nil)
				m.cleanupPartialDownload(modelID)
			} else {
				log.Printf("Download failed for model %s: %v", modelID, err)
				m.notifyProgress(modelID, 0, ModelStatusError, err)
			}
			return
		}

		downloadedSize = info.SizeBytes

		// Скачиваем vocab если нужно
		if hasVocab {
			vocabPath := m.GetVocabPath(modelID)
			vocabProgressCb := func(progress float64) {
				// vocab - последние 0.1%
				totalProgress := 99.9 + progress*0.1
				m.notifyProgress(modelID, totalProgress, ModelStatusDownloading, nil)
			}

			err = DownloadFile(ctx, info.VocabURL, vocabPath, 1000, vocabProgressCb)
			if err != nil {
				if ctx.Err() == context.Canceled {
					log.Printf("Vocab download cancelled for model: %s", modelID)
					m.notifyProgress(modelID, 0, ModelStatusNotDownloaded, nil)
					m.cleanupPartialDownload(modelID)
				} else {
					log.Printf("Vocab download failed for model %s: %v", modelID, err)
					m.notifyProgress(modelID, 0, ModelStatusError, err)
				}
				return
			}
		}

		_ = downloadedSize // используется для расчёта прогресса

		log.Printf("Download completed for model: %s", modelID)
		m.notifyProgress(modelID, 100, ModelStatusDownloaded, nil)
	}()

	return nil
}

// CancelDownload отменяет скачивание модели
func (m *Manager) CancelDownload(modelID string) error {
	m.mu.Lock()
	cancel, exists := m.downloads[modelID]
	m.mu.Unlock()

	if !exists {
		return fmt.Errorf("model %s is not downloading", modelID)
	}

	cancel()
	return nil
}

// DeleteModel удаляет скачанную модель
func (m *Manager) DeleteModel(modelID string) error {
	if !m.IsModelDownloaded(modelID) {
		return fmt.Errorf("model %s is not downloaded", modelID)
	}

	// Нельзя удалить активную модель
	m.mu.RLock()
	if m.activeModel == modelID {
		m.mu.RUnlock()
		return fmt.Errorf("cannot delete active model")
	}
	m.mu.RUnlock()

	info := GetModelByID(modelID)
	if info == nil {
		return fmt.Errorf("unknown model: %s", modelID)
	}

	// Для архивных моделей удаляем директорию
	if info.IsArchive {
		extractDir := filepath.Join(m.modelsDir, modelID)
		if err := os.RemoveAll(extractDir); err != nil {
			return fmt.Errorf("failed to delete model directory: %w", err)
		}
		log.Printf("Model deleted: %s", modelID)
		return nil
	}

	modelPath := m.GetModelPath(modelID)

	// Удаляем основной файл модели
	err := os.Remove(modelPath)
	if err != nil {
		return fmt.Errorf("failed to delete model: %w", err)
	}

	// Для ONNX моделей удаляем также vocab
	if info.Type == ModelTypeONNX && info.VocabURL != "" {
		vocabPath := m.GetVocabPath(modelID)
		os.Remove(vocabPath) // игнорируем ошибку
	}

	log.Printf("Model deleted: %s", modelID)
	return nil
}

// notifyProgress уведомляет о прогрессе
func (m *Manager) notifyProgress(modelID string, progress float64, status ModelStatus, err error) {
	m.mu.RLock()
	cb := m.onProgress
	m.mu.RUnlock()

	if cb != nil {
		cb(modelID, progress, status, err)
	}
}

// cleanupPartialDownload удаляет частично скачанный файл
func (m *Manager) cleanupPartialDownload(modelID string) {
	info := GetModelByID(modelID)
	if info == nil {
		return
	}

	// Для архивных моделей удаляем директорию
	if info.IsArchive {
		extractDir := filepath.Join(m.modelsDir, modelID)
		os.RemoveAll(extractDir)
		return
	}

	modelPath := m.GetModelPath(modelID)
	if modelPath == "" {
		return
	}

	// Удаляем основной файл и временные файлы
	os.Remove(modelPath)
	os.Remove(modelPath + ".tmp")

	// Для ONNX моделей удаляем также vocab
	if info.Type == ModelTypeONNX && info.VocabURL != "" {
		vocabPath := m.GetVocabPath(modelID)
		os.Remove(vocabPath)
		os.Remove(vocabPath + ".tmp")
	}
}

// GetDownloadingModels возвращает список скачиваемых моделей
func (m *Manager) GetDownloadingModels() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]string, 0, len(m.downloads))
	for id := range m.downloads {
		result = append(result, id)
	}
	return result
}
