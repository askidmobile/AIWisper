//go:build darwin

package ai

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// FluidDiarizer выполняет диаризацию через FluidAudio (Swift/CoreML)
// Использует subprocess для вызова diarization-fluid binary
// Это обеспечивает стабильную работу без memory leak (каждый вызов = новый процесс)
type FluidDiarizer struct {
	binaryPath          string
	clusteringThreshold float64
	minSegmentDuration  float64
	vbxMaxIterations    int
	minGapDuration      float64
	debug               bool
	mu                  sync.Mutex
	initialized         bool
}

// FluidDiarizerConfig конфигурация для FluidDiarizer
type FluidDiarizerConfig struct {
	BinaryPath string // Путь к diarization-fluid binary (опционально)

	// Параметры диаризации (опционально, используются defaults если не заданы)
	ClusteringThreshold float64 // Порог кластеризации (0.0-1.0), default: 0.70
	MinSegmentDuration  float64 // Мин. длительность сегмента (сек), default: 0.2
	VBxMaxIterations    int     // Макс. итераций VBx, default: 30
	MinGapDuration      float64 // Мин. пауза между сегментами (сек), default: 0.15
	Debug               bool    // Включить отладочный вывод
}

// DefaultFluidDiarizerConfig возвращает оптимальные параметры для разговорного аудио
func DefaultFluidDiarizerConfig() FluidDiarizerConfig {
	return FluidDiarizerConfig{
		ClusteringThreshold: 0.70,
		MinSegmentDuration:  0.2,
		VBxMaxIterations:    30,
		MinGapDuration:      0.15,
		Debug:               false,
	}
}

// fluidDiarizationResult структура JSON ответа от diarization-fluid
type fluidDiarizationResult struct {
	Segments    []fluidSegment `json:"segments"`
	NumSpeakers int            `json:"num_speakers"`
	Error       string         `json:"error,omitempty"`
}

type fluidSegment struct {
	Speaker int     `json:"speaker"`
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
}

// getFluidBinaryPath ищет diarization-fluid binary в нескольких местах
func getFluidBinaryPath() string {
	paths := []string{
		// Рядом с исполняемым файлом (для packaged app)
		filepath.Join(filepath.Dir(os.Args[0]), "diarization-fluid"),
		// В Resources для macOS app bundle
		filepath.Join(filepath.Dir(os.Args[0]), "..", "Resources", "diarization-fluid"),
		// Для разработки
		"backend/audio/diarization/.build/release/diarization-fluid",
		"audio/diarization/.build/release/diarization-fluid",
		// Абсолютный путь для разработки
		"/Users/askid/Projects/AIWisper/backend/audio/diarization/.build/release/diarization-fluid",
	}

	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}

	return "" // Не найден
}

// NewFluidDiarizer создаёт новый диаризатор на базе FluidAudio
func NewFluidDiarizer(config FluidDiarizerConfig) (*FluidDiarizer, error) {
	binaryPath := config.BinaryPath
	if binaryPath == "" {
		binaryPath = getFluidBinaryPath()
	}

	if binaryPath == "" {
		return nil, fmt.Errorf("diarization-fluid binary not found. Build it with: cd backend/audio/diarization && swift build -c release")
	}

	if _, err := os.Stat(binaryPath); err != nil {
		return nil, fmt.Errorf("diarization-fluid binary not found at %s", binaryPath)
	}

	// Применяем defaults если параметры не заданы
	clusteringThreshold := config.ClusteringThreshold
	if clusteringThreshold <= 0 {
		clusteringThreshold = 0.70
	}
	minSegmentDuration := config.MinSegmentDuration
	if minSegmentDuration <= 0 {
		minSegmentDuration = 0.2
	}
	vbxMaxIterations := config.VBxMaxIterations
	if vbxMaxIterations <= 0 {
		vbxMaxIterations = 30
	}
	minGapDuration := config.MinGapDuration
	if minGapDuration <= 0 {
		minGapDuration = 0.15
	}

	log.Printf("FluidDiarizer: using binary at %s (threshold=%.2f, minSeg=%.2f, vbxIter=%d)",
		binaryPath, clusteringThreshold, minSegmentDuration, vbxMaxIterations)

	return &FluidDiarizer{
		binaryPath:          binaryPath,
		clusteringThreshold: clusteringThreshold,
		minSegmentDuration:  minSegmentDuration,
		vbxMaxIterations:    vbxMaxIterations,
		minGapDuration:      minGapDuration,
		debug:               config.Debug,
		initialized:         true,
	}, nil
}

// Diarize выполняет диаризацию аудио через FluidAudio subprocess
// samples - аудио данные в формате float32, 16kHz, mono
func (d *FluidDiarizer) Diarize(samples []float32) ([]SpeakerSegment, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if !d.initialized {
		return nil, fmt.Errorf("FluidDiarizer not initialized")
	}

	if len(samples) == 0 {
		return nil, nil
	}

	startTime := time.Now()

	// Запускаем subprocess с режимом --samples и параметрами
	args := []string{"--samples"}
	args = append(args, "--clustering-threshold", fmt.Sprintf("%.2f", d.clusteringThreshold))
	args = append(args, "--min-segment-duration", fmt.Sprintf("%.2f", d.minSegmentDuration))
	args = append(args, "--vbx-max-iterations", fmt.Sprintf("%d", d.vbxMaxIterations))
	args = append(args, "--min-gap-duration", fmt.Sprintf("%.2f", d.minGapDuration))
	if d.debug {
		args = append(args, "--debug")
	}

	cmd := exec.Command(d.binaryPath, args...)

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
		return nil, fmt.Errorf("failed to start diarization-fluid: %w", err)
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
			log.Printf("FluidDiarizer stderr: %s", stderr.String())
		}
		return nil, fmt.Errorf("diarization-fluid failed: %w", err)
	}

	// Парсим JSON результат
	var result fluidDiarizationResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return nil, fmt.Errorf("failed to parse diarization result: %w (output: %s)", err, stdout.String())
	}

	if result.Error != "" {
		return nil, fmt.Errorf("diarization error: %s", result.Error)
	}

	// Конвертируем в наш формат
	segments := make([]SpeakerSegment, len(result.Segments))
	for i, seg := range result.Segments {
		segments[i] = SpeakerSegment{
			Start:   float32(seg.Start),
			End:     float32(seg.End),
			Speaker: seg.Speaker,
		}
	}

	elapsed := time.Since(startTime)
	log.Printf("FluidDiarizer: processed %.1fs audio in %.2fs, found %d segments from %d speakers",
		float64(len(samples))/16000.0, elapsed.Seconds(), len(segments), result.NumSpeakers)

	return segments, nil
}

// DiarizeFile выполняет диаризацию аудио файла напрямую
// audioPath - путь к WAV файлу (16kHz mono)
func (d *FluidDiarizer) DiarizeFile(audioPath string) ([]SpeakerSegment, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if !d.initialized {
		return nil, fmt.Errorf("FluidDiarizer not initialized")
	}

	startTime := time.Now()

	// Запускаем subprocess с путём к файлу и параметрами
	args := []string{audioPath}
	args = append(args, "--clustering-threshold", fmt.Sprintf("%.2f", d.clusteringThreshold))
	args = append(args, "--min-segment-duration", fmt.Sprintf("%.2f", d.minSegmentDuration))
	args = append(args, "--vbx-max-iterations", fmt.Sprintf("%d", d.vbxMaxIterations))
	args = append(args, "--min-gap-duration", fmt.Sprintf("%.2f", d.minGapDuration))
	if d.debug {
		args = append(args, "--debug")
	}

	cmd := exec.Command(d.binaryPath, args...)

	// Разделяем stdout (JSON) и stderr (profiling logs)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("diarization-fluid failed: %w (stderr: %s)", err, stderr.String())
	}

	// Парсим JSON результат из stdout
	var result fluidDiarizationResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return nil, fmt.Errorf("failed to parse diarization result: %w (stdout: %s)", err, stdout.String())
	}

	if result.Error != "" {
		return nil, fmt.Errorf("diarization error: %s", result.Error)
	}

	// Конвертируем в наш формат
	segments := make([]SpeakerSegment, len(result.Segments))
	for i, seg := range result.Segments {
		segments[i] = SpeakerSegment{
			Start:   float32(seg.Start),
			End:     float32(seg.End),
			Speaker: seg.Speaker,
		}
	}

	elapsed := time.Since(startTime)
	log.Printf("FluidDiarizer: processed file %s in %.2fs, found %d segments from %d speakers",
		filepath.Base(audioPath), elapsed.Seconds(), len(segments), result.NumSpeakers)

	return segments, nil
}

// IsInitialized возвращает true если диаризатор инициализирован
func (d *FluidDiarizer) IsInitialized() bool {
	return d.initialized
}

// Close освобождает ресурсы (для FluidDiarizer это no-op)
func (d *FluidDiarizer) Close() {
	d.initialized = false
}

// float32bits конвертирует float32 в uint32 (для бинарной сериализации)
func float32bits(f float32) uint32 {
	return math.Float32bits(f)
}
