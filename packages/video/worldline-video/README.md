# @deepseek-ai/dsh-worldline-video

English | [中文](README.zh.md)

Worldline-native Host plugin for robust local and online video inspection. It contributes the `video_probe`, `video_index`, and `video_read` model tools plus the bundled `worldline-video` workflow skill.

The implementation uses packaged FFmpeg/FFprobe for container inspection and frame extraction, and packaged yt-dlp for public online-video metadata, captions, and resumable media transfer. It does not use a speech-recognition engine or an external model API. When no embedded, sidecar, or site-provided text captions exist, results explicitly use `visual-only` mode.

Long videos are indexed once into `~/.worldline/cache/video/<id>/manifest.json`. The manifest records keyframe timestamps and approximately ten-minute chapters; actual JPEGs are extracted lazily for a requested chapter or time range. This bounds memory, disk churn, tool output, and model context even for multi-hour media.

Online `video_probe` uses metadata-only mode and does not save the media. `video_index` defaults to a resumable private media cache for stable long-form analysis; its optional `stream` mode saves only metadata/captions and refreshes a direct URL before reading sampled HTTP ranges. Both modes must transfer the bytes actually decoded. Public sources may still fail because of login, DRM, region restrictions, anti-bot challenges, removed content, or expiring URLs.

## Model Experience

### Video tools and workflow skill

#### What the model sees

The model sees the [`video_probe`, `video_index`, and `video_read` schemas](../../../docs/tool-catalog.md#deepseek-ai-dsh-worldline-video), plus the `worldline-video` catalog entry and its workflow body after explicitly loading that skill. Tool results contain compact JSON, reusable manifest paths, timestamped JPEG paths, and bounded caption text.

#### Token effect

The three stable tool schemas and compact skill catalog entry occupy every eligible model request; the full workflow is added only when the model loads `worldline-video`, while per-video metadata, captions, and sampled-frame paths grow the active turn only after the corresponding calls.

#### KV Cache effect

Unchanged tool schemas and the compact skill catalog entry form a stable repeated prefix; loading or editing the `worldline-video` body changes the later skill context, and each tool result is append-only conversation growth rather than replacement of an earlier prefix.

## Known Limitations and Deferred Work

- Visual analysis samples frames; it is not a claim of continuous playback.
- Audio without text captions is not interpreted.
- Image-based subtitle formats are reported by the probe but are not OCRed.
- The bundled native executables currently target Windows x64; other platforms fall back to compatible commands on `PATH`.
- Online sites can change faster than a packaged yt-dlp release; a later installer update may be required.
