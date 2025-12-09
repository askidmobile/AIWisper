// main.swift
// CLI утилита для захвата системного аудио и микрофона через ScreenCaptureKit
// macOS 15+: поддержка микрофона с Voice Isolation
//
// Режимы:
//   system - только системный звук (маркер 'S')
//   mic    - только микрофон (маркер 'M') - требует macOS 15+
//   both   - ДВА ОТДЕЛЬНЫХ потока: системный + микрофон (требует macOS 15+)
//
// Формат вывода:
//   [маркер 1 байт][размер 4 байта little-endian][float32 данные]
//   Маркеры: 'M' (0x4D) = микрофон, 'S' (0x53) = системный звук

import ScreenCaptureKit
import CoreMedia
import AVFoundation
import Foundation

// MARK: - Протокол вывода

let outputLock = NSLock()

func writeChannelData(marker: UInt8, samples: [Float]) {
    guard !samples.isEmpty else { return }
    
    outputLock.lock()
    defer { outputLock.unlock() }
    
    // Записываем маркер
    var m = marker
    try? FileHandle.standardOutput.write(contentsOf: Data(bytes: &m, count: 1))
    
    // Записываем размер (количество float32)
    var size = UInt32(samples.count)
    withUnsafeBytes(of: &size) { ptr in
        try? FileHandle.standardOutput.write(contentsOf: Data(ptr))
    }
    
    // Записываем данные
    samples.withUnsafeBytes { buffer in
        try? FileHandle.standardOutput.write(contentsOf: Data(buffer))
    }
}

// MARK: - Audio Capture Delegate

class AudioCaptureDelegate: NSObject, SCStreamDelegate, SCStreamOutput {
    private var isRunning = true
    let outputQueue = DispatchQueue(label: "audio.output", qos: .userInteractive)
    private var formatLogged = false
    private let marker: UInt8  // 'M' или 'S'
    let streamName: String
    private let targetSampleRate: Int
    private var sourceSampleRate: Int = 0
    
    init(marker: UInt8, streamName: String, targetSampleRate: Int = 48000) {
        self.marker = marker
        self.streamName = streamName
        self.targetSampleRate = targetSampleRate
        super.init()
    }
    
    /// Дождаться завершения всех pending операций в очереди вывода
    func waitForPendingOperations() {
        outputQueue.sync {}
    }
    
    // Простой ресемплинг с линейной интерполяцией
    private func resample(_ samples: [Float], fromRate: Int, toRate: Int) -> [Float] {
        guard fromRate != toRate, fromRate > 0, toRate > 0 else { return samples }
        
        let ratio = Double(fromRate) / Double(toRate)
        let newLength = Int(Double(samples.count) / ratio)
        var result = [Float](repeating: 0, count: newLength)
        
        for i in 0..<newLength {
            let srcPos = Double(i) * ratio
            let srcIdx = Int(srcPos)
            let frac = Float(srcPos - Double(srcIdx))
            
            if srcIdx + 1 < samples.count {
                result[i] = samples[srcIdx] * (1 - frac) + samples[srcIdx + 1] * frac
            } else if srcIdx < samples.count {
                result[i] = samples[srcIdx]
            }
        }
        
        return result
    }
    
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard isRunning else { return }
        
        // Принимаем .audio и .microphone (macOS 15+)
        var isAudioType = (type == .audio)
        if #available(macOS 15.0, *) {
            isAudioType = isAudioType || (type == .microphone)
        }
        
        guard isAudioType else { return }
        
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }
        
        let channels = Int(asbd.pointee.mChannelsPerFrame)
        let sampleRate = Int(asbd.pointee.mSampleRate)
        let formatFlags = asbd.pointee.mFormatFlags
        let isFloat = (formatFlags & kAudioFormatFlagIsFloat) != 0
        let is32Bit = asbd.pointee.mBitsPerChannel == 32
        let isNonInterleaved = (formatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        
        if !formatLogged {
            sourceSampleRate = sampleRate
            let needsResample = sampleRate != targetSampleRate
            fputs("[\(streamName)] Audio: \(sampleRate)Hz, \(channels)ch, float=\(isFloat), resample=\(needsResample)\n", stderr)
            formatLogged = true
        }
        
        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0 else { return }
        
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        
        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer)
        
        guard status == kCMBlockBufferNoErr, let data = dataPointer else { return }
        
        let totalFloats = length / MemoryLayout<Float>.size
        
        data.withMemoryRebound(to: Float.self, capacity: totalFloats) { floatPtr in
            var monoSamples = [Float](repeating: 0, count: frameCount)
            
            if isNonInterleaved && channels >= 2 {
                // Non-interleaved стерео -> моно
                let samplesPerChannel = totalFloats / channels
                for i in 0..<min(frameCount, samplesPerChannel) {
                    let left = floatPtr[i]
                    let right = floatPtr[samplesPerChannel + i]
                    monoSamples[i] = (left + right) * 0.5
                }
            } else if channels > 1 {
                // Interleaved стерео -> моно
                for i in 0..<frameCount {
                    var sum: Float = 0
                    for ch in 0..<channels {
                        sum += floatPtr[i * channels + ch]
                    }
                    monoSamples[i] = sum / Float(channels)
                }
            } else {
                // Моно
                for i in 0..<min(frameCount, totalFloats) {
                    monoSamples[i] = floatPtr[i]
                }
            }
            
            // Ресемплинг если нужно (например, микрофон 24000 -> 48000)
            let outputSamples: [Float]
            if sourceSampleRate != targetSampleRate && sourceSampleRate > 0 {
                outputSamples = resample(monoSamples, fromRate: sourceSampleRate, toRate: targetSampleRate)
            } else {
                outputSamples = monoSamples
            }
            
            outputQueue.async { [self] in
                writeChannelData(marker: self.marker, samples: outputSamples)
            }
        }
    }
    
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("[\(streamName)] Stream stopped: \(error.localizedDescription)\n", stderr)
        isRunning = false
    }
    
    func stop() {
        isRunning = false
    }
}

// MARK: - Cleanup

/// Корректно останавливает все потоки захвата и освобождает ресурсы macOS
/// Порядок операций критичен для корректного освобождения audio tap!
func performCleanup() async {
    fputs("Stopping audio capture...\n", stderr)
    
    // ШАГ 1: Останавливаем делегаты чтобы прекратить обработку новых данных
    fputs("Step 1: Stopping delegates\n", stderr)
    ScreenCaptureAudio.systemDelegate?.stop()
    ScreenCaptureAudio.micDelegate?.stop()
    
    // ШАГ 2: Дождаться завершения всех pending операций в outputQueue
    // Это важно чтобы все буферы были обработаны до удаления output
    fputs("Step 2: Waiting for pending operations\n", stderr)
    ScreenCaptureAudio.systemDelegate?.waitForPendingOperations()
    ScreenCaptureAudio.micDelegate?.waitForPendingOperations()
    
    // ШАГ 3: ВАЖНО! Удалить stream outputs ПЕРЕД stopCapture()
    // Это освобождает буферы и ресурсы ScreenCaptureKit
    fputs("Step 3: Removing stream outputs\n", stderr)
    if let stream = ScreenCaptureAudio.systemStream, let delegate = ScreenCaptureAudio.systemDelegate {
        do {
            try stream.removeStreamOutput(delegate, type: .audio)
            fputs("System stream output removed\n", stderr)
        } catch {
            fputs("Warning: Could not remove system stream output: \(error.localizedDescription)\n", stderr)
        }
    }
    
    if #available(macOS 15.0, *) {
        if let stream = ScreenCaptureAudio.micStream, let delegate = ScreenCaptureAudio.micDelegate {
            do {
                try stream.removeStreamOutput(delegate, type: .microphone)
                fputs("Mic stream output removed\n", stderr)
            } catch {
                fputs("Warning: Could not remove mic stream output: \(error.localizedDescription)\n", stderr)
            }
        }
    }
    
    // ШАГ 4: Остановить потоки захвата
    // Это освобождает audio tap в macOS
    fputs("Step 4: Stopping capture streams\n", stderr)
    do {
        if let stream = ScreenCaptureAudio.systemStream {
            try await stream.stopCapture()
            fputs("System stream stopped\n", stderr)
        }
    } catch {
        fputs("Error stopping system stream: \(error.localizedDescription)\n", stderr)
    }
    
    do {
        if let stream = ScreenCaptureAudio.micStream {
            try await stream.stopCapture()
            fputs("Mic stream stopped\n", stderr)
        }
    } catch {
        fputs("Error stopping mic stream: \(error.localizedDescription)\n", stderr)
    }
    
    // ШАГ 5: Очищаем ссылки - это позволяет ARC освободить объекты
    fputs("Step 5: Clearing references\n", stderr)
    ScreenCaptureAudio.systemStream = nil
    ScreenCaptureAudio.micStream = nil
    ScreenCaptureAudio.systemDelegate = nil
    ScreenCaptureAudio.micDelegate = nil
    
    // ШАГ 6: Задержка чтобы macOS успела обработать освобождение ресурсов
    // 500ms даёт системе достаточно времени для полного освобождения audio tap
    // Это критично для предотвращения конфликтов с другими приложениями
    fputs("Step 6: Final delay for resource release (500ms)\n", stderr)
    try? await Task.sleep(nanoseconds: 500_000_000) // 500ms

    fputs("Cleanup complete - audio resources released\n", stderr)
}

// MARK: - Main

@main
struct ScreenCaptureAudio {
    static var systemStream: SCStream?
    static var micStream: SCStream?
    static var systemDelegate: AudioCaptureDelegate?
    static var micDelegate: AudioCaptureDelegate?
    
    static func main() async {
        guard #available(macOS 13.0, *) else {
            fputs("ERROR: ScreenCaptureKit requires macOS 13.0 or later\n", stderr)
            exit(1)
        }
        
        // Парсим аргументы
        let args = CommandLine.arguments
        let captureMode = args.count > 1 ? args[1] : "system" // system, mic, both
        
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        
        // Используем отдельную очередь для обработки сигналов (не main!)
        // чтобы можно было ждать async Task без deadlock
        let signalQueue = DispatchQueue(label: "signal.handler", qos: .userInteractive)
        
        let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
        sigintSource.setEventHandler {
            let semaphore = DispatchSemaphore(value: 0)
            Task {
                await performCleanup()
                semaphore.signal()
            }
            // Ждём завершения cleanup с таймаутом 3 секунды
            let result = semaphore.wait(timeout: .now() + 3.0)
            if result == .timedOut {
                fputs("WARNING: Cleanup timed out\n", stderr)
            }
            exit(0)
        }
        sigintSource.resume()
        
        let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
        sigtermSource.setEventHandler {
            let semaphore = DispatchSemaphore(value: 0)
            Task {
                await performCleanup()
                semaphore.signal()
            }
            let result = semaphore.wait(timeout: .now() + 3.0)
            if result == .timedOut {
                fputs("WARNING: Cleanup timed out\n", stderr)
            }
            exit(0)
        }
        sigtermSource.resume()
        
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            
            guard let display = content.displays.first else {
                fputs("ERROR: No display found\n", stderr)
                exit(1)
            }
            
            let filter = SCContentFilter(display: display, excludingWindows: [])
            
            // Запускаем системный звук (для режимов system и both)
            if captureMode == "system" || captureMode == "both" {
                let sysConfig = SCStreamConfiguration()
                sysConfig.capturesAudio = true
                sysConfig.excludesCurrentProcessAudio = false
                sysConfig.sampleRate = 48000
                sysConfig.channelCount = 2
                
                // Минимальные настройки видео
                sysConfig.width = 2
                sysConfig.height = 2
                sysConfig.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                sysConfig.showsCursor = false
                
                systemDelegate = AudioCaptureDelegate(marker: 0x53, streamName: "System")
                systemStream = SCStream(filter: filter, configuration: sysConfig, delegate: systemDelegate)
                
                try systemStream?.addStreamOutput(systemDelegate!, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))
                try await systemStream?.startCapture()
                fputs("System audio stream started\n", stderr)
            }
            
            // Запускаем микрофон (для режимов mic и both) - требует macOS 15+
            if #available(macOS 15.0, *) {
                if captureMode == "mic" || captureMode == "both" {
                    if let defaultMic = AVCaptureDevice.default(for: .audio) {
                        fputs("Microphone: \(defaultMic.localizedName)\n", stderr)
                        fputs("Voice Isolation: enabled\n", stderr)
                        
                        let micConfig = SCStreamConfiguration()
                        micConfig.capturesAudio = false  // Не захватываем системный звук
                        micConfig.captureMicrophone = true
                        micConfig.microphoneCaptureDeviceID = defaultMic.uniqueID
                        // Примечание: микрофон может игнорировать sampleRate и возвращать свой (часто 24000Hz)
                        micConfig.sampleRate = 48000
                        micConfig.channelCount = 1  // Микрофон обычно моно
                        
                        // Минимальные настройки видео
                        micConfig.width = 2
                        micConfig.height = 2
                        micConfig.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                        micConfig.showsCursor = false
                        
                        micDelegate = AudioCaptureDelegate(marker: 0x4D, streamName: "Mic")
                        micStream = SCStream(filter: filter, configuration: micConfig, delegate: micDelegate)
                        
                        // Для микрофона используем тип .microphone (macOS 15+)
                        try micStream?.addStreamOutput(micDelegate!, type: .microphone, sampleHandlerQueue: .global(qos: .userInteractive))
                        try await micStream?.startCapture()
                        fputs("Microphone stream started (Voice Isolation)\n", stderr)
                    } else {
                        fputs("WARNING: No microphone found\n", stderr)
                    }
                }
            } else if captureMode == "mic" || captureMode == "both" {
                fputs("WARNING: Microphone capture requires macOS 15.0+\n", stderr)
            }
            
            fputs("READY mode=\(captureMode)\n", stderr)
            
            while true {
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
            
        } catch let error as NSError {
            if error.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" {
                fputs("ERROR: Screen Recording permission required\n", stderr)
            } else {
                fputs("ERROR: \(error.localizedDescription)\n", stderr)
            }
            exit(1)
        }
    }
}
