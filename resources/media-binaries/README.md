# WorldlineBox media binary bundles

This directory contains only trust metadata. Large executables are never copied
from a developer's `PATH` and are intentionally ignored by Git.

Supported media platform keys are `darwin-arm64`, `win32-x64`, `linux-x64`, and
`linux-arm64`. A supported key is not a promoted release: linux-arm64 remains
`build-required` until a native bundle and its checksums are published.
A prepared resource tree has this shape:

```text
resources/
  ffmpeg/<platform>/ffmpeg[.exe]
  ffmpeg/<platform>/ffprobe[.exe]
  oiio/<platform>/oiiotool[.exe]
  media-binaries/<platform>/manifest.json
  media-binaries/<platform>/licenses/
    FFmpeg-LICENSE.md
    COPYING.LGPLv2.1
    OpenImageIO-LICENSE.md
    OpenImageIO-THIRD-PARTY.md
    Build-Dependency-NOTICES.txt
```

## Release flow

1. Run `scripts/media-build/darwin-arm64.sh` on native macOS arm64,
   `scripts/media-build/win32-x64.ps1` on Windows x64, or
   `scripts/media-build/linux-x64.sh` on Linux x86_64, or
   `scripts/media-build/linux-arm64.sh` on Linux aarch64. A clean runner clones the
   vcpkg registry at the commit in `source-lock.json`, bootstraps that checkout,
   and builds the exact manifest under `vcpkg/` with custom static triplets.
   Remote binary caches are disabled; sources are verified by the SHA-512 values
   in the pinned vcpkg ports.
2. The build creates an overlay of that exact FFmpeg port and adds explicit
   `--disable-gpl` and `--disable-nonfree` configure flags. The original vcpkg
   checkout remains pinned and is checked before applying the deterministic
   overlay transformation.
3. Staging locates only the three required tools, rejects non-system dynamic
   dependencies (`otool -L` on macOS, `ldd` on Linux, PE import parsing on
   Windows), aggregates
   every target-package copyright plus its installed version into the dependency
   notice, then runs the manifest and verification gates.
4. The scripts create a ZIP, its SHA-256, and the generated manifest SHA-256
   under `artifacts/media-binaries/`.
   `.github/workflows/media-binary-bundles.yml` performs both clean builds and
   uploads these candidates as short-lived workflow artifacts. It does not
   publish a GitHub Release.
5. Put the immutable HTTPS URL, ZIP SHA-256, and manifest SHA-256 in
   `bundle-lock.json`, changing its status to `ready`. A clean checkout can then run
   `npm run media:acquire -- --platform <platform>`.
6. Acquisition writes a receipt bound to those two promoted hashes. Both the
   source manifest and receipt must still match `bundle-lock.json`; regenerating
   a local manifest cannot turn locally substituted binaries into a release bundle.
7. Forge's own `prePackage` hook runs the equivalent of `media:ensure`: when the
   promoted bundle or receipt is absent or invalid, it reacquires the pinned
   WorldlineBox-Build release and verifies it before packaging. Set
   `WORLDLINEBOX_MEDIA_AUTO_ACQUIRE=0` to keep an offline build fail-closed. Forge
   copies `resources/` outside ASAR. Its `postPackage` hook repeats hash,
   provenance, executable, version, license and FFmpeg configuration checks
   against every packaged output.

`bundle-lock.json` deliberately remains `build-required` until such artifacts
exist. This is a release blocker, not an invitation to substitute Homebrew,
Chocolatey, `ffmpeg-static`, or an unverified binary download.

## Build constraints

- FFmpeg and ffprobe: FFmpeg 8.1, LGPL-only, separate executable process.
  `--enable-gpl`, `--enable-nonfree`, libx264, libx265 and libfdk-aac are
  rejected. libvpx-vp9, libopus, drawtext, thumbnail, fps, scale and tile are
  required because current Worker commands depend on them.
- `Build-Dependency-NOTICES.txt` is supplied by the controlled dependency
  build and lists exact installed versions and licenses for libvpx, libopus,
  FreeType, HarfBuzz, OpenColorIO and every target package. Its recorded vcpkg
  commit indirectly locks every port source URL and checksum; those port files
  are the auditable source-of-truth rather than a separately maintained URL
  list. The notice is hash-locked into the bundle manifest.
- OpenImageIO: 3.1.12.0, static `oiiotool`, built with OpenColorIO enabled. The
  exact OIIO and third-party notices are part of every bundle.
- macOS arm64: build natively with the workflow Xcode/SDK image. `otool -L`
  rejects every dependency outside `/usr/lib` and `/System/Library`. Sign and
  notarize only after Forge copies the verified files.
- Windows x64: the static custom triplet uses the static CRT. The PE import gate
  rejects every imported DLL that is neither an API-set DLL nor present in
  Windows System32. Windows is not considered verified until this workflow runs
  successfully and the packaged application is exercised on Windows.
- Linux x64: build natively with `scripts/media-build/linux-x64.sh` (static
  triplet `worldlinebox-x64-linux-static`). `ldd` rejects every dependency outside
  the glibc/libstdc++ system set. The current lock pins the upstream
  `media-v0.1.3/serpent-media-linux-x64.zip` and its original checksums; local
  WorldlineBox builds produce `worldlinebox-media-linux-x64.zip`. The platform is
  promoted when `bundle-lock.json` marks `linux-x64` as `ready` (it is ready now).
  If the entry is not `ready`,
  `media:ensure` stays fail-closed. A local trial can build the tree and run
  `WORLDLINEBOX_MEDIA_SKIP_PROVENANCE=1 npm run media:ensure`.
- Linux arm64: build natively with `scripts/media-build/linux-arm64.sh` and
  triplet `worldlinebox-arm64-linux-static`. It uses the same acquire, package,
  provenance and dependency checks as x64; there is no arm64 verification skip.
  The lock remains `build-required`, including upstream at this synchronization
  point. Publish `worldlinebox-media-linux-arm64.zip` and promote its trusted URL,
  archive hash and manifest hash before a production AppImage can be released.
- Build Linux media in Ubuntu 22.04 with its system GCC to retain the GLIBC 2.35
  baseline for both architectures. Before promotion inspect each tool with
  `objdump -T <binary> | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1`. The x64
  `media-v0.1.3` bundle is a 22.04 rebuild of the same source/configuration as
  `media-v0.1.2`. AppImage-native modules still need their separate compiler and
  runtime verification; an old media baseline alone does not prove the whole
  application runs on that distribution.

This source synchronization was reviewed and unit-tested on Windows without a
usable Docker, bash or WSL Linux environment. No Linux native build, media
execution or desktop acceptance is claimed. See
[`platforms-audit.md`](../../docs/developer/serpent-031-upgrade/platforms-audit.md).

The vcpkg commit, port source SHA-512 values, triplets and overlay transform are
locked, but deterministic inputs do not imply bit-for-bit reproducible C/C++
output. Release provenance must also retain the CI run, runner image, build logs,
dependency notice and generated manifest.
