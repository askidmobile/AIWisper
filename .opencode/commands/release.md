---
description: Production release - анализ коммитов, обновление версии, сборка и публикация на GitHub
---

# Production Release

Выполни полный релизный цикл для AIWisper:

## 1. Анализ изменений

Проанализируй коммиты с момента последнего релиза:
!`git log $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~20)..HEAD --oneline --no-merges`

Определи тип релиза на основе изменений:
- **MAJOR** (x.0.0): Breaking changes, несовместимые изменения API
- **MINOR** (0.x.0): Новые функции, совместимые с предыдущей версией  
- **PATCH** (0.0.x): Исправления ошибок, мелкие улучшения

## 2. Обновление версии

Текущая версия в файле:
- `frontend/package.json` (поле "version")

Увеличь версию согласно semver и обнови файл.

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

## 4. Обновление README.md

В файле @README.md обнови версию если она указана явно.

## 5. Создание коммита

После обновления всех файлов создай коммит:
```bash
git add frontend/package.json CHANGELOG.md README.md
git commit -m "release: v{VERSION}"
```

## 6. Сборка приложения

Собери Electron приложение:
```bash
cd frontend && npm run build
```

Проверь наличие собранных файлов в `frontend/release/` или `frontend/dist-electron/`

## 7. Создание тега и push

```bash
git tag v{VERSION}
git push origin master --tags
```

## 8. Публикация релиза на GitHub

**КРИТИЧНО:** После push необходимо создать GitHub Release!

Используй GitHub CLI для создания релиза:
```bash
gh release create v{VERSION} \
  --title "AIWisper v{VERSION}" \
  --notes "## Что нового в v{VERSION}

### Added
- (скопируй из CHANGELOG)

### Fixed
- (скопируй из CHANGELOG)

---
Полный список изменений: [CHANGELOG.md](https://github.com/AskidAI/AIWisper/blob/master/CHANGELOG.md)"
```

Если есть собранные артефакты (DMG, exe), приложи их к релизу:
```bash
gh release upload v{VERSION} frontend/release/*.dmg frontend/release/*.exe
```

## 9. Финальная проверка

Выведи итоговый отчёт:
- Новая версия
- Список изменений (краткий)
- Ссылка на GitHub Release
- Команда для проверки: `gh release view v{VERSION}`

---

**Примечание:** Если `gh` CLI не установлен, создай релиз вручную:
https://github.com/AskidAI/AIWisper/releases/new
