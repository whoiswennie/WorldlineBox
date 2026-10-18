# Setup

## Requirements

- Node.js **24.15.0** (locked in `.nvmrc`; use `nvm use`)
- npm
- Native development targets: macOS arm64, Windows x64, Linux x64/arm64; Linux is preview support, and the arm64 media bundle still needs promotion before production packaging
- **Do not build or run from an SMB/NAS-mounted path** — Electron fails to start on mounted volumes (`icudtl.dat not found`) and packaged apps cannot run from them either

### macOS

- Xcode Command Line Tools (for native module builds)
- Media component builds (only when rebuilding): `scripts/media-build/darwin-arm64.sh` (vcpkg, takes hours)

### Windows

- Git, PowerShell
- Visual Studio Build Tools: "Desktop development with C++" workload + Windows SDK (required to compile native module `better-sqlite3`)
- **Inno Setup 6** (required when building the Windows installer package `WorldlineBoxSetup.exe`):
  - Recommended (no admin rights required): Fetch `Tools.InnoSetup` via NuGet, extract `ISCC.exe` into `%LOCALAPPDATA%\WorldlineBoxTools\inno\tools\`;
  - Official installer: Install official Inno Setup 6 and set environment variable `WORLDLINEBOX_INNO_TOOLS` to the directory containing `ISCC.exe` (or add it to system `PATH`);
  - Not needed if only running dev mode (`npm start`) or creating portable builds (`npm run package`).
- Media component builds (only when rebuilding underlying binaries): `scripts/media-build/win32-x64.ps1` (vcpkg)

### Linux (preview)

- Native module builds (`better-sqlite3`) need a compiler toolchain and Python, such as `build-essential` and `python3` on Debian/Ubuntu. Media builds also need the Git, CMake, zip and pkgconf tools used by the scripts.
- `npm ci` does not install media. The linux-x64 bundle is `ready` (`media-v0.1.3`); linux-arm64 uses the same acquire/verify gate but remains `build-required`. `npm run media:ensure` acquires promoted media. Before acquisition, development can use trusted `ffmpeg` / `ffprobe` from PATH, with `oiiotool` for professional image formats.
- The native aarch64 media entry point is `scripts/media-build/linux-arm64.sh`. See [Build and packaging](build-packaging.en.md#linux-appimage) for local trials and promotion. Windows cannot cross-package a Linux release through the native gates.
- Prefer same-architecture `npm run make:appimage:docker` for Ubuntu 22.04 / glibc 2.35. Without Docker, use host `npm run make:appimage` and check runtime dependencies introduced by a newer distribution. Running needs FUSE or `--appimage-extract-and-run`; X11/Wayland and screen-capture permissions require native acceptance.
- Useful variables: `WORLDLINEBOX_SOFTWARE_GL=1` (software WebGL without a usable GPU), `WORLDLINEBOX_LINUX_ROUNDED_CORNERS=0|1` (square/rounded corners), and trusted tool overrides `WORLDLINEBOX_FFMPEG_PATH` / `WORLDLINEBOX_OIIO_PATH`.

No system services, Docker or WSL were installed for this upgrade, and Linux was not accepted on this Windows host. Distinguish source support, promoted bundles, released artifacts and native test evidence.

## First build

```bash
npm ci --registry=https://registry.npmjs.org
npm run rebuild:native
npm start
```

`rebuild:native` compiles `better-sqlite3` for Electron's ABI and verifies FTS5. On Windows, **do not** run a bare `@electron/rebuild` or `node-gyp` — machine-wide vcpkg MSBuild integration can link against a non-FTS5 sqlite3.dll; the project script disables it.

## Media components

`npm ci` does **not** install FFmpeg/ffprobe/OpenImageIO. Without them, normal development and image import still work; video thumbnails/proxies fail with `FFMPEG_REQUIRED`, and EXR/TGA/complex TIFF need OpenImageIO.

Packaged builds use the controlled media bundle (FFmpeg 8.1 LGPL-only + OpenImageIO 3.1.12.0); gates verify provenance and hashes (`bundle-lock.json` promotion status + `source-lock.json` version match). For local development you can point at any trusted FFmpeg via `WORLDLINEBOX_FFMPEG_PATH` (needs the required filters/encoders; `ffprobe` in the same directory; GPL builds are local-dev only):

```bash
# macOS
export WORLDLINEBOX_FFMPEG_PATH="$HOME/tools/ffmpeg/ffmpeg"
npm start
```

```powershell
# Windows
$env:WORLDLINEBOX_FFMPEG_PATH = 'C:\tools\ffmpeg\ffmpeg.exe'
npm start
```

Quit WorldlineBox completely before retrying (single-instance lock; a second `npm start` does not replace a running process).

## Common commands

```bash
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run test             # unit + worker integration (runs in Electron)
npm run test:unit        # unit only
npm run test:worker      # worker integration only
npm run test:e2e         # Playwright E2E
npm start                # development launch
npm run start:multi      # two instances
```

## Notes

- Tests run under Electron's ABI (`test:worker`/`test` go through `run-vitest-with-electron.mjs`); after `npm run package`, run `npm run rebuild:native` to restore the dev native module
- `npm start` auto-avoids occupied Vite ports
