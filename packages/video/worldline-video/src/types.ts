/** Stable manifest format written by the Worldline video indexer. */
export interface VideoManifest {
  version: 1
  id: string
  source: string
  sourceKind: 'local' | 'online'
  onlineMode?: 'cache' | 'stream'
  mediaPath: string
  title: string
  durationSeconds: number
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
  indexedAt: string
  keyframes: number[]
  chapters: VideoChapter[]
  captionFiles: string[]
}

/** One bounded long-video navigation unit. */
export interface VideoChapter {
  index: number
  startSeconds: number
  endSeconds: number
  title: string
}

/** A timestamped caption segment parsed from a supported text subtitle. */
export interface CaptionSegment {
  startSeconds: number
  endSeconds: number
  text: string
}

/** Compact metadata returned by a source probe. */
export interface VideoProbe {
  source: string
  sourceKind: 'local' | 'online'
  title: string
  durationSeconds?: number
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
  uploader?: string
  webpageUrl?: string
  chapters: number
  subtitleLanguages: string[]
}
