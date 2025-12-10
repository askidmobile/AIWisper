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
	Center     bool // true = center frames (librosa default), false = left-aligned (GigaAM v3)
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
	// Количество фреймов зависит от режима center
	var numFrames int
	if p.config.Center {
		// center=true: фреймы центрированы, начинаются с sample 0
		numFrames = len(samples)/p.config.HopLength + 1
	} else {
		// center=false: фреймы начинаются с начала без центрирования
		// Как в GigaAM v3: (len - win_length) / hop_length + 1
		if len(samples) >= p.config.WinLength {
			numFrames = (len(samples)-p.config.WinLength)/p.config.HopLength + 1
		} else {
			numFrames = 1
		}
	}

	// Результат: [numFrames][nMels]
	melSpec := make([][]float32, numFrames)

	for frame := 0; frame < numFrames; frame++ {
		// Начало фрейма зависит от режима center
		var frameStart int
		if p.config.Center {
			// center=true: центр фрейма на позиции frame * hop_length
			frameStart = frame*p.config.HopLength - p.config.WinLength/2
		} else {
			// center=false: начало фрейма на позиции frame * hop_length
			frameStart = frame * p.config.HopLength
		}

		// Извлекаем фрейм с паддингом
		frameData := make([]float64, p.config.NFFT)
		for i := 0; i < p.config.WinLength; i++ {
			sampleIdx := frameStart + i
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
// Реализация совместима с torchaudio/librosa (работает в Hz, не bin indices)
func createMelFilterbank(nFFT, nMels, sampleRate int) [][]float64 {
	// Преобразование Hz в mel (HTK formula)
	hzToMel := func(hz float64) float64 {
		return 2595.0 * math.Log10(1.0+hz/700.0)
	}
	// Преобразование mel в Hz
	melToHz := func(mel float64) float64 {
		return 700.0 * (math.Pow(10.0, mel/2595.0) - 1.0)
	}

	numBins := nFFT/2 + 1
	fMax := float64(sampleRate) / 2.0

	// Частоты для каждого FFT bin
	allFreqs := make([]float64, numBins)
	for i := 0; i < numBins; i++ {
		allFreqs[i] = float64(i) * fMax / float64(numBins-1)
	}

	// Mel points (nMels + 2 точек: left edge, centers, right edge)
	mMin := hzToMel(0)
	mMax := hzToMel(fMax)
	fPts := make([]float64, nMels+2)
	for i := 0; i < nMels+2; i++ {
		mel := mMin + float64(i)*(mMax-mMin)/float64(nMels+1)
		fPts[i] = melToHz(mel)
	}

	// Разницы между соседними точками (для нормализации)
	fDiff := make([]float64, nMels+1)
	for i := 0; i < nMels+1; i++ {
		fDiff[i] = fPts[i+1] - fPts[i]
	}

	// Создаём фильтры (как в torchaudio)
	filters := make([][]float64, nMels)
	for m := 0; m < nMels; m++ {
		filters[m] = make([]float64, numBins)

		for k := 0; k < numBins; k++ {
			freq := allFreqs[k]

			// Lower slope: (freq - f_pts[m]) / (f_pts[m+1] - f_pts[m])
			// Upper slope: (f_pts[m+2] - freq) / (f_pts[m+2] - f_pts[m+1])
			lower := (freq - fPts[m]) / fDiff[m]
			upper := (fPts[m+2] - freq) / fDiff[m+1]

			// Берём минимум и ограничиваем [0, 1]
			val := math.Min(lower, upper)
			if val < 0 {
				val = 0
			}
			filters[m][k] = val
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
