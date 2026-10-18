#!/usr/bin/env bash
# Smoke-test the AppImage in a clean Ubuntu container under Xvfb and capture a
# screenshot + log.  Usage: scripts/appimage-smoke-docker.sh ubuntu:24.04 <outdir>
set -euo pipefail
IMAGE="${1:-ubuntu:22.04}"
OUT="$(realpath "${2:-out/smoke}")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$(ls "$ROOT"/out/make/appimage/*.AppImage | head -1)"
TAG="$(echo "$IMAGE" | tr ':/' '--')"
mkdir -p "$OUT"
docker run --rm -v "$APP":/app/WorldlineBox.AppImage:ro -v "$OUT":/out "$IMAGE" bash -euc "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q >/dev/null
  # typical desktop runtime libs + ffmpeg (WorldlineBox uses the system ffmpeg)
  apt-get install -y -q xvfb x11-apps imagemagick dbus-x11 ffmpeg libnss3 libgtk-3-0 libgbm1 libasound2 libxss1 libatk-bridge2.0-0 >/dev/null 2>&1 || \
  apt-get install -y -q xvfb x11-apps imagemagick dbus-x11 ffmpeg libnss3 libgtk-3-0t64 libgbm1 libasound2t64 libxss1 libatk-bridge2.0-0t64 >/dev/null
  cat /etc/os-release | grep PRETTY; ldd --version | head -1
  Xvfb :5 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2
  export DISPLAY=:5
  # Run as a regular desktop user, not root (Chromium refuses root without --no-sandbox).
  useradd -m tester
  cp /app/WorldlineBox.AppImage /home/tester/S.AppImage && chown tester /home/tester/S.AppImage
  su tester -c 'cd ~ && WORLDLINEBOX_SOFTWARE_GL=1 DISPLAY=:5 dbus-launch --exit-with-session ./S.AppImage --appimage-extract-and-run' > /out/appimage-$TAG.log 2>&1 &
  sleep 45
  import -window root /out/appimage-$TAG.png
  pgrep -fa 'usr/lib/worldlinebox/WorldlineBox' | grep -v type= | head -2 || echo 'NOT RUNNING'
  tail -6 /home/tester/.config/WorldlineBox/logs/*.log | cut -c1-220
"
