#!/usr/bin/env bash
# Build the Linux AppImage inside Ubuntu 22.04 (glibc 2.35 baseline) so it
# runs on Ubuntu 22.04+ / Debian 12+ and similar. Requires docker.
#   scripts/appimage-docker.sh            -> out/make/appimage/*.AppImage
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VERSION="$(cat "$ROOT/.nvmrc")"
IMAGE="${WORLDLINEBOX_APPIMAGE_IMAGE:-ubuntu:22.04}"
# Build from a clean copy so the host's node_modules (host glibc / ABI) never leak in.
docker run --rm -e HOST_UID="${SUDO_UID:-$(id -u)}" -e HOST_GID="${SUDO_GID:-$(id -g)}" -v "$ROOT":/src:ro -v "$ROOT/out":/out "$IMAGE" bash -euxc "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q curl ca-certificates build-essential python3 git file rsync software-properties-common
  # Electron 43 headers need C++20 (GCC >= 12); 22.04 ships GCC 11. Use g++-13
  # from the toolchain PPA and link libstdc++/libgcc statically so the native
  # addons still only need the stock 22.04 runtime (glibc 2.35).
  add-apt-repository -y ppa:ubuntu-toolchain-r/test
  apt-get install -y -q gcc-13 g++-13
  # Electron runtime libs (rebuild:native runs an FTS5 probe inside Electron)
  apt-get install -y -q libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libasound2 libxss1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0
  export CC=gcc-13 CXX=g++-13 LDFLAGS='-static-libstdc++ -static-libgcc'
  curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz | tar -xz -C /opt
  export PATH=/opt/node-v${NODE_VERSION}-linux-x64/bin:\$PATH
  mkdir -p /build && rsync -a --exclude node_modules --exclude out --exclude .git /src/ /build/
  cd /build
  npm ci --registry=https://registry.npmjs.org
  npm run rebuild:native
  node scripts/make-appimage.mjs
  mkdir -p /out/make/appimage && cp out/make/appimage/*.AppImage /out/make/appimage/
  chown -R \$HOST_UID:\$HOST_GID /out/make
"
ls -la "$ROOT/out/make/appimage"
