// Package models предоставляет управление моделями транскрипции
package models

// ModelType тип модели
type ModelType string

const (
	ModelTypeGGML ModelType = "ggml" // whisper.cpp GGML модели
	ModelTypeONNX ModelType = "onnx" // ONNX модели (GigaAM и др.)
)

// EngineType тип движка транскрипции
type EngineType string

const (
	EngineTypeWhisper     EngineType = "whisper"     // whisper.cpp
	EngineTypeGigaAM      EngineType = "gigaam"      // GigaAM ONNX
	EngineTypeSpeaker     EngineType = "speaker"     // Speaker Recognition
	EngineTypeDiarization EngineType = "diarization" // Speaker Diarization (segmentation + embedding)
)

// DiarizationModelType тип модели диаризации
type DiarizationModelType string

const (
	DiarizationModelSegmentation DiarizationModelType = "segmentation" // Pyannote сегментация
	DiarizationModelEmbedding    DiarizationModelType = "embedding"    // Speaker embedding (WeSpeaker, 3D-Speaker)
)

// ModelInfo информация о модели
type ModelInfo struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Type        ModelType  `json:"type"`
	Engine      EngineType `json:"engine"`
	Size        string     `json:"size"`
	SizeBytes   int64      `json:"sizeBytes"`
	Description string     `json:"description"`
	Languages   []string   `json:"languages"`
	WER         string     `json:"wer,omitempty"`
	Speed       string     `json:"speed"`
	Recommended bool       `json:"recommended,omitempty"`
	DownloadURL string     `json:"downloadUrl,omitempty"`
	VocabURL    string     `json:"vocabUrl,omitempty"` // URL словаря (для ONNX моделей)

	// Поля для диаризации
	DiarizationType DiarizationModelType `json:"diarizationType,omitempty"` // Тип модели диаризации
	IsArchive       bool                 `json:"isArchive,omitempty"`       // Модель в архиве (tar.bz2)
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
		Engine:      EngineTypeWhisper,
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
		Engine:      EngineTypeWhisper,
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
		Engine:      EngineTypeWhisper,
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
		Engine:      EngineTypeWhisper,
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
		Engine:      EngineTypeWhisper,
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
		Engine:      EngineTypeWhisper,
		Size:        "2.9 GB",
		SizeBytes:   3_094_623_691,
		Description: "Максимальное качество распознавания",
		Languages:   []string{"multi"},
		Speed:       "~1x",
		Recommended: true,
		DownloadURL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
	},

	// ===== ONNX модели (GigaAM) =====
	{
		ID:          "gigaam-v3-ctc",
		Name:        "GigaAM V3 CTC",
		Type:        ModelTypeONNX,
		Engine:      EngineTypeGigaAM,
		Size:        "225 MB",
		SizeBytes:   225_000_000,
		Description: "Быстрая модель для русского языка (Sber GigaAM v3)",
		Languages:   []string{"ru"},
		WER:         "9.1%",
		Speed:       "~50x",
		Recommended: true,
		DownloadURL: "https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/main/v3_ctc.int8.onnx",
		VocabURL:    "https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/main/v3_vocab.txt",
	},

	// ===== Модели диаризации (Diarization) =====
	{
		ID:              "pyannote-segmentation-3.0",
		Name:            "Pyannote Segmentation 3.0",
		Type:            ModelTypeONNX,
		Engine:          EngineTypeDiarization,
		DiarizationType: DiarizationModelSegmentation,
		Size:            "5.9 MB",
		SizeBytes:       5_900_000,
		Description:     "Сегментация спикеров (pyannote.audio)",
		Languages:       []string{"multi"},
		Speed:           "~100x",
		IsArchive:       true,
		DownloadURL:     "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
	},
	{
		ID:              "3dspeaker-speech-eres2net",
		Name:            "3D-Speaker ERes2Net",
		Type:            ModelTypeONNX,
		Engine:          EngineTypeDiarization,
		DiarizationType: DiarizationModelEmbedding,
		Size:            "25 MB",
		SizeBytes:       25_000_000,
		Description:     "Speaker embedding (3D-Speaker, Alibaba)",
		Languages:       []string{"multi"},
		Speed:           "~50x",
		DownloadURL:     "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
	},
	{
		ID:              "wespeaker-voxceleb-resnet34",
		Name:            "WeSpeaker ResNet34",
		Type:            ModelTypeONNX,
		Engine:          EngineTypeDiarization,
		DiarizationType: DiarizationModelEmbedding,
		Size:            "26 MB",
		SizeBytes:       26_851_029,
		Description:     "Speaker embedding (WeSpeaker ResNet34)",
		Languages:       []string{"multi"},
		Speed:           "~40x",
		Recommended:     true,
		DownloadURL:     "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx",
	},
}

// GetModelsByEngine возвращает модели для определённого движка
func GetModelsByEngine(engine EngineType) []ModelInfo {
	var result []ModelInfo
	for _, m := range Registry {
		if m.Engine == engine {
			result = append(result, m)
		}
	}
	return result
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

// GetDiarizationModels возвращает модели диаризации
func GetDiarizationModels() []ModelInfo {
	return GetModelsByEngine(EngineTypeDiarization)
}

// GetSegmentationModels возвращает модели сегментации спикеров
func GetSegmentationModels() []ModelInfo {
	var result []ModelInfo
	for _, m := range Registry {
		if m.Engine == EngineTypeDiarization && m.DiarizationType == DiarizationModelSegmentation {
			result = append(result, m)
		}
	}
	return result
}

// GetEmbeddingModels возвращает модели speaker embedding
func GetEmbeddingModels() []ModelInfo {
	var result []ModelInfo
	for _, m := range Registry {
		if m.Engine == EngineTypeDiarization && m.DiarizationType == DiarizationModelEmbedding {
			result = append(result, m)
		}
	}
	return result
}
