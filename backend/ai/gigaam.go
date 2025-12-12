// Package ai предоставляет GigaAM движок транскрипции
package ai

import (
	"bufio"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"sync"

	ort "github.com/yalue/onnxruntime_go"
)

// Константы GigaAM (общие для всех версий)
const (
	gigaamSampleRate = 16000 // GigaAM ожидает 16kHz
	gigaamNMels      = 64    // Количество mel-фильтров
	gigaamHopLength  = 160   // sample_rate // 100 (10ms)
)

// Константы препроцессора для разных версий моделей
// v2: win_length=400, n_fft=400
// v3: win_length=320, n_fft=320
const (
	gigaamV2WinLength = 400 // v2: sample_rate / 40 (25ms)
	gigaamV2NFFT      = 400 // v2: размер FFT

	gigaamV3WinLength = 320 // v3: sample_rate / 50 (20ms)
	gigaamV3NFFT      = 320 // v3: размер FFT
)

// Константы для эвристик CTC декодера
const (
	// Порог падения confidence для определения границы слова
	// Если confidence падает больше чем на этот порог, вероятна граница слова
	confidenceDropThreshold = 0.4

	// Минимальное количество blank токенов подряд для определения паузы
	// GigaAM выдаёт ~25 фреймов/сек, 2 blank = ~80ms пауза
	minBlankSequenceForPause = 2

	// Минимальная длина слова (символов) для применения эвристик разбиения
	minWordLengthForSplit = 6
)

// CoreML флаги (из coreml_provider_factory.h)
const (
	coremlFlagUseNone                    uint32 = 0x000 // Использовать все доступные устройства
	coremlFlagUseCPUOnly                 uint32 = 0x001 // Только CPU
	coremlFlagEnableOnSubgraph           uint32 = 0x002 // Включить для подграфов
	coremlFlagOnlyEnableDeviceWithANE    uint32 = 0x004 // Только устройства с Neural Engine
	coremlFlagOnlyAllowStaticInputShapes uint32 = 0x008 // Требовать статические формы
	coremlFlagCreateMLProgram            uint32 = 0x010 // Использовать MLProgram (macOS 12+)
	coremlFlagUseCPUAndGPU               uint32 = 0x020 // CPU + GPU (без Neural Engine)
)

// GigaAMModelType тип модели GigaAM
type GigaAMModelType string

const (
	GigaAMModelTypeCTC GigaAMModelType = "ctc" // Character-level CTC (34 токена)
	GigaAMModelTypeE2E GigaAMModelType = "e2e" // End-to-end BPE (257 токенов, с пунктуацией)
)

// GigaAMEngine движок распознавания речи на основе GigaAM (ONNX)
// Оптимизирован для русского языка
type GigaAMEngine struct {
	session      *ort.DynamicAdvancedSession
	modelPath    string
	vocabPath    string
	vocab        []string
	blankID      int
	spaceID      int             // ID токена ▁ (пробел/начало слова)
	modelType    GigaAMModelType // Тип модели: CTC или E2E
	melProcessor *MelProcessor
	mu           sync.Mutex
	initialized  bool
	useCoreML    bool   // Использует ли CoreML для GPU ускорения
	computeUnits string // Какие устройства используются (CPU, GPU, ANE)
}

// Проверяем что GigaAMEngine реализует TranscriptionEngine
var _ TranscriptionEngine = (*GigaAMEngine)(nil)

// NewGigaAMEngine создаёт новый GigaAM движок
// modelPath - путь к ONNX модели (v2_ctc.int8.onnx)
// vocabPath - путь к словарю (v2_vocab.txt)
//
// Примечание: CoreML отключён по умолчанию для INT8 моделей, т.к. CPU быстрее.
// CoreML не оптимизирован для INT8 квантизации и добавляет overhead конвертации.
// Для FP16/FP32 моделей CoreML может дать ускорение.
func NewGigaAMEngine(modelPath, vocabPath string) (*GigaAMEngine, error) {
	// Проверяем, является ли модель INT8 (по имени файла)
	isInt8 := strings.Contains(strings.ToLower(modelPath), "int8")

	// Для INT8 моделей CPU быстрее чем CoreML
	useCoreML := !isInt8

	return NewGigaAMEngineWithOptions(modelPath, vocabPath, useCoreML)
}

// NewGigaAMEngineWithOptions создаёт GigaAM движок с настройками
// useCoreML - использовать CoreML для GPU ускорения (только macOS)
func NewGigaAMEngineWithOptions(modelPath, vocabPath string, useCoreML bool) (*GigaAMEngine, error) {
	// Проверяем существование файлов
	if _, err := os.Stat(modelPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("model file not found: %s", modelPath)
	}
	if _, err := os.Stat(vocabPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("vocab file not found: %s", vocabPath)
	}

	engine := &GigaAMEngine{
		modelPath: modelPath,
		vocabPath: vocabPath,
	}

	// Загружаем словарь
	vocab, blankID, spaceID, err := loadGigaAMVocab(vocabPath)
	if err != nil {
		return nil, fmt.Errorf("failed to load vocabulary: %w", err)
	}
	engine.vocab = vocab
	engine.blankID = blankID
	engine.spaceID = spaceID

	// Определяем версию и тип модели по имени файла
	// v3 использует win_length=320, n_fft=320
	// v2 и v1 используют win_length=400, n_fft=400
	// E2E модели имеют "e2e" в имени и используют BPE токенизацию
	modelPathLower := strings.ToLower(modelPath)
	isV3 := strings.Contains(modelPathLower, "v3")
	isE2E := strings.Contains(modelPathLower, "e2e")

	// Определяем тип модели
	if isE2E {
		engine.modelType = GigaAMModelTypeE2E
		log.Printf("GigaAM: detected E2E model (BPE tokenization, with punctuation)")
	} else {
		engine.modelType = GigaAMModelTypeCTC
		log.Printf("GigaAM: detected CTC model (character-level)")
	}

	var winLength, nFFT int
	var center bool
	if isV3 {
		winLength = gigaamV3WinLength
		nFFT = gigaamV3NFFT
		center = false // v3: center=false в yaml конфиге
		log.Printf("GigaAM: detected v3 model, using win_length=%d, n_fft=%d, center=%v", winLength, nFFT, center)
	} else {
		winLength = gigaamV2WinLength
		nFFT = gigaamV2NFFT
		center = true // v2/v1: librosa default center=true
		log.Printf("GigaAM: detected v2/v1 model, using win_length=%d, n_fft=%d, center=%v", winLength, nFFT, center)
	}

	// Инициализируем MelProcessor с параметрами для конкретной версии
	melConfig := MelConfig{
		SampleRate: gigaamSampleRate,
		NMels:      gigaamNMels,
		HopLength:  gigaamHopLength,
		WinLength:  winLength,
		NFFT:       nFFT,
		Center:     center,
	}
	engine.melProcessor = NewMelProcessor(melConfig)

	// Инициализируем ONNX Runtime (если ещё не инициализирован)
	if err := initONNXRuntime(); err != nil {
		return nil, fmt.Errorf("failed to initialize ONNX Runtime: %w", err)
	}

	// Получаем имена входов/выходов модели
	inputInfo, outputInfo, err := ort.GetInputOutputInfo(modelPath)
	if err != nil {
		return nil, fmt.Errorf("failed to get model info: %w", err)
	}

	inputNames := make([]string, len(inputInfo))
	for i, info := range inputInfo {
		inputNames[i] = info.Name
	}
	outputNames := make([]string, len(outputInfo))
	for i, info := range outputInfo {
		outputNames[i] = info.Name
	}

	log.Printf("GigaAM model inputs: %v, outputs: %v", inputNames, outputNames)

	// Создаём SessionOptions для настройки Execution Provider
	options, err := ort.NewSessionOptions()
	if err != nil {
		return nil, fmt.Errorf("failed to create session options: %w", err)
	}
	defer options.Destroy()

	// Пробуем включить CoreML на macOS для GPU ускорения
	coreMLEnabled := false
	computeUnits := "CPU"

	if useCoreML {
		// Флаг 0 = использовать все доступные устройства (CPU + GPU + Neural Engine)
		// Это даёт максимальную производительность на Apple Silicon
		if err := options.AppendExecutionProviderCoreML(coremlFlagUseNone); err != nil {
			// CoreML не доступен - это нормально, продолжаем с CPU
			log.Printf("CoreML not available, using CPU: %v", err)
		} else {
			coreMLEnabled = true
			computeUnits = "CoreML (CPU+GPU+ANE)"
			log.Println("✓ CoreML Execution Provider enabled for GigaAM (GPU acceleration)")
		}
	}

	// Создаём ONNX сессию с опциями
	session, err := ort.NewDynamicAdvancedSession(
		modelPath,
		inputNames,
		outputNames,
		options,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create ONNX session: %w", err)
	}
	engine.session = session
	engine.initialized = true
	engine.useCoreML = coreMLEnabled
	engine.computeUnits = computeUnits

	log.Printf("GigaAM engine initialized: vocab=%d tokens, blank_id=%d, space_id=%d, compute=%s",
		len(vocab), blankID, spaceID, computeUnits)
	return engine, nil
}

// ONNX Runtime глобальная инициализация
var (
	onnxInitialized bool
	onnxInitMu      sync.Mutex
)

func initONNXRuntime() error {
	onnxInitMu.Lock()
	defer onnxInitMu.Unlock()

	if onnxInitialized {
		return nil
	}

	// Проверяем переменную окружения для пути к библиотеке
	libPath := os.Getenv("ONNXRUNTIME_SHARED_LIBRARY_PATH")

	// Если не задана переменная окружения, ищем в стандартных местах
	if libPath == "" {
		// Пути для поиска ONNX Runtime
		searchPaths := []string{
			// В Resources директории приложения (для .app bundle)
			"../Resources/libonnxruntime.1.22.0.dylib",
			"../Resources/libonnxruntime.dylib",
			// Рядом с исполняемым файлом
			"./libonnxruntime.1.22.0.dylib",
			"./libonnxruntime.dylib",
			// В spike директории (для разработки)
			"./cmd/spike_gigaam/onnxruntime-osx-arm64-1.22.0/lib/libonnxruntime.1.22.0.dylib",
		}

		for _, path := range searchPaths {
			if _, err := os.Stat(path); err == nil {
				libPath = path
				break
			}
		}
	}

	if libPath != "" {
		log.Printf("Using ONNX Runtime library: %s", libPath)
		ort.SetSharedLibraryPath(libPath)
	} else {
		log.Println("ONNX Runtime library not found, GigaAM will not be available")
		return fmt.Errorf("ONNX Runtime library not found")
	}

	if err := ort.InitializeEnvironment(); err != nil {
		return err
	}

	onnxInitialized = true
	log.Println("ONNX Runtime initialized successfully")
	return nil
}

// Name возвращает имя движка
func (e *GigaAMEngine) Name() string {
	return "gigaam"
}

// ComputeUnits возвращает информацию об используемых вычислительных устройствах
func (e *GigaAMEngine) ComputeUnits() string {
	return e.computeUnits
}

// UsesCoreML возвращает true если используется CoreML для GPU ускорения
func (e *GigaAMEngine) UsesCoreML() bool {
	return e.useCoreML
}

// SupportedLanguages возвращает список поддерживаемых языков
func (e *GigaAMEngine) SupportedLanguages() []string {
	return []string{"ru"} // GigaAM оптимизирован только для русского
}

// Transcribe транскрибирует аудио и возвращает текст
func (e *GigaAMEngine) Transcribe(samples []float32, useContext bool) (string, error) {
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
func (e *GigaAMEngine) TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.initialized {
		return nil, fmt.Errorf("GigaAM engine not initialized")
	}

	// Проверяем минимальную длину аудио
	if len(samples) < gigaamSampleRate/10 { // минимум 0.1 секунды
		return nil, nil
	}

	// Вычисляем mel-спектрограмму
	melSpec, numFrames := e.computeLogMelSpectrogram(samples)

	// Создаём входные тензоры
	batchSize := int64(1)

	// Flatten mel-spectrogram для тензора [batch, n_mels, time]
	flatMel := make([]float32, gigaamNMels*numFrames)
	for i := 0; i < gigaamNMels; i++ {
		for j := 0; j < numFrames; j++ {
			flatMel[i*numFrames+j] = melSpec[j][i]
		}
	}

	inputShape := ort.NewShape(batchSize, int64(gigaamNMels), int64(numFrames))
	inputTensor, err := ort.NewTensor(inputShape, flatMel)
	if err != nil {
		return nil, fmt.Errorf("failed to create input tensor: %w", err)
	}
	defer inputTensor.Destroy()

	lengthData := []int64{int64(numFrames)}
	lengthShape := ort.NewShape(batchSize)
	lengthTensor, err := ort.NewTensor(lengthShape, lengthData)
	if err != nil {
		return nil, fmt.Errorf("failed to create length tensor: %w", err)
	}
	defer lengthTensor.Destroy()

	// Запускаем инференс
	outputs := []ort.Value{nil}
	err = e.session.Run([]ort.Value{inputTensor, lengthTensor}, outputs)
	if err != nil {
		return nil, fmt.Errorf("failed to run inference: %w", err)
	}
	defer func() {
		for _, out := range outputs {
			if out != nil {
				out.Destroy()
			}
		}
	}()

	// Получаем выходные данные
	outputTensor := outputs[0].(*ort.Tensor[float32])
	outputShape := outputTensor.GetShape()
	outputData := outputTensor.GetData()

	// Преобразуем плоский массив в 2D [time, vocab]
	timeSteps := int(outputShape[1])
	vocabSize := int(outputShape[2])

	logits := make([][]float32, timeSteps)
	for t := 0; t < timeSteps; t++ {
		logits[t] = outputData[t*vocabSize : (t+1)*vocabSize]
	}

	// Декодирование зависит от типа модели
	var segments []TranscriptSegment
	audioDuration := float64(len(samples)) / gigaamSampleRate

	if e.modelType == GigaAMModelTypeE2E {
		// E2E модель: BPE токены, конкатенация + замена ▁ на пробел
		segments = e.decodeE2EWithTimestamps(logits, audioDuration)
	} else {
		// CTC модель: посимвольное декодирование
		segments = e.decodeCTCWithTimestamps(logits, audioDuration)
	}

	return segments, nil
}

// TranscribeHighQuality выполняет высококачественную транскрипцию
// Для GigaAM это то же самое что TranscribeWithSegments
func (e *GigaAMEngine) TranscribeHighQuality(samples []float32) ([]TranscriptSegment, error) {
	return e.TranscribeWithSegments(samples)
}

// SetLanguage устанавливает язык (игнорируется для GigaAM - только русский)
func (e *GigaAMEngine) SetLanguage(lang string) {
	// GigaAM поддерживает только русский язык
	if lang != "ru" && lang != "auto" {
		log.Printf("GigaAM: language %q not supported, using Russian", lang)
	}
}

// SetModel переключает модель
func (e *GigaAMEngine) SetModel(path string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if path == e.modelPath {
		return nil
	}

	// Закрываем текущую сессию
	if e.session != nil {
		e.session.Destroy()
		e.session = nil
	}

	// Получаем имена входов/выходов
	inputInfo, outputInfo, err := ort.GetInputOutputInfo(path)
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

	// Создаём новую сессию
	session, err := ort.NewDynamicAdvancedSession(path, inputNames, outputNames, nil)
	if err != nil {
		return fmt.Errorf("failed to create ONNX session: %w", err)
	}

	e.session = session
	e.modelPath = path
	return nil
}

// Close освобождает ресурсы
func (e *GigaAMEngine) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.session != nil {
		e.session.Destroy()
		e.session = nil
	}
	e.initialized = false
}

// computeLogMelSpectrogram вычисляет log-mel спектрограмму
func (e *GigaAMEngine) computeLogMelSpectrogram(samples []float32) ([][]float32, int) {
	return e.melProcessor.Compute(samples)
}

// decodeCTCWithTimestamps выполняет CTC декодирование с timestamps
// Для character-based словаря v3_ctc: ▁ = пробел, остальные = буквы
// Включает эвристики для улучшения определения границ слов:
// - Детекция паузы по последовательности blank токенов
// - Детекция границы по резкому падению confidence
func (e *GigaAMEngine) decodeCTCWithTimestamps(logits [][]float32, audioDuration float64) []TranscriptSegment {
	if len(logits) == 0 {
		return nil
	}

	// GigaAM использует subsampling factor 4
	// Каждый output frame соответствует ~40ms аудио
	frameMs := audioDuration * 1000 / float64(len(logits))

	var segments []TranscriptSegment
	var currentWord strings.Builder
	var currentWords []TranscriptWord
	var wordStart int64 = -1
	var lastConfidence float32 = 0.9
	var prevConfidence float32 = 0.9
	prevToken := e.blankID
	blankCount := 0 // Счётчик последовательных blank токенов

	for t, frame := range logits {
		// Находим токен с максимальной вероятностью
		maxIdx := 0
		maxVal := frame[0]
		for i, v := range frame {
			if v > maxVal {
				maxVal = v
				maxIdx = i
			}
		}

		frameTime := int64(float64(t) * frameMs)
		currentConfidence := softmaxMax(frame)

		// Эвристика 1: Детекция паузы по blank sequence
		// ОТКЛЮЧЕНА: ломает слова, т.к. модель часто выдаёт blank между буквами
		// Используем только токен пробела для разделения слов
		if maxIdx == e.blankID {
			blankCount++
		} else {
			blankCount = 0
		}
		_ = blankCount // suppress unused warning

		// Эвристика 2: Детекция границы по падению confidence
		// ОТКЛЮЧЕНА: ломает слова, т.к. confidence может падать внутри слова
		// confidenceDrop := prevConfidence - currentConfidence
		// if confidenceDrop > confidenceDropThreshold && currentWord.Len() >= minWordLengthForSplit && wordStart >= 0 {
		// 	word := TranscriptWord{
		// 		Start: wordStart,
		// 		End:   frameTime,
		// 		Text:  currentWord.String(),
		// 		P:     lastConfidence,
		// 	}
		// 	currentWords = append(currentWords, word)
		// 	currentWord.Reset()
		// 	wordStart = frameTime
		// }
		_ = prevConfidence // suppress unused warning

		// CTC правило: пропускаем blank и повторяющиеся токены
		if maxIdx != e.blankID && maxIdx != prevToken {
			if maxIdx < len(e.vocab) {
				token := e.vocab[maxIdx]
				lastConfidence = currentConfidence

				// ▁ = пробел = начало нового слова
				if maxIdx == e.spaceID {
					// Сохраняем предыдущее слово если есть
					if currentWord.Len() > 0 && wordStart >= 0 {
						word := TranscriptWord{
							Start: wordStart,
							End:   frameTime,
							Text:  currentWord.String(),
							P:     lastConfidence,
						}
						currentWords = append(currentWords, word)
						currentWord.Reset()
					}
					wordStart = frameTime
				} else {
					// Обычный символ - добавляем к текущему слову
					if wordStart < 0 {
						wordStart = frameTime
					}
					currentWord.WriteString(token)
				}
			}
		}
		prevToken = maxIdx
		prevConfidence = currentConfidence
	}

	// Добавляем последнее слово
	if currentWord.Len() > 0 && wordStart >= 0 {
		word := TranscriptWord{
			Start: wordStart,
			End:   int64(audioDuration * 1000),
			Text:  currentWord.String(),
			P:     lastConfidence,
		}
		currentWords = append(currentWords, word)
	}

	// Формируем сегмент из всех слов
	if len(currentWords) > 0 {
		var fullText strings.Builder
		for i, w := range currentWords {
			if i > 0 {
				fullText.WriteString(" ")
			}
			fullText.WriteString(w.Text)
		}

		segment := TranscriptSegment{
			Start: currentWords[0].Start,
			End:   currentWords[len(currentWords)-1].End,
			Text:  fullText.String(),
			Words: currentWords,
		}
		segments = append(segments, segment)
	}

	return segments
}

// decodeE2EWithTimestamps выполняет CTC декодирование для E2E модели
// E2E модель использует BPE токенизацию:
// - токены могут быть subwords: "пр", "овер", "ка"
// - ▁ означает начало нового слова (пробел перед токеном)
// - пунктуация: ".", ",", "!" и т.д.
// Возвращает сегменты со словами и их confidence для гибридной транскрипции
func (e *GigaAMEngine) decodeE2EWithTimestamps(logits [][]float32, audioDuration float64) []TranscriptSegment {
	if len(logits) == 0 {
		return nil
	}

	frameMs := audioDuration * 1000 / float64(len(logits))

	var segments []TranscriptSegment
	var currentTokens []bpeTokenInfo
	var currentWords []TranscriptWord
	prevToken := e.blankID

	for t, frame := range logits {
		// Находим токен с максимальной вероятностью
		maxIdx := 0
		maxVal := frame[0]
		for i, v := range frame {
			if v > maxVal {
				maxVal = v
				maxIdx = i
			}
		}

		frameTime := int64(float64(t) * frameMs)
		currentConfidence := softmaxMax(frame)

		// CTC правило: пропускаем blank и повторяющиеся токены
		if maxIdx != e.blankID && maxIdx != prevToken {
			if maxIdx < len(e.vocab) {
				token := e.vocab[maxIdx]

				// Пропускаем <unk>
				if token != "<unk>" {
					// ▁ означает начало нового слова
					if strings.HasPrefix(token, "▁") {
						// Сохраняем предыдущее слово если есть токены
						if len(currentTokens) > 0 {
							word := e.mergeTokensToWord(currentTokens)
							if word.Text != "" {
								currentWords = append(currentWords, word)
							}
							currentTokens = nil
						}
						// Убираем ▁ из токена
						token = strings.TrimPrefix(token, "▁")
					}

					// Добавляем токен (если не пустой после удаления ▁)
					if token != "" {
						currentTokens = append(currentTokens, bpeTokenInfo{
							text:       token,
							startTime:  frameTime,
							endTime:    frameTime,
							confidence: currentConfidence,
						})
					}
				}
			}
		}
		prevToken = maxIdx
	}

	// Добавляем последнее слово
	if len(currentTokens) > 0 {
		word := e.mergeTokensToWord(currentTokens)
		if word.Text != "" {
			currentWords = append(currentWords, word)
		}
	}

	// Формируем сегмент из всех слов
	if len(currentWords) > 0 {
		var fullText strings.Builder
		for i, w := range currentWords {
			if i > 0 {
				fullText.WriteString(" ")
			}
			fullText.WriteString(w.Text)
		}

		segment := TranscriptSegment{
			Start: currentWords[0].Start,
			End:   currentWords[len(currentWords)-1].End,
			Text:  fullText.String(),
			Words: currentWords,
		}
		segments = append(segments, segment)
	}

	return segments
}

// bpeTokenInfo внутренняя структура для накопления информации о BPE токене
type bpeTokenInfo struct {
	text       string
	startTime  int64
	endTime    int64
	confidence float32
}

// mergeTokensToWord объединяет BPE токены в слово с усреднённым confidence
func (e *GigaAMEngine) mergeTokensToWord(tokens []bpeTokenInfo) TranscriptWord {
	if len(tokens) == 0 {
		return TranscriptWord{}
	}

	var text strings.Builder
	var totalConfidence float32
	startTime := tokens[0].startTime
	endTime := tokens[0].endTime

	for _, t := range tokens {
		text.WriteString(t.text)
		totalConfidence += t.confidence
		if t.endTime > endTime {
			endTime = t.endTime
		}
	}

	return TranscriptWord{
		Start: startTime,
		End:   endTime,
		Text:  text.String(),
		P:     totalConfidence / float32(len(tokens)), // Среднее confidence
	}
}

// softmaxMax возвращает максимальную вероятность после softmax
func softmaxMax(logits []float32) float32 {
	maxVal := logits[0]
	for _, v := range logits {
		if v > maxVal {
			maxVal = v
		}
	}

	sum := float32(0)
	maxProb := float32(0)
	for _, v := range logits {
		exp := float32(math.Exp(float64(v - maxVal)))
		sum += exp
		if exp > maxProb {
			maxProb = exp
		}
	}

	return maxProb / sum
}

// loadGigaAMVocab загружает словарь из файла
// Возвращает: vocab, blankID, spaceID, error
func loadGigaAMVocab(path string) ([]string, int, int, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, 0, -1, err
	}
	defer file.Close()

	var vocab []string
	blankID := -1
	spaceID := -1
	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		line := scanner.Text()

		// Формат: "token index" или "token\tindex"
		// Для пробела: " 0" - первый символ пробел, потом пробел-разделитель, потом 0
		// Используем strings.LastIndex чтобы найти последний пробел (разделитель)
		lastSpace := strings.LastIndex(line, " ")
		if lastSpace < 0 {
			lastSpace = strings.LastIndex(line, "\t")
		}

		var token string
		if lastSpace > 0 {
			token = line[:lastSpace]
		} else if lastSpace == 0 {
			// Строка начинается с пробела, значит токен = пробел
			token = " "
		} else {
			// Нет разделителя, весь line - это токен
			token = line
		}

		if token != "" || lastSpace == 0 {
			// lastSpace == 0 означает что токен = пробел (пустая строка до разделителя)
			if lastSpace == 0 {
				token = " "
			}
			vocab = append(vocab, token)

			// Ищем blank токен
			if token == "<blk>" || token == "<blank>" || token == "[blank]" {
				blankID = len(vocab) - 1
			}

			// Ищем space токен (пробел " " или ▁)
			if token == " " || token == "▁" {
				spaceID = len(vocab) - 1
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, 0, -1, err
	}

	// Если blank не найден, предполагаем последний токен
	if blankID == -1 {
		blankID = len(vocab) - 1
	}

	return vocab, blankID, spaceID, nil
}
