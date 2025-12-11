//go:build darwin

package ai

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// FluidASREngine выполняет транскрипцию через FluidAudio (Swift/CoreML)
// Использует subprocess для вызова transcription-fluid binary
// Это обеспечивает стабильную работу без memory leak (каждый вызов = новый процесс)
// Поддерживает параллельные вызовы через отдельные процессы
type FluidASREngine struct {
	binaryPath     string
	modelCacheDir  string
	pauseThreshold float64
	modelVersion   FluidModelVersion
	language       string
	mu             sync.Mutex
	initialized    bool
	supportedLangs []string
}

// FluidModelVersion версия модели Parakeet TDT
type FluidModelVersion string

const (
	// FluidModelV2 - Parakeet TDT v2 (English-only, higher recall for English)
	FluidModelV2 FluidModelVersion = "v2"
	// FluidModelV3 - Parakeet TDT v3 (Multilingual: 25 European languages)
	FluidModelV3 FluidModelVersion = "v3"
)

// FluidASRConfig конфигурация для FluidASREngine
type FluidASRConfig struct {
	BinaryPath     string            // Путь к transcription-fluid binary (опционально)
	ModelCacheDir  string            // Директория для кэша моделей FluidAudio
	PauseThreshold float64           // Порог паузы для сегментации (секунды), по умолчанию 0.5
	ModelVersion   FluidModelVersion // Версия модели: v2 (English) или v3 (Multilingual), по умолчанию v3
}

// fluidTranscriptionResult структура JSON ответа от transcription-fluid
type fluidTranscriptionResult struct {
	Segments     []fluidTranscriptSegment `json:"segments"`
	Language     string                   `json:"language"`
	ModelVersion string                   `json:"model_version"`
	Error        string                   `json:"error,omitempty"`
}

type fluidTranscriptSegment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

// getFluidASRBinaryPath ищет transcription-fluid binary в нескольких местах
func getFluidASRBinaryPath() string {
	paths := []string{
		// Рядом с исполняемым файлом (для packaged app)
		filepath.Join(filepath.Dir(os.Args[0]), "transcription-fluid"),
		// В Resources для macOS app bundle
		filepath.Join(filepath.Dir(os.Args[0]), "..", "Resources", "transcription-fluid"),
		// Для разработки
		"backend/audio/transcription/.build/release/transcription-fluid",
		"audio/transcription/.build/release/transcription-fluid",
		// Абсолютный путь для разработки
		"/Users/askid/Projects/AIWisper/backend/audio/transcription/.build/release/transcription-fluid",
	}

	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}

	return "" // Не найден
}

// NewFluidASREngine создаёт новый движок транскрипции на базе FluidAudio
func NewFluidASREngine(config FluidASRConfig) (*FluidASREngine, error) {
	binaryPath := config.BinaryPath
	if binaryPath == "" {
		binaryPath = getFluidASRBinaryPath()
	}

	if binaryPath == "" {
		return nil, fmt.Errorf("transcription-fluid binary not found. Build it with: cd backend/audio/transcription && swift build -c release")
	}

	if _, err := os.Stat(binaryPath); err != nil {
		return nil, fmt.Errorf("transcription-fluid binary not found at %s", binaryPath)
	}

	// Устанавливаем версию модели по умолчанию
	modelVersion := config.ModelVersion
	if modelVersion == "" {
		modelVersion = FluidModelV3 // По умолчанию multilingual
	}

	log.Printf("FluidASREngine: using binary at %s, model version %s", binaryPath, modelVersion)

	// Определяем поддерживаемые языки в зависимости от версии модели
	var supportedLangs []string
	if modelVersion == FluidModelV2 {
		// v2 - только английский
		supportedLangs = []string{"en"}
	} else {
		// v3 - 25 европейских языков
		supportedLangs = []string{
			"multi", "en", "de", "es", "fr", "it", "pt", "pl", "nl", "ru",
			"uk", "cs", "sk", "hr", "sl", "bg", "ro", "hu", "el", "lt",
			"lv", "et", "fi", "sv", "da", "no", "is",
		}
	}

	// Устанавливаем pause threshold по умолчанию
	pauseThreshold := config.PauseThreshold
	if pauseThreshold <= 0 {
		pauseThreshold = 0.5 // 500ms по умолчанию
	}

	return &FluidASREngine{
		binaryPath:     binaryPath,
		modelCacheDir:  config.ModelCacheDir,
		pauseThreshold: pauseThreshold,
		modelVersion:   modelVersion,
		language:       "multi", // По умолчанию автоопределение
		initialized:    true,
		supportedLangs: supportedLangs,
	}, nil
}

// Name возвращает имя движка
func (e *FluidASREngine) Name() string {
	return "fluid-asr"
}

// SupportedLanguages возвращает список поддерживаемых языков
func (e *FluidASREngine) SupportedLanguages() []string {
	return e.supportedLangs
}

// SetPauseThreshold устанавливает порог паузы для сегментации (в секундах)
// Меньшие значения (0.3) создают больше сегментов, большие (1.0+) - меньше
func (e *FluidASREngine) SetPauseThreshold(threshold float64) {
	if threshold > 0 {
		e.pauseThreshold = threshold
		log.Printf("FluidASREngine: pause threshold set to %.2fs", threshold)
	}
}

// GetPauseThreshold возвращает текущий порог паузы
func (e *FluidASREngine) GetPauseThreshold() float64 {
	return e.pauseThreshold
}

// Transcribe транскрибирует аудио и возвращает текст
func (e *FluidASREngine) Transcribe(samples []float32, useContext bool) (string, error) {
	segments, err := e.TranscribeWithSegments(samples)
	if err != nil {
		return "", err
	}

	var result string
	for _, seg := range segments {
		if seg.Text != "" {
			if result != "" {
				result += " "
			}
			result += seg.Text
		}
	}
	return result, nil
}

// TranscribeWithSegments возвращает сегменты с таймстемпами
func (e *FluidASREngine) TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error) {
	// Не используем mutex здесь - subprocess изолирован, можем запускать параллельно
	if !e.initialized {
		return nil, fmt.Errorf("FluidASREngine not initialized")
	}

	if len(samples) == 0 {
		return nil, nil
	}

	startTime := time.Now()

	// Запускаем subprocess с режимом --samples (читает из stdin)
	args := []string{"--samples"}
	if e.modelCacheDir != "" {
		args = append(args, "--model-cache-dir", e.modelCacheDir)
	}
	if e.pauseThreshold > 0 {
		args = append(args, "--pause-threshold", fmt.Sprintf("%.3f", e.pauseThreshold))
	}
	if e.modelVersion != "" {
		args = append(args, "--model", string(e.modelVersion))
	}

	cmd := exec.Command(e.binaryPath, args...)

	// Подготавливаем stdin с бинарными float32 данными
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to get stdin pipe: %w", err)
	}

	// Буфер для stdout
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Запускаем процесс
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start transcription-fluid: %w", err)
	}

	// Пишем samples в stdin как бинарные float32
	buf := make([]byte, len(samples)*4)
	for i, s := range samples {
		binary.LittleEndian.PutUint32(buf[i*4:], float32bits(s))
	}
	stdin.Write(buf)
	stdin.Close()

	// Ждём завершения процесса
	if err := cmd.Wait(); err != nil {
		// Логируем stderr если есть
		if stderr.Len() > 0 {
			log.Printf("FluidASREngine stderr: %s", stderr.String())
		}
		return nil, fmt.Errorf("transcription-fluid failed: %w", err)
	}

	// Парсим JSON результат
	var result fluidTranscriptionResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return nil, fmt.Errorf("failed to parse transcription result: %w (output: %s)", err, stdout.String())
	}

	if result.Error != "" {
		return nil, fmt.Errorf("transcription error: %s", result.Error)
	}

	// Конвертируем в наш формат
	segments := make([]TranscriptSegment, len(result.Segments))
	for i, seg := range result.Segments {
		segments[i] = TranscriptSegment{
			Start: int64(seg.Start * 1000), // секунды -> миллисекунды
			End:   int64(seg.End * 1000),
			Text:  seg.Text,
			Words: nil, // FluidAudio пока не возвращает word-level timestamps
		}
	}

	elapsed := time.Since(startTime)
	log.Printf("FluidASREngine: processed %.1fs audio in %.2fs (%.1fx RTF), found %d segments, language=%s",
		float64(len(samples))/16000.0, elapsed.Seconds(),
		float64(len(samples))/16000.0/elapsed.Seconds(),
		len(segments), result.Language)

	return segments, nil
}

// TranscribeHighQuality выполняет высококачественную транскрипцию
// Для FluidAudio используем тот же метод, т.к. Parakeet TDT v3 уже высококачественная модель
func (e *FluidASREngine) TranscribeHighQuality(samples []float32) ([]TranscriptSegment, error) {
	return e.TranscribeWithSegments(samples)
}

// SetLanguage устанавливает язык распознавания
// Примечание: Parakeet TDT v3 автоматически определяет язык, но мы сохраняем для совместимости
func (e *FluidASREngine) SetLanguage(lang string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.language = lang
	log.Printf("FluidASREngine: language set to %s (note: Parakeet v3 auto-detects language)", lang)
}

// SetModel переключает модель
// Для FluidAudio поддерживаются версии v2 (English) и v3 (Multilingual)
func (e *FluidASREngine) SetModel(path string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Проверяем, является ли path версией модели
	switch path {
	case "v2", "parakeet-v2":
		e.modelVersion = FluidModelV2
		e.supportedLangs = []string{"en"}
		log.Printf("FluidASREngine: switched to Parakeet TDT v2 (English-only)")
	case "v3", "parakeet-v3", "":
		e.modelVersion = FluidModelV3
		e.supportedLangs = []string{
			"multi", "en", "de", "es", "fr", "it", "pt", "pl", "nl", "ru",
			"uk", "cs", "sk", "hr", "sl", "bg", "ro", "hu", "el", "lt",
			"lv", "et", "fi", "sv", "da", "no", "is",
		}
		log.Printf("FluidASREngine: switched to Parakeet TDT v3 (Multilingual)")
	default:
		log.Printf("FluidASREngine: unknown model %s, keeping current version %s", path, e.modelVersion)
	}
	return nil
}

// SetModelVersion устанавливает версию модели напрямую
func (e *FluidASREngine) SetModelVersion(version FluidModelVersion) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.modelVersion = version
	if version == FluidModelV2 {
		e.supportedLangs = []string{"en"}
	} else {
		e.supportedLangs = []string{
			"multi", "en", "de", "es", "fr", "it", "pt", "pl", "nl", "ru",
			"uk", "cs", "sk", "hr", "sl", "bg", "ro", "hu", "el", "lt",
			"lv", "et", "fi", "sv", "da", "no", "is",
		}
	}
	log.Printf("FluidASREngine: model version set to %s", version)
}

// Close освобождает ресурсы (для FluidASREngine это no-op)
func (e *FluidASREngine) Close() {
	e.initialized = false
}

// float32bits уже определена в diarization_fluid.go
