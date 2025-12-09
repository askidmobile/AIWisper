#!/bin/bash
# =============================================================================
# AIWisper - macOS Application Build Script
# =============================================================================
# Собирает полноценное macOS приложение (.app bundle и .dmg)
#
# Использование:
#   ./scripts/build-macos.sh           # Полная сборка
#   ./scripts/build-macos.sh --quick   # Быстрая сборка (без universal binary)
#   ./scripts/build-macos.sh --dir     # Сборка только .app (без .dmg)
#
# Результат: frontend/release/AIWisper-*.dmg
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Параметры по умолчанию
QUICK_BUILD=false
DIR_ONLY=false
CURRENT_ARCH=$(uname -m)  # arm64 или x86_64

# Парсинг аргументов
while [[ $# -gt 0 ]]; do
    case $1 in
        --quick)
            QUICK_BUILD=true
            shift
            ;;
        --dir)
            DIR_ONLY=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--quick] [--dir]"
            echo ""
            echo "Options:"
            echo "  --quick   Quick build for current architecture only"
            echo "  --dir     Build .app directory only (no .dmg)"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

log_info "========================================"
log_info "AIWisper macOS Build"
log_info "========================================"
log_info "Current architecture: $CURRENT_ARCH"
log_info "Quick build: $QUICK_BUILD"
log_info "Dir only: $DIR_ONLY"
log_info "Project root: $PROJECT_ROOT"
echo ""

# =============================================================================
# Проверка зависимостей
# =============================================================================
log_info "Checking dependencies..."

check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "$1 is required but not installed"
        exit 1
    fi
}

check_command "go"
check_command "swift"
check_command "node"
check_command "npm"

GO_VERSION=$(go version | grep -oE 'go[0-9]+\.[0-9]+')
log_success "Go: $GO_VERSION"
log_success "Swift: $(swift --version 2>&1 | head -1 | cut -d' ' -f1-4)"
log_success "Node: $(node --version)"
log_success "npm: $(npm --version)"
echo ""

# =============================================================================
# Определение директорий
# =============================================================================
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BUILD_DIR="$PROJECT_ROOT/build"
RESOURCES_DIR="$BUILD_DIR/resources"

# Очищаем и создаём директории
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
mkdir -p "$RESOURCES_DIR"

# =============================================================================
# Генерация иконки (если нет)
# =============================================================================
if [ ! -f "$FRONTEND_DIR/build-resources/icon.icns" ]; then
    log_info "Generating application icon..."
    "$SCRIPT_DIR/generate-icon.sh"
    log_success "Icon generated"
else
    log_success "Icon already exists"
fi
echo ""

# =============================================================================
# Сборка Swift ScreenCaptureKit модуля
# =============================================================================
log_info "Building Swift ScreenCaptureKit module..."

cd "$BACKEND_DIR/audio/screencapture"
swift build -c release 2>&1 | grep -v "^Build complete" || true
cp .build/release/screencapture-audio "$RESOURCES_DIR/"
chmod +x "$RESOURCES_DIR/screencapture-audio"
log_success "Swift module built"
echo ""

# =============================================================================
# Сборка Go backend
# =============================================================================
log_info "Building Go backend..."

cd "$BACKEND_DIR"

# CGO флаги для whisper.cpp с Metal
# Используем статические библиотеки из whisper.cpp/build для избежания проблем с dylib
export CGO_ENABLED=1

# Не переопределяем CGO_LDFLAGS - используем флаги из binding/whisper.go
# которые ссылаются на статические библиотеки (.a)
# export CGO_CFLAGS="-I$PROJECT_ROOT -I$BACKEND_DIR/ai/binding"
# export CGO_LDFLAGS="-L$PROJECT_ROOT -lwhisper -lggml -lggml-cpu -lggml-metal -lggml-base -framework Accelerate -framework Metal -framework Foundation -framework CoreAudio"

BINARY_NAME="aiwisper-backend"

# Определяем GOARCH
if [ "$CURRENT_ARCH" = "arm64" ]; then
    GOARCH="arm64"
else
    GOARCH="amd64"
fi

log_info "Building for $GOARCH..."
# Собираем без переопределения CGO_LDFLAGS - используем статические библиотеки из whisper.go
GOOS=darwin GOARCH=$GOARCH go build \
    -ldflags="-s -w -X main.version=1.11.0" \
    -o "$RESOURCES_DIR/$BINARY_NAME" \
    .

chmod +x "$RESOURCES_DIR/$BINARY_NAME"
log_success "Go backend built"
echo ""

# =============================================================================
# Копирование динамических библиотек
# =============================================================================
log_info "Copying dynamic libraries..."

DYLIBS=(
    "libwhisper.dylib"
    "libggml.dylib"
    "libggml-cpu.dylib"
    "libggml-metal.dylib"
    "libggml-base.dylib"
    "libggml-blas.dylib"
)

for lib in "${DYLIBS[@]}"; do
    if [ -f "$PROJECT_ROOT/$lib" ]; then
        cp "$PROJECT_ROOT/$lib" "$RESOURCES_DIR/"
        log_success "Copied $lib"
    else
        log_warn "$lib not found in project root"
    fi
done

# Metal shader
if [ -f "$BACKEND_DIR/ai/binding/ggml-metal/ggml-metal.metal" ]; then
    cp "$BACKEND_DIR/ai/binding/ggml-metal/ggml-metal.metal" "$RESOURCES_DIR/"
    log_success "Copied Metal shader"
elif [ -f "$BACKEND_DIR/ai/binding/ggml-metal.metal" ]; then
    cp "$BACKEND_DIR/ai/binding/ggml-metal.metal" "$RESOURCES_DIR/"
    log_success "Copied Metal shader"
fi

# ONNX Runtime для GigaAM
ONNX_LIB_DIR="$BACKEND_DIR/cmd/spike_gigaam/onnxruntime-osx-arm64-1.22.0/lib"
if [ -f "$ONNX_LIB_DIR/libonnxruntime.1.22.0.dylib" ]; then
    cp "$ONNX_LIB_DIR/libonnxruntime.1.22.0.dylib" "$RESOURCES_DIR/"
    # Создаём симлинк для совместимости
    cd "$RESOURCES_DIR"
    ln -sf libonnxruntime.1.22.0.dylib libonnxruntime.dylib
    cd "$PROJECT_ROOT"
    log_success "Copied ONNX Runtime for GigaAM"
else
    log_warn "ONNX Runtime not found - GigaAM will not work"
fi

echo ""

# =============================================================================
# Скачивание/копирование FFmpeg
# =============================================================================
log_info "Setting up FFmpeg..."

FFMPEG_DIR="$PROJECT_ROOT/vendor/ffmpeg"
FFMPEG_BINARY="$FFMPEG_DIR/ffmpeg"

if [ -f "$FFMPEG_BINARY" ]; then
    log_success "FFmpeg already exists in vendor/"
else
    log_info "Downloading static FFmpeg for macOS..."
    mkdir -p "$FFMPEG_DIR"
    
    # Используем martin-riedl.de для arm64 или amd64
    if [ "$CURRENT_ARCH" = "arm64" ]; then
        FFMPEG_URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip"
    else
        FFMPEG_URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip"
    fi
    
    log_info "Downloading from: $FFMPEG_URL"
    curl -L "$FFMPEG_URL" -o "$FFMPEG_DIR/ffmpeg.zip"
    
    # Распаковываем
    cd "$FFMPEG_DIR"
    unzip -o ffmpeg.zip
    rm ffmpeg.zip
    
    # Ищем бинарник (может быть в поддиректории)
    FFMPEG_FOUND=$(find . -name "ffmpeg" -type f ! -name "*.zip" | head -1)
    if [ -n "$FFMPEG_FOUND" ] && [ "$FFMPEG_FOUND" != "./ffmpeg" ]; then
        mv "$FFMPEG_FOUND" ./ffmpeg
    fi
    
    chmod +x ffmpeg
    cd "$PROJECT_ROOT"
    log_success "FFmpeg downloaded"
fi

# Копируем FFmpeg в resources
cp "$FFMPEG_BINARY" "$RESOURCES_DIR/ffmpeg"
chmod +x "$RESOURCES_DIR/ffmpeg"
log_success "FFmpeg copied to resources"
echo ""

# =============================================================================
# Копирование модели Whisper
# =============================================================================
log_info "Copying Whisper model..."

if [ -f "$BACKEND_DIR/ggml-base.bin" ]; then
    cp "$BACKEND_DIR/ggml-base.bin" "$RESOURCES_DIR/"
    MODEL_SIZE=$(du -h "$RESOURCES_DIR/ggml-base.bin" | cut -f1)
    log_success "Copied ggml-base.bin ($MODEL_SIZE)"
else
    log_warn "ggml-base.bin not found! Application will need a model to function."
fi
echo ""

# =============================================================================
# Исправление библиотечных путей (install_name_tool)
# =============================================================================
log_info "Fixing library paths for redistribution..."

cd "$RESOURCES_DIR"

# Функция для безопасного изменения ссылки (проверяет наличие старого пути)
safe_change() {
    local target="$1"
    local old_path="$2"
    local new_path="$3"
    
    # Проверяем что старый путь есть в бинарнике
    if otool -L "$target" 2>/dev/null | grep -q "$old_path"; then
        install_name_tool -change "$old_path" "$new_path" "$target" 2>/dev/null || true
    fi
}

# Исправляем ID каждой библиотеки
for lib in *.dylib; do
    if [ -f "$lib" ]; then
        install_name_tool -id "@loader_path/$lib" "$lib" 2>/dev/null || true
    fi
done

# Исправляем ссылки в библиотеках
for lib in *.dylib; do
    if [ -f "$lib" ]; then
        # Версионированные имена -> обычные имена с @loader_path
        safe_change "$lib" "@rpath/libwhisper.1.dylib" "@loader_path/libwhisper.dylib"
        safe_change "$lib" "@rpath/libggml.0.dylib" "@loader_path/libggml.dylib"
        safe_change "$lib" "@rpath/libggml-cpu.0.dylib" "@loader_path/libggml-cpu.dylib"
        safe_change "$lib" "@rpath/libggml-metal.0.dylib" "@loader_path/libggml-metal.dylib"
        safe_change "$lib" "@rpath/libggml-base.0.dylib" "@loader_path/libggml-base.dylib"
        # libggml-blas
        safe_change "$lib" "@rpath/libggml-blas.0.dylib" "@loader_path/libggml-blas.dylib"
        safe_change "$lib" "@rpath/libggml-blas.dylib" "@loader_path/libggml-blas.dylib"
        
        # Прямые ссылки
        for dep in *.dylib; do
            if [ -f "$dep" ] && [ "$lib" != "$dep" ]; then
                safe_change "$lib" "$PROJECT_ROOT/$dep" "@loader_path/$dep"
                safe_change "$lib" "/usr/local/lib/$dep" "@loader_path/$dep"
            fi
        done
    fi
done

# Исправляем ссылки в бинарнике backend
safe_change "$BINARY_NAME" "@rpath/libwhisper.1.dylib" "@executable_path/../Resources/libwhisper.dylib"
safe_change "$BINARY_NAME" "@rpath/libggml.0.dylib" "@executable_path/../Resources/libggml.dylib"
safe_change "$BINARY_NAME" "@rpath/libggml-cpu.0.dylib" "@executable_path/../Resources/libggml-cpu.dylib"
safe_change "$BINARY_NAME" "@rpath/libggml-metal.0.dylib" "@executable_path/../Resources/libggml-metal.dylib"
safe_change "$BINARY_NAME" "@rpath/libggml-base.0.dylib" "@executable_path/../Resources/libggml-base.dylib"
# libggml-blas
safe_change "$BINARY_NAME" "@rpath/libggml-blas.0.dylib" "@executable_path/../Resources/libggml-blas.dylib"
safe_change "$BINARY_NAME" "@rpath/libggml-blas.dylib" "@executable_path/../Resources/libggml-blas.dylib"

# Прямые ссылки в бинарнике
for lib in *.dylib; do
    if [ -f "$lib" ]; then
        safe_change "$BINARY_NAME" "$PROJECT_ROOT/$lib" "@executable_path/../Resources/$lib"
        safe_change "$BINARY_NAME" "/usr/local/lib/$lib" "@executable_path/../Resources/$lib"
    fi
done

# Добавляем rpath (на случай если что-то не заменилось)
install_name_tool -add_rpath "@executable_path/../Resources" "$BINARY_NAME" 2>/dev/null || true
install_name_tool -add_rpath "@loader_path" "$BINARY_NAME" 2>/dev/null || true

log_success "Library paths fixed"
echo ""

# =============================================================================
# Подписываем бинарники для macOS (ad-hoc signing)
# =============================================================================
log_info "Signing binaries (ad-hoc)..."

# Подписываем все dylib
for lib in *.dylib; do
    if [ -f "$lib" ]; then
        codesign --force --sign - "$lib" 2>/dev/null || log_warn "Failed to sign $lib"
    fi
done

# Подписываем backend
codesign --force --sign - --entitlements "$FRONTEND_DIR/build-resources/entitlements.mac.plist" "$BINARY_NAME" 2>/dev/null || log_warn "Failed to sign $BINARY_NAME"

# Подписываем screencapture-audio
if [ -f "screencapture-audio" ]; then
    codesign --force --sign - "screencapture-audio" 2>/dev/null || log_warn "Failed to sign screencapture-audio"
fi

# Подписываем ffmpeg
if [ -f "ffmpeg" ]; then
    codesign --force --sign - "ffmpeg" 2>/dev/null || log_warn "Failed to sign ffmpeg"
fi

# Подписываем ONNX Runtime
if [ -f "libonnxruntime.1.22.0.dylib" ]; then
    codesign --force --sign - "libonnxruntime.1.22.0.dylib" 2>/dev/null || log_warn "Failed to sign libonnxruntime"
fi

log_success "Binaries signed"
echo ""

# =============================================================================
# Сборка Frontend (Electron)
# =============================================================================
log_info "Building frontend..."

cd "$FRONTEND_DIR"

# Устанавливаем зависимости если нужно
if [ ! -d "node_modules" ]; then
    log_info "Installing npm dependencies..."
    npm install
fi

# Собираем Vite
log_info "Building Vite app..."
npm run build 2>&1 | tail -5

log_success "Frontend built"
echo ""

# =============================================================================
# Сборка Electron приложения
# =============================================================================
log_info "Packaging Electron application..."

cd "$FRONTEND_DIR"

# Определяем команду electron-builder
if [ "$DIR_ONLY" = true ]; then
    BUILD_CMD="electron-builder --mac dir"
else
    BUILD_CMD="electron-builder --mac dmg"
fi

# Запускаем electron-builder
npx $BUILD_CMD 2>&1 | grep -E "(Building|Packaging|artifact)" || true

log_success "========================================"
log_success "Build completed successfully!"
log_success "========================================"
echo ""

# Показываем результат
log_info "Output files:"
if [ -d "$FRONTEND_DIR/release" ]; then
    ls -lh "$FRONTEND_DIR/release/"*.dmg 2>/dev/null || ls -lh "$FRONTEND_DIR/release/" 2>/dev/null || true
fi

echo ""
log_info "To install, open the .dmg file and drag AIWisper to Applications"
log_info "Note: On first run, you'll need to grant microphone and screen recording permissions"
