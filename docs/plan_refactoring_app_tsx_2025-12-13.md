# План рефакторинга App.tsx

**Дата:** 2025-12-13  
**Цель:** Разобрать монолитный файл `App.tsx` (5291 строк) на модульные компоненты, контексты и хуки.

## Текущее состояние

### Анализ App.tsx (5291 строк)

Файл содержит:
- **~100 состояний (useState)** - настройки, UI, сессии, аудио, диаризация и т.д.
- **~50 эффектов (useEffect)** - WebSocket, таймеры, анимации, автоскролл
- **~40 обработчиков (callbacks)** - запись, воспроизведение, экспорт, поиск
- **~2000 строк JSX** - sidebar, header, main content, modals

### Существующая модульная структура

Уже созданы:
- `AppWithProviders.tsx` - альтернативная точка входа с провайдерами
- `context/SettingsContext.tsx` - частичная реализация настроек
- `context/WebSocketContext.tsx` - базовое WebSocket соединение
- `context/SessionContext.tsx` - управление сессиями
- `context/ModelContext.tsx` - управление моделями
- `hooks/useAudioPlayer.ts` - базовый аудио плеер
- `hooks/useWebSocket.ts` - WebSocket хук
- `hooks/useSettings.ts` - хук настроек
- `components/layout/MainLayout.tsx` - альтернативный layout

**Проблема:** `App.tsx` и `AppWithProviders.tsx` существуют параллельно, дублируя функциональность.

---

## Стратегия рефакторинга

### Подход: Инкрементальная миграция

1. **Не ломать существующий App.tsx** до полной готовности
2. **Расширять существующие контексты и хуки** до паритета с App.tsx
3. **Переключить main.tsx** на AppWithProviders после завершения
4. **Удалить старый App.tsx** после верификации

---

## Фаза 1: Расширение контекстов

### 1.1 SettingsContext (расширение)

**Файл:** `src/context/SettingsContext.tsx`

**Добавить настройки из App.tsx:**
```typescript
interface AppSettings {
  // Существующие
  language: 'ru' | 'en' | 'auto';
  theme: 'light' | 'dark';
  micDevice: string;
  captureSystem: boolean;
  useVoiceIsolation: boolean;
  echoCancel: number;
  ollamaModel: string;
  ollamaUrl: string;
  hybridTranscription: HybridTranscriptionSettings;
  
  // ДОБАВИТЬ из App.tsx
  vadMode: 'auto' | 'compression' | 'per-region' | 'off';
  vadMethod: 'auto' | 'energy' | 'silero';
  showSessionStats: boolean;
  
  // Диаризация
  diarizationEnabled: boolean;
  diarizationSegModelId: string;
  diarizationEmbModelId: string;
  diarizationProvider: string;
}
```

### 1.2 WebSocketContext (расширение)

**Файл:** `src/context/WebSocketContext.tsx`

**Добавить обработчики из App.tsx:**
- `devices` - список устройств
- `diarization_*` - события диаризации
- `voiceprints_*` - события голосовых отпечатков
- `full_transcription_*` - полная ретранскрипция
- `improve_*` - AI улучшение
- `diarize_*` - AI диаризация
- `search_results` - результаты поиска

### 1.3 DiarizationContext (новый)

**Файл:** `src/context/DiarizationContext.tsx` (уже существует, расширить)

**Состояние:**
```typescript
interface DiarizationContextType {
  enabled: boolean;
  provider: string;
  loading: boolean;
  error: string | null;
  
  // Модели
  segmentationModels: ModelState[];
  embeddingModels: ModelState[];
  
  // Действия
  enable: (segModelId: string, embModelId: string, provider: string) => void;
  disable: () => void;
}
```

### 1.4 AudioContext (новый)

**Файл:** `src/context/AudioContext.tsx`

**Назначение:** Web Audio API для VU-метров и звуковых сигналов

```typescript
interface AudioContextType {
  // VU-метры
  micLevel: number;
  sysLevel: number;
  playbackMicLevel: number;
  playbackSysLevel: number;
  
  // Звуковые сигналы
  playBeep: (frequency?: number, duration?: number, volume?: number) => void;
  
  // Анализаторы
  connectAnalysers: (audioElement: HTMLAudioElement) => void;
  disconnectAnalysers: () => void;
}
```

---

## Фаза 2: Расширение хуков

### 2.1 useAudioPlayer (расширение)

**Файл:** `src/hooks/useAudioPlayer.ts`

**Добавить из App.tsx:**
```typescript
interface UseAudioPlayerReturn {
  // Существующие
  play: (url: string) => void;
  pause: () => void;
  stop: () => void;
  seek: (time: number) => void;
  isPlaying: boolean;
  playingUrl: string | null;
  currentTime: number;
  duration: number;
  
  // ДОБАВИТЬ
  audioRef: RefObject<HTMLAudioElement>;
  playbackOffset: number;
  setPlaybackOffset: (offset: number) => void;
  
  // VU-метры (интеграция с AudioContext)
  micLevel: number;
  sysLevel: number;
}
```

### 2.2 useRecording (новый)

**Файл:** `src/hooks/useRecording.ts`

```typescript
interface UseRecordingReturn {
  isRecording: boolean;
  isStopping: boolean;
  recordingDuration: number;
  recordingWave: number[];
  
  startRecording: (config: RecordingConfig) => void;
  stopRecording: () => void;
}
```

### 2.3 useWaveform (новый)

**Файл:** `src/hooks/useWaveform.ts`

```typescript
interface UseWaveformReturn {
  waveformData: WaveformData | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  
  loadWaveform: (sessionId: string) => Promise<void>;
  clearWaveform: () => void;
}
```

### 2.4 useSessionManager (расширение)

**Файл:** `src/hooks/useSessionManager.ts` (создать)

```typescript
interface UseSessionManagerReturn {
  // Списки
  sessions: SessionInfo[];
  selectedSession: Session | null;
  currentSession: Session | null;
  
  // Поиск
  searchQuery: string;
  searchResults: SessionInfo[] | null;
  isSearching: boolean;
  search: (query: string) => void;
  clearSearch: () => void;
  
  // Мультиселект
  selectedSessionIds: Set<string>;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  
  // CRUD
  selectSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  
  // Экспорт
  exportSession: (id: string, format: ExportFormat) => void;
  batchExport: (ids: string[], format: ExportFormat) => void;
}
```

---

## Фаза 3: Компоненты

### 3.1 WelcomeView (новый)

**Файл:** `src/components/views/WelcomeView.tsx`

**Извлечь из App.tsx:** строки 4244-4469 (Welcome Screen)

```typescript
interface WelcomeViewProps {
  onStartRecording: () => void;
  onFileDrop: (file: File) => void;
  isDragging: boolean;
  isImporting: boolean;
  importProgress: string | null;
}
```

### 3.2 SessionHeader (новый)

**Файл:** `src/components/modules/SessionHeader.tsx`

**Извлечь из App.tsx:** строки 3655-3946 (Session info + action buttons)

```typescript
interface SessionHeaderProps {
  session: Session;
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onExport: () => void;
  onRetranscribe: () => void;
  onImprove: () => void;
  onDiarize: () => void;
  onDelete: () => void;
  onClose: () => void;
}
```

### 3.3 DialogueView (новый)

**Файл:** `src/components/modules/DialogueView.tsx`

**Извлечь из App.tsx:** строки 4486-4660 (Dialogue tab content)

```typescript
interface DialogueViewProps {
  dialogue: TranscriptSegment[];
  currentSegmentIndex: number;
  isPlaying: boolean;
  autoScrollEnabled: boolean;
  onSegmentClick: (startMs: number) => void;
  onToggleAutoScroll: () => void;
  getSpeakerDisplayName: (speaker?: string) => { name: string; color: string };
}
```

### 3.4 ChunksView (обновить)

**Файл:** `src/components/modules/ChunksView.tsx` (создать)

**Извлечь из App.tsx:** строки 4663-4799 (Chunks tab content)

### 3.5 RecordingBar (обновить)

**Файл:** `src/components/modules/RecordingBar.tsx` (создать)

**Извлечь из App.tsx:** строки 3433-3570 (Recording indicator bar)

---

## Фаза 4: Обновление MainLayout

**Файл:** `src/components/layout/MainLayout.tsx`

### Изменения:

1. **Удалить дублирующиеся состояния** - использовать контексты
2. **Интегрировать новые хуки** - useRecording, useWaveform, useSessionManager
3. **Использовать новые компоненты** - WelcomeView, SessionHeader, DialogueView

### Структура после рефакторинга:

```tsx
export const MainLayout: React.FC = () => {
  // Контексты
  const { settings } = useSettingsContext();
  const { isConnected, sendMessage } = useWebSocketContext();
  const { sessions, selectedSession, isRecording } = useSessionContext();
  const { models, activeModelId } = useModelContext();
  const { enabled: diarizationEnabled } = useDiarizationContext();
  
  // Хуки
  const audioPlayer = useAudioPlayer();
  const recording = useRecording();
  const waveform = useWaveform();
  const sessionManager = useSessionManager();
  const dragDrop = useDragDrop();
  const exportUtils = useExport();
  
  // Минимальный локальный UI state
  const [showSettings, setShowSettings] = useState(false);
  const [showModelManager, setShowModelManager] = useState(false);
  
  return (
    <div className="app-frame">
      <RecordingOverlay />
      <DragDropOverlay />
      
      <div className="main-content">
        <Sidebar />
        
        <div className="content-area">
          <Header />
          
          {showSettings && <SettingsPanel />}
          
          {!selectedSession && !isRecording ? (
            <WelcomeView />
          ) : (
            <>
              <SessionHeader />
              <WaveformDisplay />
              <TranscriptionTabs />
            </>
          )}
        </div>
        
        <AudioMeterSidebar />
      </div>
      
      <ConsoleFooter />
      
      {/* Modals */}
      <ModelManager />
      <HelpModal />
      <DeleteConfirmModal />
      <BatchExportModal />
    </div>
  );
};
```

---

## Фаза 5: Финализация

### 5.1 Обновить App.tsx

**Новый App.tsx (минимальный):**

```tsx
import { AppWithProviders } from './AppWithProviders';

function App() {
  return <AppWithProviders />;
}

export default App;
```

### 5.2 Обновить AppWithProviders.tsx

```tsx
export const AppWithProviders: React.FC = () => {
  return (
    <WebSocketProvider>
      <SettingsProvider>
        <ModelProvider>
          <SessionProvider>
            <DiarizationProvider>
              <AudioProvider>
                <MainLayout />
              </AudioProvider>
            </DiarizationProvider>
          </SessionProvider>
        </ModelProvider>
      </SettingsProvider>
    </WebSocketProvider>
  );
};
```

---

## План проверки

### Автоматические проверки

1. **TypeScript компиляция:** `npm run build`
2. **ESLint:** `npm run lint` (если настроен)
3. **E2E тесты:** `npm run test:e2e` (если есть)

### Ручное тестирование

| Функция | Проверка |
|---------|----------|
| Настройки | Изменить тему, перезагрузить - должна сохраниться |
| Запись | Начать запись, проверить beep, волну, чанки |
| Остановка | Остановить запись, проверить сохранение |
| Воспроизведение | Выбрать сессию, воспроизвести, проверить VU-метры |
| Навигация | Переключение между сессиями и вкладками |
| Поиск | Поиск по транскрипции |
| Экспорт | Экспорт в TXT, SRT, VTT, JSON, MD |
| Drag & Drop | Импорт аудиофайла |
| Горячие клавиши | Space, R, ⌘F, ⌘S, ⌘E, ? |

---

## Риски и митигация

| Риск | Митигация |
|------|-----------|
| Потеря функциональности | Инкрементальная миграция, сохранение старого App.tsx |
| Регрессии | Ручное тестирование каждой фазы |
| Сложность отладки | Подробное логирование в контекстах |
| Производительность | Мемоизация, React.memo для компонентов |

---

## Оценка трудозатрат

| Фаза | Оценка |
|------|--------|
| Фаза 1: Контексты | 2-3 часа |
| Фаза 2: Хуки | 2-3 часа |
| Фаза 3: Компоненты | 3-4 часа |
| Фаза 4: MainLayout | 2-3 часа |
| Фаза 5: Финализация | 1-2 часа |
| Тестирование | 2-3 часа |
| **Итого** | **12-18 часов** |

---

## Порядок выполнения

1. ✅ Создать документ с планом
2. ✅ Расширить SettingsContext (добавлены VAD настройки)
3. 🔄 Расширить WebSocketContext  
4. ✅ Создать AudioContext (`src/context/AudioContext.tsx`)
5. 🔄 Расширить useAudioPlayer
6. ✅ Создать useRecording (`src/hooks/useRecording.ts`)
7. ✅ Создать useWaveform (`src/hooks/useWaveform.ts`)
8. ✅ Создать useSessionSearch (`src/hooks/useSessionSearch.ts`)
9. 🔄 Обновить MainLayout
10. ✅ Создать WelcomeView (`src/components/views/WelcomeView.tsx`)
11. ✅ Создать WelcomeViewSimple (`src/components/views/WelcomeViewSimple.tsx`) - упрощённая версия
12. ✅ Создать RecordingView (`src/components/views/RecordingView.tsx`)
13. ✅ Создать EmptySessionView (`src/components/views/EmptySessionView.tsx`)
14. ✅ Создать SessionHeader (`src/components/session/SessionHeader.tsx`)
15. ✅ Интегрировать WelcomeViewSimple в TranscriptionView (сокращение на 211 строк)
16. ✅ Интегрировать RecordingView в TranscriptionView
17. 🔄 Обновить App.tsx
18. ✅ Проверка сборки (все компоненты компилируются)
19. 🔄 Ручное тестирование

---

## Созданные артефакты (сессия 2025-12-13)

### Хуки
| Файл | Описание | Статус |
|------|----------|--------|
| `src/hooks/useWaveform.ts` | Загрузка и кеширование волновой формы | ✅ Создан |
| `src/hooks/useRecording.ts` | Состояние записи, таймер, анимация | ✅ Создан |
| `src/hooks/useSessionSearch.ts` | Поиск сессий с debounce, мультиселект | ✅ Создан |
| `src/hooks/index.ts` | Обновлён экспорт | ✅ Обновлён |

### Компоненты Views
| Файл | Описание | Статус |
|------|----------|--------|
| `src/components/views/WelcomeView.tsx` | Welcome Screen с onboarding и drag-drop | ✅ Создан |
| `src/components/views/WelcomeViewSimple.tsx` | Упрощённый Welcome Screen без drag-drop | ✅ Создан + Интегрирован |
| `src/components/views/RecordingView.tsx` | Экран во время записи | ✅ Создан + Интегрирован |
| `src/components/views/EmptySessionView.tsx` | Пустая сессия | ✅ Создан |
| `src/components/views/index.ts` | Экспорт views | ✅ Создан |

### Компоненты Session
| Файл | Описание | Статус |
|------|----------|--------|
| `src/components/session/SessionHeader.tsx` | Заголовок сессии с кнопками | ✅ Создан |
| `src/components/session/index.ts` | Экспорт session | ✅ Создан |

### Компоненты Dialogue
| Файл | Описание | Статус |
|------|----------|--------|
| `src/components/dialogue/DialogueView.tsx` | Отображение диалога с таймкодами | ✅ Создан |
| `src/components/dialogue/index.ts` | Экспорт dialogue | ✅ Создан |

### Компоненты Chunks
| Файл | Описание | Статус |
|------|----------|--------|
| `src/components/chunks/ChunksView.tsx` | Отображение списка чанков | ✅ Создан |
| `src/components/chunks/index.ts` | Экспорт chunks | ✅ Создан |

### Компоненты Transcription
| Файл | Описание | Статус |
|------|----------|--------|
| `src/components/transcription/TranscriptionTabs.tsx` | Вкладки диалог/чанки/спикеры | ✅ Создан |
| `src/components/transcription/index.ts` | Экспорт transcription | ✅ Создан |

### Контексты
| Файл | Описание | Статус |
|------|----------|--------|
| `src/context/SettingsContext.tsx` | Добавлены VAD настройки | ✅ Обновлён |
| `src/context/AudioContext.tsx` | VU-метры и звуковые сигналы | ✅ Создан |
| `src/context/index.ts` | Централизованный экспорт | ✅ Создан |

### Компоненты Common
| Файл | Описание | Статус |
|------|----------|--------|
| `src/components/common/VUMeter.tsx` | VU-метр и StereoVUMeter | ✅ Создан |
| `src/components/common/index.ts` | Централизованный экспорт | ✅ Создан |

### Обновлённые файлы
| Файл | Описание | Статус |
|------|----------|--------|
| `src/AppWithProviders.tsx` | Добавлены DiarizationProvider, AudioProvider | ✅ Обновлён |
| `src/components/modules/TranscriptionView.tsx` | Интегрированы WelcomeViewSimple и RecordingView | ✅ Обновлён |

---

## Сессия 2025-12-14: Интеграция компонентов

### Выполненные задачи

1. **Создан WelcomeViewSimple** (`src/components/views/WelcomeViewSimple.tsx`)
   - Упрощённая версия Welcome Screen без drag-drop пропсов
   - Drag-drop обрабатывается на уровне MainLayout
   - Содержит Quick Start Guide и Feature Cards

2. **Интегрирован RecordingView** в TranscriptionView
   - Заменён inline код на компонент `<RecordingView />`

3. **Интегрирован WelcomeViewSimple** в TranscriptionView
   - Заменён inline Welcome Screen (~210 строк) на `<WelcomeViewSimple />`

### Результаты

| Метрика | До | После | Изменение |
|---------|-----|-------|-----------|
| TranscriptionView.tsx | 1011 строк | 800 строк | -211 строк (-21%) |
| Размер бандла AppWithProviders | 103.75 KB | 101.80 KB | -1.95 KB |

### Следующие шаги (обновлено)

1. ~~**Интеграция ChunksView** - заменить inline Chunks tab~~ ✅ Выполнено
2. ~~**Вынос DialogueHelpers** - PlaybackProgressLine, ScrollbarPositionIndicator, SegmentText~~ ✅ Выполнено
3. **Создание минимального App.tsx** - переключение на AppWithProviders
4. **Ручное тестирование** всех функций

---

## Сессия 2025-12-14 (продолжение): Дальнейшая модуляризация

### Выполненные задачи

4. **Создан ChunksViewSimple** (`src/components/chunks/ChunksViewSimple.tsx`)
   - Упрощённая версия ChunksView совместимая с API TranscriptionView
   - Интегрирован в TranscriptionView

5. **Создан DialogueHelpers** (`src/components/dialogue/DialogueHelpers.tsx`)
   - Вынесены компоненты: PlaybackProgressLine, ScrollbarPositionIndicator, ConfidenceWord, SegmentText
   - ~280 строк вынесено из TranscriptionView

### Результаты (итого за сессию)

| Метрика | Начало сессии | Конец сессии | Изменение |
|---------|---------------|--------------|-----------|
| TranscriptionView.tsx | 1011 строк | **514 строк** | **-497 строк (-49%)** |
| Новые компоненты | 0 | 4 | +4 файла |

### Созданные файлы

| Файл | Строк | Описание |
|------|-------|----------|
| `src/components/views/WelcomeViewSimple.tsx` | 175 | Упрощённый Welcome Screen |
| `src/components/chunks/ChunksViewSimple.tsx` | 170 | Упрощённый список чанков |
| `src/components/dialogue/DialogueHelpers.tsx` | 280 | Вспомогательные компоненты диалога |

### Следующие шаги

1. ~~**Создание минимального App.tsx** - переключение на AppWithProviders~~ ✅ Выполнено
2. **Ручное тестирование** всех функций

---

## Финализация: Переключение на новый UI

### Выполненные задачи

6. **Переключение main.tsx на новый UI по умолчанию**
   - Изменён feature flag: теперь `USE_LEGACY_UI` вместо `USE_NEW_UI`
   - По умолчанию загружается `AppWithProviders`

7. **Создан backup старого App.tsx**
   - Переименован в `App.legacy.tsx` (5290 строк)
   - Доступен через `localStorage.setItem("USE_LEGACY_UI", "true")`

8. **Создан минимальный App.tsx**
   - 11 строк - просто реэкспорт AppWithProviders
   - Документация по переключению на legacy UI

### Итоговые результаты рефакторинга

| Метрика | До рефакторинга | После | Изменение |
|---------|-----------------|-------|-----------|
| App.tsx | 5290 строк | 11 строк | **-99.8%** |
| TranscriptionView.tsx | 1011 строк | 514 строк | **-49%** |
| Размер бандла (новый UI) | - | 103.23 KB | - |
| Размер бандла (legacy UI) | - | 130.85 KB | - |
| Экономия размера | - | - | **-27.62 KB (-21%)** |

### Созданные файлы (всего)

| Файл | Строк | Описание |
|------|-------|----------|
| `src/App.tsx` | 11 | Минимальная точка входа |
| `src/App.legacy.tsx` | 5290 | Backup старого монолита |
| `src/components/views/WelcomeViewSimple.tsx` | 175 | Упрощённый Welcome Screen |
| `src/components/chunks/ChunksViewSimple.tsx` | 170 | Упрощённый список чанков |
| `src/components/dialogue/DialogueHelpers.tsx` | 280 | Вспомогательные компоненты диалога |

### Переключение между UI

```javascript
// Использовать legacy UI (старый монолит)
localStorage.setItem("USE_LEGACY_UI", "true");
location.reload();

// Использовать новый модульный UI (по умолчанию)
localStorage.removeItem("USE_LEGACY_UI");
location.reload();
```

### Следующие шаги (опционально)

1. **Ручное тестирование** всех функций нового UI
2. **Удаление App.legacy.tsx** после полной верификации
3. **Дальнейшая модуляризация** TranscriptionView (514 строк → ~300 строк)
