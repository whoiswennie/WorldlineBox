#!/bin/sh
set -eu

# Linux reports aarch64; Node and the media platform key use arm64.
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "aarch64" ]; then
  echo "This build must run natively on Linux aarch64." >&2
  exit 1
fi

# vcpkg probes the default `c++`, which may be clang without a matching libstdc++.
export CC="${CC:-gcc}"
export CXX="${CXX:-g++}"

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
LOCK="$ROOT/resources/media-binaries/source-lock.json"
MANIFEST_ROOT="$ROOT/resources/media-binaries/vcpkg"
WORK=${WORLDLINEBOX_MEDIA_BUILD_DIR:-"$ROOT/.media-build/linux-arm64"}
VCPKG_ROOT="$WORK/vcpkg"
OVERLAY_ROOT="$WORK/overlay-ports"
INSTALLED_ROOT="$WORK/vcpkg-installed"
HOST_TOOLS_ROOT="$WORK/host-tools"
ARTIFACT_ROOT="$ROOT/artifacts/media-binaries"
TRIPLET=worldlinebox-arm64-linux-static
OVERLAY_TRIPLETS="$MANIFEST_ROOT/triplets"
export VCPKG_ROOT

VCPKG_REPOSITORY=$(node -p "require('$LOCK').registry.repository")
VCPKG_TAG=$(node -p "require('$LOCK').registry.tag")
VCPKG_COMMIT=$(node -p "require('$LOCK').registry.commit")

mkdir -p "$WORK" "$ARTIFACT_ROOT"
if [ ! -d "$VCPKG_ROOT/.git" ]; then
  git clone --filter=blob:none --no-checkout "$VCPKG_REPOSITORY" "$VCPKG_ROOT"
fi
git -C "$VCPKG_ROOT" fetch --force --depth 1 origin "refs/tags/$VCPKG_TAG:refs/tags/$VCPKG_TAG"
git -C "$VCPKG_ROOT" checkout --detach --force "$VCPKG_COMMIT"
test "$(git -C "$VCPKG_ROOT" rev-parse HEAD)" = "$VCPKG_COMMIT"

"$VCPKG_ROOT/bootstrap-vcpkg.sh" -disableMetrics
node "$ROOT/scripts/media-build/prepare-vcpkg-overlay.mjs" \
  --vcpkg-root "$VCPKG_ROOT" \
  --output "$OVERLAY_ROOT"

rm -rf "$INSTALLED_ROOT"
export VCPKG_DISABLE_METRICS=1
export VCPKG_FEATURE_FLAGS=manifests,versions
export VCPKG_BINARY_SOURCES=clear
"$VCPKG_ROOT/vcpkg" install pkgconf:arm64-linux \
  --x-install-root="$HOST_TOOLS_ROOT"
export PKG_CONFIG="$HOST_TOOLS_ROOT/arm64-linux/tools/pkgconf/pkgconf"
test -x "$PKG_CONFIG"
"$VCPKG_ROOT/vcpkg" install \
  --x-manifest-root="$MANIFEST_ROOT" \
  --x-install-root="$INSTALLED_ROOT" \
  --triplet="$TRIPLET" \
  --overlay-ports="$OVERLAY_ROOT" \
  --overlay-triplets="$OVERLAY_TRIPLETS"

node "$ROOT/scripts/media-build/stage-vcpkg-bundle.mjs" \
  --platform linux-arm64 \
  --triplet "$TRIPLET" \
  --installed-root "$INSTALLED_ROOT" \
  --vcpkg-root "$VCPKG_ROOT" \
  --resource-root "$ROOT/resources"

BUNDLE_ROOT="$WORK/bundle-root"
ARCHIVE="$ARTIFACT_ROOT/worldlinebox-media-linux-arm64.zip"
MANIFEST_CHECKSUM="$ARTIFACT_ROOT/worldlinebox-media-linux-arm64.manifest.sha256"
rm -rf "$BUNDLE_ROOT" "$ARCHIVE" "$ARCHIVE.sha256" "$MANIFEST_CHECKSUM"
mkdir -p "$BUNDLE_ROOT/ffmpeg" "$BUNDLE_ROOT/oiio" "$BUNDLE_ROOT/media-binaries"
cp -R "$ROOT/resources/ffmpeg/linux-arm64" "$BUNDLE_ROOT/ffmpeg/"
cp -R "$ROOT/resources/oiio/linux-arm64" "$BUNDLE_ROOT/oiio/"
cp -R "$ROOT/resources/media-binaries/linux-arm64" "$BUNDLE_ROOT/media-binaries/"
cp "$ROOT/resources/media-binaries/source-lock.json" "$BUNDLE_ROOT/media-binaries/"
(cd "$BUNDLE_ROOT" && zip -q -r -X "$ARCHIVE" .)
(cd "$ARTIFACT_ROOT" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
(cd "$ROOT/resources/media-binaries/linux-arm64" && \
  sha256sum manifest.json > "$MANIFEST_CHECKSUM")
echo "Built $ARCHIVE"
echo "Human publish: upload $ARCHIVE to the WorldlineBox-Build media release, then promote url/sha256/manifestSha256 into resources/media-binaries/bundle-lock.json."
