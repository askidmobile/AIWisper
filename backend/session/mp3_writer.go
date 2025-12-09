package session

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
	"unsafe"
)

// ffmpegPath кешированный путь к FFmpeg
var ffmpegPath string

// GetFFmpegPath возвращает путь к FFmpeg бинарнику (экспортируемая версия)
func GetFFmpegPath() string {
	return getFFmpegPath()
}

// getFFmpegPath возвращает путь к FFmpeg бинарнику
// Ищет в следующих местах (в порядке приоритета):
// 1. Resources директория .app bundle (для packaged приложения)
// 2. Рядом с исполняемым файлом
// 3. В текущей рабочей директории
// 4. Системный PATH
func getFFmpegPath() string {
	if ffmpegPath != "" {
		return ffmpegPath
	}

	var searchPaths []string

	// Получаем путь к текущему исполняемому файлу
	execPath, err := os.Executable()
	if err == nil {
		execDir := filepath.Dir(execPath)
		log.Printf("FFmpeg search: execDir=%s", execDir)

		// Вариант 1: внутри .app bundle (MacOS/../Resources/ffmpeg)
		searchPaths = append(searchPaths, filepath.Join(execDir, "..", "Resources", "ffmpeg"))

		// Вариант 2: рядом с исполняемым файлом
		searchPaths = append(searchPaths, filepath.Join(execDir, "ffmpeg"))

		// Вариант 3: в той же директории что и backend (Resources)
		// Это для случая когда backend запущен из Resources
		searchPaths = append(searchPaths, filepath.Join(filepath.Dir(execPath), "ffmpeg"))
	}

	// Вариант 4: в текущей рабочей директории
	if cwd, err := os.Getwd(); err == nil {
		log.Printf("FFmpeg search: cwd=%s", cwd)
		searchPaths = append(searchPaths, filepath.Join(cwd, "ffmpeg"))
		searchPaths = append(searchPaths, filepath.Join(cwd, "vendor", "ffmpeg", "ffmpeg")) // vendor/ffmpeg/ffmpeg
		searchPaths = append(searchPaths, filepath.Join(cwd, "vendor", "ffmpeg"))           // vendor/ffmpeg (если это файл)
		searchPaths = append(searchPaths, filepath.Join(cwd, "build", "resources", "ffmpeg"))
		searchPaths = append(searchPaths, filepath.Join(cwd, "..", "build", "resources", "ffmpeg"))
	}

	// Проверяем все пути
	for _, path := range searchPaths {
		if fileExists(path) {
			ffmpegPath = path
			log.Printf("Using FFmpeg: %s", ffmpegPath)
			return ffmpegPath
		}
	}

	// Вариант 5: системный PATH
	systemPath, err := exec.LookPath("ffmpeg")
	if err == nil {
		ffmpegPath = systemPath
		log.Printf("Using system FFmpeg: %s", ffmpegPath)
		return ffmpegPath
	}

	// Fallback: просто "ffmpeg" - может сработает
	ffmpegPath = "ffmpeg"
	log.Printf("FFmpeg not found in any location, using default: %s", ffmpegPath)
	log.Printf("Searched paths: %v", searchPaths)
	return ffmpegPath
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// MP3Writer стриминговый писатель MP3 через FFmpeg
type MP3Writer struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	filePath   string
	sampleRate int
	channels   int
	bitrate    string // например "128k"

	samplesWritten int64
	startTime      time.Time
	mu             sync.Mutex
	closed         bool
}

// NewMP3Writer создаёт новый MP3 writer через FFmpeg pipe
func NewMP3Writer(filePath string, sampleRate, channels int, bitrate string) (*MP3Writer, error) {
	if bitrate == "" {
		bitrate = "128k"
	}

	// FFmpeg команда: читает raw PCM из stdin, пишет MP3 в файл
	// Формат входа: signed 16-bit little-endian PCM
	cmd := exec.Command(getFFmpegPath(),
		"-y",          // перезаписать файл
		"-f", "s16le", // формат входа: signed 16-bit little-endian
		"-ar", fmt.Sprintf("%d", sampleRate), // sample rate
		"-ac", fmt.Sprintf("%d", channels), // channels
		"-i", "pipe:0", // читать из stdin
		"-c:a", "libmp3lame", // кодек MP3
		"-b:a", bitrate, // битрейт
		"-f", "mp3", // формат выхода
		filePath,
	)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	// Перенаправляем stderr в лог (для отладки)
	cmd.Stderr = nil // игнорируем stderr FFmpeg

	if err := cmd.Start(); err != nil {
		stdin.Close()
		return nil, fmt.Errorf("failed to start ffmpeg: %w", err)
	}

	log.Printf("MP3Writer started: %s (rate=%d, ch=%d, bitrate=%s)", filePath, sampleRate, channels, bitrate)

	return &MP3Writer{
		cmd:        cmd,
		stdin:      stdin,
		filePath:   filePath,
		sampleRate: sampleRate,
		channels:   channels,
		bitrate:    bitrate,
		startTime:  time.Now(),
	}, nil
}

// Write записывает float32 семплы (конвертирует в PCM16)
func (w *MP3Writer) Write(samples []float32) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return fmt.Errorf("writer is closed")
	}

	// Конвертируем float32 в int16 и пишем
	buf := make([]byte, len(samples)*2)
	for i, s := range samples {
		// Clamp
		if s > 1.0 {
			s = 1.0
		} else if s < -1.0 {
			s = -1.0
		}
		sample := int16(s * 32767)
		binary.LittleEndian.PutUint16(buf[i*2:], uint16(sample))
	}

	_, err := w.stdin.Write(buf)
	if err != nil {
		return fmt.Errorf("failed to write to ffmpeg: %w", err)
	}

	w.samplesWritten += int64(len(samples))
	return nil
}

// SamplesWritten возвращает количество записанных семплов
func (w *MP3Writer) SamplesWritten() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.samplesWritten
}

// Duration возвращает длительность записи
func (w *MP3Writer) Duration() time.Duration {
	w.mu.Lock()
	defer w.mu.Unlock()
	// Делим на channels потому что samplesWritten это общее количество семплов (всех каналов)
	frames := w.samplesWritten / int64(w.channels)
	return time.Duration(frames) * time.Second / time.Duration(w.sampleRate)
}

// Close завершает запись и ждёт FFmpeg
func (w *MP3Writer) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	w.mu.Unlock()

	// Закрываем stdin чтобы FFmpeg завершил кодирование
	if err := w.stdin.Close(); err != nil {
		log.Printf("Error closing ffmpeg stdin: %v", err)
	}

	// Ждём завершения FFmpeg
	if err := w.cmd.Wait(); err != nil {
		return fmt.Errorf("ffmpeg finished with error: %w", err)
	}

	duration := w.Duration()
	log.Printf("MP3Writer closed: %s (duration=%v)", w.filePath, duration)

	return nil
}

// FilePath возвращает путь к файлу
func (w *MP3Writer) FilePath() string {
	return w.filePath
}

// ConvertWAVToMP3 конвертирует WAV файл в MP3 используя FFmpeg
// Вызывается после завершения записи
func ConvertWAVToMP3(wavPath, mp3Path string) error {
	if !fileExists(wavPath) {
		return fmt.Errorf("WAV file not found: %s", wavPath)
	}

	ffmpegBin := getFFmpegPath()
	log.Printf("Converting WAV to MP3: ffmpeg=%s, wav=%s, mp3=%s", ffmpegBin, wavPath, mp3Path)

	cmd := exec.Command(ffmpegBin,
		"-y",          // перезаписать
		"-i", wavPath, // вход
		"-c:a", "libmp3lame",
		"-b:a", "128k", // битрейт
		mp3Path,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg conversion failed: %w, output: %s", err, string(output))
	}

	log.Printf("WAV to MP3 conversion complete: %s", mp3Path)
	return nil
}

// ExtractSegment извлекает фрагмент из MP3 файла и возвращает PCM samples
// startMs, endMs - время в миллисекундах
func ExtractSegment(mp3Path string, startMs, endMs int64, targetSampleRate int) ([]float32, error) {
	startSec := float64(startMs) / 1000.0
	endSec := float64(endMs) / 1000.0
	duration := endSec - startSec

	if duration <= 0 {
		return nil, fmt.Errorf("invalid duration: start=%v end=%v", startMs, endMs)
	}

	// Проверяем существование MP3 файла
	if !fileExists(mp3Path) {
		return nil, fmt.Errorf("mp3 file not found: %s", mp3Path)
	}

	ffmpegBin := getFFmpegPath()
	log.Printf("ExtractSegment: ffmpeg=%s, mp3=%s, start=%.1fs, duration=%.1fs", ffmpegBin, mp3Path, startSec, duration)

	// FFmpeg: извлекаем фрагмент и конвертируем в raw PCM
	cmd := exec.Command(ffmpegBin,
		"-ss", fmt.Sprintf("%.3f", startSec), // seek to start
		"-i", mp3Path,
		"-t", fmt.Sprintf("%.3f", duration), // duration
		"-ar", fmt.Sprintf("%d", targetSampleRate), // resample to target rate
		"-ac", "1", // mono для Whisper
		"-f", "f32le", // float32 little-endian
		"-acodec", "pcm_f32le",
		"pipe:1", // output to stdout
	)

	output, err := cmd.Output()
	if err != nil {
		// Получаем stderr для диагностики
		if exitErr, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("ffmpeg extract failed (exit %d): %s", exitErr.ExitCode(), string(exitErr.Stderr))
		}
		return nil, fmt.Errorf("ffmpeg extract failed: %w (ffmpeg path: %s)", err, ffmpegBin)
	}

	// Конвертируем bytes в float32
	numSamples := len(output) / 4
	samples := make([]float32, numSamples)
	for i := 0; i < numSamples; i++ {
		bits := binary.LittleEndian.Uint32(output[i*4:])
		samples[i] = float32frombits(bits)
	}

	log.Printf("Extracted segment: %s [%.1f-%.1f sec] -> %d samples", mp3Path, startSec, endSec, len(samples))

	return samples, nil
}

// ExtractSegmentStereo извлекает фрагмент из стерео MP3 и возвращает раздельные каналы
// Возвращает: leftSamples (mic), rightSamples (sys)
func ExtractSegmentStereo(mp3Path string, startMs, endMs int64, targetSampleRate int) ([]float32, []float32, error) {
	startSec := float64(startMs) / 1000.0
	endSec := float64(endMs) / 1000.0
	duration := endSec - startSec

	if duration <= 0 {
		return nil, nil, fmt.Errorf("invalid duration: start=%v end=%v", startMs, endMs)
	}

	// Извлекаем левый канал (микрофон)
	cmdLeft := exec.Command(getFFmpegPath(),
		"-ss", fmt.Sprintf("%.3f", startSec),
		"-i", mp3Path,
		"-t", fmt.Sprintf("%.3f", duration),
		"-ar", fmt.Sprintf("%d", targetSampleRate),
		"-af", "pan=mono|c0=c0", // только левый канал
		"-f", "f32le",
		"-acodec", "pcm_f32le",
		"pipe:1",
	)

	// Извлекаем правый канал (системный звук)
	cmdRight := exec.Command(getFFmpegPath(),
		"-ss", fmt.Sprintf("%.3f", startSec),
		"-i", mp3Path,
		"-t", fmt.Sprintf("%.3f", duration),
		"-ar", fmt.Sprintf("%d", targetSampleRate),
		"-af", "pan=mono|c0=c1", // только правый канал
		"-f", "f32le",
		"-acodec", "pcm_f32le",
		"pipe:1",
	)

	// Запускаем параллельно
	leftOutput, errLeft := cmdLeft.Output()
	rightOutput, errRight := cmdRight.Output()

	if errLeft != nil {
		return nil, nil, fmt.Errorf("ffmpeg extract left failed: %w", errLeft)
	}
	if errRight != nil {
		return nil, nil, fmt.Errorf("ffmpeg extract right failed: %w", errRight)
	}

	// Конвертируем в float32
	leftSamples := bytesToFloat32(leftOutput)
	rightSamples := bytesToFloat32(rightOutput)

	log.Printf("Extracted stereo segment: %s [%.1f-%.1f sec] -> L:%d R:%d samples",
		mp3Path, startSec, endSec, len(leftSamples), len(rightSamples))

	return leftSamples, rightSamples, nil
}

func bytesToFloat32(data []byte) []float32 {
	numSamples := len(data) / 4
	samples := make([]float32, numSamples)
	for i := 0; i < numSamples; i++ {
		bits := binary.LittleEndian.Uint32(data[i*4:])
		samples[i] = float32frombits(bits)
	}
	return samples
}

func float32frombits(b uint32) float32 {
	return *(*float32)(unsafe.Pointer(&b))
}

// FileExists проверяет существование файла (экспортируемая версия)
func FileExists(path string) bool {
	return fileExists(path)
}

// ExtractChannelToWAV extracts a single channel from MP3 to a WAV file
// channel: 0 for left, 1 for right
func ExtractChannelToWAV(mp3Path, outPath string, channel int, startMs, endMs int64) error {
	startSec := float64(startMs) / 1000.0
	endSec := float64(endMs) / 1000.0
	duration := endSec - startSec

	if duration <= 0 {
		return fmt.Errorf("invalid duration: start=%v end=%v", startMs, endMs)
	}

	if !fileExists(mp3Path) {
		return fmt.Errorf("mp3 file not found: %s", mp3Path)
	}

	// Determine filter for channel selection
	// pan=mono|c0=c0 selects FL (Left)
	// pan=mono|c0=c1 selects FR (Right)
	filter := fmt.Sprintf("pan=mono|c0=c%d", channel)

	ffmpegBin := getFFmpegPath()
	log.Printf("ExtractChannelToWAV: ffmpeg=%s, mp3=%s, out=%s, ch=%d, dur=%.1f",
		ffmpegBin, mp3Path, outPath, channel, duration)

	cmd := exec.Command(ffmpegBin,
		"-y", // overwrite
		"-ss", fmt.Sprintf("%.3f", startSec),
		"-i", mp3Path,
		"-t", fmt.Sprintf("%.3f", duration),
		"-ar", "16000", // 16kHz for Whisper
		"-af", filter,
		"-ac", "1", // mono output
		"-c:a", "pcm_s16le", // standard 16-bit PCM WAV
		outPath,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg extract failed: %w, output: %s", err, string(output))
	}

	return nil
}
