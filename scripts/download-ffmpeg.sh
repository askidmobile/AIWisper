#!/bin/bash
# =============================================================================
# AIWisper - FFmpeg Download Script
# =============================================================================
# Скачивает статические бинарники FFmpeg для macOS (arm64 и x86_64)
# Эти бинарники включаются в Tauri бандл для работы с аудио/видео
#
# Использование:
#   ./scripts/download-ffmpeg.sh              # Скачать для текущей архитектуры
#   ./scripts/download-ffmpeg.sh --all        # Скачать для обеих архитектур
#   ./scripts/download-ffmpeg.sh --arm64      # Только Apple Silicon
#   ./scripts/download-ffmpeg.sh --x86_64     # Только Intel
#
# Источник: https://evermeet.cx/ffmpeg/ (статические сборки для macOS)
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$PROJECT_ROOT/rust/src-tauri/resources"

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

# URL для скачивания FFmpeg (статические сборки от evermeet.cx)
# Альтернатива: https://www.osxexperts.net или собственная сборка
FFMPEG_ARM64_URL="https://www.osxexperts.net/ffmpeg7arm.zip"
FFMPEG_X86_64_URL="https://www.osxexperts.net/ffmpeg7intel.zip"

# Резервные URL (evermeet.cx - только последняя версия, без архитектуры в URL)
FFMPEG_EVERMEET_URL="https://evermeet.cx/ffmpeg/ffmpeg-7.1.1.zip"

# Параметры
DOWNLOAD_ARM64=false
DOWNLOAD_X86_64=false
FORCE=false

# Определяем текущую архитектуру
CURRENT_ARCH=$(uname -m)

# Парсим аргументы
while [[ $# -gt 0 ]]; do
    case $1 in
        --all)
            DOWNLOAD_ARM64=true
            DOWNLOAD_X86_64=true
            shift
            ;;
        --arm64|--aarch64)
            DOWNLOAD_ARM64=true
            shift
            ;;
        --x86_64|--intel|--x64)
            DOWNLOAD_X86_64=true
            shift
            ;;
        --force|-f)
            FORCE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--all|--arm64|--x86_64] [--force]"
            echo ""
            echo "Options:"
            echo "  --all       Download for both architectures"
            echo "  --arm64     Download for Apple Silicon only"
            echo "  --x86_64    Download for Intel only"
            echo "  --force     Re-download even if file exists"
            echo ""
            echo "Without options, downloads for current architecture ($CURRENT_ARCH)"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Если ничего не указано - скачиваем для текущей архитектуры
if [ "$DOWNLOAD_ARM64" = false ] && [ "$DOWNLOAD_X86_64" = false ]; then
    if [ "$CURRENT_ARCH" = "arm64" ]; then
        DOWNLOAD_ARM64=true
    else
        DOWNLOAD_X86_64=true
    fi
fi

log_info "========================================"
log_info "AIWisper FFmpeg Download"
log_info "========================================"

# Создаём директорию resources если нет
mkdir -p "$RESOURCES_DIR"

# Функция скачивания FFmpeg
download_ffmpeg() {
    local arch=$1
    local url=$2
    local output_file="$RESOURCES_DIR/ffmpeg-$arch"
    
    # Проверяем существует ли уже
    if [ -f "$output_file" ] && [ "$FORCE" = false ]; then
        log_success "FFmpeg for $arch already exists: $output_file"
        return 0
    fi
    
    log_info "Downloading FFmpeg for $arch..."
    
    # Временная директория
    local temp_dir=$(mktemp -d)
    local zip_file="$temp_dir/ffmpeg.zip"
    
    # Скачиваем
    if ! curl -L -o "$zip_file" "$url" 2>/dev/null; then
        log_error "Failed to download from $url"
        rm -rf "$temp_dir"
        return 1
    fi
    
    # Распаковываем
    log_info "Extracting..."
    unzip -q -o "$zip_file" -d "$temp_dir"
    
    # Ищем бинарник ffmpeg
    local ffmpeg_bin=$(find "$temp_dir" -name "ffmpeg" -type f -perm +111 | head -1)
    
    if [ -z "$ffmpeg_bin" ]; then
        # Если не нашли с правами исполнения, ищем просто файл
        ffmpeg_bin=$(find "$temp_dir" -name "ffmpeg" -type f | head -1)
    fi
    
    if [ -z "$ffmpeg_bin" ]; then
        log_error "FFmpeg binary not found in archive"
        rm -rf "$temp_dir"
        return 1
    fi
    
    # Копируем и даём права
    cp "$ffmpeg_bin" "$output_file"
    chmod +x "$output_file"
    
    # Очищаем
    rm -rf "$temp_dir"
    
    # Проверяем
    local file_size=$(ls -lh "$output_file" | awk '{print $5}')
    log_success "Downloaded FFmpeg for $arch: $output_file ($file_size)"
    
    # Показываем версию
    if [ "$arch" = "$CURRENT_ARCH" ] || [ "$arch" = "arm64" -a "$CURRENT_ARCH" = "arm64" ] || [ "$arch" = "x86_64" -a "$CURRENT_ARCH" = "x86_64" ]; then
        local version=$("$output_file" -version 2>/dev/null | head -1 || echo "unknown")
        log_info "Version: $version"
    fi
    
    return 0
}

# Альтернативный метод: скачать с Homebrew bottles
download_from_homebrew() {
    local arch=$1
    local output_file="$RESOURCES_DIR/ffmpeg-$arch"
    
    log_info "Trying Homebrew bottles for $arch..."
    
    # Получаем URL бутылки из Homebrew API
    local bottle_url=""
    
    if [ "$arch" = "arm64" ]; then
        bottle_url=$(curl -s "https://formulae.brew.sh/api/formula/ffmpeg.json" | \
            grep -o '"arm64_sonoma":{[^}]*}' | \
            grep -o '"url":"[^"]*"' | \
            cut -d'"' -f4 | head -1)
    else
        bottle_url=$(curl -s "https://formulae.brew.sh/api/formula/ffmpeg.json" | \
            grep -o '"sonoma":{[^}]*}' | \
            grep -o '"url":"[^"]*"' | \
            cut -d'"' -f4 | head -1)
    fi
    
    if [ -z "$bottle_url" ]; then
        log_warn "Could not get Homebrew bottle URL for $arch"
        return 1
    fi
    
    log_info "Bottle URL: $bottle_url"
    
    local temp_dir=$(mktemp -d)
    local bottle_file="$temp_dir/ffmpeg.tar.gz"
    
    # Скачиваем bottle
    if ! curl -L -o "$bottle_file" "$bottle_url" 2>/dev/null; then
        log_error "Failed to download Homebrew bottle"
        rm -rf "$temp_dir"
        return 1
    fi
    
    # Распаковываем
    tar -xzf "$bottle_file" -C "$temp_dir"
    
    # Ищем бинарник
    local ffmpeg_bin=$(find "$temp_dir" -name "ffmpeg" -type f | head -1)
    
    if [ -z "$ffmpeg_bin" ]; then
        log_error "FFmpeg not found in Homebrew bottle"
        rm -rf "$temp_dir"
        return 1
    fi
    
    cp "$ffmpeg_bin" "$output_file"
    chmod +x "$output_file"
    rm -rf "$temp_dir"
    
    log_success "Downloaded FFmpeg from Homebrew for $arch"
    return 0
}

# Метод 3: Использовать системный ffmpeg если есть
use_system_ffmpeg() {
    local arch=$1
    local output_file="$RESOURCES_DIR/ffmpeg-$arch"
    
    # Проверяем есть ли ffmpeg в системе
    if command -v ffmpeg &> /dev/null; then
        local system_ffmpeg=$(which ffmpeg)
        local system_arch=$(file "$system_ffmpeg" | grep -o 'arm64\|x86_64' | head -1)
        
        if [ "$system_arch" = "$arch" ] || [ "$arch" = "arm64" -a "$system_arch" = "arm64" ]; then
            log_info "Copying system FFmpeg ($system_ffmpeg) for $arch"
            cp "$system_ffmpeg" "$output_file"
            chmod +x "$output_file"
            log_success "Copied system FFmpeg for $arch"
            return 0
        fi
    fi
    
    return 1
}

# Основная логика скачивания
download_with_fallback() {
    local arch=$1
    local primary_url=$2
    
    # Метод 1: Основной URL
    if download_ffmpeg "$arch" "$primary_url"; then
        return 0
    fi
    
    # Метод 2: Evermeet (универсальный URL)
    log_warn "Primary download failed, trying evermeet.cx..."
    if download_ffmpeg "$arch" "$FFMPEG_EVERMEET_URL"; then
        return 0
    fi
    
    # Метод 3: Homebrew bottles
    log_warn "Evermeet failed, trying Homebrew bottles..."
    if download_from_homebrew "$arch"; then
        return 0
    fi
    
    # Метод 4: Системный ffmpeg
    log_warn "Homebrew failed, trying system ffmpeg..."
    if use_system_ffmpeg "$arch"; then
        return 0
    fi
    
    log_error "All download methods failed for $arch"
    log_error ""
    log_error "Please install FFmpeg manually:"
    log_error "  brew install ffmpeg"
    log_error "  cp \$(which ffmpeg) $RESOURCES_DIR/ffmpeg-$arch"
    return 1
}

# Скачиваем для нужных архитектур
FAILED=false

if [ "$DOWNLOAD_ARM64" = true ]; then
    if ! download_with_fallback "arm64" "$FFMPEG_ARM64_URL"; then
        FAILED=true
    fi
fi

if [ "$DOWNLOAD_X86_64" = true ]; then
    if ! download_with_fallback "x86_64" "$FFMPEG_X86_64_URL"; then
        FAILED=true
    fi
fi

# Итоговый статус
echo ""
log_info "========================================"
if [ "$FAILED" = true ]; then
    log_error "Some downloads failed!"
    exit 1
else
    log_success "All FFmpeg binaries ready!"
fi
log_info "========================================"

# Показываем что есть
log_info "FFmpeg binaries in $RESOURCES_DIR:"
ls -lh "$RESOURCES_DIR"/ffmpeg-* 2>/dev/null || log_warn "No FFmpeg binaries found"
