/**
 * Waveform data for audio visualization
 * Simpler and more intuitive than spectrogram - shows amplitude over time
 */

export interface WaveformData {
    /** Peak values per channel [channel][sample] normalized 0..1 for waveform display */
    peaks: number[][];
    /** RMS values per channel [channel][sample] normalized 0..1 for waveform display */
    rms: number[][];
    /** Absolute RMS values per channel [channel][sample] for VU meter (0..1 linear scale) */
    rmsAbsolute: number[][];
    /** Duration per sample in seconds */
    sampleDuration: number;
    /** Total duration in seconds */
    duration: number;
    /** Number of samples */
    sampleCount: number;
    /** Number of channels */
    channelCount: number;
}

/**
 * Computes waveform data from AudioBuffer
 * Returns peak and RMS values for each time slice
 */
export const computeWaveform = (
    buffer: AudioBuffer,
    options?: { samples?: number }
): WaveformData => {
    const sampleCount = options?.samples ?? 400;
    const channelCount = Math.max(1, Math.min(2, buffer.numberOfChannels || 1));

    const peaks: number[][] = Array.from({ length: channelCount }, () =>
        new Array(sampleCount).fill(0)
    );
    const rms: number[][] = Array.from({ length: channelCount }, () =>
        new Array(sampleCount).fill(0)
    );
    const rmsAbsolute: number[][] = Array.from({ length: channelCount }, () =>
        new Array(sampleCount).fill(0)
    );

    let maxPeak = 1e-9;
    let maxRms = 1e-9;

    const sampleDuration = buffer.duration / sampleCount;

    for (let ch = 0; ch < channelCount; ch++) {
        const data = buffer.getChannelData(ch);
        const samplesPerSlice = Math.floor(data.length / sampleCount);

        for (let i = 0; i < sampleCount; i++) {
            const start = i * samplesPerSlice;
            const end = Math.min(data.length, start + samplesPerSlice);

            let peak = 0;
            let sumSquares = 0;
            let count = 0;

            for (let j = start; j < end; j++) {
                const sample = Math.abs(data[j]);
                if (sample > peak) peak = sample;
                sumSquares += data[j] * data[j];
                count++;
            }

            const rmsValue = count > 0 ? Math.sqrt(sumSquares / count) : 0;

            peaks[ch][i] = peak;
            rms[ch][i] = rmsValue;
            rmsAbsolute[ch][i] = rmsValue; // Store absolute RMS for VU meter

            if (peak > maxPeak) maxPeak = peak;
            if (rmsValue > maxRms) maxRms = rmsValue;
        }
    }

    // Normalize values for waveform display
    const peakNorm = maxPeak > 0 ? maxPeak : 1;
    const rmsNorm = maxRms > 0 ? maxRms : 1;

    return {
        peaks: peaks.map(channel => channel.map(v => v / peakNorm)),
        rms: rms.map(channel => channel.map(v => v / rmsNorm)),
        rmsAbsolute, // Absolute RMS values (0..1 linear) for VU meter
        sampleDuration,
        duration: buffer.duration,
        sampleCount,
        channelCount,
    };
};
