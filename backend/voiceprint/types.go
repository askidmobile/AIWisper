// Package voiceprint предоставляет систему глобальных голосовых отпечатков
// для автоматического распознавания спикеров между сессиями
package voiceprint

import "time"

// VoicePrint представляет сохранённый голосовой отпечаток
type VoicePrint struct {
	ID         string    `json:"id"`         // UUID
	Name       string    `json:"name"`       // Имя спикера (например, "Иван")
	Embedding  []float32 `json:"embedding"`  // 256-мерный вектор (WeSpeaker ResNet34)
	CreatedAt  time.Time `json:"createdAt"`  // Время создания
	UpdatedAt  time.Time `json:"updatedAt"`  // Время последнего обновления
	LastSeenAt time.Time `json:"lastSeenAt"` // Время последнего распознавания
	SeenCount  int       `json:"seenCount"`  // Количество встреч (для усреднения)

	// Опционально: путь к аудио-сэмплу для воспроизведения
	SamplePath string `json:"samplePath,omitempty"`

	// Метаданные
	Source string `json:"source,omitempty"` // "mic" или "sys" - откуда был записан
	Notes  string `json:"notes,omitempty"`  // Заметки пользователя
}

// VoicePrintStore структура для хранения в JSON файле
type VoicePrintStore struct {
	Version     int          `json:"version"`     // Версия формата (для миграций)
	VoicePrints []VoicePrint `json:"voiceprints"` // Список голосовых отпечатков
}

// MatchResult результат поиска совпадения
type MatchResult struct {
	VoicePrint *VoicePrint
	Similarity float32 // Косинусное сходство (0-1)
	Confidence string  // "high", "medium", "low", "none"
}

// SessionSpeaker спикер в контексте сессии (для UI)
type SessionSpeaker struct {
	LocalID       int       `json:"localId"`       // ID в рамках сессии (0, 1, 2...)
	GlobalID      string    `json:"globalId"`      // UUID из VoicePrint (если распознан)
	DisplayName   string    `json:"displayName"`   // "Вы", "Иван", "Собеседник 1"
	Embedding     []float32 `json:"embedding"`     // Текущий embedding
	IsRecognized  bool      `json:"isRecognized"`  // Был ли распознан из базы
	IsMic         bool      `json:"isMic"`         // Это микрофон (всегда "Вы")
	SegmentCount  int       `json:"segmentCount"`  // Количество сегментов речи
	TotalDuration float32   `json:"totalDuration"` // Общая длительность речи (сек)
	HasSample     bool      `json:"hasSample"`     // Есть ли аудио сэмпл для воспроизведения
}

// SpeakerMapping маппинг спикеров для хранения в session.json
type SpeakerMapping struct {
	VoicePrintID string `json:"voiceprintId"` // UUID глобального voiceprint или пустая строка
	DisplayName  string `json:"displayName"`  // Отображаемое имя
	IsRecognized bool   `json:"isRecognized"` // Был ли распознан автоматически
}

// Пороги для matching (косинусное сходство)
const (
	ThresholdHigh   float32 = 0.85 // Высокая уверенность - автоматическое назначение
	ThresholdMedium float32 = 0.70 // Средняя - предложить пользователю
	ThresholdLow    float32 = 0.50 // Низкая - возможное совпадение
	ThresholdMin    float32 = 0.50 // Минимальный порог для любого matching
)

// GetConfidence возвращает уровень уверенности для similarity
func GetConfidence(similarity float32) string {
	switch {
	case similarity >= ThresholdHigh:
		return "high"
	case similarity >= ThresholdMedium:
		return "medium"
	case similarity >= ThresholdLow:
		return "low"
	default:
		return "none"
	}
}

// CurrentVersion текущая версия формата хранения
const CurrentVersion = 1
