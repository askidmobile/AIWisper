// Package ai предоставляет GigaAM RNNT движок транскрипции
package ai

import (
	"bufio"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"

	ort "github.com/yalue/onnxruntime_go"
)

// GigaAMRNNTModelType тип RNNT модели
type GigaAMRNNTModelType string

const (
	GigaAMRNNTModelTypeBase GigaAMRNNTModelType = "rnnt"     // Базовая RNNT (без пунктуации)
	GigaAMRNNTModelTypeE2E  GigaAMRNNTModelType = "e2e_rnnt" // E2E RNNT (с пунктуацией)
)

// Константы для RNNT декодера
const (
	maxSymbolsPerStep = 10 // Максимум символов на один временной шаг
)

// GigaAMRNNTEngine движок распознавания речи на основе GigaAM RNNT (ONNX)
// RNNT обеспечивает лучшее качество (WER 8.4%) за счёт авторегрессивного декодирования
type GigaAMRNNTEngine struct {
	encoderSession *ort.DynamicAdvancedSession
	decoderSession *ort.DynamicAdvancedSession
	jointSession   *ort.DynamicAdvancedSession

	encoderPath string
	decoderPath string
	jointPath   string
	vocabPath   string

	vocab        []string
	blankID      int
	spaceID      int
	predHidden   int // Размер hidden state декодера (из yaml конфига)
	modelType    GigaAMRNNTModelType
	melProcessor *MelProcessor

	mu           sync.Mutex
	initialized  bool
	useCoreML    bool
	computeUnits string
}

// Проверяем что GigaAMRNNTEngine реализует TranscriptionEngine
var _ TranscriptionEngine = (*GigaAMRNNTEngine)(nil)

// NewGigaAMRNNTEngine создаёт новый GigaAM RNNT движок
// encoderPath - путь к encoder ONNX модели
// vocabPath - путь к словарю
// Decoder и Joint пути вычисляются автоматически из encoderPath
func NewGigaAMRNNTEngine(encoderPath, vocabPath string) (*GigaAMRNNTEngine, error) {
	// Проверяем, является ли модель INT8 (по имени файла)
	isInt8 := strings.Contains(strings.ToLower(encoderPath), "int8")
	// Для INT8 моделей CPU быстрее чем CoreML
	useCoreML := !isInt8

	return NewGigaAMRNNTEngineWithOptions(encoderPath, vocabPath, useCoreML)
}

// NewGigaAMRNNTEngineWithOptions создаёт GigaAM RNNT движок с настройками
func NewGigaAMRNNTEngineWithOptions(encoderPath, vocabPath string, useCoreML bool) (*GigaAMRNNTEngine, error) {
	// Вычисляем пути к decoder и joint из encoder path
	// v3_rnnt_encoder.int8.onnx -> v3_rnnt_decoder.int8.onnx, v3_rnnt_joint.int8.onnx
	dir := filepath.Dir(encoderPath)
	base := filepath.Base(encoderPath)

	// Определяем суффикс (int8 или обычный)
	var decoderPath, jointPath string
	if strings.Contains(base, ".int8.") {
		decoderPath = filepath.Join(dir, strings.Replace(base, "_encoder.int8.", "_decoder.int8.", 1))
		jointPath = filepath.Join(dir, strings.Replace(base, "_encoder.int8.", "_joint.int8.", 1))
	} else {
		decoderPath = filepath.Join(dir, strings.Replace(base, "_encoder.", "_decoder.", 1))
		jointPath = filepath.Join(dir, strings.Replace(base, "_encoder.", "_joint.", 1))
	}

	// Проверяем существование файлов
	for _, path := range []string{encoderPath, decoderPath, jointPath, vocabPath} {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return nil, fmt.Errorf("file not found: %s", path)
		}
	}

	engine := &GigaAMRNNTEngine{
		encoderPath: encoderPath,
		decoderPath: decoderPath,
		jointPath:   jointPath,
		vocabPath:   vocabPath,
		predHidden:  320, // Значение по умолчанию из yaml конфига GigaAM v3
	}

	// Загружаем словарь
	vocab, blankID, spaceID, err := loadGigaAMVocab(vocabPath)
	if err != nil {
		return nil, fmt.Errorf("failed to load vocabulary: %w", err)
	}
	engine.vocab = vocab
	engine.blankID = blankID
	engine.spaceID = spaceID

	// Определяем тип модели
	pathLower := strings.ToLower(encoderPath)
	if strings.Contains(pathLower, "e2e") {
		engine.modelType = GigaAMRNNTModelTypeE2E
		log.Printf("GigaAM RNNT: detected E2E model (BPE tokenization, with punctuation)")
	} else {
		engine.modelType = GigaAMRNNTModelTypeBase
		log.Printf("GigaAM RNNT: detected base model (character-level)")
	}

	// Определяем версию модели для параметров препроцессора
	isV3 := strings.Contains(pathLower, "v3")
	var winLength, nFFT int
	var center bool
	if isV3 {
		winLength = gigaamV3WinLength
		nFFT = gigaamV3NFFT
		center = false
		log.Printf("GigaAM RNNT: detected v3 model, using win_length=%d, n_fft=%d", winLength, nFFT)
	} else {
		winLength = gigaamV2WinLength
		nFFT = gigaamV2NFFT
		center = true
		log.Printf("GigaAM RNNT: detected v2/v1 model, using win_length=%d, n_fft=%d", winLength, nFFT)
	}

	// Инициализируем MelProcessor
	melConfig := MelConfig{
		SampleRate: gigaamSampleRate,
		NMels:      gigaamNMels,
		HopLength:  gigaamHopLength,
		WinLength:  winLength,
		NFFT:       nFFT,
		Center:     center,
	}
	engine.melProcessor = NewMelProcessor(melConfig)

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

	// Пробуем включить CoreML
	coreMLEnabled := false
	computeUnits := "CPU"
	if useCoreML {
		if err := options.AppendExecutionProviderCoreML(coremlFlagUseNone); err != nil {
			log.Printf("CoreML not available for RNNT, using CPU: %v", err)
		} else {
			coreMLEnabled = true
			computeUnits = "CoreML (CPU+GPU+ANE)"
			log.Println("✓ CoreML enabled for GigaAM RNNT")
		}
	}

	// Создаём сессии для каждой части модели
	// Encoder
	encInputInfo, encOutputInfo, err := ort.GetInputOutputInfo(encoderPath)
	if err != nil {
		return nil, fmt.Errorf("failed to get encoder info: %w", err)
	}
	encInputNames := extractNames(encInputInfo)
	encOutputNames := extractNames(encOutputInfo)

	encoderSession, err := ort.NewDynamicAdvancedSession(encoderPath, encInputNames, encOutputNames, options)
	if err != nil {
		return nil, fmt.Errorf("failed to create encoder session: %w", err)
	}
	engine.encoderSession = encoderSession

	// Decoder
	decInputInfo, decOutputInfo, err := ort.GetInputOutputInfo(decoderPath)
	if err != nil {
		encoderSession.Destroy()
		return nil, fmt.Errorf("failed to get decoder info: %w", err)
	}
	decInputNames := extractNames(decInputInfo)
	decOutputNames := extractNames(decOutputInfo)

	decoderSession, err := ort.NewDynamicAdvancedSession(decoderPath, decInputNames, decOutputNames, options)
	if err != nil {
		encoderSession.Destroy()
		return nil, fmt.Errorf("failed to create decoder session: %w", err)
	}
	engine.decoderSession = decoderSession

	// Joint
	jointInputInfo, jointOutputInfo, err := ort.GetInputOutputInfo(jointPath)
	if err != nil {
		encoderSession.Destroy()
		decoderSession.Destroy()
		return nil, fmt.Errorf("failed to get joint info: %w", err)
	}
	jointInputNames := extractNames(jointInputInfo)
	jointOutputNames := extractNames(jointOutputInfo)

	jointSession, err := ort.NewDynamicAdvancedSession(jointPath, jointInputNames, jointOutputNames, options)
	if err != nil {
		encoderSession.Destroy()
		decoderSession.Destroy()
		return nil, fmt.Errorf("failed to create joint session: %w", err)
	}
	engine.jointSession = jointSession

	engine.initialized = true
	engine.useCoreML = coreMLEnabled
	engine.computeUnits = computeUnits

	log.Printf("GigaAM RNNT engine initialized: vocab=%d tokens, blank_id=%d, compute=%s",
		len(vocab), blankID, computeUnits)
	return engine, nil
}

// extractNames извлекает имена из информации о входах/выходах
func extractNames(info []ort.InputOutputInfo) []string {
	names := make([]string, len(info))
	for i, inf := range info {
		names[i] = inf.Name
	}
	return names
}

// Name возвращает имя движка
func (e *GigaAMRNNTEngine) Name() string {
	return "gigaam-rnnt"
}

// ComputeUnits возвращает информацию об используемых вычислительных устройствах
func (e *GigaAMRNNTEngine) ComputeUnits() string {
	return e.computeUnits
}

// SupportedLanguages возвращает список поддерживаемых языков
func (e *GigaAMRNNTEngine) SupportedLanguages() []string {
	return []string{"ru"}
}

// Transcribe транскрибирует аудио и возвращает текст
func (e *GigaAMRNNTEngine) Transcribe(samples []float32, useContext bool) (string, error) {
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

// TranscribeWithSegments возвращает сегменты с таймстемпами и confidence
func (e *GigaAMRNNTEngine) TranscribeWithSegments(samples []float32) ([]TranscriptSegment, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.initialized {
		return nil, fmt.Errorf("GigaAM RNNT engine not initialized")
	}

	// Проверяем минимальную длину аудио
	if len(samples) < gigaamSampleRate/10 {
		return nil, nil
	}

	// Вычисляем mel-спектрограмму
	melSpec, numFrames := e.melProcessor.Compute(samples)

	// Создаём входной тензор для encoder [batch, n_mels, time]
	batchSize := int64(1)
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

	// Запускаем encoder
	// Encoder возвращает 2 выхода: encoded [B, 768, T'] и encoded_len [B]
	encoderOutputs := []ort.Value{nil, nil}
	err = e.encoderSession.Run([]ort.Value{inputTensor, lengthTensor}, encoderOutputs)
	if err != nil {
		return nil, fmt.Errorf("failed to run encoder: %w", err)
	}
	defer func() {
		for _, out := range encoderOutputs {
			if out != nil {
				out.Destroy()
			}
		}
	}()

	// Получаем encoder output [batch, hidden, time]
	encoderOutput := encoderOutputs[0].(*ort.Tensor[float32])
	encShape := encoderOutput.GetShape()
	encData := encoderOutput.GetData()

	// encShape = [1, hidden_size, time_steps]
	hiddenSize := int(encShape[1])
	timeSteps := int(encShape[2])

	// Логируем для отладки
	log.Printf("RNNT encoder output shape: [%d, %d, %d]", encShape[0], hiddenSize, timeSteps)

	// Декодируем с помощью RNNT
	audioDuration := float64(len(samples)) / gigaamSampleRate
	segments := e.decodeRNNT(encData, hiddenSize, timeSteps, audioDuration)

	return segments, nil
}

// decodeRNNT выполняет авторегрессивное декодирование RNNT
func (e *GigaAMRNNTEngine) decodeRNNT(encoderOut []float32, hiddenSize, timeSteps int, audioDuration float64) []TranscriptSegment {
	frameMs := audioDuration * 1000 / float64(timeSteps)

	var words []TranscriptWord
	var currentTokens []bpeTokenInfo

	// Начальное состояние декодера (нули)
	// predHidden = 320 для GigaAM v3
	decoderH := make([]float32, e.predHidden)
	decoderC := make([]float32, e.predHidden)
	lastLabel := int64(0) // Начальный токен

	for t := 0; t < timeSteps; t++ {
		frameTime := int64(float64(t) * frameMs)

		// Извлекаем encoder features для текущего временного шага
		// encoderOut shape: [1, hidden, time] -> берём [:, :, t]
		encFrame := make([]float32, hiddenSize)
		for h := 0; h < hiddenSize; h++ {
			encFrame[h] = encoderOut[h*timeSteps+t]
		}

		emittedSymbols := 0
		for emittedSymbols < maxSymbolsPerStep {
			// Запускаем decoder
			decOut, newH, newC, err := e.runDecoder(lastLabel, decoderH, decoderC)
			if err != nil {
				log.Printf("RNNT decoder error: %v", err)
				break
			}

			// Запускаем joint network
			logProbs, err := e.runJoint(encFrame, decOut)
			if err != nil {
				log.Printf("RNNT joint error: %v", err)
				break
			}

			// Находим токен с максимальной вероятностью
			maxIdx := 0
			maxVal := logProbs[0]
			for i, v := range logProbs {
				if v > maxVal {
					maxVal = v
					maxIdx = i
				}
			}

			// Вычисляем confidence
			confidence := softmaxMaxFromLogProbs(logProbs)

			if maxIdx == e.blankID {
				// Blank - переходим к следующему временному шагу
				// НЕ обновляем состояние декодера при blank (стандартное поведение RNNT)
				break
			}

			// Не blank - эмитируем токен и обновляем состояние
			if maxIdx < len(e.vocab) {
				token := e.vocab[maxIdx]

				// Для E2E модели: ▁ означает начало нового слова
				if e.modelType == GigaAMRNNTModelTypeE2E {
					if strings.HasPrefix(token, "▁") {
						// Сохраняем предыдущее слово
						if len(currentTokens) > 0 {
							word := mergeRNNTTokensToWord(currentTokens)
							if word.Text != "" {
								words = append(words, word)
							}
							currentTokens = nil
						}
						token = strings.TrimPrefix(token, "▁")
					}

					if token != "" && token != "<unk>" {
						currentTokens = append(currentTokens, bpeTokenInfo{
							text:       token,
							startTime:  frameTime,
							endTime:    frameTime,
							confidence: confidence,
						})
					}
				} else {
					// Для базовой модели: пробел = новое слово
					if maxIdx == e.spaceID {
						if len(currentTokens) > 0 {
							word := mergeRNNTTokensToWord(currentTokens)
							if word.Text != "" {
								words = append(words, word)
							}
							currentTokens = nil
						}
					} else if token != "<unk>" {
						currentTokens = append(currentTokens, bpeTokenInfo{
							text:       token,
							startTime:  frameTime,
							endTime:    frameTime,
							confidence: confidence,
						})
					}
				}
			}

			// Обновляем состояние декодера только при эмиссии не-blank токена
			lastLabel = int64(maxIdx)
			decoderH = newH
			decoderC = newC
			emittedSymbols++
		}
	}

	// Добавляем последнее слово
	if len(currentTokens) > 0 {
		word := mergeRNNTTokensToWord(currentTokens)
		if word.Text != "" {
			words = append(words, word)
		}
	}

	// Формируем сегмент
	if len(words) == 0 {
		return nil
	}

	var fullText strings.Builder
	for i, w := range words {
		if i > 0 {
			fullText.WriteString(" ")
		}
		fullText.WriteString(w.Text)
	}

	segment := TranscriptSegment{
		Start: words[0].Start,
		End:   words[len(words)-1].End,
		Text:  fullText.String(),
		Words: words,
	}

	return []TranscriptSegment{segment}
}

// runDecoder запускает decoder ONNX сессию
func (e *GigaAMRNNTEngine) runDecoder(label int64, h, c []float32) ([]float32, []float32, []float32, error) {
	// Input: x [1, 1], h [1, 1, pred_hidden], c [1, 1, pred_hidden]
	labelData := []int64{label}
	labelShape := ort.NewShape(1, 1)
	labelTensor, err := ort.NewTensor(labelShape, labelData)
	if err != nil {
		return nil, nil, nil, err
	}
	defer labelTensor.Destroy()

	hShape := ort.NewShape(1, 1, int64(e.predHidden))
	hTensor, err := ort.NewTensor(hShape, h)
	if err != nil {
		return nil, nil, nil, err
	}
	defer hTensor.Destroy()

	cTensor, err := ort.NewTensor(hShape, c)
	if err != nil {
		return nil, nil, nil, err
	}
	defer cTensor.Destroy()

	outputs := []ort.Value{nil, nil, nil}
	err = e.decoderSession.Run([]ort.Value{labelTensor, hTensor, cTensor}, outputs)
	if err != nil {
		return nil, nil, nil, err
	}
	defer func() {
		for _, out := range outputs {
			if out != nil {
				out.Destroy()
			}
		}
	}()

	// Output: dec [1, 1, pred_hidden], h [1, 1, pred_hidden], c [1, 1, pred_hidden]
	decOut := outputs[0].(*ort.Tensor[float32]).GetData()
	newH := outputs[1].(*ort.Tensor[float32]).GetData()
	newC := outputs[2].(*ort.Tensor[float32]).GetData()

	// Копируем данные (т.к. тензоры будут уничтожены)
	decCopy := make([]float32, len(decOut))
	copy(decCopy, decOut)
	hCopy := make([]float32, len(newH))
	copy(hCopy, newH)
	cCopy := make([]float32, len(newC))
	copy(cCopy, newC)

	return decCopy, hCopy, cCopy, nil
}

// runJoint запускает joint network ONNX сессию
func (e *GigaAMRNNTEngine) runJoint(encFrame, decOut []float32) ([]float32, error) {
	// Joint input: enc [1, hidden, 1], dec [1, pred_hidden, 1]
	// Нужно транспонировать для формата joint network

	encShape := ort.NewShape(1, int64(len(encFrame)), 1)
	encTensor, err := ort.NewTensor(encShape, encFrame)
	if err != nil {
		return nil, err
	}
	defer encTensor.Destroy()

	decShape := ort.NewShape(1, int64(len(decOut)), 1)
	decTensor, err := ort.NewTensor(decShape, decOut)
	if err != nil {
		return nil, err
	}
	defer decTensor.Destroy()

	outputs := []ort.Value{nil}
	err = e.jointSession.Run([]ort.Value{encTensor, decTensor}, outputs)
	if err != nil {
		return nil, err
	}
	defer func() {
		for _, out := range outputs {
			if out != nil {
				out.Destroy()
			}
		}
	}()

	// Output: log_probs [1, 1, 1, vocab_size]
	logProbs := outputs[0].(*ort.Tensor[float32]).GetData()

	// Копируем данные
	result := make([]float32, len(logProbs))
	copy(result, logProbs)

	return result, nil
}

// softmaxMaxFromLogProbs вычисляет максимальную вероятность из log probabilities
func softmaxMaxFromLogProbs(logProbs []float32) float32 {
	// log_probs уже после log_softmax, поэтому просто exp(max)
	maxVal := logProbs[0]
	for _, v := range logProbs {
		if v > maxVal {
			maxVal = v
		}
	}
	return float32(math.Exp(float64(maxVal)))
}

// mergeRNNTTokensToWord объединяет токены в слово
func mergeRNNTTokensToWord(tokens []bpeTokenInfo) TranscriptWord {
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
		P:     totalConfidence / float32(len(tokens)),
	}
}

// TranscribeHighQuality выполняет высококачественную транскрипцию
func (e *GigaAMRNNTEngine) TranscribeHighQuality(samples []float32) ([]TranscriptSegment, error) {
	return e.TranscribeWithSegments(samples)
}

// SetLanguage устанавливает язык (игнорируется для GigaAM - только русский)
func (e *GigaAMRNNTEngine) SetLanguage(lang string) {
	if lang != "ru" && lang != "auto" {
		log.Printf("GigaAM RNNT: language %q not supported, using Russian", lang)
	}
}

// SetHotwords устанавливает словарь подсказок
// GigaAM RNNT не поддерживает hotwords на уровне модели, но они используются для пост-обработки
func (e *GigaAMRNNTEngine) SetHotwords(words []string) {
	// GigaAM RNNT модель не поддерживает промпты
	// Hotwords применяются на уровне гибридной транскрипции как пост-обработка
	if len(words) > 0 {
		log.Printf("GigaAM RNNT: hotwords will be applied as post-processing: %v", words)
	}
}

// SetModel переключает модель (не поддерживается для RNNT - нужно пересоздать движок)
func (e *GigaAMRNNTEngine) SetModel(path string) error {
	return fmt.Errorf("GigaAM RNNT: SetModel not supported, create new engine instead")
}

// Close освобождает ресурсы
func (e *GigaAMRNNTEngine) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.encoderSession != nil {
		e.encoderSession.Destroy()
		e.encoderSession = nil
	}
	if e.decoderSession != nil {
		e.decoderSession.Destroy()
		e.decoderSession = nil
	}
	if e.jointSession != nil {
		e.jointSession.Destroy()
		e.jointSession = nil
	}
	e.initialized = false
}

// loadGigaAMRNNTVocab загружает словарь для RNNT модели
// Использует ту же функцию что и CTC
func loadGigaAMRNNTVocab(path string) ([]string, int, int, error) {
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
		lastSpace := strings.LastIndex(line, " ")
		if lastSpace < 0 {
			lastSpace = strings.LastIndex(line, "\t")
		}

		var token string
		if lastSpace > 0 {
			token = line[:lastSpace]
		} else if lastSpace == 0 {
			token = " "
		} else {
			token = line
		}

		if token != "" || lastSpace == 0 {
			if lastSpace == 0 {
				token = " "
			}
			vocab = append(vocab, token)

			if token == "<blk>" || token == "<blank>" || token == "[blank]" {
				blankID = len(vocab) - 1
			}
			if token == " " || token == "▁" {
				spaceID = len(vocab) - 1
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, 0, -1, err
	}

	if blankID == -1 {
		blankID = len(vocab) - 1
	}

	return vocab, blankID, spaceID, nil
}
