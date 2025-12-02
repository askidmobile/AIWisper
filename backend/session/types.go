package session

import (
	"sync"
	"time"
)

// SessionStatus представляет состояние сессии
type SessionStatus string

const (
	SessionStatusRecording SessionStatus = "recording"
	SessionStatusCompleted SessionStatus = "completed"
	SessionStatusFailed    SessionStatus = "failed"
)

// ChunkStatus представляет состояние чанка
type ChunkStatus string

const (
	ChunkStatusPending      ChunkStatus = "pending"
	ChunkStatusTranscribing ChunkStatus = "transcribing"
	ChunkStatusCompleted    ChunkStatus = "completed"
	ChunkStatusFailed       ChunkStatus = "failed"
)

// Session представляет сессию записи
type Session struct {
	ID            string        `json:"id"`
	StartTime     time.Time     `json:"startTime"`
	EndTime       *time.Time    `json:"endTime,omitempty"`
	Status        SessionStatus `json:"status"`
	Language      string        `json:"language"`
	Model         string        `json:"model"`
	DataDir       string        `json:"dataDir"`
	TotalDuration time.Duration `json:"totalDuration"`
	SampleCount   int64         `json:"sampleCount"`
	Summary       string        `json:"summary,omitempty"` // AI-generated summary

	Chunks []*Chunk `json:"chunks"`

	mu sync.RWMutex `json:"-"`
}

// TranscriptWord слово с точными таймстемпами
type TranscriptWord struct {
	Start   int64   `json:"start"`   // Начало в миллисекундах
	End     int64   `json:"end"`     // Конец в миллисекундах
	Text    string  `json:"text"`    // Текст слова
	P       float32 `json:"p"`       // Вероятность (confidence)
	Speaker string  `json:"speaker"` // "mic" или "sys"
}

// TranscriptSegment сегмент транскрипции с таймстемпами
type TranscriptSegment struct {
	Start   int64            `json:"start"`           // Начало в миллисекундах относительно начала чанка
	End     int64            `json:"end"`             // Конец в миллисекундах
	Text    string           `json:"text"`            // Текст сегмента
	Speaker string           `json:"speaker"`         // "mic" или "sys"
	Words   []TranscriptWord `json:"words,omitempty"` // Слова с точными timestamps (word-level)
}

// Chunk представляет фрагмент аудио для распознавания
type Chunk struct {
	ID        string      `json:"id"`
	SessionID string      `json:"sessionId"`
	Index     int         `json:"index"`
	Status    ChunkStatus `json:"status"`

	// Таймстемпы в миллисекундах (относительно начала записи)
	StartMs  int64         `json:"startMs"`
	EndMs    int64         `json:"endMs"`
	Duration time.Duration `json:"duration"`

	// Флаг стерео режима (Voice Isolation): раздельная транскрипция mic/sys
	IsStereo bool `json:"isStereo,omitempty"`

	// Deprecated: используйте StartMs/EndMs и извлечение из MP3
	StartOffset int64  `json:"startOffset,omitempty"`
	EndOffset   int64  `json:"endOffset,omitempty"`
	FilePath    string `json:"filePath,omitempty"`
	MicFilePath string `json:"micFilePath,omitempty"`
	SysFilePath string `json:"sysFilePath,omitempty"`

	// Транскрипция
	Transcription string `json:"transcription,omitempty"`
	MicText       string `json:"micText,omitempty"` // Транскрипция микрофона (Вы)
	SysText       string `json:"sysText,omitempty"` // Транскрипция системного звука (Собеседник)

	// Сегменты с таймстемпами для диалога
	MicSegments []TranscriptSegment `json:"micSegments,omitempty"`
	SysSegments []TranscriptSegment `json:"sysSegments,omitempty"`
	Dialogue    []TranscriptSegment `json:"dialogue,omitempty"`

	CreatedAt     time.Time  `json:"createdAt"`
	TranscribedAt *time.Time `json:"transcribedAt,omitempty"`
	Error         string     `json:"error,omitempty"`
}

// SessionConfig конфигурация для создания сессии
type SessionConfig struct {
	Language      string
	Model         string
	MicDevice     string
	SystemDevice  string
	CaptureSystem bool
	UseNative     bool
}

// VADConfig конфигурация Voice Activity Detection
type VADConfig struct {
	SilenceThreshold   float64       // RMS порог (default: 0.008)
	SilenceDuration    time.Duration // Длительность тишины для разделения (default: 1s)
	MinChunkDuration   time.Duration // Минимальная длина чанка (default: 30s)
	MaxChunkDuration   time.Duration // Максимальная длина чанка (default: 5min)
	PreRollDuration    time.Duration // Буфер до начала речи (default: 500ms)
	ChunkingStartDelay time.Duration // Задержка перед началом нарезки (default: 60s)
}

// DefaultVADConfig возвращает конфигурацию VAD по умолчанию
func DefaultVADConfig() VADConfig {
	return VADConfig{
		SilenceThreshold:   0.008,
		SilenceDuration:    1 * time.Second,  // Пауза 1 секунда для разделения
		MinChunkDuration:   30 * time.Second, // Минимум 30 секунд для чанка
		MaxChunkDuration:   5 * time.Minute,  // Максимум 5 минут
		PreRollDuration:    500 * time.Millisecond,
		ChunkingStartDelay: 60 * time.Second, // Начинаем нарезку после 1 минуты
	}
}

// SampleRate константа частоты дискретизации для записи (48kHz)
const SampleRate = 48000

// WhisperSampleRate частота для Whisper (16kHz)
const WhisperSampleRate = 16000
