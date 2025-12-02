package models

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// ProgressFunc функция для отчёта о прогрессе (0-100)
type ProgressFunc func(progress float64)

// DownloadFile скачивает файл по URL с отображением прогресса
func DownloadFile(ctx context.Context, url, destPath string, expectedSize int64, onProgress ProgressFunc) error {
	// Создаём директорию если нужно
	dir := filepath.Dir(destPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Создаём временный файл
	tmpPath := destPath + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	defer out.Close()

	// Создаём HTTP запрос с контекстом
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Выполняем запрос
	client := &http.Client{
		Timeout: 0, // Без таймаута для больших файлов
	}
	resp, err := client.Do(req)
	if err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		os.Remove(tmpPath)
		return fmt.Errorf("bad status: %s", resp.Status)
	}

	// Определяем размер файла
	totalSize := resp.ContentLength
	if totalSize <= 0 && expectedSize > 0 {
		totalSize = expectedSize
	}

	// Создаём reader с прогрессом
	reader := &progressReader{
		reader:     resp.Body,
		totalSize:  totalSize,
		onProgress: onProgress,
	}

	// Копируем данные
	_, err = io.Copy(out, reader)
	if err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to write file: %w", err)
	}

	// Закрываем файл перед переименованием
	out.Close()

	// Переименовываем временный файл
	if err := os.Rename(tmpPath, destPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to rename file: %w", err)
	}

	return nil
}

// progressReader обёртка для io.Reader с отслеживанием прогресса
type progressReader struct {
	reader       io.Reader
	totalSize    int64
	downloaded   int64
	onProgress   ProgressFunc
	lastReport   time.Time
	reportPeriod time.Duration
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.reader.Read(p)
	if n > 0 {
		pr.downloaded += int64(n)

		// Ограничиваем частоту отчётов
		now := time.Now()
		if pr.reportPeriod == 0 {
			pr.reportPeriod = 500 * time.Millisecond
		}

		if pr.onProgress != nil && (now.Sub(pr.lastReport) >= pr.reportPeriod || err == io.EOF) {
			pr.lastReport = now
			if pr.totalSize > 0 {
				progress := float64(pr.downloaded) / float64(pr.totalSize) * 100
				pr.onProgress(progress)
			}
		}
	}
	return n, err
}

// Faster-Whisper модели требуют эти файлы
var fasterWhisperFiles = []string{
	"config.json",
	"model.bin",
	"tokenizer.json",
	"vocabulary.json",
	"preprocessor_config.json",
}

// DownloadHuggingFaceModel скачивает модель из HuggingFace напрямую через HTTP
func DownloadHuggingFaceModel(ctx context.Context, repo, destDir string, onProgress ProgressFunc) error {
	// Создаём директорию
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	log.Printf("Downloading HuggingFace model %s to %s", repo, destDir)

	// Отправляем начальный прогресс
	if onProgress != nil {
		onProgress(0)
	}

	// Сначала получаем список файлов через API
	files, err := getHuggingFaceFiles(ctx, repo)
	if err != nil {
		// Fallback: используем стандартный список файлов
		log.Printf("Failed to get file list from API, using default files: %v", err)
		files = fasterWhisperFiles
	}

	// Фильтруем только нужные файлы (исключаем .gitattributes, README и т.д.)
	var modelFiles []string
	for _, f := range files {
		// Пропускаем служебные файлы
		if f == ".gitattributes" || f == "README.md" || f == ".git" {
			continue
		}
		modelFiles = append(modelFiles, f)
	}

	if len(modelFiles) == 0 {
		modelFiles = fasterWhisperFiles
	}

	log.Printf("Files to download: %v", modelFiles)

	// Скачиваем каждый файл
	totalFiles := len(modelFiles)
	for i, filename := range modelFiles {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		fileURL := fmt.Sprintf("https://huggingface.co/%s/resolve/main/%s", repo, filename)
		destPath := filepath.Join(destDir, filename)

		log.Printf("Downloading [%d/%d]: %s", i+1, totalFiles, filename)

		// Прогресс на основе количества файлов
		fileProgress := func(p float64) {
			if onProgress != nil {
				// Общий прогресс = (завершённые файлы + текущий прогресс) / всего файлов
				totalProgress := (float64(i) + p/100) / float64(totalFiles) * 100
				onProgress(totalProgress)
			}
		}

		err := DownloadFile(ctx, fileURL, destPath, 0, fileProgress)
		if err != nil {
			// Некоторые файлы могут отсутствовать - это нормально
			if filename == "vocabulary.json" || filename == "preprocessor_config.json" {
				log.Printf("Optional file not found, skipping: %s", filename)
				continue
			}
			return fmt.Errorf("failed to download %s: %w", filename, err)
		}
	}

	// Финальный прогресс
	if onProgress != nil {
		onProgress(100)
	}

	log.Printf("HuggingFace model downloaded successfully: %s", repo)
	return nil
}

// getHuggingFaceFiles получает список файлов модели через HuggingFace API
func getHuggingFaceFiles(ctx context.Context, repo string) ([]string, error) {
	apiURL := fmt.Sprintf("https://huggingface.co/api/models/%s", repo)

	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return nil, err
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned status %d", resp.StatusCode)
	}

	// Простой парсинг JSON для получения списка файлов
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// Ищем siblings в JSON (список файлов)
	// Формат: "siblings":[{"rfilename":"config.json"},{"rfilename":"model.bin"}...]
	var files []string
	bodyStr := string(body)

	// Простой парсинг без полного JSON unmarshal
	siblingsStart := indexOf(bodyStr, `"siblings":[`)
	if siblingsStart == -1 {
		return nil, fmt.Errorf("siblings not found in API response")
	}

	// Ищем все rfilename
	searchStr := bodyStr[siblingsStart:]
	for {
		rfnStart := indexOf(searchStr, `"rfilename":"`)
		if rfnStart == -1 {
			break
		}
		rfnStart += len(`"rfilename":"`)
		rfnEnd := indexOf(searchStr[rfnStart:], `"`)
		if rfnEnd == -1 {
			break
		}
		filename := searchStr[rfnStart : rfnStart+rfnEnd]
		files = append(files, filename)
		searchStr = searchStr[rfnStart+rfnEnd:]
	}

	return files, nil
}

func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
