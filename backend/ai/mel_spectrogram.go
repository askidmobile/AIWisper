package ai

import (
	"math"

	"gonum.org/v1/gonum/dsp/fourier"
)

// MelConfig конфигурация для вычисления Mel-спектрограммы
type MelConfig struct {
	SampleRate int
	NMels      int
	HopLength  int // Usually SampleRate / 100 (10ms)
	WinLength  int // Usually SampleRate / 40 (25ms)
	NFFT       int
}

// MelProcessor обрабатывает аудио и вычисляет Mel-спектрограмму
type MelProcessor struct {
	config     MelConfig
	melFilters [][]float64
	window     []float64
	fft        *fourier.FFT
}

// NewMelProcessor создаёт новый процессор
func NewMelProcessor(config MelConfig) *MelProcessor {
	p := &MelProcessor{
		config: config,
	}

	p.melFilters = createMelFilterbank(config.NFFT, config.NMels, config.SampleRate)
	p.window = createHannWindow(config.WinLength)
	p.fft = fourier.NewFFT(config.NFFT)

	return p
}

// Compute вычисляет log-mel спектрограмму
func (p *MelProcessor) Compute(samples []float32) ([][]float32, int) {
	// Количество фреймов
	numFrames := len(samples)/p.config.HopLength + 1

	// Результат: [numFrames][nMels]
	melSpec := make([][]float32, numFrames)

	for frame := 0; frame < numFrames; frame++ {
		// Центр фрейма
		center := frame * p.config.HopLength

		// Извлекаем фрейм с паддингом
		frameData := make([]float64, p.config.NFFT)
		for i := 0; i < p.config.WinLength; i++ {
			sampleIdx := center - p.config.WinLength/2 + i
			if sampleIdx >= 0 && sampleIdx < len(samples) {
				frameData[i] = float64(samples[sampleIdx]) * p.window[i]
			}
		}

		// FFT
		coeffs := p.fft.Coefficients(nil, frameData)

		// Power spectrum (только положительные частоты)
		powerSpec := make([]float64, p.config.NFFT/2+1)
		for i := 0; i <= p.config.NFFT/2; i++ {
			re := real(coeffs[i])
			im := imag(coeffs[i])
			powerSpec[i] = re*re + im*im
		}

		// Применяем mel-фильтры
		melSpec[frame] = make([]float32, p.config.NMels)
		for m := 0; m < p.config.NMels; m++ {
			sum := float64(0)
			for k := 0; k < len(powerSpec); k++ {
				sum += powerSpec[k] * p.melFilters[m][k]
			}
			// Log с клампингом
			if sum < 1e-9 {
				sum = 1e-9
			}
			melSpec[frame][m] = float32(math.Log(sum))
		}
	}

	return melSpec, numFrames
}

// createMelFilterbank создаёт mel-фильтры
func createMelFilterbank(nFFT, nMels, sampleRate int) [][]float64 {
	// Преобразование Hz в mel
	hzToMel := func(hz float64) float64 {
		return 2595.0 * math.Log10(1.0+hz/700.0)
	}
	// Преобразование mel в Hz
	melToHz := func(mel float64) float64 {
		return 700.0 * (math.Pow(10.0, mel/2595.0) - 1.0)
	}

	// Границы в mel
	lowFreq := float64(0)
	highFreq := float64(sampleRate / 2)
	lowMel := hzToMel(lowFreq)
	highMel := hzToMel(highFreq)

	// Точки mel-фильтров
	melPoints := make([]float64, nMels+2)
	for i := 0; i < nMels+2; i++ {
		melPoints[i] = lowMel + float64(i)*(highMel-lowMel)/float64(nMels+1)
	}

	// Преобразуем обратно в Hz и затем в bin индексы
	binPoints := make([]int, nMels+2)
	for i := 0; i < nMels+2; i++ {
		hz := melToHz(melPoints[i])
		binPoints[i] = int(math.Floor((float64(nFFT)+1)*hz/float64(sampleRate) + 0.5))
	}

	// Создаём фильтры
	filters := make([][]float64, nMels)
	numBins := nFFT/2 + 1

	for m := 0; m < nMels; m++ {
		filters[m] = make([]float64, numBins)
		left := binPoints[m]
		center := binPoints[m+1]
		right := binPoints[m+2]

		for k := left; k < center && k < numBins; k++ {
			if center > left {
				filters[m][k] = float64(k-left) / float64(center-left)
			}
		}
		for k := center; k < right && k < numBins; k++ {
			if right > center {
				filters[m][k] = float64(right-k) / float64(right-center)
			}
		}
	}

	return filters
}

// createHannWindow создаёт окно Ханна
func createHannWindow(size int) []float64 {
	window := make([]float64, size)
	for i := 0; i < size; i++ {
		window[i] = 0.5 * (1 - math.Cos(2*math.Pi*float64(i)/float64(size-1)))
	}
	return window
}
