package audio

import (
	"fmt"
	"log"
	"math"
	"strings"
	"sync"

	"github.com/gen2brain/malgo"
)

// DeviceID - алиас для malgo.DeviceID
type DeviceID = malgo.DeviceID

// AudioDevice представляет аудио устройство
type AudioDevice struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	IsInput  bool   `json:"isInput"`
	IsOutput bool   `json:"isOutput"`
}

// AudioChannel представляет источник аудио (микрофон или системный звук)
type AudioChannel int

const (
	ChannelMicrophone AudioChannel = iota
	ChannelSystem
)

// ChannelData содержит аудио данные с указанием канала
type ChannelData struct {
	Channel AudioChannel
	Samples []float32
}

// SystemCaptureMethod определяет метод захвата системного звука на macOS
type SystemCaptureMethod int

const (
	// SystemCaptureBlackHole использует BlackHole/loopback устройство
	SystemCaptureBlackHole SystemCaptureMethod = iota
	// SystemCaptureScreenKit использует ScreenCaptureKit (macOS 13+)
	SystemCaptureScreenKit
	// SystemCaptureCoreAudioTap использует Core Audio Process Tap (macOS 14.2+)
	// Преимущества: меньше overhead, лучше совместимость с другими приложениями
	SystemCaptureCoreAudioTap
)

// Capture управляет захватом аудио с микрофона и системного звука
type Capture struct {
	ctx *malgo.AllocatedContext

	micDevice    *malgo.Device
	systemDevice *malgo.Device

	micDeviceID    *malgo.DeviceID
	systemDeviceID *malgo.DeviceID

	stopChan chan struct{}
	dataChan chan ChannelData
	mu       sync.Mutex
	running  bool

	// Настройки
	captureSystem       bool                // Захватывать ли системный звук
	useScreenCaptureKit bool                // Использовать ScreenCaptureKit для системного звука (macOS 13+)
	useCoreAudioTap     bool                // Использовать Core Audio tap (macOS 14.2+)
	systemCaptureMethod SystemCaptureMethod // Метод захвата системного звука
}

func NewCapture() (*Capture, error) {
	ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, err
	}

	return &Capture{
		ctx:      ctx,
		stopChan: make(chan struct{}),
		dataChan: make(chan ChannelData, 1000), // Большой буфер чтобы не терять данные
	}, nil
}

// ListDevices возвращает список доступных аудио устройств
func (c *Capture) ListDevices() ([]AudioDevice, error) {
	var devices []AudioDevice

	// Получаем устройства захвата (микрофоны и loopback)
	captureDevices, err := c.ctx.Devices(malgo.Capture)
	if err != nil {
		return nil, fmt.Errorf("failed to enumerate capture devices: %w", err)
	}

	for _, dev := range captureDevices {
		name := dev.Name()
		devices = append(devices, AudioDevice{
			ID:       deviceIDToString(dev.ID),
			Name:     name,
			IsInput:  true,
			IsOutput: false,
		})
	}

	// Получаем устройства воспроизведения (для информации)
	playbackDevices, err := c.ctx.Devices(malgo.Playback)
	if err != nil {
		log.Printf("Warning: failed to enumerate playback devices: %v", err)
	} else {
		for _, dev := range playbackDevices {
			name := dev.Name()
			// Проверяем, не добавлено ли уже это устройство
			found := false
			for i := range devices {
				if devices[i].Name == name {
					devices[i].IsOutput = true
					found = true
					break
				}
			}
			if !found {
				devices = append(devices, AudioDevice{
					ID:       deviceIDToString(dev.ID),
					Name:     name,
					IsInput:  false,
					IsOutput: true,
				})
			}
		}
	}

	return devices, nil
}

// FindDeviceByName ищет устройство по имени (частичное совпадение)
func (c *Capture) FindDeviceByName(name string, deviceType malgo.DeviceType) (*malgo.DeviceID, error) {
	devices, err := c.ctx.Devices(deviceType)
	if err != nil {
		return nil, err
	}

	nameLower := strings.ToLower(name)
	for _, dev := range devices {
		if strings.Contains(strings.ToLower(dev.Name()), nameLower) {
			id := dev.ID
			return &id, nil
		}
	}
	return nil, fmt.Errorf("device not found: %s", name)
}

// FindBlackHoleDevice ищет BlackHole устройство для захвата системного звука
func (c *Capture) FindBlackHoleDevice() (*malgo.DeviceID, error) {
	return c.FindDeviceByName("BlackHole", malgo.Capture)
}

// SetMicrophoneDevice устанавливает устройство микрофона по ID
func (c *Capture) SetMicrophoneDevice(deviceID string) error {
	if deviceID == "" || deviceID == "default" {
		c.micDeviceID = nil
		return nil
	}

	id, err := stringToDeviceID(deviceID)
	if err != nil {
		return err
	}
	c.micDeviceID = id
	return nil
}

// SetSystemDevice устанавливает устройство для захвата системного звука
func (c *Capture) SetSystemDevice(deviceID string) error {
	if deviceID == "" {
		c.systemDeviceID = nil
		c.captureSystem = false
		return nil
	}

	id, err := stringToDeviceID(deviceID)
	if err != nil {
		return err
	}
	c.systemDeviceID = id
	c.captureSystem = true
	return nil
}

// SetSystemDeviceByName устанавливает устройство системного звука по имени
func (c *Capture) SetSystemDeviceByName(name string) error {
	if name == "" {
		c.systemDeviceID = nil
		c.captureSystem = false
		return nil
	}

	id, err := c.FindDeviceByName(name, malgo.Capture)
	if err != nil {
		return err
	}
	c.systemDeviceID = id
	c.captureSystem = true
	log.Printf("System audio device set: %s", name)
	return nil
}

// EnableSystemCapture включает/выключает захват системного звука
func (c *Capture) EnableSystemCapture(enable bool) {
	c.captureSystem = enable
}

// EnableScreenCaptureKit включает использование ScreenCaptureKit для системного звука
func (c *Capture) EnableScreenCaptureKit(enable bool) {
	c.useScreenCaptureKit = enable
	if enable {
		c.systemCaptureMethod = SystemCaptureScreenKit
	}
}

// EnableCoreAudioTap включает использование Core Audio tap для системного звука (macOS 14.2+)
// Это предпочтительный метод если доступен - меньше конфликтов с другими приложениями
func (c *Capture) EnableCoreAudioTap(enable bool) {
	c.useCoreAudioTap = enable
	if enable {
		c.systemCaptureMethod = SystemCaptureCoreAudioTap
	}
}

// SetSystemCaptureMethod устанавливает метод захвата системного звука
func (c *Capture) SetSystemCaptureMethod(method SystemCaptureMethod) {
	c.systemCaptureMethod = method
	switch method {
	case SystemCaptureScreenKit:
		c.useScreenCaptureKit = true
		c.useCoreAudioTap = false
	case SystemCaptureCoreAudioTap:
		c.useScreenCaptureKit = false
		c.useCoreAudioTap = true
	default:
		c.useScreenCaptureKit = false
		c.useCoreAudioTap = false
	}
}

// GetSystemCaptureMethod возвращает текущий метод захвата системного звука
func (c *Capture) GetSystemCaptureMethod() SystemCaptureMethod {
	return c.systemCaptureMethod
}

// Start начинает захват аудио
func (c *Capture) Start(deviceID int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.running {
		return fmt.Errorf("already running")
	}

	// Запускаем захват микрофона
	if err := c.startMicrophoneCapture(); err != nil {
		return fmt.Errorf("failed to start microphone capture: %w", err)
	}

	// Запускаем захват системного звука
	if c.captureSystem {
		switch c.systemCaptureMethod {
		case SystemCaptureCoreAudioTap:
			// Используем Core Audio tap (macOS 14.2+) - меньше конфликтов
			if err := c.StartCoreAudioTap(); err != nil {
				log.Printf("Warning: failed to start Core Audio tap: %v, falling back to ScreenCaptureKit", err)
				// Fallback на ScreenCaptureKit
				if err := c.StartScreenCaptureKitAudio(); err != nil {
					log.Printf("Warning: failed to start ScreenCaptureKit audio: %v", err)
				}
			}
		case SystemCaptureScreenKit:
			// Используем ScreenCaptureKit (macOS 13+) - не требует BlackHole
			if err := c.StartScreenCaptureKitAudio(); err != nil {
				log.Printf("Warning: failed to start ScreenCaptureKit audio: %v", err)
			}
		default:
			// Используем BlackHole/loopback устройство
			if c.systemDeviceID != nil {
				if err := c.startSystemCapture(); err != nil {
					log.Printf("Warning: failed to start system audio capture: %v", err)
				}
			}
		}
	}

	c.running = true
	return nil
}

func (c *Capture) startMicrophoneCapture() error {
	deviceConfig := malgo.DefaultDeviceConfig(malgo.Capture)
	deviceConfig.Capture.Format = malgo.FormatF32
	deviceConfig.Capture.Channels = 1
	deviceConfig.SampleRate = 48000 // 48kHz для синхронизации с ScreenCaptureKit
	deviceConfig.Alsa.NoMMap = 1

	if c.micDeviceID != nil {
		deviceConfig.Capture.DeviceID = c.micDeviceID.Pointer()
	}

	onRecvFrames := func(pOutputSample, pInputSamples []byte, framecount uint32) {
		sampleCount := int(framecount) * int(deviceConfig.Capture.Channels)

		if len(pInputSamples) != sampleCount*4 {
			return
		}

		samples := make([]float32, sampleCount)
		for i := 0; i < sampleCount; i++ {
			bits := uint32(pInputSamples[i*4]) | uint32(pInputSamples[i*4+1])<<8 | uint32(pInputSamples[i*4+2])<<16 | uint32(pInputSamples[i*4+3])<<24
			samples[i] = float32frombits(bits)
		}

		// Отправляем в канал - блокируемся если буфер полон (не теряем данные)
		c.dataChan <- ChannelData{Channel: ChannelMicrophone, Samples: samples}
	}

	var err error
	c.micDevice, err = malgo.InitDevice(c.ctx.Context, deviceConfig, malgo.DeviceCallbacks{
		Data: onRecvFrames,
	})
	if err != nil {
		return err
	}

	if err := c.micDevice.Start(); err != nil {
		return err
	}

	log.Println("Microphone capture started")
	return nil
}

func (c *Capture) startSystemCapture() error {
	deviceConfig := malgo.DefaultDeviceConfig(malgo.Capture)
	deviceConfig.Capture.Format = malgo.FormatF32
	deviceConfig.Capture.Channels = 2 // Стерео для системного звука
	deviceConfig.SampleRate = 48000   // 48kHz для синхронизации
	deviceConfig.Alsa.NoMMap = 1

	if c.systemDeviceID != nil {
		deviceConfig.Capture.DeviceID = c.systemDeviceID.Pointer()
	}

	onRecvFrames := func(pOutputSample, pInputSamples []byte, framecount uint32) {
		channels := int(deviceConfig.Capture.Channels)
		sampleCount := int(framecount) * channels

		if len(pInputSamples) != sampleCount*4 {
			return
		}

		// Конвертируем стерео в моно для Whisper
		monoSamples := make([]float32, int(framecount))
		for i := 0; i < int(framecount); i++ {
			var sum float32
			for ch := 0; ch < channels; ch++ {
				idx := (i*channels + ch) * 4
				bits := uint32(pInputSamples[idx]) | uint32(pInputSamples[idx+1])<<8 | uint32(pInputSamples[idx+2])<<16 | uint32(pInputSamples[idx+3])<<24
				sum += float32frombits(bits)
			}
			monoSamples[i] = sum / float32(channels)
		}

		// Отправляем в канал - блокируемся если буфер полон (не теряем данные)
		c.dataChan <- ChannelData{Channel: ChannelSystem, Samples: monoSamples}
	}

	var err error
	c.systemDevice, err = malgo.InitDevice(c.ctx.Context, deviceConfig, malgo.DeviceCallbacks{
		Data: onRecvFrames,
	})
	if err != nil {
		return err
	}

	if err := c.systemDevice.Start(); err != nil {
		return err
	}

	log.Println("System audio capture started")
	return nil
}

// Stop останавливает захват аудио
func (c *Capture) Stop() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.running {
		return nil
	}

	if c.micDevice != nil {
		c.micDevice.Uninit()
		c.micDevice = nil
	}

	if c.systemDevice != nil {
		c.systemDevice.Uninit()
		c.systemDevice = nil
	}

	// Останавливаем все возможные методы захвата
	// (могут работать одновременно: Core Audio Tap для системы + ScreenCaptureKit для микрофона)
	c.StopCoreAudioTap()
	c.StopScreenCaptureKitAudio()

	c.running = false
	log.Println("Audio capture stopped")
	return nil
}

// Data возвращает канал с аудио данными
func (c *Capture) Data() <-chan ChannelData {
	return c.dataChan
}

// ClearBuffers очищает все накопленные аудио данные в буфере
// Вызывается перед началом новой записи чтобы не захватить старые данные
func (c *Capture) ClearBuffers() {
	// Очищаем канал данных
	for {
		select {
		case <-c.dataChan:
			// Выбрасываем старые данные
		default:
			// Канал пуст
			return
		}
	}
}

// IsSystemCaptureEnabled возвращает true если захват системного звука включен
func (c *Capture) IsSystemCaptureEnabled() bool {
	// systemDeviceID используется только для BlackHole/loopback.
	// Для ScreenCaptureKit/CoreAudioTap устройство не требуется, поэтому учитываем флаг.
	return c.captureSystem
}

// Close освобождает ресурсы
func (c *Capture) Close() {
	c.Stop()
	if c.ctx != nil {
		c.ctx.Uninit()
		c.ctx.Free()
	}
}

func float32frombits(b uint32) float32 {
	return math.Float32frombits(b)
}

// Вспомогательные функции для конвертации DeviceID
func deviceIDToString(id malgo.DeviceID) string {
	// Используем первые 32 байта ID как строку
	var result strings.Builder
	for _, b := range id[:32] {
		if b == 0 {
			break
		}
		result.WriteByte(b)
	}
	return result.String()
}

func stringToDeviceID(s string) (*malgo.DeviceID, error) {
	if len(s) > 32 {
		return nil, fmt.Errorf("device ID too long")
	}
	var id malgo.DeviceID
	copy(id[:], []byte(s))
	return &id, nil
}
