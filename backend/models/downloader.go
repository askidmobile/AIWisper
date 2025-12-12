package models

import (
	"archive/tar"
	"compress/bzip2"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

// DownloadAndExtractTarBz2 скачивает tar.bz2 архив и распаковывает в указанную директорию
func DownloadAndExtractTarBz2(ctx context.Context, url, destDir string, expectedSize int64, onProgress ProgressFunc) error {
	// Создаём директорию если нужно
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Создаём HTTP запрос с контекстом
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Выполняем запрос
	client := &http.Client{
		Timeout: 0,
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
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

	// Декомпрессия bzip2
	bzReader := bzip2.NewReader(reader)

	// Распаковка tar
	tarReader := tar.NewReader(bzReader)

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("failed to read tar: %w", err)
		}

		// Определяем целевой путь
		targetPath := filepath.Join(destDir, header.Name)

		// Защита от path traversal
		if !strings.HasPrefix(filepath.Clean(targetPath), filepath.Clean(destDir)) {
			return fmt.Errorf("invalid file path in archive: %s", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(targetPath, 0755); err != nil {
				return fmt.Errorf("failed to create directory: %w", err)
			}
		case tar.TypeReg:
			// Создаём директорию для файла
			if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
				return fmt.Errorf("failed to create directory: %w", err)
			}

			// Создаём файл
			outFile, err := os.Create(targetPath)
			if err != nil {
				return fmt.Errorf("failed to create file: %w", err)
			}

			if _, err := io.Copy(outFile, tarReader); err != nil {
				outFile.Close()
				return fmt.Errorf("failed to write file: %w", err)
			}
			outFile.Close()
		}
	}

	return nil
}

// FindOnnxModelInDir ищет .onnx файл в директории (рекурсивно)
func FindOnnxModelInDir(dir string) (string, error) {
	var modelPath string

	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && strings.HasSuffix(strings.ToLower(info.Name()), ".onnx") {
			modelPath = path
			return filepath.SkipAll // Нашли первый .onnx файл
		}
		return nil
	})

	if err != nil && err != filepath.SkipAll {
		return "", err
	}

	if modelPath == "" {
		return "", fmt.Errorf("no .onnx file found in %s", dir)
	}

	return modelPath, nil
}

// DownloadRNNTModel скачивает все 3 файла RNNT модели (encoder, decoder, joint)
// Возвращает путь к encoder файлу (decoder и joint будут рядом)
func DownloadRNNTModel(ctx context.Context, model ModelInfo, destDir string, onProgress ProgressFunc) (string, error) {
	if !model.IsRNNT {
		return "", fmt.Errorf("model %s is not RNNT type", model.ID)
	}

	// Создаём директорию
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create directory: %w", err)
	}

	// Определяем имена файлов
	encoderName := filepath.Base(model.DownloadURL)
	decoderName := filepath.Base(model.DecoderURL)
	jointName := filepath.Base(model.JointURL)

	encoderPath := filepath.Join(destDir, encoderName)
	decoderPath := filepath.Join(destDir, decoderName)
	jointPath := filepath.Join(destDir, jointName)

	// Общий размер для прогресса (примерно: encoder ~225MB, decoder ~1MB, joint ~0.5MB)
	totalSize := model.SizeBytes
	downloadedSize := int64(0)

	// Обёртка для прогресса с учётом всех файлов
	wrapProgress := func(fileSize int64) ProgressFunc {
		return func(progress float64) {
			if onProgress != nil {
				// Вычисляем общий прогресс
				fileProgress := float64(fileSize) * progress / 100
				totalProgress := (float64(downloadedSize) + fileProgress) / float64(totalSize) * 100
				onProgress(totalProgress)
			}
		}
	}

	// Скачиваем encoder (основной файл, ~99% размера)
	encoderSize := int64(float64(totalSize) * 0.99)
	if err := DownloadFile(ctx, model.DownloadURL, encoderPath, encoderSize, wrapProgress(encoderSize)); err != nil {
		return "", fmt.Errorf("failed to download encoder: %w", err)
	}
	downloadedSize += encoderSize

	// Скачиваем decoder (~0.5% размера)
	decoderSize := int64(float64(totalSize) * 0.005)
	if err := DownloadFile(ctx, model.DecoderURL, decoderPath, decoderSize, wrapProgress(decoderSize)); err != nil {
		// Удаляем encoder если decoder не скачался
		os.Remove(encoderPath)
		return "", fmt.Errorf("failed to download decoder: %w", err)
	}
	downloadedSize += decoderSize

	// Скачиваем joint (~0.5% размера)
	jointSize := int64(float64(totalSize) * 0.005)
	if err := DownloadFile(ctx, model.JointURL, jointPath, jointSize, wrapProgress(jointSize)); err != nil {
		// Удаляем encoder и decoder если joint не скачался
		os.Remove(encoderPath)
		os.Remove(decoderPath)
		return "", fmt.Errorf("failed to download joint: %w", err)
	}

	// Финальный прогресс
	if onProgress != nil {
		onProgress(100)
	}

	return encoderPath, nil
}

// IsRNNTModelComplete проверяет, что все 3 файла RNNT модели скачаны
func IsRNNTModelComplete(encoderPath string) bool {
	// Вычисляем пути к decoder и joint
	dir := filepath.Dir(encoderPath)
	base := filepath.Base(encoderPath)

	var decoderPath, jointPath string
	if strings.Contains(base, ".int8.") {
		decoderPath = filepath.Join(dir, strings.Replace(base, "_encoder.int8.", "_decoder.int8.", 1))
		jointPath = filepath.Join(dir, strings.Replace(base, "_encoder.int8.", "_joint.int8.", 1))
	} else {
		decoderPath = filepath.Join(dir, strings.Replace(base, "_encoder.", "_decoder.", 1))
		jointPath = filepath.Join(dir, strings.Replace(base, "_encoder.", "_joint.", 1))
	}

	// Проверяем существование всех файлов
	for _, path := range []string{encoderPath, decoderPath, jointPath} {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return false
		}
	}

	return true
}
