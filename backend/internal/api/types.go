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
	VADMode           string  `json:"vadMode,omitempty"` // auto, compression, per-region, off
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
	DiarizationBackend    string `json:"diarizationBackend,omitempty"`  // sherpa (default), fluid (FluidAudio/CoreML)
	SegmentationModelPath string `json:"segmentationModelPath,omitempty"`
	EmbeddingModelPath    string `json:"embeddingModelPath,omitempty"`

	// Auto-improve with LLM
	AutoImproveEnabled bool `json:"autoImproveEnabled,omitempty"`

	// VoicePrint (спикеры)
	VoicePrints      []voiceprint.VoicePrint     `json:"voiceprints,omitempty"`
	VoicePrint       *voiceprint.VoicePrint      `json:"voiceprint,omitempty"`
	SessionSpeakers  []voiceprint.SessionSpeaker `json:"sessionSpeakers,omitempty"`
	LocalSpeakerID   int                         `json:"localSpeakerId,omitempty"`
	SpeakerName      string                      `json:"speakerName,omitempty"`
	SaveAsVoiceprint bool                        `json:"saveAsVoiceprint,omitempty"`
	VoicePrintID     string                      `json:"voiceprintId,omitempty"`
	Similarity       float32                     `json:"similarity,omitempty"`

	// Streaming Transcription (real-time updates)
	StreamingText        string  `json:"streamingText,omitempty"`        // Текущий текст (volatile или confirmed)
	StreamingIsConfirmed bool    `json:"streamingIsConfirmed,omitempty"` // true = confirmed, false = volatile
	StreamingConfidence  float32 `json:"streamingConfidence,omitempty"`  // Уверенность модели (0.0-1.0)
	StreamingTimestamp   int64   `json:"streamingTimestamp,omitempty"`   // Unix timestamp в миллисекундах
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
