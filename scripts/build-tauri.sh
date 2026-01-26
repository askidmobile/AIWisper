#!/bin/bash
# =============================================================================
# AIWisper - Tauri Application Build Script
# =============================================================================
# Собирает Tauri приложение и исправляет DMG (удаляет VolumeIcon.icns)
#
# Использование:
#   ./scripts/build-tauri.sh                    # Release сборка (native arch)
#   ./scripts/build-tauri.sh --debug            # Debug сборка
#   ./scripts/build-tauri.sh --target arm64     # Release для Apple Silicon
#   ./scripts/build-tauri.sh --target x64       # Release для Intel
#   ./scripts/build-tauri.sh --target universal # Universal Binary (arm64 + x64)
#
# Результат: rust/target/release/bundle/dmg/AIWisper_*.dmg
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$PROJECT_ROOT/rust"

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Параметры
DEBUG_BUILD=false
TARGET_ARCH=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --debug)
            DEBUG_BUILD=true
            shift
            ;;
        --target)
            TARGET_ARCH="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--debug] [--target arm64|x64|universal]"
            echo ""
            echo "Options:"
            echo "  --debug           Build debug version"
            echo "  --target arm64    Build for Apple Silicon"
            echo "  --target x64      Build for Intel"
            echo "  --target universal Build Universal Binary (arm64 + x64)"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

log_info "========================================"
log_info "AIWisper Tauri Build"
log_info "========================================"

# =============================================================================
# Проверка FFmpeg
# =============================================================================
RESOURCES_DIR="$RUST_DIR/src-tauri/resources"

check_ffmpeg() {
    local arch=$1
    local ffmpeg_path="$RESOURCES_DIR/ffmpeg-$arch"
    
    if [ -f "$ffmpeg_path" ]; then
        log_success "FFmpeg for $arch: OK"
        return 0
    else
        return 1
    fi
}

log_info "Checking FFmpeg binaries..."

# Определяем какие архитектуры нужны
NEED_ARM64=false
NEED_X86_64=false

case "$TARGET_ARCH" in
    arm64|aarch64)
        NEED_ARM64=true
        ;;
    x64|x86_64|intel)
        NEED_X86_64=true
        ;;
    universal)
        NEED_ARM64=true
        NEED_X86_64=true
        ;;
    "")
        # Native architecture
        if [ "$(uname -m)" = "arm64" ]; then
            NEED_ARM64=true
        else
            NEED_X86_64=true
        fi
        ;;
esac

FFMPEG_MISSING=false

if [ "$NEED_ARM64" = true ]; then
    if ! check_ffmpeg "arm64" && ! check_ffmpeg "aarch64"; then
        log_warn "FFmpeg for arm64 not found"
        FFMPEG_MISSING=true
    fi
fi

if [ "$NEED_X86_64" = true ]; then
    if ! check_ffmpeg "x86_64"; then
        log_warn "FFmpeg for x86_64 not found"
        FFMPEG_MISSING=true
    fi
fi

if [ "$FFMPEG_MISSING" = true ]; then
    log_warn ""
    log_warn "FFmpeg binaries are missing!"
    log_warn "Run: ./scripts/download-ffmpeg.sh --all"
    log_warn ""
    log_warn "Or download manually:"
    log_warn "  - ARM64: brew install ffmpeg && cp \$(which ffmpeg) $RESOURCES_DIR/ffmpeg-arm64"
    log_warn "  - x86_64: Download from https://evermeet.cx/ffmpeg/"
    log_warn ""
    
    # Спрашиваем пользователя
    read -p "Try to download FFmpeg automatically? [Y/n] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
        log_info "Running download-ffmpeg.sh..."
        if [ "$NEED_ARM64" = true ] && [ "$NEED_X86_64" = true ]; then
            "$SCRIPT_DIR/download-ffmpeg.sh" --all
        elif [ "$NEED_ARM64" = true ]; then
            "$SCRIPT_DIR/download-ffmpeg.sh" --arm64
        else
            "$SCRIPT_DIR/download-ffmpeg.sh" --x86_64
        fi
        
        # Проверяем снова
        FFMPEG_MISSING=false
        if [ "$NEED_ARM64" = true ] && ! check_ffmpeg "arm64"; then
            FFMPEG_MISSING=true
        fi
        if [ "$NEED_X86_64" = true ] && ! check_ffmpeg "x86_64"; then
            FFMPEG_MISSING=true
        fi
        
        if [ "$FFMPEG_MISSING" = true ]; then
            log_error "FFmpeg download failed. Please install manually."
            exit 1
        fi
    else
        log_error "Build cancelled. FFmpeg is required for the application."
        exit 1
    fi
fi

# =============================================================================
# Сборка UI
# =============================================================================
log_info "Building UI..."
cd "$RUST_DIR/ui"
npm run build
log_success "UI built"

# =============================================================================
# Сборка Tauri
# =============================================================================
log_info "Building Tauri application..."
cd "$RUST_DIR"

# Log GPU acceleration features
if [[ "$OSTYPE" == "darwin"* ]]; then
    log_info "Platform: macOS - Metal GPU and CoreML acceleration enabled"
    log_info "  - Whisper: Metal GPU acceleration (whisper-rs with metal feature)"
    log_info "  - GigaAM/VAD: CoreML acceleration (ort with coreml feature)"
    log_info "  - Note: INT8 models use CPU (faster than CoreML for quantized)"
fi

# Определяем target для cargo
CARGO_TARGET=""
case "$TARGET_ARCH" in
    arm64|aarch64)
        CARGO_TARGET="--target aarch64-apple-darwin"
        log_info "Target: Apple Silicon (aarch64-apple-darwin)"
        ;;
    x64|x86_64|intel)
        CARGO_TARGET="--target x86_64-apple-darwin"
        log_info "Target: Intel (x86_64-apple-darwin)"
        ;;
    universal)
        log_info "Target: Universal Binary (arm64 + x64)"
        # Universal build требует отдельной обработки
        ;;
    "")
        log_info "Target: Native architecture"
        ;;
    *)
        log_error "Unknown target: $TARGET_ARCH"
        exit 1
        ;;
esac

if [ "$DEBUG_BUILD" = true ]; then
    cargo tauri build --debug --bundles dmg $CARGO_TARGET
    BUNDLE_DIR="$RUST_DIR/target/debug/bundle"
else
    cargo tauri build --bundles dmg $CARGO_TARGET
    if [ -n "$CARGO_TARGET" ]; then
        # Для cross-compile target директория другая
        case "$TARGET_ARCH" in
            arm64|aarch64)
                BUNDLE_DIR="$RUST_DIR/target/aarch64-apple-darwin/release/bundle"
                ;;
            x64|x86_64|intel)
                BUNDLE_DIR="$RUST_DIR/target/x86_64-apple-darwin/release/bundle"
                ;;
        esac
    else
        BUNDLE_DIR="$RUST_DIR/target/release/bundle"
    fi
fi

log_success "Tauri build completed"

# =============================================================================
# Постобработка DMG - УДАЛЯЕМ VolumeIcon.icns полностью
# =============================================================================
# Проблема: Tauri добавляет VolumeIcon.icns как видимый файл.
# Решение: Удаляем его полностью. Иконка тома всё равно будет работать
# через .DS_Store и атрибуты тома.
# =============================================================================
log_info "Post-processing DMG (removing VolumeIcon.icns)..."

DMG_DIR="$BUNDLE_DIR/dmg"
if [ -d "$DMG_DIR" ]; then
    for dmg_file in "$DMG_DIR"/*.dmg; do
        if [ -f "$dmg_file" ]; then
            log_info "Processing: $(basename "$dmg_file")"
            
            # Создаём временную директорию
            MOUNT_POINT=$(mktemp -d)
            TEMP_DMG=$(mktemp).dmg
            
            # Монтируем DMG read-only для проверки
            hdiutil attach "$dmg_file" -mountpoint "$MOUNT_POINT" -nobrowse -quiet
            
            # Проверяем наличие VolumeIcon.icns (с точкой или без)
            NEEDS_FIX=false
            
            if [ -f "$MOUNT_POINT/VolumeIcon.icns" ]; then
                NEEDS_FIX=true
                log_warn "Found visible VolumeIcon.icns"
            elif [ -f "$MOUNT_POINT/.VolumeIcon.icns" ]; then
                # Проверяем видимость через ls -la
                if ls -la "$MOUNT_POINT/" | grep -q "VolumeIcon.icns"; then
                    # Проверяем флаг hidden
                    if ! ls -lO "$MOUNT_POINT/.VolumeIcon.icns" 2>/dev/null | grep -q "hidden"; then
                        NEEDS_FIX=true
                        log_warn "Found .VolumeIcon.icns without hidden flag"
                    fi
                fi
            fi
            
            # Отмонтируем
            hdiutil detach "$MOUNT_POINT" -quiet
            
            if [ "$NEEDS_FIX" = true ]; then
                log_info "Removing VolumeIcon.icns from DMG..."
                
                # Конвертируем в read-write
                hdiutil convert "$dmg_file" -format UDRW -o "$TEMP_DMG" -quiet
                
                # Монтируем read-write версию
                hdiutil attach "$TEMP_DMG" -mountpoint "$MOUNT_POINT" -nobrowse -quiet
                
                # УДАЛЯЕМ файл иконки полностью (вместо скрытия)
                rm -f "$MOUNT_POINT/VolumeIcon.icns" 2>/dev/null || true
                rm -f "$MOUNT_POINT/.VolumeIcon.icns" 2>/dev/null || true
                
                log_success "Removed VolumeIcon.icns"
                
                # Отмонтируем
                hdiutil detach "$MOUNT_POINT" -quiet
                
                # Конвертируем обратно в compressed readonly и заменяем оригинал
                rm -f "$dmg_file"
                hdiutil convert "$TEMP_DMG" -format UDZO -o "$dmg_file" -quiet
                
                # Удаляем временные файлы
                rm -f "$TEMP_DMG"
                
                log_success "DMG fixed: $(basename "$dmg_file")"
            else
                log_success "DMG is clean: $(basename "$dmg_file")"
            fi
            
            # Очистка
            rmdir "$MOUNT_POINT" 2>/dev/null || true
        fi
    done
else
    log_warn "DMG directory not found: $DMG_DIR"
fi

# =============================================================================
# Копирование DMG в build/
# =============================================================================
log_info "Copying DMG to build/ directory..."

BUILD_OUTPUT_DIR="$PROJECT_ROOT/build"
mkdir -p "$BUILD_OUTPUT_DIR"

if [ -d "$DMG_DIR" ]; then
    for dmg_file in "$DMG_DIR"/*.dmg; do
        if [ -f "$dmg_file" ]; then
            cp "$dmg_file" "$BUILD_OUTPUT_DIR/"
            log_success "Copied: $(basename "$dmg_file") -> build/"
        fi
    done
fi

# =============================================================================
# Результат
# =============================================================================
log_success "========================================"
log_success "Build completed!"
log_success "========================================"

if [ -d "$BUILD_OUTPUT_DIR" ]; then
    log_info "Output files in build/:"
    ls -lh "$BUILD_OUTPUT_DIR"/*.dmg 2>/dev/null || true
fi
