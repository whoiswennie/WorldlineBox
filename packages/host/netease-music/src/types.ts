/** One song in the fixed built-in NetEase playlist. */
export interface NeteasePlaylistTrack {
  readonly id: string
  readonly name: string
  readonly artists: readonly string[]
  readonly album: string
  readonly coverUrl: string
  readonly durationMs: number
}

/** Complete ordered playlist projection returned to the browser. */
export interface NeteasePlaylistCatalog {
  readonly id: string
  readonly name: string
  readonly coverUrl: string
  readonly trackCount: number
  readonly tracks: readonly NeteasePlaylistTrack[]
}

/** Short-lived, public playback location for one song in the built-in playlist. */
export interface NeteaseTrackStream {
  readonly trackId: string
  readonly url: string
}

/** One timestamped line in a song's synchronized LRC document. */
export interface NeteaseLyricLine {
  readonly timeMs: number
  readonly text: string
  readonly translatedText?: string
}

/** Synchronized lyrics for one song in the built-in playlist. */
export interface NeteaseTrackLyrics {
  readonly trackId: string
  readonly lines: readonly NeteaseLyricLine[]
}
