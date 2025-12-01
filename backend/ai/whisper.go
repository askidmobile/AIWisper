package ai

import (
	whisper "aiwisper/ai/binding"
	"bytes"
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Engine struct {
	model       whisper.Model
	modelPath   string
	language    string
	useFaster   bool
	fasterModel string
	mu          sync.Mutex
}

func NewEngine(modelPath string) (*Engine, error) {
	if _, err := os.Stat(modelPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("model file not found: %s", modelPath)
	}

	useFaster := isFasterModel(modelPath)
	var model whisper.Model
	var err error
	if !useFaster {
		model, err = whisper.New(modelPath)
		if err != nil {
			return nil, err
		}
	}

	lang := strings.TrimSpace(os.Getenv("WHISPER_LANG"))
	if lang == "" {
		lang = "auto" // Автоопределение позволит распознавать русский и английский
	}

	log.Printf("Whisper init: language=%s model=%s faster=%t", lang, modelPath, useFaster)

	return &Engine{
		model:     model,
		modelPath: modelPath,
		language:  lang,
		useFaster: useFaster,
		fasterModel: func() string {
			if useFaster {
				return modelPath
			}
			return ""
		}(),
	}, nil
}

// TranscriptSegment сегмент с таймстемпами
type TranscriptSegment struct {
	Start int64 // миллисекунды
	End   int64 // миллисекунды
	Text  string
}

func (e *Engine) Transcribe(samples []float32, useContext bool) (string, error) {
	segments, err := e.TranscribeWithSegments(samples)
	if err != nil {
		return "", err
	}

	var texts []string
	for _, seg := range segments {
		if seg.Text != "" {
			texts = append(texts, seg.Text)
		}
	}
	return strings.Join(texts, " "), nil
}

// TranscribeWithSegments возвращает сегменты с таймстемпами
func (e *Engine) TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Проверяем что аудио содержит речь (не только шум/тишину)
	if !hasSignificantAudio(samples) {
		log.Printf("Skipping transcription: audio too quiet or no speech detected")
		return nil, nil
	}

	norm := normalize(samples)

	if e.useFaster {
		text, err := transcribeFasterWhisper(norm, e.language, e.fasterModel)
		if err != nil {
			return nil, err
		}
		// Faster whisper пока не возвращает сегменты, возвращаем весь текст как один сегмент
		if text != "" {
			durationMs := int64(len(samples)) * 1000 / 16000
			return []TranscriptSegment{{Start: 0, End: durationMs, Text: text}}, nil
		}
		return nil, nil
	}

	ctx, err := e.model.NewContext()
	if err != nil {
		return nil, err
	}

	if err := ctx.SetLanguage(e.language); err != nil {
		log.Printf("Failed to set language %q, falling back to auto: %v", e.language, err)
		_ = ctx.SetLanguage("auto")
	} else {
		ctx.SetTranslate(false)
	}

	// Настройки для качественной транскрипции
	ctx.SetBeamSize(5)
	ctx.SetTemperature(0.1) // Небольшая температура для лучшего качества
	ctx.SetTemperatureFallback(0.3)
	ctx.SetMaxTokensPerSegment(128)
	ctx.SetSplitOnWord(true)
	ctx.SetEntropyThold(2.4)

	log.Printf("TranscribeWithSegments: samples=%d duration=%.1fs lang=%s", len(samples), float64(len(samples))/16000, e.language)

	if err := ctx.Process(norm, nil, nil, nil); err != nil {
		return nil, err
	}

	// Собираем сегменты с таймстемпами
	var segments []TranscriptSegment
	for {
		segment, err := ctx.NextSegment()
		if err != nil {
			break
		}

		text := strings.TrimSpace(segment.Text)
		if text != "" {
			segments = append(segments, TranscriptSegment{
				Start: segment.Start.Milliseconds(),
				End:   segment.End.Milliseconds(),
				Text:  text,
			})
		}
	}

	return segments, nil
}

// hasSignificantAudio проверяет что аудио содержит значимый сигнал
func hasSignificantAudio(samples []float32) bool {
	if len(samples) < 1600 { // Меньше 0.1 секунды
		return false
	}

	// Вычисляем RMS
	var sum float64
	for _, s := range samples {
		sum += float64(s * s)
	}
	rms := math.Sqrt(sum / float64(len(samples)))

	// Порог для определения наличия речи
	const minRMS = 0.005

	if rms < minRMS {
		log.Printf("Audio RMS %.4f below threshold %.4f", rms, minRMS)
		return false
	}

	// Проверяем что есть вариация (не просто DC offset или постоянный шум)
	var maxAbs float32
	for _, s := range samples {
		if s > maxAbs {
			maxAbs = s
		} else if -s > maxAbs {
			maxAbs = -s
		}
	}

	if maxAbs < 0.01 {
		log.Printf("Audio max amplitude %.4f too low", maxAbs)
		return false
	}

	return true
}

func (e *Engine) Close() {
	// e.context.Close() // Context might not have Close, check bindings.
	// Usually bindings use runtime.SetFinalizer or have a Free/Close method.
	// If undefined, maybe we just close the model.
	e.model.Close()
}

func (e *Engine) SetLanguage(lang string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	lang = strings.TrimSpace(lang)
	if lang == "" {
		return
	}
	e.language = lang
}

func (e *Engine) SetModel(path string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}

	// Нормализуем путь для сравнения
	absPath, _ := filepath.Abs(path)
	absCurrentPath, _ := filepath.Abs(e.modelPath)

	if absPath == absCurrentPath {
		return nil // Та же модель, ничего не делаем
	}

	if _, err := os.Stat(path); err != nil {
		return err
	}

	log.Printf("Switching model from %s to %s", e.modelPath, path)

	useFaster := isFasterModel(path)
	var newModel whisper.Model
	var err error
	if !useFaster {
		newModel, err = whisper.New(path)
		if err != nil {
			return err
		}
	}

	// swap
	old := e.model
	e.model = newModel
	e.modelPath = path
	e.useFaster = useFaster
	if useFaster {
		e.fasterModel = path
	} else {
		e.fasterModel = ""
	}
	if old != nil {
		old.Close()
	}
	return nil
}

func normalize(in []float32) []float32 {
	const targetRMS = 0.03
	if len(in) == 0 {
		return in
	}
	var sum float64
	for _, s := range in {
		sum += float64(s * s)
	}
	rms := math.Sqrt(sum / float64(len(in)))
	scale := targetRMS / (rms + 1e-6)
	if scale > 5.0 {
		scale = 5.0
	}
	out := make([]float32, len(in))
	for i, v := range in {
		x := float64(v) * scale
		if x > 1 {
			x = 1
		} else if x < -1 {
			x = -1
		}
		out[i] = float32(x)
	}
	return out
}

func (e *Engine) IsFaster() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.useFaster
}

func isFasterModel(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	if info.IsDir() {
		if _, err := os.Stat(filepath.Join(path, "config.json")); err == nil {
			return true
		}
		if _, err := os.Stat(filepath.Join(path, "model.bin")); err == nil {
			return true
		}
	}
	return strings.HasSuffix(path, ".ct2") || strings.Contains(path, "faster-whisper")
}

func transcribeFasterWhisper(samples []float32, lang, modelPath string) (string, error) {
	if err := ensureFasterModelFiles(modelPath); err != nil {
		return "", err
	}

	tmpDir := os.TempDir()
	wavPath := filepath.Join(tmpDir, fmt.Sprintf("fw-%d.wav", time.Now().UnixNano()))
	if err := writeWav16k(wavPath, samples); err != nil {
		return "", err
	}
	defer os.Remove(wavPath)

	python := filepath.Join("backend", ".venv", "bin", "python3")
	if _, err := os.Stat(python); err != nil {
		python = "python3"
	}

	args := []string{
		"backend/faster_whisper_cli.py",
		"--model", modelPath,
		"--language", lang,
		"--file", wavPath,
	}
	cmd := exec.Command(python, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("faster-whisper failed: %v, output: %s", err, string(out))
	}
	return strings.TrimSpace(string(out)), nil
}

func writeWav16k(path string, samples []float32) error {
	const sampleRate = 16000
	buf := &bytes.Buffer{}

	// WAV header for PCM 16-bit mono
	// RIFF header
	writeString := func(s string) {
		buf.WriteString(s)
	}
	writeUint32 := func(v uint32) {
		_ = binary.Write(buf, binary.LittleEndian, v)
	}
	writeUint16 := func(v uint16) {
		_ = binary.Write(buf, binary.LittleEndian, v)
	}

	data := make([]int16, len(samples))
	for i, s := range samples {
		if s > 1 {
			s = 1
		} else if s < -1 {
			s = -1
		}
		data[i] = int16(s * 32767)
	}
	dataBytes := new(bytes.Buffer)
	for _, v := range data {
		_ = binary.Write(dataBytes, binary.LittleEndian, v)
	}

	byteRate := sampleRate * 2
	blockAlign := uint16(2)
	subchunk2Size := uint32(len(data) * 2)

	writeString("RIFF")
	writeUint32(36 + subchunk2Size)
	writeString("WAVE")

	// fmt chunk
	writeString("fmt ")
	writeUint32(16) // PCM chunk size
	writeUint16(1)  // PCM
	writeUint16(1)  // mono
	writeUint32(sampleRate)
	writeUint32(uint32(byteRate))
	writeUint16(blockAlign)
	writeUint16(16) // bits per sample

	// data chunk
	writeString("data")
	writeUint32(subchunk2Size)
	buf.Write(dataBytes.Bytes())

	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func ensureFasterModelFiles(modelPath string) error {
	info, err := os.Stat(modelPath)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return nil
	}
	modelBin := filepath.Join(modelPath, "model.bin")
	if binInfo, err := os.Stat(modelBin); err == nil && binInfo.Size() > 10*1024*1024 {
		return nil
	}

	python := filepath.Join("backend", ".venv", "bin", "python3")
	if _, err := os.Stat(python); err != nil {
		python = "python3"
	}

	// Heuristic: if path contains faster-whisper-small, download that repo
	repo := "Systran/faster-whisper-small"
	cmd := exec.Command(python, "-c", fmt.Sprintf(`from huggingface_hub import snapshot_download; snapshot_download(repo_id=%q, local_dir=%q, allow_patterns="*")`, repo, modelPath))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to fetch faster-whisper model via huggingface_hub: %v, output: %s", err, string(out))
	}
	return nil
}
