//go:build !darwin

package audio

import "fmt"

// CoreAudioTapAvailable возвращает false на не-darwin платформах
func CoreAudioTapAvailable() bool {
	return false
}

// StartCoreAudioTap недоступен на не-darwin платформах
func (c *Capture) StartCoreAudioTap() error {
	return fmt.Errorf("Core Audio tap is only available on macOS 14.2+")
}

// StopCoreAudioTap недоступен на не-darwin платформах
func (c *Capture) StopCoreAudioTap() {
	// No-op на не-darwin платформах
}

// IsCoreAudioTapRunning возвращает false на не-darwin платформах
func IsCoreAudioTapRunning() bool {
	return false
}
