package models

import (
	"context"
	"fmt"
	"io"
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
