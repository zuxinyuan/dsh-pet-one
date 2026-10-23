#!/usr/bin/env bash
# Build DSHPetOne.app — a dependency-free macOS desktop pet.
# Usage: ./build.sh [--install]   (--install copies the app to ~/Applications)
set -euo pipefail
cd "$(dirname "$0")"

APP="build/DSHPetOne.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> compiling"
swiftc -O Sources/*.swift \
  -o "$APP/Contents/MacOS/DSHPetOne" \
  -framework Cocoa -framework QuartzCore

echo "==> assembling bundle"
cp Info.plist "$APP/Contents/Info.plist"
cp assets/frame0.png assets/frame1.png "$APP/Contents/Resources/"
cp -R assets/packs "$APP/Contents/Resources/packs"
cp -R panel "$APP/Contents/Resources/panel"
cp -R live2d-web "$APP/Contents/Resources/live2d-web"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "==> built $APP"
if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/DSHPetOne.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "==> installed ~/Applications/DSHPetOne.app"
fi
