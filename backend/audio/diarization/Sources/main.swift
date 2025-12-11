import Foundation
import FluidAudio

// diarization-fluid CLI
// Принимает WAV файл (16kHz mono), выводит JSON с сегментами спикеров
//
// Использование:
//   diarization-fluid <audio.wav>
//   diarization-fluid --samples  # читает float32 samples из stdin
//   diarization-fluid --samples --clustering-threshold 0.70
//   diarization-fluid --samples --min-segment-duration 0.2
//   diarization-fluid --samples --vbx-max-iterations 30
//   diarization-fluid --samples --debug
//
// Параметры:
//   --clustering-threshold <0.0-1.0>  Порог кластеризации (default: 0.70)
//   --min-segment-duration <sec>      Мин. длительность сегмента (default: 0.2)
//   --vbx-max-iterations <int>        Макс. итераций VBx (default: 30)
//   --min-gap-duration <sec>          Мин. пауза между сегментами (default: 0.15)
//   --debug                           Включить отладочный вывод
//
// Вывод (JSON):
// {
//   "segments": [
//     {"speaker": 0, "start": 0.5, "end": 2.3},
//     {"speaker": 1, "start": 2.5, "end": 5.1}
//   ],
//   "num_speakers": 2
// }

struct DiarizationSegment: Codable {
    let speaker: Int
    let start: Double
    let end: Double
}

struct DiarizationResult: Codable {
    let segments: [DiarizationSegment]
    let num_speakers: Int
    let error: String?
}

func printError(_ message: String) {
    let result = DiarizationResult(segments: [], num_speakers: 0, error: message)
    if let data = try? JSONEncoder().encode(result),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"segments\":[], \"num_speakers\":0, \"error\":\"\(message)\"}")
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

// Конфигурация диаризации с параметрами по умолчанию
struct DiarizationConfig {
    var clusteringThreshold: Double = 0.70  // Снижено с 0.82 для лучшего баланса
    var minSegmentDuration: Double = 0.2    // Снижено с 0.3 для коротких реплик
    var vbxMaxIterations: Int = 30          // Увеличено с 20 для лучшей сходимости
    var minGapDuration: Double = 0.15       // Мин. пауза между сегментами
    var fa: Double = 0.07                   // PLDA precision
    var fb: Double = 0.8                    // PLDA recall
    var debug: Bool = false
}

@main
struct DiarizationCLI {
    static func main() async {
        let args = CommandLine.arguments
        
        var samples: [Float]?
        var config = DiarizationConfig()
        var isStdinMode = false
        var audioPath: String?
        
        // Парсим аргументы
        var i = 1
        while i < args.count {
            let arg = args[i]
            
            if arg == "--samples" {
                isStdinMode = true
            } else if arg == "--clustering-threshold" {
                if i + 1 < args.count, let value = Double(args[i + 1]) {
                    config.clusteringThreshold = value
                    i += 1
                }
            } else if arg == "--min-segment-duration" {
                if i + 1 < args.count, let value = Double(args[i + 1]) {
                    config.minSegmentDuration = value
                    i += 1
                }
            } else if arg == "--vbx-max-iterations" {
                if i + 1 < args.count, let value = Int(args[i + 1]) {
                    config.vbxMaxIterations = value
                    i += 1
                }
            } else if arg == "--min-gap-duration" {
                if i + 1 < args.count, let value = Double(args[i + 1]) {
                    config.minGapDuration = value
                    i += 1
                }
            } else if arg == "--fa" {
                if i + 1 < args.count, let value = Double(args[i + 1]) {
                    config.fa = value
                    i += 1
                }
            } else if arg == "--fb" {
                if i + 1 < args.count, let value = Double(args[i + 1]) {
                    config.fb = value
                    i += 1
                }
            } else if arg == "--debug" {
                config.debug = true
            } else if !arg.hasPrefix("--") {
                audioPath = arg
            }
            
            i += 1
        }
        
        // Загружаем аудио
        if isStdinMode {
            samples = readSamplesFromStdin()
            if samples == nil {
                printError("Failed to read samples from stdin")
                return
            }
        } else if let path = audioPath {
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
            printError("Usage: diarization-fluid <audio.wav> or diarization-fluid --samples [options]")
            return
        }
        
        guard let audioSamples = samples else {
            printError("No audio samples")
            return
        }
        
        // Выполняем диаризацию с FluidAudio
        do {
            // Используем Offline pipeline (VBx clustering)
            // Параметры оптимизированы для разговорного аудио (2-4 спикера)
            let offlineConfig = OfflineDiarizerConfig(
                clusteringThreshold: config.clusteringThreshold,
                Fa: config.fa,
                Fb: config.fb,
                minSegmentDuration: config.minSegmentDuration,
                minGapDuration: config.minGapDuration,
                maxVBxIterations: config.vbxMaxIterations
            )
            let manager = OfflineDiarizerManager(config: offlineConfig)
            
            if config.debug {
                fputs("[FluidAudio] Config: threshold=\(config.clusteringThreshold), minSeg=\(config.minSegmentDuration), vbxIter=\(config.vbxMaxIterations), minGap=\(config.minGapDuration)\n", stderr)
            }
            
            // Загружаем модели (скачиваются автоматически при первом запуске)
            try await manager.prepareModels()
            
            // Выполняем диаризацию
            let audioDuration = Double(audioSamples.count) / 16000.0
            if config.debug {
                fputs("[FluidAudio] Starting diarization on \(audioSamples.count) samples (\(audioDuration) sec)\n", stderr)
            }
            
            let startTime = Date()
            let result = try await manager.process(audio: audioSamples)
            let elapsed = Date().timeIntervalSince(startTime)
            
            if config.debug {
                fputs("[FluidAudio] Completed in \(String(format: "%.2f", elapsed))s (RTFx: \(String(format: "%.1f", audioDuration / elapsed)))\n", stderr)
                fputs("[FluidAudio] Raw result: \(result.segments.count) segments\n", stderr)
            }
            
            // Конвертируем результат в наш формат
            var segments: [DiarizationSegment] = []
            var speakerSet = Set<Int>()
            
            for (idx, segment) in result.segments.enumerated() {
                // FluidAudio использует строковые ID вида "SPEAKER_00"
                // Извлекаем числовой ID
                let speakerId: Int
                if let match = segment.speakerId.range(of: #"\d+"#, options: .regularExpression) {
                    speakerId = Int(segment.speakerId[match]) ?? 0
                } else {
                    speakerId = 0
                }
                
                // Debug: выводим первые 10 сегментов
                if config.debug && idx < 10 {
                    fputs("[FluidAudio] Segment[\(idx)]: speaker=\(segment.speakerId) (\(speakerId)), start=\(segment.startTimeSeconds), end=\(segment.endTimeSeconds)\n", stderr)
                }
                
                segments.append(DiarizationSegment(
                    speaker: speakerId,
                    start: Double(segment.startTimeSeconds),
                    end: Double(segment.endTimeSeconds)
                ))
                speakerSet.insert(speakerId)
            }
            
            if config.debug {
                fputs("[FluidAudio] Final: \(segments.count) segments, \(speakerSet.count) unique speakers: \(speakerSet.sorted())\n", stderr)
            }
            
            let output = DiarizationResult(
                segments: segments,
                num_speakers: speakerSet.count,
                error: nil
            )
            
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            if let data = try? encoder.encode(output),
               let json = String(data: data, encoding: .utf8) {
                print(json)
            }
            
        } catch {
            printError("Diarization failed: \(error.localizedDescription)")
        }
    }
}
