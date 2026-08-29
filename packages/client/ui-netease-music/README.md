# Built-in NetEase Music UI

English | [中文](README.zh.md)

This Client plugin contributes a persistent complete NetEase Cloud Music playlist to the global top-bar tool region. Unlike the official outchain iframe, the custom React/audio player reads all ordered songs through the bounded Host Remote, so the default playlist `18322613388` is not truncated to its first ten embedded rows. The General settings page can save, name, and remove multiple public playlists, with immediate switching there or in the player. The built-in “Default” playlist cannot be removed and can always be restored with one action. Custom playlists and the current selection persist across restarts.

The audio element remains mounted when the panel closes or Worldline switches conversations and feature pages. Account-isolated browser state records the selected song, timestamp, volume, and autoplay preference. Autoplay defaults to off; after an application restart, the player restores the saved song and timestamp while remaining paused unless the user enabled startup autoplay. The scrollable list and search field expose the complete catalog without creating the iframe's empty area.

The player also provides previous and next track controls, ten-second rewind and fast-forward, seeking, and a synchronized lyric view that can be opened or closed without interrupting playback. The active line follows playback automatically, translated lines are shown when available, and selecting a lyric seeks to its timestamp. List repeat is the default playback mode; single-track repeat and shuffle are available from the transport controls and the selection persists across restarts.

When a stream is unavailable because of VIP, copyright, regional, or stale-link restrictions, the player marks that attempt and advances to the next candidate automatically. It stops with an actionable message only after every track in the current pass is unavailable.

## Model Experience

### Global player

#### What the model sees

Nothing: playback and preferences remain in the `worldline.topbar.trailing` Client slot.

#### Token effect

The player adds no messages, tools, prompt sections, or request tokens.

#### KV Cache effect

Playback and its persisted state do not change an Agent request prefix.

## Known Limitations and Deferred Work

- **Browser policy** — a browser may still require one explicit play click when the user enabled startup autoplay; the Desktop profile permits that opt-in behavior.
- **Service availability** — metadata and playback depend on NetEase Cloud Music availability, regional policy, and the playlist owner's published free content.
