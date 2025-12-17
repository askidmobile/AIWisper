/**
 * Централизованный экспорт всех хуков приложения
 */

// Аудио
export { useAudioPlayer } from './useAudioPlayer';

// Настройки
export { useSettings } from './useSettings';
export type { AppSettings } from './useSettings';

// Экспорт
export { useExport } from './useExport';

// Клавиатурные сочетания
export { useKeyboardShortcuts, createAppShortcuts } from './useKeyboardShortcuts';
export type { KeyboardShortcut } from './useKeyboardShortcuts';

// Drag & Drop
export { useDragDrop, dropOverlayStyles } from './useDragDrop';

// WebSocket
export { useWebSocket } from './useWebSocket';

// Streaming транскрипция
export { useStreamingTranscription } from './useStreamingTranscription';

// Волновая форма
export { useWaveform } from './useWaveform';
export type { WaveformStatus } from './useWaveform';

// Запись
export { useRecording, playBeep, formatDuration } from './useRecording';

// Поиск сессий
export { useSessionSearch } from './useSessionSearch';

// Провайдеры STT/LLM
export { useProviders } from './useProviders';
export type { UseProvidersReturn, ProvidersStatusResponse } from './useProviders';
