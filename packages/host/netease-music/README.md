# NetEase Music Host

English | [中文](README.zh.md)

Host authority for a user-selected public NetEase playlist, defaulting to `18322613388`. It validates the numeric playlist id, reads the complete ordered track-id list, expands song metadata in bounded batches, resolves public media redirects, and parses synchronized lyrics only for tracks that belong to the selected playlist. The Client receives JSON metadata, timestamped lyric lines, and HTTPS media URLs; no NetEase account cookie or credential crosses the Host/Client boundary.

## Model Experience

### Playlist gateway

#### What the model sees

Nothing. The `ctx.remote.neteaseMusic` surface is consumed only by the global music UI.

#### Token effect

No messages, tools, prompt sections, or request tokens are added.

#### KV Cache effect

Playlist requests do not change an Agent request prefix.

## Known Limitations and Deferred Work

- **Upstream dependency** — NetEase may change or withdraw its undocumented public metadata and media endpoints.
- **Published free tracks only** — this package does not authenticate, decrypt, unlock, or bypass regional, copyright, or paid-content restrictions.
