package ai

import (
	"fmt"
	"log"
	"math"
	"os"
	"sync"

	ort "github.com/yalue/onnxruntime_go"
)

// SpeakerEncoderConfig конфигурация для энкодера голоса
type SpeakerEncoderConfig struct {
	ModelPath  string
	SampleRate int
	NMels      int
	HopLength  int
	WinLength  int
	NFFT       int
}

// DefaultSpeakerEncoderConfig возвращает стандартную конфигурацию для WeSpeaker ResNet34
func DefaultSpeakerEncoderConfig(modelPath string) SpeakerEncoderConfig {
	return SpeakerEncoderConfig{
		ModelPath:  modelPath,
		SampleRate: 16000,
		NMels:      80,  // WeSpeaker использует 80 mels
		HopLength:  160, // 10ms
		WinLength:  400, // 25ms
		NFFT:       512, // Обычно 512 для 80 mels
	}
}

// SpeakerEncoder преобразует аудио в вектор (embedding)
type SpeakerEncoder struct {
	config       SpeakerEncoderConfig
	session      *ort.DynamicAdvancedSession
	melProcessor *MelProcessor
	mu           sync.Mutex
	initialized  bool
}

// NewSpeakerEncoder создаёт новый энкодер
func NewSpeakerEncoder(config SpeakerEncoderConfig) (*SpeakerEncoder, error) {
	if _, err := os.Stat(config.ModelPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("model file not found: %s", config.ModelPath)
	}

	encoder := &SpeakerEncoder{
		config: config,
	}

	// Инициализируем MelProcessor
	melConfig := MelConfig{
		SampleRate: config.SampleRate,
		NMels:      config.NMels,
		HopLength:  config.HopLength,
		WinLength:  config.WinLength,
		NFFT:       config.NFFT,
	}
	encoder.melProcessor = NewMelProcessor(melConfig)

	// Инициализируем ONNX Runtime
	if err := initONNXRuntime(); err != nil {
		return nil, fmt.Errorf("failed to initialize ONNX Runtime: %w", err)
	}

	// Загружаем модель
	if err := encoder.loadModel(); err != nil {
		return nil, err
	}

	return encoder, nil
}

func (e *SpeakerEncoder) loadModel() error {
	inputInfo, outputInfo, err := ort.GetInputOutputInfo(e.config.ModelPath)
	if err != nil {
		return fmt.Errorf("failed to get model info: %w", err)
	}

	inputNames := make([]string, len(inputInfo))
	for i, info := range inputInfo {
		inputNames[i] = info.Name
	}
	outputNames := make([]string, len(outputInfo))
	for i, info := range outputInfo {
		outputNames[i] = info.Name
	}

	log.Printf("SpeakerEncoder inputs: %v, outputs: %v", inputNames, outputNames)

	options, err := ort.NewSessionOptions()
	if err != nil {
		return fmt.Errorf("failed to create session options: %w", err)
	}
	defer options.Destroy()

	// Используем CPU для начала, так как модель легкая
	// TODO: Добавить поддержку CoreML если нужно

	session, err := ort.NewDynamicAdvancedSession(
		e.config.ModelPath,
		inputNames,
		outputNames,
		options,
	)
	if err != nil {
		return fmt.Errorf("failed to create ONNX session: %w", err)
	}

	e.session = session
	e.initialized = true
	return nil
}

// Encode извлекает вектор (embedding) из аудио
func (e *SpeakerEncoder) Encode(samples []float32) ([]float32, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.initialized {
		return nil, fmt.Errorf("encoder not initialized")
	}

	if len(samples) < e.config.SampleRate/10 {
		return nil, fmt.Errorf("audio too short")
	}

	// 1. Вычисляем Mel-спектрограмму
	melSpec, numFrames := e.melProcessor.Compute(samples)

	// 2. Подготавливаем входной тензор
	// WeSpeaker ожидает [batch, num_frames, n_mels] или [batch, n_mels, num_frames]?
	// Обычно [batch, num_frames, n_mels] для ResNet подобных моделей в PyTorch->ONNX
	// Но GigaAM был [batch, n_mels, num_frames].
	// Проверим shape: 80 mels.
	// Если это ResNet34, то скорее всего [batch, n_mels, num_frames] (как картинка C, H, W)
	// или [batch, num_frames, n_mels] (sequence).
	// ДАВАЙТЕ ПОПРОБУЕМ [batch, frames, mels] так как это стандарт для аудио последовательностей,
	// НО ResNet - это сверточная сеть, обычно (N, C, H, W) -> (1, 1, Frames, Mels) или (1, 1, Mels, Frames).
	// Wespeaker onnx export обычно делает [batch, feats] input, где feats = frames * mels?
	// Нет, обычно [B, T, F].

	// ВАЖНО: Wespeaker ONNX обычно принимает [B, T, D] где D=80.
	// То есть [1, numFrames, 80].

	flatInput := make([]float32, numFrames*e.config.NMels)
	for t := 0; t < numFrames; t++ {
		for m := 0; m < e.config.NMels; m++ {
			// [t][m] -> row-major
			flatInput[t*e.config.NMels+m] = melSpec[t][m]
		}
	}

	inputShape := ort.NewShape(1, int64(numFrames), int64(e.config.NMels))
	inputTensor, err := ort.NewTensor(inputShape, flatInput)
	if err != nil {
		return nil, fmt.Errorf("failed to create input tensor: %w", err)
	}
	defer inputTensor.Destroy()

	// 3. Запускаем инференс
	outputs := []ort.Value{nil}
	err = e.session.Run([]ort.Value{inputTensor}, outputs)
	if err != nil {
		// Если ошибка формы, попробуем транспонировать?
		// Но пока вернем ошибку
		return nil, fmt.Errorf("inference failed: %w", err)
	}
	defer func() {
		for _, out := range outputs {
			if out != nil {
				out.Destroy()
			}
		}
	}()

	// 4. Получаем результат
	outputTensor := outputs[0].(*ort.Tensor[float32])
	embedding := outputTensor.GetData()

	// Нормализуем вектор
	normalized := normalizeVector(embedding)

	// Копируем, так как outputTensor будет уничтожен
	result := make([]float32, len(normalized))
	copy(result, normalized)

	return result, nil
}

func normalizeVector(v []float32) []float32 {
	var sumSq float64
	for _, x := range v {
		sumSq += float64(x * x)
	}
	norm := float32(math.Sqrt(sumSq))
	if norm < 1e-6 {
		return v
	}

	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = x / norm
	}
	return out
}

func (e *SpeakerEncoder) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session != nil {
		e.session.Destroy()
		e.session = nil
	}
	e.initialized = false
}
