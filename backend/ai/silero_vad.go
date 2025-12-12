// Package ai предоставляет Silero VAD движок для определения голосовой активности
package ai

import (
	"fmt"
	"log"
	"os"
	"sync"

	ort "github.com/yalue/onnxruntime_go"
)

// SileroVADConfig конфигурация Silero VAD
type SileroVADConfig struct {
	ModelPath            string  // Путь к ONNX модели
	SampleRate           int     // Частота дискретизации (8000 или 16000)
	Threshold            float32 // Порог вероятности речи (0.0 - 1.0)
	MinSilenceDurationMs int     // Минимальная длительность тишины для разделения (мс)
	SpeechPadMs          int     // Padding вокруг речи (мс)
	MinSpeechDurationMs  int     // Минимальная длительность речи (мс)
}

// DefaultSileroVADConfig возвращает конфигурацию по умолчанию
func DefaultSileroVADConfig() SileroVADConfig {
	return SileroVADConfig{
		SampleRate:           16000,
		Threshold:            0.5,
		MinSilenceDurationMs: 100,
		SpeechPadMs:          30,
		MinSpeechDurationMs:  250,
	}
}

// SileroVAD движок определения голосовой активности на основе Silero VAD
type SileroVAD struct {
	session *ort.DynamicAdvancedSession
	config  SileroVADConfig

	// LSTM состояние (сохраняется между вызовами для streaming)
	state []float32

	// Контекст - последние N сэмплов предыдущего чанка
	// 64 сэмпла для 16kHz, 32 для 8kHz
	context []float32

	mu          sync.Mutex
	initialized bool
}

// SileroVADSegment сегмент речи
type SileroVADSegment struct {
	StartMs int64   // Начало речи в миллисекундах
	EndMs   int64   // Конец речи в миллисекундах
	AvgProb float32 // Средняя вероятность речи
}

// NewSileroVAD создаёт новый Silero VAD движок
func NewSileroVAD(config SileroVADConfig) (*SileroVAD, error) {
	// Проверяем существование файла модели
	if _, err := os.Stat(config.ModelPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("model file not found: %s", config.ModelPath)
	}

	// Проверяем sample rate
	if config.SampleRate != 8000 && config.SampleRate != 16000 {
		return nil, fmt.Errorf("sample rate must be 8000 or 16000, got %d", config.SampleRate)
	}

	// Инициализируем ONNX Runtime
	if err := initONNXRuntime(); err != nil {
		return nil, fmt.Errorf("failed to initialize ONNX Runtime: %w", err)
	}

	// Создаём SessionOptions
	options, err := ort.NewSessionOptions()
	if err != nil {
		return nil, fmt.Errorf("failed to create session options: %w", err)
	}
	defer options.Destroy()

	// Создаём сессию
	// Silero VAD inputs: input, state, sr
	// Silero VAD outputs: output, stateN
	inputNames := []string{"input", "state", "sr"}
	outputNames := []string{"output", "stateN"}

	session, err := ort.NewDynamicAdvancedSession(
		config.ModelPath,
		inputNames,
		outputNames,
		options,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create ONNX session: %w", err)
	}

	// Размер контекста: 64 для 16kHz, 32 для 8kHz
	contextSize := 64
	if config.SampleRate == 8000 {
		contextSize = 32
	}

	vad := &SileroVAD{
		session:     session,
		config:      config,
		state:       make([]float32, 2*1*128), // [2, 1, 128] - h и c состояния LSTM
		context:     make([]float32, contextSize),
		initialized: true,
	}

	log.Printf("Silero VAD initialized: sample_rate=%d, threshold=%.2f", config.SampleRate, config.Threshold)
	return vad, nil
}

// ResetState сбрасывает LSTM состояние и контекст
func (v *SileroVAD) ResetState() {
	v.mu.Lock()
	defer v.mu.Unlock()
	for i := range v.state {
		v.state[i] = 0
	}
	for i := range v.context {
		v.context[i] = 0
	}
}

// ProcessChunk обрабатывает один чанк аудио и возвращает вероятность речи
// Размер чанка должен быть 512 для 16kHz или 256 для 8kHz
func (v *SileroVAD) ProcessChunk(samples []float32) (float32, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if !v.initialized {
		return 0, fmt.Errorf("Silero VAD not initialized")
	}

	// Размер контекста: 64 для 16kHz, 32 для 8kHz
	contextSize := len(v.context)

	// Создаём входной буфер: context + samples
	// Silero VAD ожидает [batch, context_size + window_size]
	inputData := make([]float32, contextSize+len(samples))
	copy(inputData[:contextSize], v.context)
	copy(inputData[contextSize:], samples)

	// Обновляем контекст для следующего вызова (последние contextSize сэмплов)
	if len(samples) >= contextSize {
		copy(v.context, samples[len(samples)-contextSize:])
	} else {
		// Сдвигаем контекст и добавляем новые сэмплы
		copy(v.context, v.context[len(samples):])
		copy(v.context[contextSize-len(samples):], samples)
	}

	// Создаём входные тензоры
	// input: [batch, context_size + window_size]
	batchSize := int64(1)
	numSamples := int64(len(inputData))

	inputShape := ort.NewShape(batchSize, numSamples)
	inputTensor, err := ort.NewTensor(inputShape, inputData)
	if err != nil {
		return 0, fmt.Errorf("failed to create input tensor: %w", err)
	}
	defer inputTensor.Destroy()

	// state: [2, batch, 128]
	stateShape := ort.NewShape(2, batchSize, 128)
	stateTensor, err := ort.NewTensor(stateShape, v.state)
	if err != nil {
		return 0, fmt.Errorf("failed to create state tensor: %w", err)
	}
	defer stateTensor.Destroy()

	// sr: scalar (int64)
	srData := []int64{int64(v.config.SampleRate)}
	srShape := ort.NewShape(1)
	srTensor, err := ort.NewTensor(srShape, srData)
	if err != nil {
		return 0, fmt.Errorf("failed to create sr tensor: %w", err)
	}
	defer srTensor.Destroy()

	// Запускаем инференс
	outputs := []ort.Value{nil, nil}
	err = v.session.Run([]ort.Value{inputTensor, stateTensor, srTensor}, outputs)
	if err != nil {
		return 0, fmt.Errorf("failed to run inference: %w", err)
	}
	defer func() {
		for _, out := range outputs {
			if out != nil {
				out.Destroy()
			}
		}
	}()

	// Получаем результаты
	outputTensor := outputs[0].(*ort.Tensor[float32])
	outputData := outputTensor.GetData()

	stateNTensor := outputs[1].(*ort.Tensor[float32])
	stateNData := stateNTensor.GetData()

	// Обновляем состояние LSTM
	copy(v.state, stateNData)

	// Возвращаем вероятность речи
	if len(outputData) > 0 {
		return outputData[0], nil
	}
	return 0, nil
}

// DetectSpeechRegions определяет участки речи в аудио
// Возвращает список сегментов с началом и концом каждого участка речи
func (v *SileroVAD) DetectSpeechRegions(samples []float32) ([]SileroVADSegment, error) {
	v.ResetState()

	// Размер окна для обработки
	// Silero VAD работает с окнами 512 сэмплов для 16kHz (32ms)
	// или 256 сэмплов для 8kHz (32ms)
	var windowSize int
	if v.config.SampleRate == 16000 {
		windowSize = 512
	} else {
		windowSize = 256
	}

	windowMs := float64(windowSize) * 1000 / float64(v.config.SampleRate)

	var segments []SileroVADSegment
	var currentSegment *SileroVADSegment
	var probSum float32
	var probCount int

	minSilenceWindows := int(float64(v.config.MinSilenceDurationMs) / windowMs)
	speechPadWindows := int(float64(v.config.SpeechPadMs) / windowMs)
	_ = minSilenceWindows // используется ниже

	silenceCount := 0
	speechCount := 0

	// Обрабатываем аудио окнами
	for i := 0; i < len(samples); i += windowSize {
		end := i + windowSize
		if end > len(samples) {
			// Дополняем нулями если нужно
			chunk := make([]float32, windowSize)
			copy(chunk, samples[i:])
			end = len(samples)
		}

		var chunk []float32
		if end-i == windowSize {
			chunk = samples[i:end]
		} else {
			chunk = make([]float32, windowSize)
			copy(chunk, samples[i:])
		}

		prob, err := v.ProcessChunk(chunk)
		if err != nil {
			return nil, err
		}

		currentMs := int64(float64(i) * 1000 / float64(v.config.SampleRate))
		isSpeech := prob >= v.config.Threshold

		if isSpeech {
			silenceCount = 0
			speechCount++

			if currentSegment == nil && speechCount >= 1 {
				// Начало нового сегмента речи
				startMs := currentMs - int64(speechPadWindows)*int64(windowMs)
				if startMs < 0 {
					startMs = 0
				}
				currentSegment = &SileroVADSegment{
					StartMs: startMs,
				}
				probSum = 0
				probCount = 0
			}

			if currentSegment != nil {
				probSum += prob
				probCount++
			}
		} else {
			speechCount = 0

			if currentSegment != nil {
				silenceCount++

				if silenceCount >= minSilenceWindows {
					// Конец сегмента речи
					endMs := currentMs - int64(silenceCount-speechPadWindows)*int64(windowMs)
					if endMs < currentSegment.StartMs {
						endMs = currentSegment.StartMs + int64(windowMs)
					}
					currentSegment.EndMs = endMs

					if probCount > 0 {
						currentSegment.AvgProb = probSum / float32(probCount)
					}

					// Добавляем только если сегмент достаточно длинный
					durationMs := currentSegment.EndMs - currentSegment.StartMs
					if durationMs >= int64(v.config.MinSpeechDurationMs) {
						segments = append(segments, *currentSegment)
					}

					currentSegment = nil
					silenceCount = 0
				}
			}
		}
	}

	// Закрываем последний сегмент если есть
	if currentSegment != nil {
		totalDurationMs := int64(len(samples)) * 1000 / int64(v.config.SampleRate)
		currentSegment.EndMs = totalDurationMs

		if probCount > 0 {
			currentSegment.AvgProb = probSum / float32(probCount)
		}

		durationMs := currentSegment.EndMs - currentSegment.StartMs
		if durationMs >= int64(v.config.MinSpeechDurationMs) {
			segments = append(segments, *currentSegment)
		}
	}

	log.Printf("Silero VAD: detected %d speech segments", len(segments))
	for i, seg := range segments {
		log.Printf("  segment[%d]: %dms - %dms (duration: %dms, prob: %.2f)",
			i, seg.StartMs, seg.EndMs, seg.EndMs-seg.StartMs, seg.AvgProb)
	}

	return segments, nil
}

// Close освобождает ресурсы
func (v *SileroVAD) Close() {
	v.mu.Lock()
	defer v.mu.Unlock()

	if v.session != nil {
		v.session.Destroy()
		v.session = nil
	}
	v.initialized = false
}
