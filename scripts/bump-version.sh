#!/bin/bash
# Скрипт для автоматического увеличения версии
# Использование: ./scripts/bump-version.sh [major|minor|patch]
# По умолчанию: patch

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PACKAGE_JSON="$PROJECT_ROOT/frontend/package.json"

# Определяем тип инкремента
BUMP_TYPE="${1:-patch}"

# Получаем текущую версию
CURRENT_VERSION=$(grep -o '"version": "[^"]*"' "$PACKAGE_JSON" | cut -d'"' -f4)

# Разбиваем на части
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Увеличиваем нужную часть
case "$BUMP_TYPE" in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    patch)
        PATCH=$((PATCH + 1))
        ;;
    *)
        echo "Unknown bump type: $BUMP_TYPE"
        echo "Usage: $0 [major|minor|patch]"
        exit 1
        ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"

# Обновляем версию в package.json
sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$PACKAGE_JSON"

echo "Version bumped: $CURRENT_VERSION -> $NEW_VERSION"
echo "$NEW_VERSION"
