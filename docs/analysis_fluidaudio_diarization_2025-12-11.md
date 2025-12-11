# Системный анализ: Интеграция FluidAudio Offline Diarization в AIWisper

**Дата:** 2025-12-11 18:30
**Статус:** Completed
**Аналитик:** @analyst

---

## Контекст и стейкхолдеры

### Цель анализа
Оценить текущую интеграцию FluidAudio Offline Diarization и предложить улучшения для повышения качества диаризации в сценариях разговорного аудио (2-4 спикера).

### Заинтересованные стороны
- **Пользователи AIWisper**: Нуждаются в точном разделении спикеров в записях встреч/звонков
- **Разработчики**: Требуется гибкая настройка параметров без перекомпиляции

### Текущие проблемы (из контекста)
1. Иногда спикеры склеиваются (недостаточное разделение)
2. Короткие реплики могут теряться

---

## AS-IS (как сейчас)

### Текущая реализация

**Файл:** `backend/audio/diarization/Sources/main.swift`

```swift
let config = OfflineDiarizerConfig(
    clusteringThreshold: 0.82,  // Оптимизирован для разделения похожих голосов
    Fa: 0.07,                   // Стандарт FluidAudio
    Fb: 0.8,                    // Стандарт FluidAudio
    minSegmentDuration: 0.3     // Короткие реплики ОК
)
```

### Архитектура интеграции

```
Go Backend (diarization_fluid.go)
    │
    ├── NewFluidDiarizer() - инициализация
    │
    ├── Diarize(samples []float32) - через stdin (бинарные float32)
    │   └── subprocess: diarization-fluid --samples
    │
    └── DiarizeFile(audioPath) - через аргумент командной строки
        └── subprocess: diarization-fluid <audio.wav>
```

### Анализ текущих параметров

| Параметр | Текущее значение | Стандарт FluidAudio | Комментарий |
|----------|------------------|---------------------|-------------|
| `clusteringThreshold` | 0.82 | 0.6 | **Завышен** - может приводить к избыточному разделению |
| `Fa` | 0.07 | 0.07 | Стандарт - precision параметр PLDA |
| `Fb` | 0.8 | 0.8 | Стандарт - recall параметр PLDA |
| `minSegmentDuration` | 0.3 | - | Хорошо для коротких реплик |

### Выявленные проблемы

#### Проблема 1: Отсутствие настройки сегментации
Текущая реализация использует только 4 параметра из `OfflineDiarizerConfig`, игнорируя богатый API FluidAudio:

**Не используются:**
- `segmentation.windowDuration` (по умолчанию 10.0 сек)
- `segmentation.stepRatio` (по умолчанию 0.1)
- `segmentation.speechOnsetThreshold` / `speechOffsetThreshold`
- `embedding.batchSize`, `embedding.excludeOverlap`
- `vbx.maxIterations`, `vbx.convergenceTolerance`
- `postProcessing.minGapDuration`

#### Проблема 2: Жёсткая конфигурация
Параметры захардкожены в Swift коде. Для изменения требуется:
1. Редактирование `main.swift`
2. Перекомпиляция Swift binary
3. Перезапуск приложения

#### Проблема 3: Нет экспорта embeddings
FluidAudio поддерживает экспорт speaker embeddings через `export.embeddingsPath`, но это не используется. Embeddings полезны для:
- Идентификации известных спикеров
- Voiceprint matching
- Анализа качества кластеризации

#### Проблема 4: Нет диагностики
Отсутствует вывод метрик качества (DER, JER) и timing breakdown для отладки.

---

## TO-BE (как должно быть)

### 1. Расширенная конфигурация через CLI флаги

```swift
// Новые CLI аргументы
struct DiarizationCLI {
    // Segmentation
    @Option var windowDuration: Double = 10.0
    @Option var stepRatio: Double = 0.1
    @Option var speechOnsetThreshold: Double = 0.5
    @Option var speechOffsetThreshold: Double = 0.5
    
    // Embedding
    @Option var embeddingBatchSize: Int = 32
    @Option var excludeOverlap: Bool = true
    @Option var minSegmentDuration: Double = 0.3
    
    // Clustering
    @Option var clusteringThreshold: Double = 0.7
    @Option var warmStartFa: Double = 0.07
    @Option var warmStartFb: Double = 0.8
    
    // VBx
    @Option var vbxMaxIterations: Int = 20
    @Option var vbxConvergenceTolerance: Double = 1e-4
    
    // Post-processing
    @Option var minGapDuration: Double = 0.1
    
    // Export
    @Option var exportEmbeddings: String? = nil
}
```

### 2. Оптимальные параметры для разговорного аудио (2-4 спикера)

На основе документации FluidAudio и анализа проблем:

```swift
let config = OfflineDiarizerConfig(
    segmentation: SegmentationConfig(
        windowDuration: 10.0,           // Стандарт - хорошо для длинных записей
        stepRatio: 0.1,                 // 1 сек шаг - баланс точности/скорости
        speechOnsetThreshold: 0.6,      // Чуть выше стандарта для чистой речи
        speechOffsetThreshold: 0.4,     // Ниже для захвата окончаний фраз
        minOnDuration: 0.1,             // Минимум 100мс речи
        minOffDuration: 0.1             // Минимум 100мс тишины
    ),
    embedding: EmbeddingConfig(
        batchSize: 32,                  // Стандарт
        excludeOverlap: true,           // Важно для powerset модели
        minSegmentDuration: 0.2         // Снижено для коротких реплик
    ),
    clustering: ClusteringConfig(
        threshold: 0.70,                // СНИЖЕНО с 0.82 - меньше разделения
        warmStartFa: 0.07,              // Стандарт
        warmStartFb: 0.8                // Стандарт
    ),
    vbx: VBxConfig(
        maxIterations: 30,              // Увеличено для лучшей сходимости
        convergenceTolerance: 1e-5      // Строже для точности
    ),
    postProcessing: PostProcessingConfig(
        minGapDuration: 0.15            // 150мс минимум между сегментами
    )
)
```

### 3. Обоснование изменений параметров

| Параметр | Было | Стало | Обоснование |
|----------|------|-------|-------------|
| `clusteringThreshold` | 0.82 | 0.70 | 0.82 слишком агрессивно разделяет похожие голоса. 0.70 - баланс |
| `speechOnsetThreshold` | default | 0.6 | Выше порог = меньше ложных срабатываний на шум |
| `speechOffsetThreshold` | default | 0.4 | Ниже порог = лучше захватывает окончания фраз |
| `minSegmentDuration` | 0.3 | 0.2 | Снижено для коротких реплик ("угу", "да") |
| `vbxMaxIterations` | default | 30 | Больше итераций = лучше кластеризация |
| `minGapDuration` | default | 0.15 | Предотвращает склеивание близких сегментов |

---

## Сценарии использования

### UC-1: Стандартная диаризация (текущий режим)
```bash
diarization-fluid audio.wav
```
Использует оптимизированные параметры по умолчанию.

### UC-2: Агрессивное разделение спикеров
```bash
diarization-fluid audio.wav \
    --clustering-threshold 0.85 \
    --min-segment-duration 0.1
```
Для записей с очень похожими голосами.

### UC-3: Консервативное объединение
```bash
diarization-fluid audio.wav \
    --clustering-threshold 0.55 \
    --min-gap-duration 0.3
```
Для записей с чётко различимыми голосами.

### UC-4: Экспорт embeddings для voiceprint
```bash
diarization-fluid audio.wav \
    --export-embeddings embeddings.json
```
Для последующей идентификации спикеров.

### UC-5: Отладка качества
```bash
diarization-fluid audio.wav --debug
```
Выводит timing breakdown и метрики.

---

## Глоссарий

| Термин | Определение |
|--------|-------------|
| VBx | Variational Bayes x-vector clustering - алгоритм кластеризации спикеров |
| PLDA | Probabilistic Linear Discriminant Analysis - модель для сравнения embeddings |
| Fa/Fb | Параметры PLDA: Fa - precision, Fb - recall |
| DER | Diarization Error Rate - метрика качества диаризации |
| JER | Jaccard Error Rate - альтернативная метрика |
| Powerset | Модель сегментации, предсказывающая комбинации активных спикеров |
| Embedding | 256-мерный вектор, представляющий голос спикера |
| WeSpeaker | Модель извлечения speaker embeddings |

---

## Качественные атрибуты (черновик)

### Точность
- DER < 20% для записей с 2-4 спикерами
- Короткие реплики (< 1 сек) не должны теряться в > 90% случаев

### Производительность
- RTFx > 100x на Apple Silicon (M1+)
- Время обработки 1 часа аудио < 1 минуты

### Гибкость
- Все ключевые параметры настраиваются через CLI
- Возможность экспорта embeddings для внешних систем

---

## Данные и интеграции

### Входные данные
- WAV файл (16kHz mono) или float32 samples через stdin
- CLI параметры конфигурации

### Выходные данные
```json
{
    "segments": [
        {"speaker": 0, "start": 0.5, "end": 2.3},
        {"speaker": 1, "start": 2.5, "end": 5.1}
    ],
    "num_speakers": 2,
    "embeddings": {
        "SPEAKER_00": [0.123, -0.456, ...],
        "SPEAKER_01": [0.789, -0.012, ...]
    },
    "timings": {
        "segmentation_ms": 150,
        "embedding_ms": 200,
        "clustering_ms": 50,
        "total_ms": 400
    }
}
```

### Интеграция с Go backend
- `FluidDiarizer.Diarize()` - передаёт samples через stdin
- `FluidDiarizer.DiarizeFile()` - передаёт путь к файлу
- Парсинг JSON результата

---

## Ограничения и предположения

### Ограничения
1. Только macOS (CoreML/ANE)
2. Требуется FluidAudio >= 0.7.9
3. Offline режим (не streaming)

### Предположения
1. Аудио уже конвертировано в 16kHz mono
2. 2-4 спикера в записи
3. Минимальное перекрытие речи

---

## Открытые вопросы и риски

| # | Вопрос/Риск | Приоритет | Следующее действие |
|---|-------------|-----------|-------------------|
| 1 | Как влияет снижение threshold с 0.82 до 0.70 на реальные записи? | Высокий | A/B тестирование на 10+ записях |
| 2 | Нужен ли streaming режим диаризации? | Средний | Оценить latency требования |
| 3 | Как интегрировать embeddings с voiceprint системой? | Средний | Согласовать формат с @architect |
| 4 | Совместимость с FluidAudio 0.8.x | Низкий | Мониторинг релизов |

---

## Рекомендуемые изменения кода

### 1. Обновлённый main.swift с CLI флагами

```swift
import Foundation
import FluidAudio
import ArgumentParser

@main
struct DiarizationCLI: AsyncParsableCommand {
    static var configuration = CommandConfiguration(
        commandName: "diarization-fluid",
        abstract: "FluidAudio Offline Diarization CLI"
    )
    
    // Input
    @Argument(help: "Audio file path (WAV 16kHz mono)")
    var audioPath: String?
    
    @Flag(name: .long, help: "Read float32 samples from stdin")
    var samples: Bool = false
    
    // Segmentation
    @Option(name: .long, help: "Segmentation window duration (seconds)")
    var windowDuration: Double = 10.0
    
    @Option(name: .long, help: "Segmentation step ratio (0.0-1.0)")
    var stepRatio: Double = 0.1
    
    @Option(name: .long, help: "Speech onset threshold (0.0-1.0)")
    var speechOnsetThreshold: Double = 0.6
    
    @Option(name: .long, help: "Speech offset threshold (0.0-1.0)")
    var speechOffsetThreshold: Double = 0.4
    
    // Embedding
    @Option(name: .long, help: "Minimum segment duration for embedding (seconds)")
    var minSegmentDuration: Double = 0.2
    
    @Option(name: .long, help: "Embedding batch size")
    var embeddingBatchSize: Int = 32
    
    @Flag(name: .long, inversion: .prefixedNo, help: "Exclude overlapping speech from embeddings")
    var excludeOverlap: Bool = true
    
    // Clustering
    @Option(name: .long, help: "Clustering threshold (0.0-1.0)")
    var clusteringThreshold: Double = 0.70
    
    @Option(name: .long, help: "PLDA Fa parameter (precision)")
    var fa: Double = 0.07
    
    @Option(name: .long, help: "PLDA Fb parameter (recall)")
    var fb: Double = 0.8
    
    // VBx
    @Option(name: .long, help: "VBx max iterations")
    var vbxMaxIterations: Int = 30
    
    @Option(name: .long, help: "VBx convergence tolerance")
    var vbxConvergenceTolerance: Double = 1e-5
    
    // Post-processing
    @Option(name: .long, help: "Minimum gap duration between segments (seconds)")
    var minGapDuration: Double = 0.15
    
    // Export
    @Option(name: .long, help: "Export embeddings to JSON file")
    var exportEmbeddings: String?
    
    @Flag(name: .long, help: "Enable debug output")
    var debug: Bool = false
    
    mutating func run() async throws {
        var audioSamples: [Float]?
        
        if samples {
            audioSamples = readSamplesFromStdin()
            guard audioSamples != nil else {
                printError("Failed to read samples from stdin")
                return
            }
        } else if let path = audioPath {
            guard FileManager.default.fileExists(atPath: path) else {
                printError("File not found: \(path)")
                return
            }
            audioSamples = loadAudioSamples(from: path)
            guard audioSamples != nil else {
                printError("Failed to load audio file: \(path)")
                return
            }
        } else {
            printError("Usage: diarization-fluid <audio.wav> or diarization-fluid --samples")
            return
        }
        
        guard let samples = audioSamples else {
            printError("No audio samples")
            return
        }
        
        // Build configuration from CLI arguments
        let config = OfflineDiarizerConfig(
            segmentation: SegmentationConfig(
                windowDuration: windowDuration,
                stepRatio: stepRatio,
                speechOnsetThreshold: speechOnsetThreshold,
                speechOffsetThreshold: speechOffsetThreshold
            ),
            embedding: EmbeddingConfig(
                batchSize: embeddingBatchSize,
                excludeOverlap: excludeOverlap,
                minSegmentDuration: minSegmentDuration
            ),
            clustering: ClusteringConfig(
                threshold: clusteringThreshold,
                warmStartFa: fa,
                warmStartFb: fb
            ),
            vbx: VBxConfig(
                maxIterations: vbxMaxIterations,
                convergenceTolerance: vbxConvergenceTolerance
            ),
            postProcessing: PostProcessingConfig(
                minGapDuration: minGapDuration
            ),
            export: exportEmbeddings != nil ? ExportConfig(embeddingsPath: exportEmbeddings) : nil
        )
        
        do {
            let manager = OfflineDiarizerManager(config: config)
            try await manager.prepareModels()
            
            if debug {
                fputs("[FluidAudio] Config: threshold=\(clusteringThreshold), minSeg=\(minSegmentDuration), vbxIter=\(vbxMaxIterations)\n", stderr)
                fputs("[FluidAudio] Starting diarization on \(samples.count) samples (\(Double(samples.count)/16000.0) sec)\n", stderr)
            }
            
            let result = try await manager.process(audio: samples)
            
            // Convert to output format
            var segments: [DiarizationSegment] = []
            var speakerSet = Set<Int>()
            
            for segment in result.segments {
                let speakerId = extractSpeakerId(from: segment.speakerId)
                segments.append(DiarizationSegment(
                    speaker: speakerId,
                    start: Double(segment.startTimeSeconds),
                    end: Double(segment.endTimeSeconds)
                ))
                speakerSet.insert(speakerId)
            }
            
            // Build output
            var output = DiarizationResult(
                segments: segments,
                num_speakers: speakerSet.count,
                error: nil
            )
            
            // Add embeddings if requested
            if let embeddings = result.speakerDatabase {
                output.embeddings = embeddings
            }
            
            // Add timings if debug
            if debug, let timings = result.timings {
                output.timings = TimingsOutput(
                    segmentation_ms: Int(timings.segmentation * 1000),
                    embedding_ms: Int(timings.embedding * 1000),
                    clustering_ms: Int(timings.clustering * 1000),
                    total_ms: Int(timings.total * 1000)
                )
            }
            
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

// Output structures
struct DiarizationSegment: Codable {
    let speaker: Int
    let start: Double
    let end: Double
}

struct TimingsOutput: Codable {
    let segmentation_ms: Int
    let embedding_ms: Int
    let clustering_ms: Int
    let total_ms: Int
}

struct DiarizationResult: Codable {
    let segments: [DiarizationSegment]
    let num_speakers: Int
    let error: String?
    var embeddings: [String: [Float]]?
    var timings: TimingsOutput?
}

// Helper functions
func extractSpeakerId(from speakerString: String) -> Int {
    if let match = speakerString.range(of: #"\d+"#, options: .regularExpression) {
        return Int(speakerString[match]) ?? 0
    }
    return 0
}

func printError(_ message: String) {
    let result = DiarizationResult(segments: [], num_speakers: 0, error: message)
    if let data = try? JSONEncoder().encode(result),
       let json = String(data: data, encoding: .utf8) {
        print(json)
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
    var samples: [Float] = []
    let bufferSize = 4096
    var buffer = [UInt8](repeating: 0, count: bufferSize)
    
    while true {
        let bytesRead = fread(&buffer, 1, bufferSize, stdin)
        if bytesRead == 0 { break }
        
        let floatCount = bytesRead / 4
        for i in 0..<floatCount {
            let offset = i * 4
            let value = buffer[offset..<offset+4].withUnsafeBytes { $0.load(as: Float.self) }
            samples.append(value)
        }
    }
    
    return samples.isEmpty ? nil : samples
}
```

### 2. Обновлённый Package.swift

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "diarization-fluid",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.7.9"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.3.0"),
    ],
    targets: [
        .executableTarget(
            name: "diarization-fluid",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources"
        )
    ]
)
```

### 3. Обновление Go backend для поддержки параметров

```go
// FluidDiarizerConfig расширенная конфигурация
type FluidDiarizerConfig struct {
    BinaryPath string
    
    // Clustering
    ClusteringThreshold float64
    Fa                  float64
    Fb                  float64
    
    // Segmentation
    MinSegmentDuration float64
    
    // VBx
    VBxMaxIterations int
    
    // Export
    ExportEmbeddings bool
    
    // Debug
    Debug bool
}

// DefaultFluidDiarizerConfig возвращает оптимальные параметры
func DefaultFluidDiarizerConfig() FluidDiarizerConfig {
    return FluidDiarizerConfig{
        ClusteringThreshold: 0.70,
        Fa:                  0.07,
        Fb:                  0.8,
        MinSegmentDuration:  0.2,
        VBxMaxIterations:    30,
        ExportEmbeddings:    false,
        Debug:               false,
    }
}

// Diarize с поддержкой параметров
func (d *FluidDiarizer) DiarizeWithConfig(samples []float32, cfg FluidDiarizerConfig) ([]SpeakerSegment, map[string][]float32, error) {
    args := []string{"--samples"}
    
    if cfg.ClusteringThreshold > 0 {
        args = append(args, "--clustering-threshold", fmt.Sprintf("%.2f", cfg.ClusteringThreshold))
    }
    if cfg.MinSegmentDuration > 0 {
        args = append(args, "--min-segment-duration", fmt.Sprintf("%.2f", cfg.MinSegmentDuration))
    }
    if cfg.VBxMaxIterations > 0 {
        args = append(args, "--vbx-max-iterations", fmt.Sprintf("%d", cfg.VBxMaxIterations))
    }
    if cfg.ExportEmbeddings {
        args = append(args, "--export-embeddings", "-") // stdout
    }
    if cfg.Debug {
        args = append(args, "--debug")
    }
    
    cmd := exec.Command(d.binaryPath, args...)
    // ... rest of implementation
}
```

---

## Хэндовер для @architect и @planner

### Ключевые артефакты
1. Анализ текущих параметров и их влияния на качество
2. Рекомендуемые оптимальные параметры для 2-4 спикеров
3. Код расширенного CLI с ArgumentParser
4. Обновлённый Go backend с поддержкой параметров

### Области требующие особого внимания
1. **A/B тестирование**: Необходимо протестировать новые параметры на реальных записях
2. **Обратная совместимость**: CLI должен работать без аргументов (defaults)
3. **Интеграция embeddings**: Формат экспорта должен быть согласован с voiceprint системой

### Рекомендуемый план реализации
1. Добавить swift-argument-parser в Package.swift
2. Переписать main.swift с поддержкой CLI флагов
3. Обновить Go backend для передачи параметров
4. Провести A/B тестирование на 10+ записях
5. Документировать оптимальные пресеты для разных сценариев

### Приоритеты
1. **Высокий**: Снижение clusteringThreshold до 0.70
2. **Высокий**: Добавление CLI флагов для основных параметров
3. **Средний**: Экспорт embeddings
4. **Низкий**: Debug режим с timings
