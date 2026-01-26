# Руководство: Захват системного звука на macOS

Дата: 2026-01-21

Данный документ описывает архитектуру и реализацию захвата системного аудио (loopback) в приложении AIWisper. Мы используем **гибридный подход**, сочетающий современные API для новых версий macOS и проверенные методы для обратной совместимости.

---

## 1. Архитектура: Гибридный подход

Приложение автоматически выбирает наилучший доступный метод захвата в зависимости от версии macOS. Это позволяет минимизировать неудобства для пользователя, связанные с разрешениями.

### 1.1. Метод А: Core Audio Process Tap (Приоритетный)

| Параметр | Значение |
|----------|----------|
| **Версия macOS** | 14.2 (Sonoma) и новее |
| **API** | `AudioHardwareCreateProcessTap` |
| **Исходный код** | `swift/coreaudio/Sources/main.swift` |

**Преимущества:**
- ✅ **Не требует** разрешения на запись экрана (Screen Recording Permission).
- ✅ **Нет** системных индикаторов (фиолетовой иконки) в статус-баре.
- ✅ Меньшая нагрузка на CPU (не обрабатывает видео-поток).
- ✅ Работает прозрачно для пользователя.

**Ограничения:**
- ⚠️ Приложение **не должно** быть в App Sandbox.
- ⚠️ Требует macOS 14.2+ (выпущена в декабре 2023).

**Принцип работы:**
1. Создается `CATapDescription` для захвата всего системного аудио.
2. Создается виртуальное Aggregate Device, связанное с Tap.
3. Через `AudioDeviceIOProc` получаем аудио-буферы в реальном времени.

```swift
// Ключевой код (swift/coreaudio/Sources/main.swift)
let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDesc.muteBehavior = CATapMuteBehavior.unmuted  // Не глушим оригинальный звук
tapDesc.name = "AIWisper System Audio Tap"

var tapIDOut: AudioObjectID = kAudioObjectUnknown
let status = AudioHardwareCreateProcessTap(tapDesc, &tapIDOut)
```

### 1.2. Метод Б: ScreenCaptureKit (Fallback)

| Параметр | Значение |
|----------|----------|
| **Версия macOS** | 13.0 (Ventura) — 14.1 |
| **API** | `ScreenCaptureKit` (SCK) |
| **Исходный код** | `swift/screencapture/Sources/main.swift` |

**Преимущества:**
- ✅ Официальный, современный API от Apple.
- ✅ Поддерживает Voice Isolation (macOS 15+).
- ✅ Может захватывать микрофон с шумоподавлением.

**Ограничения:**
- ⚠️ **Требует** разрешения "Screen & System Audio Recording".
- ⚠️ Показывает системный индикатор использования экрана в Control Center.
- ⚠️ Пользователь должен явно выдать права в System Settings.

**Почему нельзя запросить только аудио?**

Apple объединяет права на захват системного аудио и записи экрана в одно разрешение. Это сделано для защиты приватности: если приложение может слышать звук, оно потенциально может слышать конфиденциальные уведомления. Разделить эти права программно невозможно.

### 1.3. Логика выбора метода (Rust)

Код автоматического выбора находится в `rust/crates/aiwisper-audio/src/system_audio/macos.rs`:

```rust
pub fn get_best_method() -> Option<SystemCaptureMethod> {
    let version = get_macos_version();

    if let Some((major, minor)) = version {
        // macOS 14.2+ — Core Audio Process Tap (лучший вариант)
        if major > 14 || (major == 14 && minor >= 2) {
            if coreaudio_tap_available() {
                return Some(SystemCaptureMethod::CoreAudioTap);
            }
        }

        // macOS 13+ — ScreenCaptureKit (требует разрешения)
        if major >= 13 {
            if screencapture_available() {
                return Some(SystemCaptureMethod::ScreenCaptureKit);
            }
        }
    }

    // Fallback: виртуальный loopback (BlackHole и т.п.)
    Some(SystemCaptureMethod::VirtualLoopback)
}
```

---

## 2. Реализация UX для разработчика

Главная сложность — грамотно обработать сценарий **Метода Б (ScreenCaptureKit)**, так как он требует взаимодействия с пользователем.

### 2.1. Когда запрашивать разрешения

**Правило:** Не запрашивайте разрешения при старте приложения. Делайте это только когда пользователь активирует функцию записи системного звука.

**Почему:**
- Пользователь понимает контекст ("я нажал Записать → меня просят разрешение").
- Меньше отказов ("зачем приложению экран при запуске?").
- Соответствует Apple Human Interface Guidelines.

### 2.2. Проверка наличия прав (Swift)

ScreenCaptureKit не имеет API для проверки прав напрямую. Но можно определить статус косвенно:

```swift
import ScreenCaptureKit

func checkPermissions() async -> Bool {
    do {
        // Попытка получить список окон триггерит проверку прав
        _ = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        return true
    } catch let error as NSError {
        // Код ошибки для отсутствия прав
        if error.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" {
            return false
        }
        return false
    }
}
```

### 2.3. Обработка отсутствия прав

Если прав нет, покажите пользователю **собственный диалог** с объяснением перед отправкой в настройки.

**Пример текста диалога:**

> **Требуется разрешение**
>
> Для транскрибации звука из других приложений необходим доступ к системному аудио.
>
> Apple включает это разрешение в раздел "Запись экрана и системного звука". Мы записываем только аудио — видео-поток полностью игнорируется.
>
> [Отмена] [Открыть настройки]

### 2.4. Перенаправление в настройки macOS

Используйте Deep Link для открытия конкретного раздела:

**Rust (Tauri):**
```rust
use std::process::Command;

fn open_screen_recording_settings() {
    let _ = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn();
}
```

**Swift:**
```swift
import AppKit

func openScreenRecordingSettings() {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
        NSWorkspace.shared.open(url)
    }
}
```

### 2.5. Перезапуск приложения

После выдачи разрешения macOS потребует перезапустить приложение. Система сама покажет диалог "Quit & Reopen".

**Что должен сделать разработчик:**
- Сохранять состояние приложения перед запросом разрешений.
- Восстанавливать состояние после перезапуска.
- Не пытаться "обойти" перезапуск — это требование безопасности macOS.

---

## 3. Визуальная индикация записи

### 3.1. Системные индикаторы (неуправляемые)

macOS автоматически показывает индикаторы в Menu Bar:

| Индикатор | Значение |
|-----------|----------|
| 🟠 Оранжевая точка | Активен микрофон |
| 🟣 Иконка экрана | Активен ScreenCaptureKit |

**Важно:** Разработчик **не может** скрыть или изменить эти индикаторы. Не пытайтесь это обойти.

### 3.2. Иконка приложения в статус-баре (NSStatusItem)

Рекомендуется добавить собственную иконку для управления записью, так как системные индикаторы могут быть неочевидны пользователю.

**Требования к реализации:**

1. **Состояние иконки:**
   - Обычное состояние: стандартная иконка приложения.
   - Запись активна: красная иконка или бейдж "REC".

2. **Меню по клику:**
   - Текущий статус: "Запись: Системный звук" / "Ожидание".
   - Источник: "Системный звук" / "Микрофон" / "Оба".
   - Действия: "Остановить запись", "Настройки", "Выход".

3. **Tooltip:**
   - При наведении показывать статус: "AIWisper — Запись активна".

### 3.3. Уведомления (User Notifications)

При старте записи отправляйте локальное уведомление:

**Rust (Tauri):**
```rust
use tauri::api::notification::Notification;

fn notify_recording_started(app: &tauri::AppHandle) {
    Notification::new(&app.config().tauri.bundle.identifier)
        .title("AIWisper")
        .body("Начата запись системного звука")
        .show()
        .ok();
}
```

---

## 4. Техническая конфигурация

### 4.1. Entitlements (rust/src-tauri/entitlements.plist)

Для работы **Core Audio Tap** критически важно отключить песочницу:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- КРИТИЧНО: Отключаем Sandbox для CoreAudio Tap -->
    <key>com.apple.security.app-sandbox</key>
    <false/>
    
    <!-- Доступ к микрофону -->
    <key>com.apple.security.device.audio-input</key>
    <true/>
    
    <!-- Сеть (для загрузки моделей) -->
    <key>com.apple.security.network.client</key>
    <true/>
    
    <!-- Hardened Runtime для ML -->
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
```

### 4.2. Info.plist (rust/src-tauri/Info.plist)

Описание причин доступа для пользователя:

```xml
<dict>
    <!-- Микрофон -->
    <key>NSMicrophoneUsageDescription</key>
    <string>AIWisper записывает ваш голос для транскрибации речи в текст.</string>
    
    <!-- Запись экрана / системного звука (для ScreenCaptureKit) -->
    <key>NSScreenCaptureUsageDescription</key>
    <string>AIWisper записывает системный звук для транскрибации аудио из других приложений. Видео-поток не записывается.</string>
</dict>
```

---

## 5. Дистрибуция и подписание

### 5.1. Code Signing

Система разрешений TCC (Transparency, Consent, and Control) корректно работает только с подписанными приложениями.

**Что нужно подписать:**
1. Основной бинарник Tauri (делается автоматически).
2. Swift-модули в `resources/` (могут требовать ручного подписания).

**Команда для ручного подписания Swift-модуля:**
```bash
codesign --force --options runtime \
    --sign "Developer ID Application: Your Name (TEAM_ID)" \
    --timestamp \
    path/to/screencapture-audio
```

### 5.2. Notarization

Для распространения вне Mac App Store приложение **должно быть нотаризовано**.

**Без нотаризации:**
- На macOS Catalina+ приложение может не запуститься.
- TCC может сбрасывать разрешения при каждом перезапуске.
- Gatekeeper будет блокировать запуск.

---

## 6. Чек-лист для разработчика

### Конфигурация
- [ ] `com.apple.security.app-sandbox` установлен в `false`.
- [ ] `NSScreenCaptureUsageDescription` добавлен в `Info.plist`.
- [ ] `NSMicrophoneUsageDescription` добавлен в `Info.plist`.

### Логика приложения
- [ ] Реализована проверка версии macOS для выбора метода (Tap vs SCK).
- [ ] Разрешения запрашиваются только при активации функции записи.
- [ ] Показывается объясняющий диалог перед отправкой в настройки.
- [ ] Приложение корректно восстанавливает состояние после перезапуска.

### UI/UX
- [ ] Добавлена иконка в статус-бар с индикацией записи.
- [ ] Отправляется уведомление при старте записи.
- [ ] В меню статус-бара есть кнопка "Остановить запись".

### Дистрибуция
- [ ] Все бинарники подписаны одним сертификатом Developer ID.
- [ ] Приложение нотаризовано перед распространением.
- [ ] Протестировано на "чистой" системе без предварительных разрешений.

---

## 7. Полезные ссылки

- [Apple: ScreenCaptureKit Documentation](https://developer.apple.com/documentation/screencapturekit)
- [Apple: Core Audio Tap (WWDC 2023)](https://developer.apple.com/videos/play/wwdc2023/10118/)
- [Apple: Requesting Authorization for Media Capture](https://developer.apple.com/documentation/avfoundation/capture_setup/requesting_authorization_for_media_capture_on_macos)
- [Apple: Hardened Runtime](https://developer.apple.com/documentation/security/hardened_runtime)
