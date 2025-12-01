package session

import (
	"log"
	"math"
	"time"
)

// ChunkEvent событие готовности чанка
type ChunkEvent struct {
	// Таймстемпы в миллисекундах (для извлечения из MP3)
	StartMs  int64
	EndMs    int64
	Duration time.Duration

	// Legacy: samples для обратной совместимости (будет nil при MP3 режиме)
	Samples     []float32 // Микс или моно
	MicSamples  []float32 // Только микрофон (опционально)
	SysSamples  []float32 // Только системный звук (опционально)
	StartOffset int64     // deprecated: use StartMs
	EndOffset   int64     // deprecated: use EndMs
}

// ChunkBuffer буфер для VAD и нарезки на чанки
// Логика: накапливаем аудио, нарезаем на паузах в речи (1+ сек тишины)
type ChunkBuffer struct {
	config     VADConfig
	sampleRate int

	// Накопленные семплы (микс)
	accumulated []float32
	// Раздельные каналы
	micAccumulated []float32
	sysAccumulated []float32

	// Счётчики
	totalSamples   int64
	emittedSamples int64 // Сколько семплов уже отправлено в чанки

	// Время начала записи
	startTime time.Time

	// Флаг: можно ли начинать нарезку
	chunkingEnabled bool

	// Флаг: есть ли раздельные каналы
	hasSeparateChannels bool

	outputChan chan ChunkEvent
}

// NewChunkBuffer создаёт новый буфер для чанков
func NewChunkBuffer(config VADConfig, sampleRate int) *ChunkBuffer {
	// Буфер на 10 минут
	return &ChunkBuffer{
		config:         config,
		sampleRate:     sampleRate,
		accumulated:    make([]float32, 0, sampleRate*600),
		micAccumulated: make([]float32, 0, sampleRate*600),
		sysAccumulated: make([]float32, 0, sampleRate*600),
		outputChan:     make(chan ChunkEvent, 10),
		startTime:      time.Now(),
	}
}

// ProcessStereo обрабатывает раздельные каналы микрофона и системного звука
func (b *ChunkBuffer) ProcessStereo(micSamples, sysSamples []float32) {
	// Убеждаемся что длины совпадают
	minLen := len(micSamples)
	if len(sysSamples) < minLen {
		minLen = len(sysSamples)
	}

	if minLen == 0 {
		return
	}

	b.hasSeparateChannels = true

	// Накапливаем раздельные каналы
	b.micAccumulated = append(b.micAccumulated, micSamples[:minLen]...)
	b.sysAccumulated = append(b.sysAccumulated, sysSamples[:minLen]...)

	// Создаём микс для VAD
	mix := make([]float32, minLen)
	for i := 0; i < minLen; i++ {
		mix[i] = (micSamples[i] + sysSamples[i]) / 2
	}

	// Обрабатываем через стандартный Process
	b.Process(mix)
}

// Process обрабатывает входящие семплы
func (b *ChunkBuffer) Process(samples []float32) {
	// Всегда накапливаем
	b.accumulated = append(b.accumulated, samples...)
	b.totalSamples += int64(len(samples))

	// Проверяем, прошло ли достаточно времени для начала нарезки
	if !b.chunkingEnabled {
		elapsed := time.Since(b.startTime)
		if elapsed >= b.config.ChunkingStartDelay {
			b.chunkingEnabled = true
			log.Printf("Chunking enabled after %v", elapsed)
		} else {
			return // Ещё рано нарезать
		}
	}

	// Логика нарезки
	b.tryEmitChunk()
}

// findSilenceGap ищет паузу (тишину) длительностью silenceDuration в указанном диапазоне
// Возвращает позицию начала паузы или -1 если не найдена
func (b *ChunkBuffer) findSilenceGap(startPos, endPos int64) int64 {
	silenceSamples := int64(b.config.SilenceDuration.Seconds() * float64(b.sampleRate))
	windowSize := int64(b.sampleRate / 10) // 100ms окно для анализа

	// Ищем последовательность тихих окон
	consecutiveSilent := int64(0)
	silenceStart := int64(-1)

	for pos := startPos; pos < endPos-windowSize; pos += windowSize {
		end := pos + windowSize
		if end > int64(len(b.accumulated)) {
			break
		}

		window := b.accumulated[pos:end]
		rms := CalculateRMS(window)

		if rms < b.config.SilenceThreshold {
			if consecutiveSilent == 0 {
				silenceStart = pos
			}
			consecutiveSilent += windowSize

			// Нашли паузу нужной длительности
			if consecutiveSilent >= silenceSamples {
				// Возвращаем середину паузы
				return silenceStart + consecutiveSilent/2
			}
		} else {
			consecutiveSilent = 0
			silenceStart = -1
		}
	}

	return -1
}

// tryEmitChunk пытается выделить чанк из накопленных данных
func (b *ChunkBuffer) tryEmitChunk() {
	availableSamples := int64(len(b.accumulated)) - b.emittedSamples
	if availableSamples <= 0 {
		return
	}

	minChunkSamples := int64(b.config.MinChunkDuration.Seconds() * float64(b.sampleRate))
	maxChunkSamples := int64(b.config.MaxChunkDuration.Seconds() * float64(b.sampleRate))

	// Недостаточно данных для минимального чанка
	if availableSamples < minChunkSamples {
		return
	}

	// Ищем паузу после минимальной длины чанка
	searchStart := b.emittedSamples + minChunkSamples
	searchEnd := b.emittedSamples + availableSamples
	if searchEnd > b.emittedSamples+maxChunkSamples {
		searchEnd = b.emittedSamples + maxChunkSamples
	}

	splitPoint := b.findSilenceGap(searchStart, searchEnd)

	// Если не нашли паузу
	if splitPoint == -1 {
		// Если достигли максимума - режем принудительно
		if availableSamples >= maxChunkSamples {
			splitPoint = b.emittedSamples + maxChunkSamples
			log.Printf("Forced chunk split at max duration (5 min)")
		} else {
			// Ждём паузу
			return
		}
	}

	// Выделяем чанк
	chunkSize := splitPoint - b.emittedSamples
	if chunkSize < minChunkSamples {
		return
	}

	samples := make([]float32, chunkSize)
	copy(samples, b.accumulated[b.emittedSamples:splitPoint])

	duration := time.Duration(chunkSize) * time.Second / time.Duration(b.sampleRate)

	// Вычисляем таймстемпы в миллисекундах
	startMs := b.emittedSamples * 1000 / int64(b.sampleRate)
	endMs := splitPoint * 1000 / int64(b.sampleRate)

	log.Printf("Emitting chunk: %.1f seconds [%d-%d ms]", duration.Seconds(), startMs, endMs)

	event := ChunkEvent{
		StartMs:     startMs,
		EndMs:       endMs,
		Duration:    duration,
		Samples:     samples,
		StartOffset: b.emittedSamples,
		EndOffset:   splitPoint,
	}

	// Добавляем раздельные каналы если есть
	if b.hasSeparateChannels && len(b.micAccumulated) >= int(splitPoint) && len(b.sysAccumulated) >= int(splitPoint) {
		event.MicSamples = make([]float32, chunkSize)
		event.SysSamples = make([]float32, chunkSize)
		copy(event.MicSamples, b.micAccumulated[b.emittedSamples:splitPoint])
		copy(event.SysSamples, b.sysAccumulated[b.emittedSamples:splitPoint])
	}

	select {
	case b.outputChan <- event:
		b.emittedSamples = splitPoint
	default:
		log.Printf("Warning: chunk output channel full")
	}
}

// Output возвращает канал с готовыми чанками
func (b *ChunkBuffer) Output() <-chan ChunkEvent {
	return b.outputChan
}

// Flush принудительно выдаёт текущий буфер как чанк
func (b *ChunkBuffer) Flush() *ChunkEvent {
	b.chunkingEnabled = true

	remaining := int64(len(b.accumulated)) - b.emittedSamples
	if remaining <= 0 {
		return nil
	}

	// Минимум 5 секунд для создания чанка
	minFlushSamples := int64(5 * b.sampleRate)
	if remaining < minFlushSamples {
		return nil
	}

	samples := make([]float32, remaining)
	copy(samples, b.accumulated[b.emittedSamples:])

	duration := time.Duration(remaining) * time.Second / time.Duration(b.sampleRate)

	startMs := b.emittedSamples * 1000 / int64(b.sampleRate)
	endMs := int64(len(b.accumulated)) * 1000 / int64(b.sampleRate)

	event := &ChunkEvent{
		StartMs:     startMs,
		EndMs:       endMs,
		Duration:    duration,
		Samples:     samples,
		StartOffset: b.emittedSamples,
		EndOffset:   int64(len(b.accumulated)),
	}

	b.emittedSamples = int64(len(b.accumulated))
	return event
}

// FlushAll выдаёт все оставшиеся данные как чанки (для остановки записи)
func (b *ChunkBuffer) FlushAll() []ChunkEvent {
	b.chunkingEnabled = true

	var events []ChunkEvent

	// Минимум 1 секунда для создания чанка при остановке (чтобы не терять последние слова)
	minFlushSamples := int64(1 * b.sampleRate)
	maxChunkSamples := int64(b.config.MaxChunkDuration.Seconds() * float64(b.sampleRate))

	for {
		remaining := int64(len(b.accumulated)) - b.emittedSamples
		if remaining <= 0 {
			break
		}

		// Слишком маленький остаток - пропускаем (менее 1 сек)
		if remaining < minFlushSamples {
			log.Printf("Skipping remaining %d samples (< 1 sec)", remaining)
			break
		}

		// Определяем размер чанка
		chunkSize := remaining
		if chunkSize > maxChunkSamples {
			// Ищем паузу для разделения
			searchStart := b.emittedSamples + maxChunkSamples/2
			searchEnd := b.emittedSamples + maxChunkSamples

			splitPoint := b.findSilenceGap(searchStart, searchEnd)
			if splitPoint != -1 {
				chunkSize = splitPoint - b.emittedSamples
			} else {
				chunkSize = maxChunkSamples
			}
		}

		samples := make([]float32, chunkSize)
		copy(samples, b.accumulated[b.emittedSamples:b.emittedSamples+chunkSize])

		duration := time.Duration(chunkSize) * time.Second / time.Duration(b.sampleRate)

		startMs := b.emittedSamples * 1000 / int64(b.sampleRate)
		endMs := (b.emittedSamples + chunkSize) * 1000 / int64(b.sampleRate)

		log.Printf("FlushAll: chunk %.1f seconds [%d-%d ms]", duration.Seconds(), startMs, endMs)

		event := ChunkEvent{
			StartMs:     startMs,
			EndMs:       endMs,
			Duration:    duration,
			Samples:     samples,
			StartOffset: b.emittedSamples,
			EndOffset:   b.emittedSamples + chunkSize,
		}

		// Добавляем раздельные каналы если есть
		endOffset := b.emittedSamples + chunkSize
		if b.hasSeparateChannels && len(b.micAccumulated) >= int(endOffset) && len(b.sysAccumulated) >= int(endOffset) {
			event.MicSamples = make([]float32, chunkSize)
			event.SysSamples = make([]float32, chunkSize)
			copy(event.MicSamples, b.micAccumulated[b.emittedSamples:endOffset])
			copy(event.SysSamples, b.sysAccumulated[b.emittedSamples:endOffset])
		}

		events = append(events, event)
		b.emittedSamples += chunkSize
	}

	return events
}

// Reset сбрасывает состояние буфера
func (b *ChunkBuffer) Reset() {
	b.accumulated = b.accumulated[:0]
	b.totalSamples = 0
	b.emittedSamples = 0
	b.chunkingEnabled = false
	b.startTime = time.Now()
}

// TotalSamples возвращает общее количество обработанных семплов
func (b *ChunkBuffer) TotalSamples() int64 {
	return b.totalSamples
}

// AccumulatedDuration возвращает длительность накопленного аудио
func (b *ChunkBuffer) AccumulatedDuration() time.Duration {
	return time.Duration(len(b.accumulated)) * time.Second / time.Duration(b.sampleRate)
}

// Close закрывает канал
func (b *ChunkBuffer) Close() {
	close(b.outputChan)
}

// CalculateRMS вычисляет RMS для семплов
func CalculateRMS(samples []float32) float64 {
	if len(samples) == 0 {
		return 0
	}
	var sum float64
	for _, s := range samples {
		sum += float64(s * s)
	}
	return math.Sqrt(sum / float64(len(samples)))
}
