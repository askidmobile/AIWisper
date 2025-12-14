package api

import (
	"aiwisper/audio"
	"aiwisper/models"
	"aiwisper/session"
	"aiwisper/voiceprint"
	"time"
)

// Message WebSocket message structure
type Message struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`

	// Start Session Parameters
	Language          string  `json:"language,omitempty"`
	Model             string  `json:"model,omitempty"`
	MicDevice         string  `json:"micDevice,omitempty"`
	SystemDevice      string  `json:"systemDevice,omitempty"`
	CaptureSystem     bool    `json:"captureSystem,omitempty"`
	UseNative         bool    `json:"useNativeCapture,omitempty"`
	UseVoiceIsolation bool    `json:"useVoiceIsolation,omitempty"`
	VADMode           string  `json:"vadMode,omitempty"`   // auto, compression, per-region, off
	VADMethod         string  `json:"vadMethod,omitempty"` // energy, silero, auto
	EchoCancel        float64 `json:"echoCancel,omitempty"`
	PauseThreshold    float64 `json:"pauseThreshold,omitempty"` // Порог паузы для сегментации (0.3-2.0 сек)

	// Responses
	Session   *session.Session `json:"session,omitempty"`
	Sessions  []*SessionInfo   `json:"sessions,omitempty"`
	Chunk     *session.Chunk   `json:"chunk,omitempty"`
	SessionID string           `json:"sessionId,omitempty"`

	// Audio levels
	MicLevel    float64 `json:"micLevel,omitempty"`
	SystemLevel float64 `json:"systemLevel,omitempty"`

	// Devices
	Devices                   []audio.AudioDevice `json:"devices,omitempty"`
	ScreenCaptureKitAvailable bool                `json:"screenCaptureKitAvailable,omitempty"`

	// Models
	Models    []models.ModelState `json:"models,omitempty"`
	ModelID   string              `json:"modelId,omitempty"`
	ModelName string              `json:"modelName,omitempty"` // Human-readable название модели
	Progress  float64             `json:"progress,omitempty"`
	Error     string              `json:"error,omitempty"`

	// Summary
	Summary string `json:"summary,omitempty"`

	// Ollama
	OllamaModel  string        `json:"ollamaModel,omitempty"`
	OllamaUrl    string        `json:"ollamaUrl,omitempty"`
	OllamaModels []OllamaModel `json:"ollamaModels,omitempty"`

	// Diarization
	DiarizationEnabled    bool   `json:"diarizationEnabled,omitempty"`
	DiarizationProvider   string `json:"diarizationProvider,omitempty"` // cpu, coreml, cuda, auto
	DiarizationBackend    string `json:"diarizationBackend,omitempty"`  // sherpa (default), fluid (FluidAudio/CoreML)
	SegmentationModelPath string `json:"segmentationModelPath,omitempty"`
	EmbeddingModelPath    string `json:"embeddingModelPath,omitempty"`

	// Auto-improve with LLM
	AutoImproveEnabled bool `json:"autoImproveEnabled,omitempty"`

	// VoicePrint (спикеры)
	VoicePrints      []voiceprint.VoicePrint     `json:"voiceprints,omitempty"`
	VoicePrint       *voiceprint.VoicePrint      `json:"voiceprint,omitempty"`
	SessionSpeakers  []voiceprint.SessionSpeaker `json:"speakers,omitempty"`
	LocalSpeakerID   int                         `json:"localSpeakerId,omitempty"`
	SpeakerName      string                      `json:"speakerName,omitempty"`
	SaveAsVoiceprint bool                        `json:"saveAsVoiceprint,omitempty"`
	VoicePrintID     string                      `json:"voiceprintId,omitempty"`
	Similarity       float32                     `json:"similarity,omitempty"`

	// Merge Speakers
	SourceSpeakerIDs []int `json:"sourceSpeakerIds,omitempty"` // LocalIDs спикеров для объединения
	TargetSpeakerID  int   `json:"targetSpeakerId,omitempty"`  // LocalID целевого спикера
	MergeEmbeddings  bool  `json:"mergeEmbeddings,omitempty"`  // Усреднять embeddings
	MergedCount      int   `json:"mergedCount,omitempty"`      // Количество объединённых сегментов

	// Streaming Transcription (real-time updates)
	StreamingText                  string  `json:"streamingText,omitempty"`                  // Текущий текст (volatile или confirmed)
	StreamingIsConfirmed           bool    `json:"streamingIsConfirmed,omitempty"`           // true = confirmed, false = volatile
	StreamingConfidence            float32 `json:"streamingConfidence,omitempty"`            // Уверенность модели (0.0-1.0)
	StreamingTimestamp             int64   `json:"streamingTimestamp,omitempty"`             // Unix timestamp в миллисекундах
	StreamingChunkSeconds          float64 `json:"streamingChunkSeconds,omitempty"`          // Размер чанка в секундах (1-30)
	StreamingConfirmationThreshold float64 `json:"streamingConfirmationThreshold,omitempty"` // Порог подтверждения (0.5-1.0)

	// Hybrid Transcription (двухпроходное распознавание)
	HybridEnabled             bool     `json:"hybridEnabled,omitempty"`             // Включена ли гибридная транскрипция
	HybridSecondaryModelID    string   `json:"hybridSecondaryModelId,omitempty"`    // ID дополнительной модели
	HybridConfidenceThreshold float64  `json:"hybridConfidenceThreshold,omitempty"` // Порог уверенности (0.0-1.0)
	HybridContextWords        int      `json:"hybridContextWords,omitempty"`        // Количество слов контекста
	HybridUseLLMForMerge      bool     `json:"hybridUseLLMForMerge,omitempty"`      // Использовать LLM для слияния
	HybridMode                string   `json:"hybridMode,omitempty"`                // Режим: "confidence", "full_compare" или "parallel"
	HybridOllamaModel         string   `json:"hybridOllamaModel,omitempty"`         // Модель Ollama для LLM
	HybridOllamaURL           string   `json:"hybridOllamaUrl,omitempty"`           // URL Ollama API
	HybridHotwords            []string `json:"hybridHotwords,omitempty"`            // Словарь подсказок (термины, имена)

	// Search (поиск сессий)
	SearchQuery   string              `json:"searchQuery,omitempty"`   // Текстовый поиск
	SearchResults []SearchSessionInfo `json:"searchResults,omitempty"` // Результаты поиска
	TotalCount    int                 `json:"totalCount,omitempty"`    // Всего найдено
}

type OllamaModel struct {
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	IsCloud    bool   `json:"isCloud"`
	Family     string `json:"family"`
	Parameters string `json:"parameters"`
}

type SessionInfo struct {
	ID            string    `json:"id"`
	StartTime     time.Time `json:"startTime"`
	Status        string    `json:"status"`
	TotalDuration int64     `json:"totalDuration"`
	ChunksCount   int       `json:"chunksCount"`
	Title         string    `json:"title,omitempty"`
}

// SearchSessionInfo расширенная информация о сессии с результатами поиска
type SearchSessionInfo struct {
	SessionInfo
	MatchedText  string `json:"matchedText,omitempty"`  // Текст, где найдено совпадение
	MatchContext string `json:"matchContext,omitempty"` // Контекст вокруг совпадения
}
