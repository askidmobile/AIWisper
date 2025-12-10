import Foundation
import FluidAudio

// diarization-fluid CLI
// Принимает WAV файл (16kHz mono), выводит JSON с сегментами спикеров
//
// Использование:
//   diarization-fluid <audio.wav>
//   diarization-fluid --samples  # читает float32 samples из stdin
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

@main
struct DiarizationCLI {
    static func main() async {
        let args = CommandLine.arguments
        
        var samples: [Float]?
        
        if args.count >= 2 {
            if args[1] == "--samples" {
                // Режим чтения из stdin
                samples = readSamplesFromStdin()
                if samples == nil {
                    printError("Failed to read samples from stdin")
                    return
                }
            } else {
                // Режим чтения файла
                let audioPath = args[1]
                
                guard FileManager.default.fileExists(atPath: audioPath) else {
                    printError("File not found: \(audioPath)")
                    return
                }
                
                samples = loadAudioSamples(from: audioPath)
                if samples == nil {
                    printError("Failed to load audio file: \(audioPath)")
                    return
                }
            }
        } else {
            printError("Usage: diarization-fluid <audio.wav> or diarization-fluid --samples")
            return
        }
        
        guard let audioSamples = samples else {
            printError("No audio samples")
            return
        }
        
        // Выполняем диаризацию с FluidAudio
        do {
            // Используем Offline pipeline (более точный, VBx clustering)
            // Параметры кластеризации VBx (оптимизированы для реальных записей):
            // - clusteringThreshold: 0.82 (стандарт FluidAudio 0.6 слишком склеивает)
            // - Fa: 0.07 (стандарт) - precision параметр PLDA
            // - Fb: 0.8 (стандарт) - recall параметр PLDA
            // 
            // Тестирование: c06f6e38 (4 спикера) → 4, d822227d (3-4 спикера) → 4
            let config = OfflineDiarizerConfig(
                clusteringThreshold: 0.82,  // Оптимизирован для разделения похожих голосов
                Fa: 0.07,                   // Стандарт FluidAudio
                Fb: 0.8,                    // Стандарт FluidAudio
                minSegmentDuration: 0.3     // Короткие реплики ОК
            )
            let manager = OfflineDiarizerManager(config: config)
            
            // Загружаем модели (скачиваются автоматически при первом запуске)
            try await manager.prepareModels()
            
            // Выполняем диаризацию
            fputs("[FluidAudio] Starting diarization on \(audioSamples.count) samples (\(Double(audioSamples.count)/16000.0) sec)\n", stderr)
            let result = try await manager.process(audio: audioSamples)
            
            fputs("[FluidAudio] Raw result: \(result.segments.count) segments\n", stderr)
            
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
                if idx < 10 {
                    fputs("[FluidAudio] Segment[\(idx)]: speaker=\(segment.speakerId) (\(speakerId)), start=\(segment.startTimeSeconds), end=\(segment.endTimeSeconds)\n", stderr)
                }
                
                segments.append(DiarizationSegment(
                    speaker: speakerId,
                    start: Double(segment.startTimeSeconds),
                    end: Double(segment.endTimeSeconds)
                ))
                speakerSet.insert(speakerId)
            }
            
            fputs("[FluidAudio] Final: \(segments.count) segments, \(speakerSet.count) unique speakers: \(speakerSet.sorted())\n", stderr)
            
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
