---
description: Показать текущую версию приложения
---

# Текущая версия AIWisper

Версии в файлах проекта:

**frontend/package.json:**
!`grep '"version"' frontend/package.json | head -1`

**Последний тег:**
!`git describe --tags --abbrev=0 2>/dev/null || echo "Нет тегов"`

**Последние коммиты:**
!`git log --oneline -5`

**Статус репозитория:**
!`git status -s | head -10`
