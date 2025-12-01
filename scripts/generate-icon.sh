#!/bin/bash
# =============================================================================
# Генерация иконки приложения AIWisper
# =============================================================================
# Создаёт .icns файл для macOS из PNG изображения
#
# Использование:
#   ./scripts/generate-icon.sh [source.png]
#
# Если source.png не указан, создаёт простую иконку-заглушку
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_RESOURCES="$PROJECT_ROOT/frontend/build-resources"

mkdir -p "$BUILD_RESOURCES"

SOURCE_PNG="${1:-}"
ICONSET_DIR="$BUILD_RESOURCES/icon.iconset"
ICNS_FILE="$BUILD_RESOURCES/icon.icns"

# Если не указан исходный PNG, создаём простую иконку
if [ -z "$SOURCE_PNG" ] || [ ! -f "$SOURCE_PNG" ]; then
    echo "Creating placeholder icon..."
    
    # Проверяем наличие ImageMagick
    if command -v convert &> /dev/null; then
        # Создаём иконку с помощью ImageMagick
        convert -size 1024x1024 xc:'#1a1a2e' \
            -fill '#4a9eff' -draw "roundrectangle 128,128 896,896 64,64" \
            -fill white -font Helvetica-Bold -pointsize 400 \
            -gravity center -annotate +0+0 "AW" \
            "$BUILD_RESOURCES/icon-1024.png"
        SOURCE_PNG="$BUILD_RESOURCES/icon-1024.png"
    elif command -v sips &> /dev/null; then
        # Fallback: создаём простой PNG с помощью Python
        python3 << 'EOF'
import struct
import zlib
import os

def create_png(width, height, color, filename):
    """Create a simple solid color PNG"""
    def chunk(chunk_type, data):
        chunk_len = len(data)
        chunk_data = chunk_type + data
        checksum = zlib.crc32(chunk_data) & 0xffffffff
        return struct.pack('>I', chunk_len) + chunk_data + struct.pack('>I', checksum)
    
    # PNG signature
    signature = b'\x89PNG\r\n\x1a\n'
    
    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = chunk(b'IHDR', ihdr_data)
    
    # IDAT chunk (image data)
    r, g, b = color
    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # filter type: none
        for x in range(width):
            raw_data += bytes([r, g, b])
    
    compressed = zlib.compress(raw_data, 9)
    idat = chunk(b'IDAT', compressed)
    
    # IEND chunk
    iend = chunk(b'IEND', b'')
    
    with open(filename, 'wb') as f:
        f.write(signature + ihdr + idat + iend)

# Create a blue icon
build_resources = os.environ.get('BUILD_RESOURCES', 'frontend/build-resources')
create_png(1024, 1024, (74, 158, 255), f'{build_resources}/icon-1024.png')
print(f"Created {build_resources}/icon-1024.png")
EOF
        export BUILD_RESOURCES
        SOURCE_PNG="$BUILD_RESOURCES/icon-1024.png"
    else
        echo "Error: Neither ImageMagick nor Python available for icon generation"
        echo "Please provide a source PNG file: $0 source.png"
        exit 1
    fi
fi

echo "Source PNG: $SOURCE_PNG"

# Создаём директорию для iconset
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

# Генерируем все необходимые размеры
SIZES="16 32 64 128 256 512 1024"

for size in $SIZES; do
    # Обычная версия
    sips -z $size $size "$SOURCE_PNG" --out "$ICONSET_DIR/icon_${size}x${size}.png" 2>/dev/null
    
    # Retina версия (2x) для размеров меньше 512
    if [ $size -le 512 ]; then
        doubled=$((size * 2))
        if [ $doubled -le 1024 ]; then
            sips -z $doubled $doubled "$SOURCE_PNG" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" 2>/dev/null
        fi
    fi
done

# Переименовываем файлы в правильный формат для iconutil
cd "$ICONSET_DIR"
mv icon_16x16.png icon_16x16.png 2>/dev/null || true
mv icon_32x32.png icon_32x32.png 2>/dev/null || true
mv icon_64x64.png icon_32x32@2x.png 2>/dev/null || true
mv icon_128x128.png icon_128x128.png 2>/dev/null || true
mv icon_256x256.png icon_128x128@2x.png 2>/dev/null || true
# Также сохраняем как 256x256
sips -z 256 256 "$SOURCE_PNG" --out icon_256x256.png 2>/dev/null
mv icon_512x512.png icon_256x256@2x.png 2>/dev/null || true
sips -z 512 512 "$SOURCE_PNG" --out icon_512x512.png 2>/dev/null
mv icon_1024x1024.png icon_512x512@2x.png 2>/dev/null || true

# Создаём .icns файл
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_FILE"

# Также создаём PNG и ICO для других платформ
cp "$SOURCE_PNG" "$BUILD_RESOURCES/icon.png"

echo "Icon created: $ICNS_FILE"
echo "PNG copied: $BUILD_RESOURCES/icon.png"

# Очищаем временные файлы
rm -rf "$ICONSET_DIR"
rm -f "$BUILD_RESOURCES/icon-1024.png" 2>/dev/null || true

echo "Done!"
