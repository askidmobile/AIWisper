#!/bin/bash
# =============================================================================
# AIWisper - Tauri Application Build Script
# =============================================================================
# Собирает Tauri приложение и исправляет DMG (скрывает VolumeIcon.icns)
#
# Использование:
#   ./scripts/build-tauri.sh           # Полная сборка
#   ./scripts/build-tauri.sh --debug   # Debug сборка
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

while [[ $# -gt 0 ]]; do
    case $1 in
        --debug)
            DEBUG_BUILD=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--debug]"
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

if [ "$DEBUG_BUILD" = true ]; then
    cargo tauri build --debug --bundles dmg
    BUNDLE_DIR="$RUST_DIR/target/debug/bundle"
else
    cargo tauri build --bundles dmg
    BUNDLE_DIR="$RUST_DIR/target/release/bundle"
fi

log_success "Tauri build completed"

# =============================================================================
# Постобработка DMG - скрываем VolumeIcon.icns
# =============================================================================
log_info "Post-processing DMG..."

DMG_DIR="$BUNDLE_DIR/dmg"
if [ -d "$DMG_DIR" ]; then
    for dmg_file in "$DMG_DIR"/*.dmg; do
        if [ -f "$dmg_file" ]; then
            log_info "Processing: $(basename "$dmg_file")"
            
            # Создаём временную директорию
            MOUNT_POINT=$(mktemp -d)
            TEMP_DMG=$(mktemp).dmg
            
            # Монтируем DMG
            hdiutil attach "$dmg_file" -mountpoint "$MOUNT_POINT" -nobrowse -quiet
            
            # Проверяем наличие VolumeIcon.icns (с точкой или без)
            NEEDS_FIX=false
            ICON_FILE=""
            
            if [ -f "$MOUNT_POINT/.VolumeIcon.icns" ]; then
                ICON_FILE="$MOUNT_POINT/.VolumeIcon.icns"
                # Проверяем есть ли флаг hidden
                if ! ls -lO "$ICON_FILE" 2>/dev/null | grep -q "hidden"; then
                    NEEDS_FIX=true
                    log_warn ".VolumeIcon.icns exists but not hidden"
                else
                    log_success ".VolumeIcon.icns already hidden"
                fi
            elif [ -f "$MOUNT_POINT/VolumeIcon.icns" ]; then
                ICON_FILE="$MOUNT_POINT/VolumeIcon.icns"
                NEEDS_FIX=true
                log_warn "VolumeIcon.icns is visible"
            fi
            
            if [ "$NEEDS_FIX" = true ] && [ -n "$ICON_FILE" ]; then
                log_info "Fixing VolumeIcon.icns visibility..."
                
                # Отмонтируем read-only
                hdiutil detach "$MOUNT_POINT" -quiet
                
                # Конвертируем в read-write
                hdiutil convert "$dmg_file" -format UDRW -o "$TEMP_DMG" -quiet
                
                # Монтируем read-write версию
                hdiutil attach "$TEMP_DMG" -mountpoint "$MOUNT_POINT" -nobrowse -quiet
                
                # Находим файл иконки
                if [ -f "$MOUNT_POINT/VolumeIcon.icns" ]; then
                    # Переименовываем с точкой
                    mv "$MOUNT_POINT/VolumeIcon.icns" "$MOUNT_POINT/.VolumeIcon.icns"
                fi
                
                # Устанавливаем флаг hidden через chflags
                if [ -f "$MOUNT_POINT/.VolumeIcon.icns" ]; then
                    chflags hidden "$MOUNT_POINT/.VolumeIcon.icns"
                    log_success "Set hidden flag on .VolumeIcon.icns"
                fi
                
                # Отмонтируем
                hdiutil detach "$MOUNT_POINT" -quiet
                
                # Конвертируем обратно в compressed readonly и заменяем оригинал
                rm -f "$dmg_file"
                hdiutil convert "$TEMP_DMG" -format UDZO -o "$dmg_file" -quiet
                
                # Удаляем временные файлы
                rm -f "$TEMP_DMG"
                
                log_success "DMG fixed: $(basename "$dmg_file")"
            else
                hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
            fi
            
            # Очистка
            rmdir "$MOUNT_POINT" 2>/dev/null || true
        fi
    done
else
    log_warn "DMG directory not found: $DMG_DIR"
fi

# =============================================================================
# Результат
# =============================================================================
log_success "========================================"
log_success "Build completed!"
log_success "========================================"

if [ -d "$DMG_DIR" ]; then
    log_info "Output files:"
    ls -lh "$DMG_DIR"/*.dmg 2>/dev/null || true
fi
