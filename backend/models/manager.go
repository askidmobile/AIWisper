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

	// Все модели теперь GGML формата
	return filepath.Join(m.modelsDir, modelID+".bin")
}

// IsModelDownloaded проверяет, скачана ли модель
func (m *Manager) IsModelDownloaded(modelID string) bool {
	info := GetModelByID(modelID)
	if info == nil {
		return false
	}

	modelPath := m.GetModelPath(modelID)
	if modelPath == "" {
		return false
	}

	// Все модели GGML - проверяем существование .bin файла
	stat, err := os.Stat(modelPath)
	if err != nil {
		return false
	}
	// Проверяем что файл не пустой и примерно соответствует размеру
	return stat.Size() > 1000000 // > 1MB
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

		progressCb := func(progress float64) {
			m.notifyProgress(modelID, progress, ModelStatusDownloading, nil)
		}

		// Все модели GGML - скачиваем напрямую
		destPath := m.GetModelPath(modelID)
		err := DownloadFile(ctx, info.DownloadURL, destPath, info.SizeBytes, progressCb)

		if err != nil {
			if ctx.Err() == context.Canceled {
				log.Printf("Download cancelled for model: %s", modelID)
				m.notifyProgress(modelID, 0, ModelStatusNotDownloaded, nil)
				// Удаляем частично скачанный файл
				m.cleanupPartialDownload(modelID)
			} else {
				log.Printf("Download failed for model %s: %v", modelID, err)
				m.notifyProgress(modelID, 0, ModelStatusError, err)
			}
			return
		}

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

	modelPath := m.GetModelPath(modelID)

	// Все модели GGML - удаляем .bin файл
	err := os.Remove(modelPath)
	if err != nil {
		return fmt.Errorf("failed to delete model: %w", err)
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
	modelPath := m.GetModelPath(modelID)
	if modelPath == "" {
		return
	}

	// Все модели GGML - удаляем .bin и .tmp файлы
	os.Remove(modelPath)
	os.Remove(modelPath + ".tmp")
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
