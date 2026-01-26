---
description: Production release - анализ коммитов, обновление версии, сборка Tauri и публикация на GitHub
---

# Production Release (Tauri)

Выполни полный релизный цикл для AIWisper:

## 1. Анализ изменений

Проанализируй коммиты с момента последнего релиза:
!`git log $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~20)..HEAD --oneline --no-merges`

Определи тип релиза на основе изменений:
- **MAJOR** (x.0.0): Breaking changes, несовместимые изменения API
- **MINOR** (0.x.0): Новые функции, совместимые с предыдущей версией  
- **PATCH** (0.0.x): Исправления ошибок, мелкие улучшения

## 2. Обновление версии

Версия хранится в следующих файлах:
- `rust/Cargo.toml` — workspace version
- `rust/src-tauri/tauri.conf.json` — Tauri version
- `README.md` — badge version

Увеличь версию согласно semver и обнови **все** файлы.

## 3. Обновление CHANGELOG.md

Добавь новую секцию в начало файла @CHANGELOG.md после заголовка:

```markdown
## [X.X.X] - YYYY-MM-DD

### Added
- Новые функции (если есть)

### Changed  
- Изменения в существующей функциональности

### Fixed
- Исправления ошибок

### Security
- Исправления безопасности (если есть)
```

Заполни секции на основе анализа коммитов.

## 4. Подготовка FFmpeg для бандла

**КРИТИЧНО:** FFmpeg должен быть в `rust/src-tauri/resources/` для обеих архитектур.

### Проверка наличия FFmpeg:
```bash
ls -lah rust/src-tauri/resources/ffmpeg*
```

### Если отсутствует — скачать:

**Для Apple Silicon (arm64):**
```bash
curl -L -o /tmp/ffmpeg-arm64.zip "https://www.osxexperts.net/ffmpeg7arm.zip"
unzip -o /tmp/ffmpeg-arm64.zip -d /tmp/
cp /tmp/ffmpeg rust/src-tauri/resources/ffmpeg-aarch64
chmod +x rust/src-tauri/resources/ffmpeg-aarch64
```

**Для Intel (x86_64):**
```bash
curl -L -o /tmp/ffmpeg-x64.7z "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/7z"
7z x -y /tmp/ffmpeg-x64.7z -o/tmp/
cp /tmp/ffmpeg rust/src-tauri/resources/ffmpeg-x86_64
chmod +x rust/src-tauri/resources/ffmpeg-x86_64
```

### Обновить tauri.conf.json для архитектурно-специфичных ресурсов:
В секции `bundle.resources` должно быть:
```json
"resources": [
  "resources/*"
]
```

И в коде `mp3_writer.rs` должна быть логика выбора ffmpeg по архитектуре.

## 5. Создание коммита

После обновления всех файлов создай коммит:
```bash
git add rust/Cargo.toml rust/src-tauri/tauri.conf.json CHANGELOG.md README.md
git commit -m "release: v{VERSION}"
```

## 6. Сборка приложения

**Из-за проблем с AppleDouble файлами на внешних накопителях, используй /tmp для target:**

```bash
export CARGO_TARGET_DIR=/tmp/aiwisper-target
cd rust && cargo tauri build
```

### Для Universal Binary (arm64 + x86_64):
```bash
# Сборка для arm64 (на Apple Silicon)
export CARGO_TARGET_DIR=/tmp/aiwisper-target
cd rust && cargo tauri build --target aarch64-apple-darwin

# Сборка для x86_64 (требует Rosetta toolchain)
cd rust && cargo tauri build --target x86_64-apple-darwin
```

Проверь наличие собранных файлов:
```bash
ls -lah /tmp/aiwisper-target/release/bundle/dmg/
ls -lah /tmp/aiwisper-target/aarch64-apple-darwin/release/bundle/dmg/
ls -lah /tmp/aiwisper-target/x86_64-apple-darwin/release/bundle/dmg/
```

## 7. Создание тега и push

```bash
git tag v{VERSION}
git push origin master --tags
```

## 8. Публикация релиза на GitHub

**КРИТИЧНО:** После push необходимо создать GitHub Release!

Используй GitHub CLI для создания релиза с DMG файлами:
```bash
gh release create v{VERSION} \
  --title "AIWisper v{VERSION}" \
  --notes "$(cat <<'EOF'
## Что нового в v{VERSION}

### Added
- (скопируй из CHANGELOG)

### Fixed
- (скопируй из CHANGELOG)

---
Полный список изменений: [CHANGELOG.md](https://github.com/askidmobile/AIWisper/blob/master/CHANGELOG.md)
EOF
)" \
  /tmp/aiwisper-target/release/bundle/dmg/*.dmg
```

Для мультиархитектурного релиза:
```bash
gh release create v{VERSION} \
  --title "AIWisper v{VERSION}" \
  --notes "..." \
  /tmp/aiwisper-target/aarch64-apple-darwin/release/bundle/dmg/*.dmg \
  /tmp/aiwisper-target/x86_64-apple-darwin/release/bundle/dmg/*.dmg
```

## 9. Финальная проверка

Выведи итоговый отчёт:
- Новая версия
- Список изменений (краткий)
- Ссылка на GitHub Release
- Размер DMG файлов
- Команда для проверки: `gh release view v{VERSION}`

### Проверка содержимого DMG:
```bash
hdiutil attach /tmp/aiwisper-target/release/bundle/dmg/AIWisper_*.dmg -quiet
ls -lah /Volumes/AIWisper/AIWisper.app/Contents/Resources/resources/
hdiutil detach /Volumes/AIWisper -quiet
```

---

**Примечание:** Если `gh` CLI не установлен, создай релиз вручную:
https://github.com/askidmobile/AIWisper/releases/new

## Troubleshooting

### Ошибка "stream did not contain valid UTF-8" при сборке Tauri
Это AppleDouble файлы (._*) на внешнем накопителе. Решение:
```bash
find rust/target -name "._*" -delete
rm -rf rust/target/release/build/tauri-*
```
Или используй `CARGO_TARGET_DIR=/tmp/aiwisper-target`

### FFmpeg не включён в DMG
Проверь что файл существует и исполняемый:
```bash
ls -la rust/src-tauri/resources/ffmpeg*
file rust/src-tauri/resources/ffmpeg*
```
