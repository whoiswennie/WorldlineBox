# Troubleshooting

## macOS Gatekeeper / Windows SmartScreen

Development builds may be unsigned. Verify the package source first, then choose **Open** on macOS or **More info → Run anyway** on Windows. Do not bypass security prompts for an unknown package.

## Linux AppImage will not run or previews fail

Check that the AppImage matches the machine architecture (x86-64 for x86_64, arm64 for aarch64) and has execute permission. Without FUSE, use `--appimage-extract-and-run`. A missing `GLIBC_2.35` or newer symbol requires checking the distribution and actual build baseline; changing permissions or renaming a file cannot fix binary compatibility.

A production AppImage should bundle media tools. For a development checkout or local trial with missing tools, inspect `media:ensure` and package verification results. An arm64 `build-required` message means its media bundle is unpromoted; skipping a check does not establish production support. Try `WORLDLINEBOX_SOFTWARE_GL=1` without a usable GPU, or `WORLDLINEBOX_LINUX_ROUNDED_CORNERS=0` for corner-rendering issues.

This upgrade has no WorldlineBox Linux native acceptance result. When reporting a problem, include distribution, CPU architecture, X11/Wayland, desktop environment and whether it uses AppImage. Screen capture, recording and audio issues should also describe system permission status.

## Thumbnails or previews fail

WorldlineBox generates previews for many image, RAW, video, audio, and 3D formats. Confirm that the source is readable and the library directory is writable, then fully quit and reopen the library so background jobs can retry. If the problem continues, open **Window → Background jobs** or **Main Menu → About → View Diagnostic Logs** to check messages and diagnostic logs.

Different formats may use different preview methods; for example, video may use a compatible playback version and audio first gets a waveform. A corrupt or unsupported source cannot be fixed by retrying alone.

## AI analysis fails or never starts

In **Settings → Global model**, verify the API format, model, and key, and test the connection. Enable **Analyze new assets automatically** only for import-time analysis; it is off by default and is not required for manual analysis. Readable TXT, Markdown, JSON, code, and similar text work with text-only models. Only the first 64 KiB of UTF-8 is sent, marked as a truncated excerpt when necessary. Images, video frames, and 3D views require vision. PDF/AI analysis sees only the existing first-page preview, not the full document. Audio, Office documents, HTML, and formats without an input extractor are currently unsupported.

Video AI needs a contact sheet and 3D AI needs a four-view sheet. Retry media generation in Background jobs before retrying AI. Failure notices include a short reason. Network, rate-limit, and timeout failures are usually retryable; authentication, permission, quota, and unsupported-format errors need a configuration or file fix. To re-analyze an asset that already has AI content, use **AI analysis**, not **Analyze unanalyzed assets**.

Check the source file when text is empty, binary, or damaged. A model without image input needs to be replaced by a vision model for visual assets; text still works with the original model. Invalid analysis output means the provider response failed structural validation, rather than a rate limit or timeout. Queue retries are bounded by settings; unsupported files are not treated as temporary network failures.

## Searches miss imported assets

Check active filter chips; Shift-selected values can intentionally narrow the result. Search remains within the current folder/collection scope, and hovering or focusing the `?` beside the field shows advanced syntax. Ignore rules affect browsing, search, and scanning; inspect **Library settings → Ignore rules**.

## A plugin will not enable

Open **Settings → Plugins** and check the plugin status and trust prompt. A library plugin needs trust on each device; a user-wide package is normally trusted automatically. Turn the plugin off and on again, or click **Reload**. If it still does not work, contact the plugin author with your WorldlineBox version, operating system, and plugin name.

## Automation script or MCP will not work

For a script, open a library first and choose **More tools → Automation scripts**. For MCP, open **Settings → MCP**, ensure the service is enabled and started, and paste WorldlineBox’s latest configuration into the client. The default address is `http://127.0.0.1:47342/mcp`. If you revoked a Token, add the client again and copy a new configuration. Connect only a local AI tool you trust.

## A library will not open

- **Version compatibility**: WorldlineBox maintains forward data compatibility. Opening an older library with a newer version will automatically run database migrations. Older app versions opening a library created by a newer version will also open it in writable mode permissively, rather than locking it into a read-only state. If prompted that the version is unsupported, update to the latest WorldlineBox release.
- **"Library is already open" prompt**: The same library directory is already open in the current app instance, or was opened via different paths (e.g. network share path vs. mapped drive). Switch directly to the existing window.
- **Automatic recovery and rescue**: If you see a database corruption prompt, do not manually delete the `.worldlinebox/` directory. WorldlineBox includes rotating backup mechanisms and will automatically attempt to restore from the latest valid backup. In extreme corruption scenarios, it enters an automatic asset rescue workflow in the `Assets/` directory, preserving as many source files and metadata as possible.
- **Permissions and disk space**: Ensure the drive containing the library and temporary folders has sufficient read/write permissions and available storage.
- **Importing from archives**: When importing from ZIP / Eagle / Billfish, ensure the system temp folder and destination disk have adequate space for extraction and storage. Thumbnails and metadata will rebuild progressively in the background after extraction.

## Shortcuts do nothing

Shortcut handling follows focus and modal priority. Settings, the viewer, and menus take priority for keys such as `Esc`; close them and focus the canvas before retrying. If F2 does not work after a context menu closes, click the asset or folder to restore focus.

## Still stuck

You can view the current logs from **Main Menu → About → View Diagnostic Logs** (or click "Show Log File" in that dialog, or use **Main Menu → About → Show Log File in File Manager** to locate the file).

When reporting issues via GitHub Issues, please include: OS and version, WorldlineBox version, library type, reproduction steps, error messages/codes, and sanitized diagnostic logs. Never attach an API key, full token, or unsanitized personal file paths.
