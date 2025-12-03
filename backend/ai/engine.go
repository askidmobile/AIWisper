// Package ai предоставляет интерфейсы и реализации для транскрипции речи
package ai

// TranscriptSegment сегмент с таймстемпами
type TranscriptSegment struct {
	Start int64            // миллисекунды
	End   int64            // миллисекунды
	Text  string           // полный текст сегмента
	Words []TranscriptWord // слова с точными timestamps (word-level)
}

// TranscriptWord слово с точными таймстемпами
type TranscriptWord struct {
	Start int64   // миллисекунды
	End   int64   // миллисекунды
	Text  string  // текст слова
	P     float32 // вероятность (confidence)
}

// TranscriptionEngine интерфейс для движков транскрипции
// Позволяет использовать разные бэкенды (Whisper, GigaAM и др.)
type TranscriptionEngine interface {
	// Transcribe транскрибирует аудио и возвращает текст
	// samples - аудио данные в формате float32, 16kHz, mono
	// useContext - использовать ли контекст предыдущих сегментов
	Transcribe(samples []float32, useContext bool) (string, error)

	// TranscribeWithSegments возвращает сегменты с таймстемпами
	TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error)

	// TranscribeHighQuality выполняет высококачественную транскрипцию
	// Используется для финальной обработки записей
	TranscribeHighQuality(samples []float32) ([]TranscriptSegment, error)

	// SetLanguage устанавливает язык распознавания
	// Поддерживаемые значения зависят от движка
	SetLanguage(lang string)

	// SetModel переключает модель
	// path - путь к файлу модели
	SetModel(path string) error

	// Close освобождает ресурсы движка
	Close()

	// Name возвращает имя движка (для логирования)
	Name() string

	// SupportedLanguages возвращает список поддерживаемых языков
	SupportedLanguages() []string
}

// EngineType тип движка транскрипции
type EngineType string

const (
	// EngineTypeWhisper - whisper.cpp движок
	EngineTypeWhisper EngineType = "whisper"
	// EngineTypeGigaAM - GigaAM ONNX движок
	EngineTypeGigaAM EngineType = "gigaam"
)

// EngineConfig конфигурация для создания движка
type EngineConfig struct {
	Type      EngineType // тип движка
	ModelPath string     // путь к модели
	VocabPath string     // путь к словарю (для GigaAM)
	Language  string     // язык по умолчанию
}
