import Foundation
import FluidAudio

// transcription-fluid CLI
// Принимает аудио (WAV файл или float32 samples из stdin), выводит JSON с транскрипцией
//
// Использование:
//   transcription-fluid <audio.wav>
//   transcription-fluid --samples  # читает float32 samples из stdin
//   transcription-fluid --samples --model-cache-dir /path/to/cache
//
// Вывод (JSON):
// {
//   "segments": [
//     {"start": 0.5, "end": 2.3, "text": "Hello world"},
//     {"start": 2.5, "end": 5.1, "text": "How are you?"}
//   ],
//   "language": "en",
//   "model_version": "v3"
// }

struct TranscriptionSegment: Codable {
    let start: Double
    let end: Double
    let text: String
}

struct TranscriptionResult: Codable {
    let segments: [TranscriptionSegment]
    let language: String?
    let model_version: String
    let error: String?
}

func printError(_ message: String) {
    let result = TranscriptionResult(
        segments: [],
        language: nil,
        model_version: "v3",
        error: message
    )
    if let data = try? JSONEncoder().encode(result),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"segments\":[], \"language\":null, \"model_version\":\"v3\", \"error\":\"\(message)\"}")
    }
}

func loadAudioSamples(from path: String) -> [Float]? {
    do {
        let converter = AudioConverter()
        return try converter.resampleAudioFile(path: path)
    } catch {
        return nil
    }
}

func readSamplesFromStdin() -> [Float]? {
    // Читаем бинарные float32 данные из stdin
    var samples: [Float] = []
    let bufferSize = 4096
    var buffer = [UInt8](repeating: 0, count: bufferSize)
    
    while true {
        let bytesRead = fread(&buffer, 1, bufferSize, stdin)
        if bytesRead == 0 { break }
        
        // Конвертируем bytes в float32
        let floatCount = bytesRead / 4
        for i in 0..<floatCount {
            let offset = i * 4
            let value = buffer[offset..<offset+4].withUnsafeBytes { $0.load(as: Float.self) }
            samples.append(value)
        }
    }
    
    return samples.isEmpty ? nil : samples
}

// Настройка кастомного кэша моделей для FluidAudio
func configureModelCache(customPath: String?) {
    if let cachePath = customPath {
        // Устанавливаем кастомный путь для кэша моделей FluidAudio
        // FluidAudio использует ModelRegistry.baseURL для загрузки
        // и кэширует в ~/.cache/fluidaudio по умолчанию
        
        // Создаём директорию если не существует
        let fileManager = FileManager.default
        let cacheURL = URL(fileURLWithPath: cachePath)
        
        if !fileManager.fileExists(atPath: cachePath) {
            try? fileManager.createDirectory(at: cacheURL, withIntermediateDirectories: true)
        }
        
        // Устанавливаем переменную окружения для FluidAudio
        setenv("FLUIDAUDIO_CACHE_DIR", cachePath, 1)
        
        fputs("[transcription-fluid] Using custom model cache: \(cachePath)\n", stderr)
    }
}

@main
struct TranscriptionCLI {
    static func main() async {
        let args = CommandLine.arguments
        
        var samples: [Float]?
        var modelCacheDir: String?
        var isStdinMode = false
        var audioPath: String?
        var pauseThreshold: TimeInterval = 0.5 // По умолчанию 500ms
        
        // Парсим аргументы
        var i = 1
        while i < args.count {
            let arg = args[i]
            
            if arg == "--samples" {
                isStdinMode = true
            } else if arg == "--model-cache-dir" {
                if i + 1 < args.count {
                    modelCacheDir = args[i + 1]
                    i += 1
                } else {
                    printError("--model-cache-dir requires a path argument")
                    return
                }
            } else if arg == "--pause-threshold" {
                if i + 1 < args.count {
                    if let threshold = Double(args[i + 1]) {
                        pauseThreshold = threshold
                        i += 1
                    } else {
                        printError("--pause-threshold requires a numeric value (seconds)")
                        return
                    }
                } else {
                    printError("--pause-threshold requires a value")
                    return
                }
            } else if !arg.hasPrefix("--") {
                audioPath = arg
            }
            
            i += 1
        }
        
        // Настраиваем кэш моделей
        configureModelCache(customPath: modelCacheDir)
        
        // Загружаем аудио
        if isStdinMode {
            // Режим чтения из stdin
            samples = readSamplesFromStdin()
            if samples == nil {
                printError("Failed to read samples from stdin")
                return
            }
        } else if let path = audioPath {
            // Режим чтения файла
            guard FileManager.default.fileExists(atPath: path) else {
                printError("File not found: \(path)")
                return
            }
            
            samples = loadAudioSamples(from: path)
            if samples == nil {
                printError("Failed to load audio file: \(path)")
                return
            }
        } else {
            printError("Usage: transcription-fluid <audio.wav> or transcription-fluid --samples [--model-cache-dir /path]")
            return
        }
        
        guard let audioSamples = samples else {
            printError("No audio samples")
            return
        }
        
        // Выполняем транскрипцию с FluidAudio
        do {
            // Используем Parakeet TDT v3 (multilingual, 25 European languages)
            fputs("[transcription-fluid] Loading Parakeet TDT v3 models...\n", stderr)
            let models = try await AsrModels.downloadAndLoad(version: .v3)
            
            fputs("[transcription-fluid] Initializing ASR manager...\n", stderr)
            let asrManager = AsrManager(config: .default)
            try await asrManager.initialize(models: models)
            
            // Выполняем транскрипцию
            fputs("[transcription-fluid] Starting transcription on \(audioSamples.count) samples (\(Double(audioSamples.count)/16000.0) sec)\n", stderr)
            let result = try await asrManager.transcribe(audioSamples)
            
            fputs("[transcription-fluid] Transcription completed: \"\(result.text)\"\n", stderr)
            fputs("[transcription-fluid] Confidence: \(result.confidence), RTFx: \(result.rtfx)\n", stderr)
            
            // Конвертируем результат в наш формат
            // Parakeet TDT возвращает весь текст целиком, создаём один сегмент
            var segments: [TranscriptionSegment] = []
            
            if !result.text.isEmpty {
                // Если есть tokenTimings, используем их для создания более детальных сегментов
                if let tokenTimings = result.tokenTimings, !tokenTimings.isEmpty {
                    // Группируем токены в предложения по паузам
                    var currentSegmentTokens: [TokenTiming] = []
                    // pauseThreshold передан из аргументов командной строки
                    
                    for (index, token) in tokenTimings.enumerated() {
                        currentSegmentTokens.append(token)
                        
                        // Проверяем паузу до следующего токена
                        let isLastToken = index == tokenTimings.count - 1
                        let hasLongPause = !isLastToken && tokenTimings[index + 1].startTime - token.endTime > pauseThreshold
                        
                        if isLastToken || hasLongPause {
                            // Создаём сегмент из накопленных токенов
                            let segmentText = currentSegmentTokens.map { $0.token }.joined()
                            let segmentStart = currentSegmentTokens.first!.startTime
                            let segmentEnd = currentSegmentTokens.last!.endTime
                            
                            segments.append(TranscriptionSegment(
                                start: segmentStart,
                                end: segmentEnd,
                                text: segmentText.trimmingCharacters(in: .whitespaces)
                            ))
                            
                            currentSegmentTokens.removeAll()
                        }
                    }
                } else {
                    // Нет tokenTimings - создаём один сегмент на всё аудио
                    segments.append(TranscriptionSegment(
                        start: 0.0,
                        end: result.duration,
                        text: result.text
                    ))
                }
                
                // Debug: выводим первые 5 сегментов
                for (index, segment) in segments.prefix(5).enumerated() {
                    fputs("[transcription-fluid] Segment[\(index)]: \(segment.start)s-\(segment.end)s: \"\(segment.text)\"\n", stderr)
                }
            }
            
            fputs("[transcription-fluid] Created \(segments.count) segments\n", stderr)
            
            let output = TranscriptionResult(
                segments: segments,
                language: nil, // Parakeet v3 автоопределяет язык, но не возвращает его в API
                model_version: "v3",
                error: nil
            )
            
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            if let data = try? encoder.encode(output),
               let json = String(data: data, encoding: .utf8) {
                print(json)
            }
            
        } catch {
            printError("Transcription failed: \(error.localizedDescription)")
        }
    }
}
