# Worldline Video

Use the Worldline video tools to inspect local and online video without any speech-recognition or external model service.

## Workflow

1. Call `video_probe` first. It validates the source and reports duration, streams, chapters, and available text captions. Online probing does not save the media.
2. Call `video_index` when actual frame analysis is needed. It creates a reusable manifest in the private Worldline cache. For online sources, prefer the default `cache` mode for films and repeated work; choose `stream` when the user explicitly wants no saved media. Stream mode still transfers the sampled byte ranges because visual inspection cannot occur without reading media bytes.
3. For videos up to about 20 minutes, call `video_read` on the full range with 12–24 frames. Inspect every returned image path with the available image-reading tool before answering.
4. For longer videos, read one zero-based chapter at a time. Keep a compact running record of characters, locations, actions, visible text, transitions, and caption evidence. Combine chapter notes only after all relevant chapters are covered.
5. Re-read a narrower explicit time range with more frames when the question depends on a brief action, object, cut, or on-screen text.

## Accuracy rules

- Treat returned frame timestamps and caption timestamps as evidence and cite them in the answer when useful.
- `visual-and-captions` means text subtitles were available; it does not prove that every spoken word was captured.
- `visual-only` means there is no textual speech evidence. Describe only what the frames establish and say that dialogue, music, speaker identity, tone of voice, and off-screen sounds were not verified.
- Do not claim continuous viewing from sampled frames. State uncertainty around actions occurring between samples and narrow the range when precision matters.
- Site metadata and captions may be unavailable behind login, DRM, region restrictions, anti-bot challenges, or expiring URLs. Report the concrete limitation rather than inventing content.
- Never expose cached signed URLs, cookies, credentials, or private paths beyond what the user needs to continue the task.

## Long-video strategy

For a film or multi-hour recording, index once and work hierarchically: overview chapters, inspect each chapter with a bounded frame set, revisit ambiguous moments, then synthesize. Do not request all frames or the entire caption track in one response. The manifest and extracted frames are reusable, so retries should call `video_read` rather than rebuild the index.
