import Foundation
import FluidAudio
import AVFoundation

// transcription-fluid-stream CLI
// Long-running процесс для streaming транскрипции через line-delimited JSON протокол
//
// Протокол (stdin/stdout):
// INPUT (line-delimited JSON):
//   {"command": "init", "model_cache_dir": "/path/to/cache"}
//   {"command": "stream", "samples": [0.1, 0.2, ...]}  // или base64 для больших чанков
//   {"command": "finish"}
//   {"command": "reset"}
//   {"command": "exit"}
//
// OUTPUT (line-delimited JSON):
//   {"type": "ready"}
//   {"type": "update", "text": "Hello", "is_confirmed": false, "confidence": 0.85, "timestamp": 1234567890.123}
//   {"type": "update", "text": "Hello world", "is_confirmed": true, "confidence": 0.95, "timestamp": 1234567890.456}
//   {"type": "final", "text": "Hello world", "duration": 2.5}
//   {"type": "error", "message": "..."}

// MARK: - Protocol Types

struct Command: Codable {
    let command: String
    let model_cache_dir: String?
    let samples: [Float]?
    let samples_base64: String?  // Альтернатива для больших чанков
    let chunk_seconds: Double?
    let confirmation_threshold: Double?
}

struct Response: Codable {
    let type: String
    let text: String?
    let is_confirmed: Bool?
    let confidence: Float?
    let timestamp: Double?
    let duration: Double?
    let message: String?
    let token_timings: [TokenTimingJSON]?
}

struct TokenTimingJSON: Codable {
    let token: String
    let start: Double
    let end: Double
    let confidence: Float
}

// MARK: - Streaming Manager

actor StreamingTranscriptionManager {
    private var streamingManager: StreamingAsrManager?
    private var isInitialized = false
    private var updateTask: Task<Void, Never>?
    
    func initialize(modelCacheDir: String?, chunkSeconds: Double?, confirmationThreshold: Double?) async throws {
        guard !isInitialized else {
            fputs("[transcription-fluid-stream] Already initialized\n", stderr)
            return
        }
        
        // Настраиваем кэш моделей
        if let cachePath = modelCacheDir {
            let fileManager = FileManager.default
            let cacheURL = URL(fileURLWithPath: cachePath)
            
            if !fileManager.fileExists(atPath: cachePath) {
                try? fileManager.createDirectory(at: cacheURL, withIntermediateDirectories: true)
            }
            
            setenv("FLUIDAUDIO_CACHE_DIR", cachePath, 1)
            fputs("[transcription-fluid-stream] Using custom model cache: \(cachePath)\n", stderr)
        }
        
        // Создаём конфигурацию
        let config: StreamingAsrConfig
        if let chunk = chunkSeconds, let threshold = confirmationThreshold {
            config = StreamingAsrConfig(
                chunkSeconds: chunk,
                confirmationThreshold: threshold
            )
        } else if let chunk = chunkSeconds {
            config = StreamingAsrConfig(chunkSeconds: chunk)
        } else {
            config = .default
        }
        
        fputs("[transcription-fluid-stream] Loading Parakeet TDT v3 models...\n", stderr)
        
        // Создаём StreamingAsrManager
        streamingManager = StreamingAsrManager(config: config)
        
        // Запускаем streaming
        try await streamingManager?.start()
        
        // Подписываемся на обновления
        // Создаём Task для получения обновлений из AsyncStream
        let manager = streamingManager!
        updateTask = Task {
            // Получаем AsyncStream вне actor context
            let updates = await manager.transcriptionUpdates
            for await update in updates {
                self.handleUpdate(update)
            }
        }
        
        isInitialized = true
        fputs("[transcription-fluid-stream] Initialized successfully\n", stderr)
        
        // Отправляем ready
        sendResponse(Response(type: "ready", text: nil, is_confirmed: nil, confidence: nil, timestamp: nil, duration: nil, message: nil, token_timings: nil))
    }
    
    func streamAudio(samples: [Float]) async throws {
        guard isInitialized, let manager = streamingManager else {
            throw NSError(domain: "StreamingManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "Not initialized"])
        }
        
        // Конвертируем samples в AVAudioPCMBuffer
        let buffer = createPCMBuffer(from: samples)
        await manager.streamAudio(buffer)
    }
    
    func finish() async throws -> String {
        guard isInitialized, let manager = streamingManager else {
            throw NSError(domain: "StreamingManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "Not initialized"])
        }
        
        let finalText = try await manager.finish()
        
        // Отменяем задачу обновлений
        updateTask?.cancel()
        updateTask = nil
        
        return finalText
    }
    
    func reset() async throws {
        guard isInitialized, let manager = streamingManager else {
            throw NSError(domain: "StreamingManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "Not initialized"])
        }
        
        try await manager.reset()
        fputs("[transcription-fluid-stream] Reset completed\n", stderr)
    }
    
    func cleanup() async {
        updateTask?.cancel()
        updateTask = nil
        
        if let manager = streamingManager {
            await manager.cancel()
        }
        
        streamingManager = nil
        isInitialized = false
        fputs("[transcription-fluid-stream] Cleanup completed\n", stderr)
    }
    
    private func handleUpdate(_ update: StreamingTranscriptionUpdate) {
        let tokenTimings = update.tokenTimings.map { timing in
            TokenTimingJSON(
                token: timing.token,
                start: timing.startTime,
                end: timing.endTime,
                confidence: timing.confidence
            )
        }
        
        let response = Response(
            type: "update",
            text: update.text,
            is_confirmed: update.isConfirmed,
            confidence: update.confidence,
            timestamp: update.timestamp.timeIntervalSince1970,
            duration: nil,
            message: nil,
            token_timings: tokenTimings.isEmpty ? nil : tokenTimings
        )
        
        sendResponse(response)
    }
    
    private func createPCMBuffer(from samples: [Float]) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = buffer.frameCapacity
        
        let channelData = buffer.floatChannelData![0]
        for (index, sample) in samples.enumerated() {
            channelData[index] = sample
        }
        
        return buffer
    }
}

// MARK: - Helper Functions

func sendResponse(_ response: Response) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    
    if let data = try? encoder.encode(response),
       let json = String(data: data, encoding: .utf8) {
        print(json)
        fflush(stdout)
    }
}

func sendError(_ message: String) {
    let response = Response(
        type: "error",
        text: nil,
        is_confirmed: nil,
        confidence: nil,
        timestamp: nil,
        duration: nil,
        message: message,
        token_timings: nil
    )
    sendResponse(response)
}

func decodeSamplesFromBase64(_ base64: String) -> [Float]? {
    guard let data = Data(base64Encoded: base64) else {
        return nil
    }
    
    let floatCount = data.count / 4
    var samples = [Float](repeating: 0, count: floatCount)
    
    data.withUnsafeBytes { (ptr: UnsafeRawBufferPointer) in
        let floatPtr = ptr.bindMemory(to: Float.self)
        for i in 0..<floatCount {
            samples[i] = floatPtr[i]
        }
    }
    
    return samples
}

// MARK: - Main Loop

@main
struct TranscriptionStreamCLI {
    static func main() async {
        fputs("[transcription-fluid-stream] Starting streaming transcription CLI\n", stderr)
        
        let manager = StreamingTranscriptionManager()
        let decoder = JSONDecoder()
        
        // Читаем команды из stdin (line-delimited JSON)
        while let line = readLine() {
            guard !line.isEmpty else { continue }
            
            do {
                guard let data = line.data(using: .utf8) else {
                    sendError("Invalid UTF-8 input")
                    continue
                }
                
                let command = try decoder.decode(Command.self, from: data)
                
                switch command.command {
                case "init":
                    try await manager.initialize(
                        modelCacheDir: command.model_cache_dir,
                        chunkSeconds: command.chunk_seconds,
                        confirmationThreshold: command.confirmation_threshold
                    )
                    
                case "stream":
                    var samples: [Float]?
                    
                    if let samplesArray = command.samples {
                        samples = samplesArray
                    } else if let base64 = command.samples_base64 {
                        samples = decodeSamplesFromBase64(base64)
                    }
                    
                    guard let audioSamples = samples else {
                        sendError("No samples provided or invalid base64")
                        continue
                    }
                    
                    try await manager.streamAudio(samples: audioSamples)
                    
                case "finish":
                    let finalText = try await manager.finish()
                    let response = Response(
                        type: "final",
                        text: finalText,
                        is_confirmed: nil,
                        confidence: nil,
                        timestamp: nil,
                        duration: nil,
                        message: nil,
                        token_timings: nil
                    )
                    sendResponse(response)
                    
                case "reset":
                    try await manager.reset()
                    sendResponse(Response(
                        type: "ready",
                        text: nil,
                        is_confirmed: nil,
                        confidence: nil,
                        timestamp: nil,
                        duration: nil,
                        message: nil,
                        token_timings: nil
                    ))
                    
                case "exit":
                    await manager.cleanup()
                    fputs("[transcription-fluid-stream] Exiting\n", stderr)
                    return
                    
                default:
                    sendError("Unknown command: \(command.command)")
                }
                
            } catch {
                sendError("Command processing failed: \(error.localizedDescription)")
                fputs("[transcription-fluid-stream] Error: \(error)\n", stderr)
            }
        }
        
        // EOF reached
        await manager.cleanup()
        fputs("[transcription-fluid-stream] EOF reached, exiting\n", stderr)
    }
}
