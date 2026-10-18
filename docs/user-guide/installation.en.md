# Installation

Download the latest installer from [WorldlineBox Releases](https://github.com/whoiswennie/WorldlineBox/releases).

## Requirements

- macOS: Apple Silicon (arm64) or Intel (x64), macOS 11 or newer
- Windows: 64-bit Windows 10 or Windows 11
- Linux: preview build targets x86_64 / aarch64 with an Ubuntu 22.04 / glibc ≥ 2.35 baseline; aarch64 still lacks a promoted media bundle and is not release-ready
- The app uses about 500 MB; library data needs additional space

Use [WorldlineBox Releases](https://github.com/whoiswennie/WorldlineBox/releases) for actual platform downloads and version notes. Source build support does not establish a published artifact or native acceptance on every platform.

## macOS

1. Download the matching `WorldlineBox-darwin-arm64-<version>-package.dmg` (or Intel build).
2. Open the DMG and drag WorldlineBox to Applications.

Unsigned development builds may trigger Gatekeeper. Verify the source, then right-click the app, choose Open, and confirm. If it is still blocked, clear quarantine from Terminal:

```bash
xattr -cr /Applications/WorldlineBox.app
```

To uninstall, move the app to the Trash. Libraries live where you created them and are not removed with the app.

## Windows

1. Download the Windows installer package `WorldlineBox-win-x86-64-<version>-setup.zip` (extract and run the setup wizard), or download the portable build `WorldlineBox-win-x86-64-<version>-portable.zip` (extract and run directly from any local directory).
2. Run the installer and follow the wizard to choose install path, language, and shortcut preferences.

Unsigned development builds may trigger SmartScreen. Verify the source, then choose **More info → Run anyway**. Uninstall from **Settings → Apps**; the uninstaller will cleanly remove application files.

## Linux (preview)

When the releases page provides an AppImage for your architecture, download the x86_64 file `WorldlineBox-linux-x86-64-<version>.AppImage`, make it executable and run:

```bash
chmod +x WorldlineBox-linux-x86-64-<version>.AppImage
./WorldlineBox-linux-x86-64-<version>.AppImage
```

The canonical aarch64 name is `WorldlineBox-linux-arm64-<version>.AppImage`. Its media bundle is still unpromoted in this source upgrade, so a downloadable artifact is not promised. Do not run an AppImage built for another architecture.

- FUSE is required (such as `libfuse2` on distributions that provide it). Alternatively, add `--appimage-extract-and-run`.
- An AppImage built through the production gates bundles `ffmpeg`, `ffprobe` and `oiiotool`, so these preview tools normally need no separate installation. A source checkout without acquired media may still use PATH. Trusted overrides are `WORLDLINEBOX_FFMPEG_PATH` / `WORLDLINEBOX_OIIO_PATH`.
- Linux uses the in-app menu and a frameless window; rounded corners depend on a compositor. Use `WORLDLINEBOX_LINUX_ROUNDED_CORNERS=0` / `1` to force square/rounded corners, or try `WORLDLINEBOX_SOFTWARE_GL=1` without a usable GPU.
- Linux does not offer Windows notification-area residence or launch at login. Screen capture, recording, system audio and shortcuts can depend on desktop permissions. X11 and native Wayland require separate acceptance.
- This upgrade was checked on Windows through source review and cross-platform unit tests. No WorldlineBox Linux build or native acceptance was performed; upstream test-machine results are not claimed as this project's results.

To uninstall, delete the AppImage. Libraries live in separate directories and remain.

## Browser extension

Download the browser extension (Chrome / Edge / Firefox) from the [extension releases](https://github.com/dolag233/WorldlineBox-Extension/releases). Installation and usage: see [Browser extension](browser-extension.md).

## Upgrading

Replace the macOS app with the new DMG, run the new Windows installer over the existing install, or replace the Linux AppImage with a newer file for the same architecture (keep the old file until the new one works). Libraries and user configuration live outside the application install directory and normally remain; back up a library before upgrading. Follow the release notes for migrations and platform-specific caveats.

The Linux updater looks for the matching AppImage and checksum for the running architecture. Grant execute permission after download and verification. If no asset is published for that architecture, wait for its release rather than using another architecture's file.
