import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  NeteasePlaylistCatalog,
  NeteasePlaylistTrack,
  NeteaseLyricLine,
  NeteaseTrackLyrics,
  NeteaseTrackStream,
} from './types.ts'

export type * from './types.ts'

/**
 * Netease playlist id.
 */
export const NETEASE_PLAYLIST_ID = '18322613388'
const NETEASE_ORIGIN = 'https://music.163.com'
const REQUEST_HEADERS = {
  accept: 'application/json,text/plain,*/*',
  referer: `${NETEASE_ORIGIN}/`,
  'user-agent': 'Worldline/0.1 NetEase playlist player',
} as const
const CATALOG_TTL_MS = 5 * 60_000
const LYRICS_TTL_MS = 30 * 60_000
const DETAIL_BATCH_SIZE = 100

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

interface PlaylistResponse {
  readonly code?: number
  readonly playlist?: {
    readonly id?: number | string
    readonly name?: string
    readonly coverImgUrl?: string
    readonly trackCount?: number
    readonly trackIds?: readonly { readonly id?: number | string }[]
  }
}

interface SongDetailResponse {
  readonly code?: number
  readonly songs?: readonly SongRecord[]
}

interface LyricResponse {
  readonly code?: number
  readonly lrc?: { readonly lyric?: string }
  readonly tlyric?: { readonly lyric?: string }
  readonly romalrc?: { readonly lyric?: string }
  readonly yrc?: { readonly lyric?: string }
  readonly ytlrc?: { readonly lyric?: string }
  readonly yromalrc?: { readonly lyric?: string }
  readonly nolyric?: boolean
  readonly uncollected?: boolean
}

interface SongRecord {
  readonly id?: number | string
  readonly name?: string
  readonly duration?: number
  readonly dt?: number
  readonly artists?: readonly { readonly name?: string }[]
  readonly ar?: readonly { readonly name?: string }[]
  readonly album?: { readonly name?: string; readonly picUrl?: string }
  readonly al?: { readonly name?: string; readonly picUrl?: string }
}

function asPositiveId(value: unknown): string | undefined {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return undefined
  const id = `${value as string | number | bigint}`
  return /^\d+$/u.test(id) && id !== '0' ? id : undefined
}

async function jsonResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new Error(`${label}请求失败：HTTP ${String(response.status)}`)
  try {
    return await response.json() as T
  } catch (error) {
    throw new Error(`${label}返回了无效 JSON`, { cause: error })
  }
}

function detailUrl(ids: readonly string[]): string {
  const query = new URLSearchParams({ ids: `[${ids.join(',')}]` })
  return `${NETEASE_ORIGIN}/api/song/detail?${query.toString()}`
}

function requestInit(signal: AbortSignal | undefined): RequestInit {
  return { headers: REQUEST_HEADERS, ...(signal === undefined ? {} : { signal }) }
}

function normalizeTrack(song: SongRecord): NeteasePlaylistTrack | undefined {
  const id = asPositiveId(song.id)
  const name = song.name?.trim()
  if (id === undefined || name === undefined || name === '') return undefined
  const album = song.album ?? song.al
  const artists = (song.artists ?? song.ar ?? [])
    .map(artist => artist.name?.trim())
    .filter((artist): artist is string => artist !== undefined && artist !== '')
  return {
    id,
    name,
    artists,
    album: album?.name?.trim() ?? '',
    coverUrl: album?.picUrl ?? '',
    durationMs: Math.max(0, song.duration ?? song.dt ?? 0),
  }
}

const LRC_TIMESTAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gu
const LRC_OFFSET = /^\[offset:([+-]?\d+)\]$/iu
const YRC_LINE = /^\[(\d+),\d+\](.*)$/u
const YRC_WORD_TIMESTAMP = /\(\d+,\d+,\d+\)/gu

function splitInlineTranslation(text: string): Pick<NeteaseLyricLine, 'text' | 'translatedText'> {
  const separator = text.indexOf('|')
  if (separator <= 0) return { text }
  const original = text.slice(0, separator).trim()
  const translatedText = text.slice(separator + 1).trim()
  return original === '' || translatedText === '' ? { text } : { text: original, translatedText }
}

/**
 *  Parse a standard LRC document into ordered millisecond timestamps.
 * @param source - source value.
 * @returns The resulting value.
 */
export function parseNeteaseLyrics(source: string): NeteaseLyricLine[] {
  const rawLines = source.split(/\r?\n/u)
  const offset = rawLines.reduce((value, line) => {
    const match = LRC_OFFSET.exec(line.trim())
    return match?.[1] === undefined ? value : Number(match[1])
  }, 0)
  const lines: NeteaseLyricLine[] = []
  for (const rawLine of rawLines) {
    const text = rawLine.replace(LRC_TIMESTAMP, '').trim()
    if (text === '' || LRC_OFFSET.test(rawLine.trim())) continue
    LRC_TIMESTAMP.lastIndex = 0
    for (const match of rawLine.matchAll(LRC_TIMESTAMP)) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fraction = match[3] ?? '0'
      const fractionMs = Number(fraction.padEnd(3, '0').slice(0, 3))
      const timeMs = Math.max(0, minutes * 60_000 + seconds * 1_000 + fractionMs + offset)
      lines.push({ timeMs, ...splitInlineTranslation(text) })
    }
  }
  return lines.sort((left, right) => left.timeMs - right.timeMs)
}

/**
 *  Parse NetEase's word-synchronized YRC document into line-level timestamps.
 * @param source - source value.
 * @returns The resulting value.
 */
export function parseNeteaseWordLyrics(source: string): NeteaseLyricLine[] {
  const lines: NeteaseLyricLine[] = []
  for (const rawLine of source.split(/\r?\n/u)) {
    const match = YRC_LINE.exec(rawLine.trim())
    if (match?.[1] === undefined || match[2] === undefined) continue
    const text = match[2].replace(YRC_WORD_TIMESTAMP, '').trim()
    if (text === '') continue
    lines.push({ timeMs: Number(match[1]), ...splitInlineTranslation(text) })
  }
  return lines.sort((left, right) => left.timeMs - right.timeMs)
}

function parseLyricDocument(source: string): NeteaseLyricLine[] {
  const lrc = parseNeteaseLyrics(source)
  return lrc.length > 0 ? lrc : parseNeteaseWordLyrics(source)
}

function firstLyrics(...sources: readonly (string | undefined)[]): string {
  return sources.find(source => source !== undefined && source.trim() !== '') ?? ''
}

function mergeLyrics(original: string, translated: string): NeteaseLyricLine[] {
  const translations = new Map(parseLyricDocument(translated).map(line => [line.timeMs, line.text]))
  return parseLyricDocument(original).map((line) => {
    const translatedText = translations.get(line.timeMs) ?? line.translatedText
    return translatedText === undefined ? line : { ...line, translatedText }
  })
}

/**
 *  Fetch synchronized lyrics without sending NetEase account credentials.
 * @param trackId - track id value.
 * @param fetcher - fetcher value.
 * @param signal - Cancellation signal for the operation.
 * @returns The resulting value.
 */
export async function fetchNeteaseTrackLyrics(
  trackId: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<NeteaseTrackLyrics> {
  const normalizedId = asPositiveId(trackId)
  if (normalizedId === undefined) throw new TypeError('歌曲 ID 必须是正整数')
  const query = new URLSearchParams({
    id: normalizedId,
    lv: '-1',
    kv: '-1',
    tv: '-1',
    rv: '-1',
    yv: '-1',
    ytv: '-1',
    yrv: '-1',
  })
  const response = await fetcher(
    `${NETEASE_ORIGIN}/api/song/lyric?${query.toString()}`,
    requestInit(signal),
  )
  const payload = await jsonResponse<LyricResponse>(response, '网易云歌词')
  if (payload.code !== 200) throw new Error(`歌曲 ${normalizedId} 的歌词暂不可用`)
  if (payload.nolyric === true || payload.uncollected === true) {
    return { trackId: normalizedId, lines: [] }
  }
  return {
    trackId: normalizedId,
    lines: mergeLyrics(
      firstLyrics(
        payload.lrc?.lyric,
        payload.yrc?.lyric,
        payload.romalrc?.lyric,
        payload.yromalrc?.lyric,
      ),
      firstLyrics(payload.tlyric?.lyric, payload.ytlrc?.lyric),
    ),
  }
}

/**
 *  Fetch every ordered song in the fixed public playlist, not just the first ten expanded rows.
 * @param playlistId - playlist id value.
 * @param fetcher - fetcher value.
 * @param signal - Cancellation signal for the operation.
 * @returns The resulting value.
 */
export async function fetchNeteasePlaylistCatalog(
  playlistId: string = NETEASE_PLAYLIST_ID,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<NeteasePlaylistCatalog> {
  const normalizedPlaylistId = asPositiveId(playlistId)
  if (normalizedPlaylistId === undefined) throw new TypeError('歌单 ID 必须是正整数')
  const playlistResponse = await fetcher(
    `${NETEASE_ORIGIN}/api/v6/playlist/detail?id=${normalizedPlaylistId}`,
    requestInit(signal),
  )
  const payload = await jsonResponse<PlaylistResponse>(playlistResponse, '网易云歌单')
  const playlist = payload.playlist
  if (payload.code !== 200 || playlist === undefined) throw new Error('网易云歌单不存在或暂不可用')
  const ids = (playlist.trackIds ?? [])
    .map(entry => asPositiveId(entry.id))
    .filter((id): id is string => id !== undefined)
  if (ids.length === 0) throw new Error('网易云歌单没有可读取的歌曲')

  const songs = new Map<string, NeteasePlaylistTrack>()
  for (let offset = 0; offset < ids.length; offset += DETAIL_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + DETAIL_BATCH_SIZE)
    const response = await fetcher(detailUrl(batch), requestInit(signal))
    const details = await jsonResponse<SongDetailResponse>(response, '网易云歌曲详情')
    if (details.code !== 200 || details.songs === undefined) {
      throw new Error('网易云歌曲详情暂不可用')
    }
    for (const song of details.songs) {
      const normalized = normalizeTrack(song)
      if (normalized !== undefined) songs.set(normalized.id, normalized)
    }
  }

  const tracks = ids.map(id => songs.get(id)).filter((track): track is NeteasePlaylistTrack => (
    track !== undefined
  ))
  if (tracks.length !== ids.length) {
    throw new Error(`网易云只返回了 ${String(tracks.length)}/${String(ids.length)} 首歌曲详情`)
  }
  return {
    id: asPositiveId(playlist.id) ?? normalizedPlaylistId,
    name: playlist.name?.trim() || '网易云歌单',
    coverUrl: playlist.coverImgUrl ?? tracks[0]?.coverUrl ?? '',
    trackCount: playlist.trackCount ?? tracks.length,
    tracks,
  }
}

function allowedStreamHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'music.126.net' || host.endsWith('.music.126.net')
}

/**
 *  Resolve the official public media redirect and normalize it to HTTPS.
 * @param trackId - track id value.
 * @param fetcher - fetcher value.
 * @param signal - Cancellation signal for the operation.
 * @returns The resulting value.
 */
export async function resolveNeteaseTrackStream(
  trackId: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<NeteaseTrackStream> {
  const normalizedId = asPositiveId(trackId)
  if (normalizedId === undefined) throw new TypeError('歌曲 ID 必须是正整数')
  const response = await fetcher(
    `${NETEASE_ORIGIN}/song/media/outer/url?id=${normalizedId}.mp3`,
    { ...requestInit(signal), redirect: 'manual' },
  )
  const location = response.headers.get('location')
  if (response.status < 300 || response.status >= 400 || location === null) {
    throw new Error(`网易云没有返回歌曲 ${normalizedId} 的公开播放地址`)
  }
  const url = new URL(location, NETEASE_ORIGIN)
  if (!['http:', 'https:'].includes(url.protocol) || !allowedStreamHost(url.hostname)) {
    throw new Error('网易云返回了不受信任的播放地址')
  }
  url.protocol = 'https:'
  return { trackId: normalizedId, url: url.toString() }
}

/** Host authority for the complete built-in playlist and its public media redirects. */
export class NeteaseMusicGateway extends TypertRemoteService {
  private readonly catalogCache = new Map<string, {
    readonly expiresAt: number
    readonly value: Promise<NeteasePlaylistCatalog>
  }>()
  private readonly lyricsCache = new Map<string, {
    readonly expiresAt: number
    readonly value: Promise<NeteaseTrackLyrics>
  }>()

  constructor(ctx: Context) {
    super(ctx, 'neteaseMusic')
  }

  /**
   *  Return the complete ordered playlist catalog.
   * @param playlistId - playlist id value.
   * @param signal - Cancellation signal for the operation.
   * @returns The resulting value.
   */
  @Remote('catalog')
  async catalog(playlistId: string, signal: AbortSignal): Promise<NeteasePlaylistCatalog> {
    const normalizedPlaylistId = asPositiveId(playlistId)
    if (normalizedPlaylistId === undefined) throw new TypeError('歌单 ID 必须是正整数')
    const now = Date.now()
    const cached = this.catalogCache.get(normalizedPlaylistId)
    if (cached !== undefined && cached.expiresAt > now) return await cached.value
    const value = fetchNeteasePlaylistCatalog(normalizedPlaylistId, fetch, signal)
    this.catalogCache.set(normalizedPlaylistId, { expiresAt: now + CATALOG_TTL_MS, value })
    try {
      return await value
    } catch (error) {
      if (this.catalogCache.get(normalizedPlaylistId)?.value === value) {
        this.catalogCache.delete(normalizedPlaylistId)
      }
      throw error
    }
  }

  /**
   *  Resolve one public stream only when the song belongs to the built-in playlist.
   * @param playlistId - playlist id value.
   * @param trackId - track id value.
   * @param signal - Cancellation signal for the operation.
   * @returns The resulting value.
   */
  @Remote('stream')
  async stream(
    playlistId: string,
    trackId: string,
    signal: AbortSignal,
  ): Promise<NeteaseTrackStream> {
    const catalog = await this.catalog(playlistId, signal)
    if (!catalog.tracks.some(track => track.id === trackId)) {
      throw new Error('歌曲不属于内置网易云歌单')
    }
    return await resolveNeteaseTrackStream(trackId, fetch, signal)
  }

  /**
   *  Return synchronized lyrics only for a song in the built-in playlist.
   * @param playlistId - playlist id value.
   * @param trackId - track id value.
   * @param signal - Cancellation signal for the operation.
   * @returns The resulting value.
   */
  @Remote('lyrics')
  async lyrics(
    playlistId: string,
    trackId: string,
    signal: AbortSignal,
  ): Promise<NeteaseTrackLyrics> {
    const catalog = await this.catalog(playlistId, signal)
    if (!catalog.tracks.some(track => track.id === trackId)) {
      throw new Error('歌曲不属于内置网易云歌单')
    }
    const now = Date.now()
    const cached = this.lyricsCache.get(trackId)
    if (cached !== undefined && cached.expiresAt > now) return await cached.value
    const value = fetchNeteaseTrackLyrics(trackId, fetch, signal)
    this.lyricsCache.set(trackId, { expiresAt: now + LYRICS_TTL_MS, value })
    try {
      return await value
    } catch (error) {
      if (this.lyricsCache.get(trackId)?.value === value) this.lyricsCache.delete(trackId)
      throw error
    }
  }
}

export default NeteaseMusicGateway
