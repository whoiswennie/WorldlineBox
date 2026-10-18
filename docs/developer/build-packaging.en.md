# Build & Packaging

## Basic commands

```bash
npm run package          # package the app (includes build) → out/WorldlineBox-<platform>-<arch>/
npm run make             # build installers → out/make/ (macOS dmg / Windows zip; Windows setup built with Inno Setup)
npm run verify:package   # verify the packaged output (ASAR, native modules, media)
```

`package`/`make` run pre-hooks that ensure the media dependencies are available:

- Media binaries (`media-binaries ensure` — recover from the pinned release when needed, then verify provenance and hashes)
- ufbx WASM (`verify-ufbx-wasm` — hash-locked via `scripts/ufbx-wasm-lock.json`)
- Packaged output (`verify:package`: ASAR, better_sqlite3.node, Host utilities)

`package`/`make` update the dev Electron binary — run `npm run rebuild:native` afterwards.

If the media executables are missing or do not match the promoted manifest, the
hook automatically downloads and verifies the pinned `WorldlineBox-Build` release.
Run the same recovery explicitly with:

```bash
npm run media:ensure
```

Set `WORLDLINEBOX_MEDIA_AUTO_ACQUIRE=0` in an offline environment to make a failed
verification stop immediately instead of downloading.

## Shared user-data location

Normal development launches and installed applications share `appData/WorldlineBox`
(`%APPDATA%\WorldlineBox` on Windows). DSH downloads, staging, installed runtimes and
instances live in its `dsh-launcher` subdirectory, outside the checkout's `.tools`.
An absolute `WORLDLINEBOX_USER_DATA_PATH` overrides this location for both distributions.
E2E profiles remain isolated; only explicit `WORLDLINEBOX_ALLOW_MULTI_INSTANCE=1`
creates a separate `dev-instances/pid-*` profile. The old development-only override
is used solely as an optional legacy migration source.

Legacy DSH stores with no instances or installed environments, no pending operation
and no unfinished download are copied only when the destination DSH store is absent.
Physical files and SHA-256 inventories are checked before committing. Existing
shared data and the old profile remain intact. Chromium preferences are not migrated;
old instances must be exported as complete backups or packs and imported explicitly.

## Forge / Vite configuration checks

```bash
node scripts/verify-vite-forge-builds.mjs
```

This check uses Forge's actual configuration merging to build every entry in development
and production modes. Outputs and `report.json` go into a new `.tools/vite-forge-smoke-*`
directory, leaving the development `.vite` untouched and starting no servers. It also
checks that preloads, QuickJS and plugin UtilityProcess entries remain single CJS bundles.

Forge 7's preload template injects the old `inlineDynamicImports` option. A project-owned
config hook migrates the merged option to `codeSplitting: false`, retaining single-file
semantics without the Vite 8 / Rolldown deprecation warning. See the
[Rolldown option](https://rolldown.rs/reference/OutputOptions.codeSplitting).
Do not patch dependencies, suppress warnings or inline all of Main; DSH stays lazily loaded.

## Release pipeline (release:local)

One command for the full flow:

```bash
npm run release:local
```

Phases: `verify` → `media` → `package` → `e2e` → `make` → `checksums`

| Phase | What it does |
| --- | --- |
| verify | `rebuild:native` + `verify:mainline` (same gates as CI) |
| media | download the controlled media bundle (`media:acquire`) + verify; Linux x64/arm64 use the same gate, and an unpromoted arm64 bundle blocks a production release |
| package | `electron-forge package` + `verify:package` |
| e2e | packaged startup tests (`test:e2e:packaged`) |
| make | build installers; Linux prefers a same-architecture Docker environment and produces the matching AppImage |
| checksums | SHA-256 manifests (versioned header) |

Skip slow phases with `--skip-verify` / `--skip-media` / `--skip-e2e`. Run one phase with `npm run release:<phase>` (the e2e phase is `npm run release:e2e:packaged`).

```mermaid
flowchart LR
    C[Change] --> L[Lint + typecheck]
    L --> U[Unit tests]
    U --> W[Worker integration]
    W --> E[Electron E2E]
    E --> P[Package + verify]
    P --> PE[Packaged E2E]
    PE --> R[Make release artifacts]
```

### Local trial without media promotion

The media bundle must be "promoted" (built and registered in `bundle-lock.json` with an immutable URL + hashes) before the formal pipeline runs. If local artifacts already match `source-lock.json`, you can skip provenance:

```bash
WORLDLINEBOX_MEDIA_SKIP_PROVENANCE=1 npm run release:local -- --skip-verify --skip-media
```

> `SKIP_PROVENANCE` is for local trials only. Formal releases must go through promotion.

Another local path is `--build-media-locally`: build the full media bundle on this machine with vcpkg (`scripts/media-build/*`, takes 1-3 hours) and let the gates use the local artifacts:

```bash
npm run release:local -- --skip-verify --build-media-locally
```

### Versions

- Version lives in `package.json` (semver)
- Bump with `npm version patch|minor|major` (tags automatically)
- Every pipeline run prints `WorldlineBox v<version>`; checksum manifests carry the version header

### Platforms

`forge.config.ts` enforces **native-platform builds**, with the media allowlist `darwin-arm64` / `win32-x64` / `linux-x64` / `linux-arm64`. Media binaries, ufbx and native modules are platform-specific; cross-packaging is not supported. Use a matching host OS/architecture or a same-architecture Linux container. A source-level platform entry does not prove that its artifact has been built or accepted on that platform.

### Linux AppImage

```bash
npm run make:appimage           # out/make/appimage/WorldlineBox-<version>-x86_64.AppImage or -aarch64.AppImage
npm run make:appimage:docker    # same-architecture Ubuntu 22.04 / glibc 2.35 environment
npm run release:make            # canonical WorldlineBox-linux-x86-64-<version>.AppImage or -arm64-<version>.AppImage
```

- Both Linux architectures must acquire, verify and package `ffmpeg` / `ffprobe` / `oiiotool`; neither media validation nor package verification is skipped for arm64. The x64 lock pins upstream `media-v0.1.3`, rebuilt on Ubuntu 22.04 for the lower glibc baseline with unchanged source versions and configuration.
- Linux arm64 remains `build-required`. Run `scripts/media-build/linux-arm64.sh` on native Linux aarch64, then promote a trusted ZIP URL, archive SHA-256 and manifest SHA-256 to `ready` before a production release. Upstream has not promoted this media bundle either. A build script is not a downloadable installer. Local `--build-media-locally` / `WORLDLINEBOX_MEDIA_SKIP_PROVENANCE=1` trials do not count as promotion or supply missing binaries.
- Build Linux media in an Ubuntu 22.04 container with its system GCC. Before publishing, check that each executable requires at most GLIBC 2.35: `objdump -T <binary> | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1`. Building directly on a newer host can raise the runtime requirement; the AppImage wrapper alone does not establish old-distribution compatibility.
- AppImage requires FUSE (usually `libfuse2`), or `--appimage-extract-and-run`. Both architectures share the window-system and permission constraints. X11, native Wayland, GPU support and screenshot/recording features need separate Linux acceptance.
- Release names match the updater: `WorldlineBox-linux-x86-64-<version>.AppImage` / `WorldlineBox-linux-arm64-<version>.AppImage`, with sibling `.sha256` files and `SHA256SUMS-linux-x64.txt` / `SHA256SUMS-linux-arm64.txt` manifests.

This upgrade was developed on Windows without a usable Docker, bash or WSL Linux environment. No Linux build or native acceptance is claimed. See the [platform synchronization audit](serpent-031-upgrade/platforms-audit.md) for scope and environment evidence.

### Windows installer (Inno Setup)

The Windows installer `WorldlineBoxSetup.exe` is built with **Inno Setup 6** (script `assets/inno/worldlineboxsetup.iss`, outputting to `out/make/inno/WorldlineBoxSetup.exe`):

#### 1. Install Inno Setup compiler dependency (ISCC.exe)

Running `npm run make:inno` requires `ISCC.exe`, which can be prepared in one of two ways:

- **No admin rights required (recommended)**:
  Download `Tools.InnoSetup` from NuGet, extract it, and place the directory containing `ISCC.exe` in `%LOCALAPPDATA%\WorldlineBoxTools\inno\tools` (the build script looks here by default).
- **Official installer**:
  Install official Inno Setup 6 and set environment variable `WORLDLINEBOX_INNO_TOOLS` to the absolute path containing `ISCC.exe` (e.g., `C:\Program Files (x86)\Inno Setup 6`), or add that folder to system `PATH`.

#### 2. Build commands

```bash
# 1. Package the application first (generates out/WorldlineBox-win32-x64)
npm run package

# 2. Run the Inno installer build script
npm run make:inno
```

- Multilingual: language selection dialog on launch (defaults to system language), English + Simplified Chinese
- Wizard with install-path selection (default `C:\Program Files\WorldlineBox`), Start Menu / desktop shortcuts
- Per-machine install (UAC elevation), automatic uninstaller `unins000.exe` and Apps & Features entry

> History: Squirrel (no wizard / no path selection / uninstall leftovers) and WiX MSI (MSI language switching requires a custom bootstrapper, confirmed by the community) were both tried and rolled back — see the [Windows packaging development log](https://github.com/whoiswennie/WorldlineBox/blob/dev/docs/internal/development/2026-08-08-windows-packaging-and-squirrel-installer-development-log.md).

## Media binary promotion (WorldlineBox-Build)

Media bundles (FFmpeg/OpenImageIO) are distributed via GitHub Releases on the
[WorldlineBox-Build](https://github.com/dolag233/WorldlineBox-Build) repo (immutable URL +
SHA-256); main-repo `release:media` downloads and verifies them:

1. **Build once** (not in CI):
   - `ffmpeg/ffprobe`: BtbN LGPL builds (`registry.npmmirror.com/-/binary/ffmpeg-builds/`
     `ffmpeg-<ver>-win32-x64-lgpl.tar.xz`, or the macOS variant), LGPL-only (no GPL markers)
   - `oiiotool`: `scripts/media-build/build-oiiotool-win32.ps1` (Windows) /
     `darwin-arm64.sh` (macOS) / `linux-x64.sh` (Linux x86_64) / `linux-arm64.sh` (Linux aarch64, including FFmpeg) — vcpkg build (pinned toolchain + registry commit)
2. **Package and upload**:
   ```bash
   # assemble zip (platform layer ffmpeg/<platform>/…) + sha256
   # upload (create/reuse Release media-v<ver> + assets + publish):
   node scripts/release/publish-media-bundle.mjs --platform win32-x64 \
     --version v0.1.1 --zip artifacts/media-binaries/worldlinebox-media-win32-x64.zip
   ```
3. **Promote in main repo**: set the platform entry in
   `resources/media-binaries/bundle-lock.json` to
   `{status: ready, url, sha256, size, manifestSha256}` (script prints the entry).

> Versioning: bundle versions are independent of app versions (`media-vX.Y.Z`);
> Releases use GitHub Immutable Releases (assets immutable, tags non-reusable).

## Browser extension

The extension ships inside the app bundle (`Resources/extension`), not via a store:

```bash
npm run extension:build   # builds dist/extension
```

`prePackage` rebuilds it automatically. Manual loading instructions are in the [user guide](../user-guide/installation.md).

## Signing

- **macOS**: packages are ad-hoc signed (`identity: '-'` with keychain identity validation off; otherwise the lookup fails and is skipped, and Gatekeeper still reports the app as damaged). Ad-hoc signatures do not share a team identifier, so the entitlements must allow loading bundled frameworks; otherwise the system kills the app at launch. This does not clear the unidentified-developer prompt; the first launch needs right-click Open. Swap the identity for a Developer ID and add `osxNotarize` once you have a certificate
- **Windows**: currently unsigned (SmartScreen warning). For formal releases, SignPath free signing (same as VSCodium) or a commercial certificate

## Release prerequisites (in progress)

1. **Media promotion**: toolchain repo (Release attachments + `versions.json`) to remove the `SKIP_PROVENANCE` need
2. **Windows native validation**: same pipeline on a Windows host + install/uninstall journey
3. **Signing upgrade**: SignPath application / Apple Developer account
4. **CI/CD**: local CICD (2026-08-09 decision: main repo dropped GitHub Actions;
   each platform runs `npm run release:local`; the browser-extension repo keeps
   Actions for release publishing). See [local CICD](https://github.com/whoiswennie/WorldlineBox/blob/dev/docs/internal/development/local-cicd.md).

See the research doc for details.
