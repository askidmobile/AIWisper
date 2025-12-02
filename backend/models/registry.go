// Package models предоставляет управление моделями Whisper
package models

// ModelType тип модели
type ModelType string

const (
	ModelTypeGGML          ModelType = "ggml"
	ModelTypeFasterWhisper ModelType = "faster-whisper"
)

// ModelInfo информация о модели
type ModelInfo struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Type            ModelType `json:"type"`
	Size            string    `json:"size"`
	SizeBytes       int64     `json:"sizeBytes"`
	Description     string    `json:"description"`
	Languages       []string  `json:"languages"`
	WER             string    `json:"wer,omitempty"`
	Speed           string    `json:"speed"`
	Recommended     bool      `json:"recommended,omitempty"`
	DownloadURL     string    `json:"downloadUrl,omitempty"`
	HuggingFaceRepo string    `json:"huggingfaceRepo,omitempty"`
	// RequiresPython - модель требует Python для конвертации (transformers формат)
	RequiresPython bool `json:"requiresPython,omitempty"`
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
		Description: "Максимальное качество, медленная",
		Languages:   []string{"multi"},
		Speed:       "~1x",
		DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
	},

	// ===== Faster-Whisper модели (CTranslate2) =====
	{
		ID:              "faster-large-v3-turbo",
		Name:            "Large V3 Turbo (Faster)",
		Type:            ModelTypeFasterWhisper,
		Size:            "1.5 GB",
		SizeBytes:       1_550_000_000,
		Description:     "Быстрая мультиязычная модель Faster-Whisper",
		Languages:       []string{"multi"},
		Speed:           "~8x",
		HuggingFaceRepo: "Systran/faster-whisper-large-v3-turbo",
	},
	{
		ID:              "faster-large-v3-russian",
		Name:            "Large V3 Russian",
		Type:            ModelTypeFasterWhisper,
		Size:            "3.0 GB",
		SizeBytes:       3_100_000_000,
		Description:     "Лучшее качество для русского языка (CTranslate2)",
		Languages:       []string{"ru"},
		Speed:           "~2x",
		Recommended:     true,
		HuggingFaceRepo: "bzikst/faster-whisper-large-v3-russian",
	},
	{
		ID:              "faster-large-v3-turbo-russian",
		Name:            "Large V3 Turbo Russian",
		Type:            ModelTypeFasterWhisper,
		Size:            "1.6 GB",
		SizeBytes:       1_600_000_000,
		Description:     "Быстрая модель для русского языка",
		Languages:       []string{"ru"},
		Speed:           "~6x",
		HuggingFaceRepo: "dvislobokov/faster-whisper-large-v3-turbo-russian",
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
