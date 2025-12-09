// main.swift
// CLI утилита для захвата системного аудио через Core Audio Process Tap
// macOS 14.2+: использует AudioHardwareCreateProcessTap
//
// Режимы:
//   system - только системный звук (маркер 'S')
//
// Формат вывода:
//   [маркер 1 байт][размер 4 байта little-endian][float32 данные]
//   Маркер: 'S' (0x53) = системный звук

import Foundation
import CoreAudio
import AudioToolbox

// MARK: - Протокол вывода (идентичен screencapture)

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

// MARK: - Core Audio Tap

@available(macOS 14.2, *)
class CoreAudioTap: NSObject {
    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    private var ioProcID: AudioDeviceIOProcID?
    private var isRunning = false
    private let outputQueue = DispatchQueue(label: "audio.output", qos: .userInteractive)
    private var tapDescription: CATapDescription?
    private var realChannelCount: UInt32 = 2
    private let targetSampleRate: Double = 48_000
    private var deviceSampleRate: Double = 48_000

    override init() {
        super.init()
    }

    func start() throws {
        // Создаём tap description для всего системного звука
        // Передаём пустой массив для захвата всех процессов
        let processes: [AudioObjectID] = []

        // Используем stereo global tap исключая пустой список = захватываем всё
        let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: processes)

        tapDescription = tapDesc

        // Настраиваем tap
        tapDesc.muteBehavior = CATapMuteBehavior.unmuted  // НЕ заглушаем оригинальный звук!
        tapDesc.name = "AIWisper System Audio Tap"
        tapDesc.isPrivate = true
        tapDesc.isExclusive = true  // Исключаем процессы из списка (пустой = ничего не исключаем)

        fputs("Creating stereo global tap...\n", stderr)

        // Создаём tap
        var tapIDOut: AudioObjectID = kAudioObjectUnknown
        let status = AudioHardwareCreateProcessTap(tapDesc, &tapIDOut)

        guard status == noErr else {
            throw NSError(domain: "CoreAudioTap", code: Int(status),
                         userInfo: [NSLocalizedDescriptionKey: "Failed to create process tap: \(status)"])
        }

        tapID = tapIDOut
        fputs("Process tap created: \(tapID)\n", stderr)

        // Получаем UUID для создания aggregate device
        let tapUUID = tapDesc.uuid.uuidString
        fputs("Tap UUID: \(tapUUID)\n", stderr)

        // Определяем реальное количество каналов default output device
        realChannelCount = getDefaultOutputChannelCount()
        fputs("Default output device channels: \(realChannelCount)\n", stderr)

        // Создаём aggregate device с tap
        try createAggregateDevice(tapUUID: tapUUID)

        // Принудительно ставим 48 kHz чтобы совпадать с микрофоном/FFmpeg
        setAggregateDeviceSampleRate(targetSampleRate)
        deviceSampleRate = readAggregateSampleRate()
        fputs("Aggregate device sample rate: \(deviceSampleRate) Hz (target \(targetSampleRate))\n", stderr)

        // Настраиваем IO callback
        try setupIOProc()

        isRunning = true
        fputs("READY mode=system\n", stderr)
    }

    private func getDefaultOutputChannelCount() -> UInt32 {
        var deviceID: AudioDeviceID = kAudioObjectUnknown
        var propertySize = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                               &address, 0, nil, &propertySize, &deviceID)
        guard status == noErr else { return 2 }

        // Получаем stream configuration
        address.mSelector = kAudioDevicePropertyStreamConfiguration
        address.mScope = kAudioObjectPropertyScopeOutput

        // Сначала узнаём размер
        status = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &propertySize)
        guard status == noErr else { return 2 }

        // Выделяем память под AudioBufferList
        let bufferListPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(propertySize))
        defer { bufferListPtr.deallocate() }

        status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &propertySize, bufferListPtr)
        guard status == noErr else { return 2 }

        // Считаем общее количество каналов
        let bufferList = bufferListPtr.pointee
        return bufferList.mBuffers.mNumberChannels
    }

    private func createAggregateDevice(tapUUID: String) throws {
        let tapDict: [String: Any] = [
            kAudioSubTapUIDKey as String: tapUUID,
            kAudioSubTapDriftCompensationKey as String: true
        ]

        let deviceDict: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "AIWisperAggregateDevice",
            kAudioAggregateDeviceUIDKey as String: "com.aiwisper.aggregate.tap",
            kAudioAggregateDeviceTapListKey as String: [tapDict],
            kAudioAggregateDeviceTapAutoStartKey as String: false,
            kAudioAggregateDeviceIsPrivateKey as String: true
        ]

        var deviceIDOut: AudioObjectID = kAudioObjectUnknown
        let status = AudioHardwareCreateAggregateDevice(deviceDict as CFDictionary, &deviceIDOut)

        guard status == noErr else {
            if status == 1852797029 {
                throw NSError(domain: "CoreAudioTap", code: Int(status),
                             userInfo: [NSLocalizedDescriptionKey: "Aggregate device already exists"])
            }
            throw NSError(domain: "CoreAudioTap", code: Int(status),
                         userInfo: [NSLocalizedDescriptionKey: "Failed to create aggregate device: \(status)"])
        }

        aggregateDeviceID = deviceIDOut
        fputs("Aggregate device created: \(aggregateDeviceID)\n", stderr)
    }

    private func readAggregateSampleRate() -> Double {
        var rate = targetSampleRate
        var size = UInt32(MemoryLayout<Double>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectGetPropertyData(aggregateDeviceID, &address, 0, nil, &size, &rate)
        if status != noErr || rate <= 0 {
            fputs("Warning: Failed to read aggregate sample rate (status \(status)), using target \(targetSampleRate)\n", stderr)
            return targetSampleRate
        }

        return rate
    }

    private func setAggregateDeviceSampleRate(_ rate: Double) {
        var rate = rate
        var size = UInt32(MemoryLayout<Double>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectSetPropertyData(aggregateDeviceID, &address, 0, nil, size, &rate)
        if status != noErr {
            fputs("Warning: Failed to set aggregate sample rate to \(rate): \(status)\n", stderr)
        } else {
            fputs("Aggregate device sample rate set to \(rate) Hz\n", stderr)
        }
    }

    private func setupIOProc() throws {
        // Создаём контекст для callback
        let contextPtr = Unmanaged.passUnretained(self).toOpaque()

        var ioProcIDOut: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcID(aggregateDeviceID, ioCallback, contextPtr, &ioProcIDOut)

        guard status == noErr, let procID = ioProcIDOut else {
            throw NSError(domain: "CoreAudioTap", code: Int(status),
                         userInfo: [NSLocalizedDescriptionKey: "Failed to create IO proc: \(status)"])
        }

        ioProcID = procID

        // Запускаем
        let startStatus = AudioDeviceStart(aggregateDeviceID, procID)
        guard startStatus == noErr else {
            throw NSError(domain: "CoreAudioTap", code: Int(startStatus),
                         userInfo: [NSLocalizedDescriptionKey: "Failed to start device: \(startStatus)"])
        }

        fputs("IO proc started\n", stderr)
    }

    func stop() {
        fputs("Stopping Core Audio tap...\n", stderr)
        isRunning = false

        // Останавливаем device
        if let procID = ioProcID {
            AudioDeviceStop(aggregateDeviceID, procID)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, procID)
            ioProcID = nil
            fputs("IO proc stopped\n", stderr)
        }

        // Уничтожаем aggregate device
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
            fputs("Aggregate device destroyed\n", stderr)
        }

        // Уничтожаем tap
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
            fputs("Process tap destroyed\n", stderr)
        }

        tapDescription = nil
        fputs("Core Audio tap cleanup complete\n", stderr)
    }

    // Обработка аудио данных
    fileprivate func processAudio(inputData: UnsafePointer<AudioBufferList>) {
        guard isRunning else { return }

        let bufferList = inputData.pointee
        let buffer = bufferList.mBuffers

        guard buffer.mDataByteSize > 0, let data = buffer.mData else { return }

        let floatPtr = data.assumingMemoryBound(to: Float.self)
        let numChannels = Int(buffer.mNumberChannels)
        let numFrames = Int(buffer.mDataByteSize) / (MemoryLayout<Float>.size * numChannels)

        // Конвертируем в моно
        var monoSamples = [Float](repeating: 0, count: numFrames)

        if numChannels >= 2 {
            // Интерливированное стерео -> моно
            // Компенсация громкости для устройств с >2 каналами
            let compensation: Float = realChannelCount > 2 ? Float(realChannelCount - 2) : 1.0

            for i in 0..<numFrames {
                let left = floatPtr[i * numChannels]
                let right = floatPtr[i * numChannels + 1]
                monoSamples[i] = (left + right) * 0.5 * compensation
            }
        } else {
            for i in 0..<numFrames {
                monoSamples[i] = floatPtr[i]
            }
        }

        // Приводим поток к 48 kHz, иначе при 44.1 kHz слышны щелчки и «замедление» из-за рассинхрона с микрофоном
        let sourceRate = deviceSampleRate
        let outputSamples: [Float]
        if abs(sourceRate - targetSampleRate) > 1 {
            outputSamples = resample(monoSamples, from: sourceRate, to: targetSampleRate)
        } else {
            outputSamples = monoSamples
        }

        outputQueue.async {
            writeChannelData(marker: 0x53, samples: outputSamples) // 'S' = system
        }
    }

    private func resample(_ samples: [Float], from fromRate: Double, to toRate: Double) -> [Float] {
        guard fromRate > 0, toRate > 0, fromRate != toRate else { return samples }

        let ratio = fromRate / toRate
        let newLength = Int(Double(samples.count) / ratio)
        if newLength <= 1 { return samples }

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
}

// IO Callback (C function)
@available(macOS 14.2, *)
private let ioCallback: AudioDeviceIOProc = { (
    inDevice: AudioObjectID,
    inNow: UnsafePointer<AudioTimeStamp>,
    inInputData: UnsafePointer<AudioBufferList>,
    inInputTime: UnsafePointer<AudioTimeStamp>,
    outOutputData: UnsafeMutablePointer<AudioBufferList>,
    inOutputTime: UnsafePointer<AudioTimeStamp>,
    inClientData: UnsafeMutableRawPointer?
) -> OSStatus in

    guard let clientData = inClientData else { return noErr }
    let tap = Unmanaged<CoreAudioTap>.fromOpaque(clientData).takeUnretainedValue()
    tap.processAudio(inputData: inInputData)
    return noErr
}

// MARK: - Main

@main
@available(macOS 14.2, *)
struct CoreAudioTapMain {
    static var tap: CoreAudioTap?

    static func main() {
        // Проверяем версию macOS
        guard #available(macOS 14.2, *) else {
            fputs("ERROR: Core Audio Process Tap requires macOS 14.2 or later\n", stderr)
            exit(1)
        }

        // Настраиваем signal handlers
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)

        let signalQueue = DispatchQueue(label: "signal.handler", qos: .userInteractive)

        let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
        sigintSource.setEventHandler {
            Self.tap?.stop()
            Thread.sleep(forTimeInterval: 0.3)
            exit(0)
        }
        sigintSource.resume()

        let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
        sigtermSource.setEventHandler {
            Self.tap?.stop()
            Thread.sleep(forTimeInterval: 0.3)
            exit(0)
        }
        sigtermSource.resume()

        // Создаём и запускаем tap
        do {
            let coreTap = CoreAudioTap()
            Self.tap = coreTap
            try coreTap.start()

            // Бесконечный цикл
            RunLoop.current.run()
        } catch {
            fputs("ERROR: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}
