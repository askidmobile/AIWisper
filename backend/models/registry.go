// Package models предоставляет управление моделями Whisper
package models

// ModelType тип модели
type ModelType string

const (
	ModelTypeGGML ModelType = "ggml"
)

// ModelInfo информация о модели
type ModelInfo struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Type        ModelType `json:"type"`
	Size        string    `json:"size"`
	SizeBytes   int64     `json:"sizeBytes"`
	Description string    `json:"description"`
	Languages   []string  `json:"languages"`
	WER         string    `json:"wer,omitempty"`
	Speed       string    `json:"speed"`
	Recommended bool      `json:"recommended,omitempty"`
	DownloadURL string    `json:"downloadUrl,omitempty"`
}

// ModelStatus статус модели на устройстве
type ModelStatus string

const (
	ModelStatusNotDownloaded ModelStatus = "not_downloaded"
	ModelStatusDownloading   ModelStatus = "downloading"
	ModelStatusDownloaded    ModelStatus = "downloaded"
	ModelStatusActive        ModelStatus = "active"
	ModelStatusError         ModelStatus = "error"
)

// ModelState состояние модели с информацией
type ModelState struct {
	ModelInfo
	Status   ModelStatus `json:"status"`
	Progress float64     `json:"progress,omitempty"` // 0-100
	Error    string      `json:"error,omitempty"`
	Path     string      `json:"path,omitempty"` // Путь к скачанной модели
}

// Registry реестр доступных моделей
var Registry = []ModelInfo{
	// ===== GGML модели (whisper.cpp) =====
	{
		ID:          "ggml-tiny",
		Name:        "Tiny",
		Type:        ModelTypeGGML,
		Size:        "74 MB",
		SizeBytes:   77_691_713,
		Description: "Самая быстрая модель, базовое качество",
		Languages:   []string{"multi"},
		Speed:       "~10x",
		DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
	},
	{
		ID:          "ggml-base",
		Name:        "Base",
		Type:        ModelTypeGGML,
		Size:        "141 MB",
		SizeBytes:   147_951_465,
		Description: "Хороший баланс скорости и качества",
		Languages:   []string{"multi"},
		Speed:       "~7x",
		DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
	},
	{
		ID:          "ggml-small",
		Name:        "Small",
		Type:        ModelTypeGGML,
		Size:        "465 MB",
		SizeBytes:   487_601_967,
		Description: "Хорошее качество распознавания",
		Languages:   []string{"multi"},
		Speed:       "~4x",
		DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
	},
	{
		ID:          "ggml-medium",
		Name:        "Medium",
		Type:        ModelTypeGGML,
		Size:        "1.4 GB",
		SizeBytes:   1_533_774_781,
		Description: "Высокое качество распознавания",
		Languages:   []string{"multi"},
		Speed:       "~2x",
		DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
	},
	{
		ID:          "ggml-large-v3-turbo",
		Name:        "Large V3 Turbo",
		Type:        ModelTypeGGML,
		Size:        "1.5 GB",
		SizeBytes:   1_624_417_792,
		Description: "Быстрая модель с высоким качеством",
		Languages:   []string{"multi"},
		Speed:       "~8x",
		Recommended: true,
		DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
	},
	{
		ID:          "ggml-large-v3",
		Name:        "Large V3",
		Type:        ModelTypeGGML,
		Size:        "2.9 GB",
		SizeBytes:   3_094_623_691,
		Description: "Максимальное качество распознавания",
		Languages:   []string{"multi"},
		Speed:       "~1x",
		Recommended: true,
		DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
	},
}

// GetModelByID возвращает модель по ID
func GetModelByID(id string) *ModelInfo {
	for _, m := range Registry {
		if m.ID == id {
			return &m
		}
	}
	return nil
}

// GetModelsByType возвращает модели определённого типа
func GetModelsByType(modelType ModelType) []ModelInfo {
	var result []ModelInfo
	for _, m := range Registry {
		if m.Type == modelType {
			result = append(result, m)
		}
	}
	return result
}

// GetRecommendedModels возвращает рекомендуемые модели
func GetRecommendedModels() []ModelInfo {
	var result []ModelInfo
	for _, m := range Registry {
		if m.Recommended {
			result = append(result, m)
		}
	}
	return result
}
