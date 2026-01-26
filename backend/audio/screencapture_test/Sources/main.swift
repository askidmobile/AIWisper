// test_wav.swift
// Тестовая утилита для записи микрофона напрямую в WAV файл (без Go)
// Использование: swift test_wav.swift

import ScreenCaptureKit
import CoreMedia
import AVFoundation
import Foundation

// WAV Writer - записывает float32 сэмплы в WAV файл
class WAVWriter {
    private var fileHandle: FileHandle?
    private let sampleRate: Int
    private let channels: Int
    private var samplesWritten: Int = 0
    private let filePath: String
    
    init(path: String, sampleRate: Int, channels: Int) throws {
        self.filePath = path
        self.sampleRate = sampleRate
        self.channels = channels
        
        // Создаём файл
        FileManager.default.createFile(atPath: path, contents: nil)
        self.fileHandle = FileHandle(forWritingAtPath: path)
        
        // Пишем placeholder header (обновим в конце)
        try writeHeader()
    }
    
    private func writeHeader() throws {
        guard let fh = fileHandle else { return }
        try fh.seek(toOffset: 0)
        
        let bitsPerSample = 16
        let byteRate = sampleRate * channels * bitsPerSample / 8
        let blockAlign = channels * bitsPerSample / 8
        let dataSize = UInt32(samplesWritten * 2) // 2 bytes per sample (16-bit)
        
        var header = Data()
        
        // RIFF header
        header.append(contentsOf: "RIFF".utf8)
        header.append(contentsOf: withUnsafeBytes(of: UInt32(36 + dataSize).littleEndian) { Array($0) })
        header.append(contentsOf: "WAVE".utf8)
        
        // fmt chunk
        header.append(contentsOf: "fmt ".utf8)
        header.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) }) // chunk size
        header.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })  // PCM
        header.append(contentsOf: withUnsafeBytes(of: UInt16(channels).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt32(byteRate).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(blockAlign).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(bitsPerSample).littleEndian) { Array($0) })
        
        // data chunk
        header.append(contentsOf: "data".utf8)
        header.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })
        
        try fh.write(contentsOf: header)
    }
    
    func write(samples: [Float]) throws {
        guard let fh = fileHandle else { return }
        
        var data = Data()
        for sample in samples {
            // Clamp to [-1, 1]
            let clamped = max(-1.0, min(1.0, sample))
            let int16Sample = Int16(clamped * 32767)
            data.append(contentsOf: withUnsafeBytes(of: int16Sample.littleEndian) { Array($0) })
            samplesWritten += 1
        }
        
        try fh.write(contentsOf: data)
    }
    
    func close() throws {
        // Обновляем header с правильным размером
        try writeHeader()
        try fileHandle?.close()
        
        let duration = Double(samplesWritten) / Double(sampleRate) / Double(channels)
        fputs("WAV closed: \(filePath), samples=\(samplesWritten), duration=\(String(format: "%.2f", duration))s\n", stderr)
    }
}

// Audio Delegate для теста
class TestAudioDelegate: NSObject, SCStreamDelegate, SCStreamOutput {
    private var isRunning = true
    private let wavWriter: WAVWriter
    private var formatLogged = false
    private var sampleCount = 0
    
    init(wavWriter: WAVWriter) {
        self.wavWriter = wavWriter
        super.init()
    }
    
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard isRunning else { return }
        
        var isAudioType = (type == .audio)
        if #available(macOS 15.0, *) {
            isAudioType = isAudioType || (type == .microphone)
        }
        guard isAudioType else { return }
        
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }
        
        let channels = Int(asbd.pointee.mChannelsPerFrame)
        let sampleRate = Int(asbd.pointee.mSampleRate)
        
        if !formatLogged {
            fputs("[Test] Audio format: \(sampleRate)Hz, \(channels)ch\n", stderr)
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
            
            if channels > 1 {
                // Стерео -> моно
                for i in 0..<frameCount {
                    var sum: Float = 0
                    for ch in 0..<channels {
                        sum += floatPtr[i * channels + ch]
                    }
                    monoSamples[i] = sum / Float(channels)
                }
            } else {
                for i in 0..<min(frameCount, totalFloats) {
                    monoSamples[i] = floatPtr[i]
                }
            }
            
            // Пишем напрямую в WAV
            do {
                try wavWriter.write(samples: monoSamples)
                sampleCount += monoSamples.count
            } catch {
                fputs("Error writing WAV: \(error)\n", stderr)
            }
        }
    }
    
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("[Test] Stream stopped: \(error.localizedDescription)\n", stderr)
        isRunning = false
    }
    
    func stop() {
        isRunning = false
        fputs("[Test] Total samples: \(sampleCount)\n", stderr)
    }
}

// Main
@main
struct TestWAV {
    static var stream: SCStream?
    static var delegate: TestAudioDelegate?
    static var wavWriter: WAVWriter?
    
    static func main() async {
        guard #available(macOS 15.0, *) else {
            fputs("ERROR: Requires macOS 15.0+\n", stderr)
            exit(1)
        }
        
        let outputPath = "/tmp/swift_direct_test.wav"
        fputs("=== Swift Direct WAV Test ===\n", stderr)
        fputs("Output: \(outputPath)\n", stderr)
        fputs("Recording for 5 seconds...\n", stderr)
        fputs(">>> SPEAK NOW! <<<\n", stderr)
        
        do {
            // Создаём WAV writer
            wavWriter = try WAVWriter(path: outputPath, sampleRate: 24000, channels: 1)
            
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                fputs("ERROR: No display found\n", stderr)
                exit(1)
            }
            
            let filter = SCContentFilter(display: display, excludingWindows: [])
            
            guard let defaultMic = AVCaptureDevice.default(for: .audio) else {
                fputs("ERROR: No microphone found\n", stderr)
                exit(1)
            }
            
            fputs("Microphone: \(defaultMic.localizedName)\n", stderr)
            
            let config = SCStreamConfiguration()
            config.capturesAudio = false
            config.captureMicrophone = true
            config.microphoneCaptureDeviceID = defaultMic.uniqueID
            config.sampleRate = 24000
            config.channelCount = 1
            config.queueDepth = 8
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            
            delegate = TestAudioDelegate(wavWriter: wavWriter!)
            stream = SCStream(filter: filter, configuration: config, delegate: delegate)
            
            let audioQueue = DispatchQueue(label: "test.audio", qos: .userInteractive)
            try stream?.addStreamOutput(delegate!, type: .microphone, sampleHandlerQueue: audioQueue)
            try await stream?.startCapture()
            
            fputs("Recording started...\n", stderr)
            
            // Записываем 5 секунд
            try await Task.sleep(nanoseconds: 5_000_000_000)
            
            fputs("Stopping...\n", stderr)
            delegate?.stop()
            try await stream?.stopCapture()
            try wavWriter?.close()
            
            fputs("=== Test Complete ===\n", stderr)
            fputs("Check file: \(outputPath)\n", stderr)
            fputs("Play with: afplay \(outputPath)\n", stderr)
            
        } catch {
            fputs("ERROR: \(error)\n", stderr)
            exit(1)
        }
    }
}
