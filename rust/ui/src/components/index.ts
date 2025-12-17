/**
 * Централизованный экспорт всех компонентов приложения
 * 
 * Использование:
 * import { WelcomeView, SessionHeader, DialogueView } from './components';
 */

// Common
export { AudioMeterBar, ErrorBoundary, HelpTooltip, VUMeter, StereoVUMeter } from './common';

// Views
export { WelcomeView, RecordingView, EmptySessionView } from './views';

// Session
export { SessionHeader } from './session';

// Dialogue
export { DialogueView } from './dialogue';

// Chunks
export { ChunksView } from './chunks';

// Transcription
export { TranscriptionTabs } from './transcription';
export type { TabType } from './transcription';

// Layout
export { MainLayout } from './layout/MainLayout';
export { Sidebar } from './layout/Sidebar';
export { Header } from './layout/Header';

// Modules
export { TranscriptionView } from './modules/TranscriptionView';
export { SettingsPanel } from './modules/SettingsPanel';
export { ConsoleFooter } from './modules/ConsoleFooter';
export { SessionControls } from './modules/SessionControls';
export { SessionStats } from './modules/SessionStats';

// Other
export { RecordingOverlay } from './RecordingOverlay';
export { StreamingTranscription } from './StreamingTranscription';
export { HelpModal } from './HelpModal';
export { default as ModelManager } from './ModelManager';
