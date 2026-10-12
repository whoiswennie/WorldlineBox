# Installation

Download the latest installer from [WorldlineBox Releases](https://github.com/whoiswennie/WorldlineBox/releases).

## Requirements

- macOS: Apple Silicon (arm64) or Intel (x64), macOS 11 or newer
- Windows: 64-bit Windows 10 or Windows 11
- The app uses about 500 MB; library data needs additional space

Use [WorldlineBox Releases](https://github.com/whoiswennie/WorldlineBox/releases) for the current Windows installer and version notes.

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

## Browser extension

Download the browser extension (Chrome / Edge / Firefox) from the [extension releases](https://github.com/dolag233/WorldlineBox-Extension/releases). Installation and usage: see [Browser extension](browser-extension.md).

## Upgrading

Replace the macOS app with the new DMG, or run the new Windows installer over the existing install. Libraries and user configuration live outside the application install directory and normally remain; back up a library before upgrading. Follow the release notes for migrations and platform-specific caveats.
