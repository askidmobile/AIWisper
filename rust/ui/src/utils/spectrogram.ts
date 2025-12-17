export interface ChannelSpectrogramData {
    channelSpectrogram: number[][][]; // [channel][slice][freqBin] normalized 0..1
    rms: number[][]; // [channel][slice] normalized 0..1
    sliceDuration: number; // seconds
    duration: number; // seconds
    freqBins: number;
    sliceCount: number;
}

const createHannWindow = (size: number): Float32Array => {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return window;
};

const fftRadix2 = (real: Float32Array, imag: Float32Array) => {
    const n = real.length;
    if ((n & (n - 1)) !== 0) {
        throw new Error('FFT size must be a power of two');
    }

    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            const tr = real[i];
            real[i] = real[j];
            real[j] = tr;
            const ti = imag[i];
            imag[i] = imag[j];
            imag[j] = ti;
        }
    }

    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wlenReal = Math.cos(ang);
        const wlenImag = Math.sin(ang);

        for (let i = 0; i < n; i += len) {
            let wReal = 1;
            let wImag = 0;
            for (let j = 0; j < len / 2; j++) {
                const uReal = real[i + j];
                const uImag = imag[i + j];
                const vReal = real[i + j + len / 2] * wReal - imag[i + j + len / 2] * wImag;
                const vImag = real[i + j + len / 2] * wImag + imag[i + j + len / 2] * wReal;

                real[i + j] = uReal + vReal;
                imag[i + j] = uImag + vImag;
                real[i + j + len / 2] = uReal - vReal;
                imag[i + j + len / 2] = uImag - vImag;

                const nextWReal = wReal * wlenReal - wImag * wlenImag;
                const nextWImag = wReal * wlenImag + wImag * wlenReal;
                wReal = nextWReal;
                wImag = nextWImag;
            }
        }
    }
};

const buildFrequencyRanges = (
    freqBins: number,
    sampleRate: number,
    fftSize: number
): Array<{ start: number; end: number }> => {
    const nyquist = sampleRate / 2;
    const step = sampleRate / fftSize;
    const ranges: Array<{ start: number; end: number }> = [];

    for (let i = 0; i < freqBins; i++) {
        const startRatio = i / freqBins;
        const endRatio = (i + 1) / freqBins;
        const startFreq = Math.pow(startRatio, 1.5) * nyquist;
        const endFreq = Math.pow(endRatio, 1.5) * nyquist;

        ranges.push({
            start: Math.max(1, Math.floor(startFreq / step)),
            end: Math.max(Math.floor(startFreq / step) + 1, Math.ceil(endFreq / step)),
        });
    }

    return ranges;
};

export const computeChannelSpectrogram = (
    buffer: AudioBuffer,
    options?: { slices?: number; freqBins?: number; fftSize?: number }
): ChannelSpectrogramData => {
    const sliceCount = options?.slices ?? 320;
    const freqBins = options?.freqBins ?? 48;
    const fftSize = options?.fftSize ?? 1024;
    const channelCount = Math.max(1, Math.min(2, buffer.numberOfChannels || 1));

    if ((fftSize & (fftSize - 1)) !== 0) {
        throw new Error('fftSize must be a power of two');
    }

    const hann = createHannWindow(fftSize);
    const ranges = buildFrequencyRanges(freqBins, buffer.sampleRate, fftSize);
    const channelSpectrogram: number[][][] = Array.from({ length: channelCount }, () =>
        Array.from({ length: sliceCount }, () => new Array(freqBins).fill(0))
    );
    const rms: number[][] = Array.from({ length: channelCount }, () =>
        new Array(sliceCount).fill(0)
    );

    let maxMagnitude = 1e-9;
    let maxRms = 1e-9;

    const timeBuffer = new Float32Array(fftSize);
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    const sliceDuration = buffer.duration / sliceCount;

    for (let ch = 0; ch < channelCount; ch++) {
        const data = buffer.getChannelData(ch);

        for (let sliceIndex = 0; sliceIndex < sliceCount; sliceIndex++) {
            const start = Math.floor((sliceIndex / sliceCount) * data.length);
            const end = Math.min(data.length, start + fftSize);

            timeBuffer.fill(0);
            timeBuffer.set(data.subarray(start, end));

            let sumSquares = 0;
            for (let i = 0; i < fftSize; i++) {
                const windowed = timeBuffer[i] * hann[i];
                real[i] = windowed;
                imag[i] = 0;
                sumSquares += windowed * windowed;
            }

            const rmsValue = Math.sqrt(sumSquares / fftSize);
            rms[ch][sliceIndex] = rmsValue;
            if (rmsValue > maxRms) maxRms = rmsValue;

            fftRadix2(real, imag);

            const magnitudes = channelSpectrogram[ch][sliceIndex];
            for (let b = 0; b < freqBins; b++) {
                const { start: binStart, end: binEnd } = ranges[b];
                let acc = 0;
                let count = 0;
                for (let k = binStart; k < binEnd && k < fftSize / 2; k++) {
                    const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
                    acc += mag;
                    count++;
                    if (mag > maxMagnitude) maxMagnitude = mag;
                }
                magnitudes[b] = count > 0 ? acc / count : 0;
            }
        }
    }

    const magnitudeNorm = maxMagnitude > 0 ? maxMagnitude : 1;
    const rmsNorm = maxRms > 0 ? maxRms : 1;

    return {
        channelSpectrogram: channelSpectrogram.map((channel) =>
            channel.map((slice) => slice.map((v) => v / magnitudeNorm))
        ),
        rms: rms.map((channel) => channel.map((v) => v / rmsNorm)),
        sliceDuration,
        duration: buffer.duration,
        freqBins,
        sliceCount,
    };
};

