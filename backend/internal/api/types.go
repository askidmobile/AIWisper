package api

import (
	"aiwisper/audio"
	"aiwisper/models"
	"aiwisper/session"
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
	DisableVAD        bool    `json:"disableVAD,omitempty"`
	EchoCancel        float64 `json:"echoCancel,omitempty"`

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
	Models   []models.ModelState `json:"models,omitempty"`
	ModelID  string              `json:"modelId,omitempty"`
	Progress float64             `json:"progress,omitempty"`
	Error    string              `json:"error,omitempty"`

	// Summary
	Summary string `json:"summary,omitempty"`

	// Ollama
	OllamaModel  string        `json:"ollamaModel,omitempty"`
	OllamaUrl    string        `json:"ollamaUrl,omitempty"`
	OllamaModels []OllamaModel `json:"ollamaModels,omitempty"`

	// Diarization
	DiarizationEnabled    bool   `json:"diarizationEnabled,omitempty"`
	DiarizationProvider   string `json:"diarizationProvider,omitempty"` // cpu, coreml, cuda, auto
	SegmentationModelPath string `json:"segmentationModelPath,omitempty"`
	EmbeddingModelPath    string `json:"embeddingModelPath,omitempty"`

	// Auto-improve with LLM
	AutoImproveEnabled bool `json:"autoImproveEnabled,omitempty"`
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
