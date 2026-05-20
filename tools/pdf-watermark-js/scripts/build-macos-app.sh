#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOL_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${1:-$TOOL_DIR/dist/PDF Watermark JS.app}"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cp "$TOOL_DIR/macos/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$TOOL_DIR/macos/PDF Watermark JS" "$APP_DIR/Contents/MacOS/PDF Watermark JS"
cp "$TOOL_DIR/pdfwatermark_web.js" "$APP_DIR/Contents/Resources/pdfwatermark_web.js"
cp "$TOOL_DIR/package.json" "$APP_DIR/Contents/Resources/package.json"
cp "$TOOL_DIR/package-lock.json" "$APP_DIR/Contents/Resources/package-lock.json"

chmod +x "$APP_DIR/Contents/MacOS/PDF Watermark JS"

if [ -d "$TOOL_DIR/node_modules" ]; then
  cp -R "$TOOL_DIR/node_modules" "$APP_DIR/Contents/Resources/node_modules"
fi

echo "Built $APP_DIR"
