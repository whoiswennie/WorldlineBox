# WorldlineBox Windows installer

The Windows release uses a native, self-drawn WPF installer rather than an NSIS user
interface. The same executable contains the install, progress, completion, uninstall,
uninstall-progress, and uninstall-completion views.

## Package format

`scripts/build-custom-installer.mjs` compiles `WorldlineInstaller.cs`, creates a ZIP from
Electron's `win-unpacked` directory, and appends it to the native executable. A 24-byte
footer stores the `WLBOX001` signature, payload offset, and payload length. The installer
opens that bounded stream directly, validates every destination against path traversal,
and reports extraction progress in its own UI.

The installed uninstaller is the lightweight native prefix only; the application payload
is not copied a second time.

The Electron executable is stored in the ZIP as `WorldlineBox.exe`. The packager restores
the localized `win-unpacked` filename after archiving and rejects any remaining non-ASCII
payload path, preventing Windows ZIP filename encoding from corrupting installed files.

## Windows behavior

- The final directory name is always `WorldlineBox`. Selecting `D:\Apps` installs to
  `D:\Apps\WorldlineBox`; selecting that final directory keeps it unchanged.
- The default is `C:\Program Files\WorldlineBox` and the release requests elevation.
- Desktop and Start menu shortcuts are created only when selected.
- Programs and Features points to the custom WorldlineBox uninstaller.
- The bundled FFmpeg and yt-dlp directories are added to the machine PATH without `setx`.
- Uninstall removes application files, shortcuts, registry entries, and exact PATH items.
  User-owned `.worldline` data lives outside the install root and is intentionally kept.

## Commands

```powershell
pnpm run package:installer-preview
node scripts/build-custom-installer.mjs --input release/desktop/win-unpacked `
  --output release/desktop/WorldlineBox-Setup-0.1.0.exe
```

`build-exe.bat` performs the second command automatically after building and smoke-testing
the unpacked desktop application.
