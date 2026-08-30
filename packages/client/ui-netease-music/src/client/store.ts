import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Type contract for playback mode.
 * @returns The resulting value.
 */
export type PlaybackMode = 'list' | 'single' | 'shuffle'
/**
 * Default netease playlist id.
 */
export const DEFAULT_NETEASE_PLAYLIST_ID = '18322613388'
/**
 * Default netease playlist name.
 */
export const DEFAULT_NETEASE_PLAYLIST_NAME = '默认'

/**
 * Contract for saved netease playlist.
 */
export interface SavedNeteasePlaylist {
  readonly id: string
  readonly name: string
}

/**
 * Default netease playlist.
 * @returns The resulting value.
 */
export const DEFAULT_NETEASE_PLAYLIST: SavedNeteasePlaylist = {
  id: DEFAULT_NETEASE_PLAYLIST_ID,
  name: DEFAULT_NETEASE_PLAYLIST_NAME,
}

const AUTOPLAY_COOKIE_PREFIX = 'worldline_netease_autoplay_'
const AUTOPLAY_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 5

function autoplayCookieName(): string {
  const namespace = (globalThis as typeof globalThis & {
    __WORLDLINE_STORAGE_NAMESPACE__?: unknown
  }).__WORLDLINE_STORAGE_NAMESPACE__
  const account = typeof namespace === 'string' && namespace !== '' ? namespace : 'shared'
  return `${AUTOPLAY_COOKIE_PREFIX}${account.replace(/[^a-zA-Z0-9_-]/gu, '_')}`
}

/**
 * Cookies are host-scoped rather than port-scoped. The desktop runtime uses a
 * fresh loopback port after restart, so this small preference bridge preserves
 * the user's explicit autoplay choice when localStorage moves to a new origin.
 * @returns The resulting value.
 */
export function persistedMusicAutoplayPreference(): boolean | undefined {
  if (typeof document === 'undefined') return undefined
  const prefix = `${autoplayCookieName()}=`
  const value = document.cookie.split(';').map(part => part.trim())
    .find(part => part.startsWith(prefix))?.slice(prefix.length)
  return value === '1' ? true : value === '0' ? false : undefined
}

/**
 *  Persist an explicit autoplay choice across changing loopback ports.
 * @param enabled - enabled value.
 */
export function persistMusicAutoplayPreference(enabled: boolean): void {
  if (typeof document === 'undefined') return
  document.cookie = `${autoplayCookieName()}=${enabled ? '1' : '0'}; Path=/; Max-Age=${AUTOPLAY_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`
}

/**
 * Contract for music preferences.
 */
export interface MusicPreferences {
  /** Whether the custom player starts after restoring its saved track and timestamp. */
  autoPlay: boolean
  /** Optional for compatibility with the earlier v1 autoplay-only document. */
  trackId?: string
  positionSeconds?: number
  volume?: number
  /** Optional for compatibility with persisted preferences written before playback modes. */
  playbackMode?: PlaybackMode
  /** Optional for compatibility with preferences written before playlist switching. */
  playlistId?: string
  /** User-managed playlists; the immutable built-in default is always injected separately. */
  playlists?: SavedNeteasePlaylist[]
}

type MusicPreferenceActions = {
  setAutoPlay: (draft: MusicPreferences, enabled: boolean) => void
  selectTrack: (draft: MusicPreferences, trackId: string) => void
  rememberProgress: (draft: MusicPreferences, trackId: string, positionSeconds: number) => void
  setVolume: (draft: MusicPreferences, volume: number) => void
  setPlaybackMode: (draft: MusicPreferences, mode: PlaybackMode) => void
  savePlaylist: (draft: MusicPreferences, name: string, playlistId: string) => void
  removePlaylist: (draft: MusicPreferences, playlistId: string) => void
  selectPlaylist: (draft: MusicPreferences, playlistId: string) => void
  restoreDefaultPlaylist: (draft: MusicPreferences) => void
  /** Compatibility action retained for callers compiled against the single-playlist store. */
  setPlaylistId: (draft: MusicPreferences, playlistId: string) => void
}

type MusicPreferenceStore = EngineStoreHandle<MusicPreferences, MusicPreferenceActions>

type PlaylistPreferenceSlice = {
  readonly playlistId?: string | undefined
  readonly playlists?: readonly SavedNeteasePlaylist[] | undefined
}

function validPlaylistId(playlistId: string): boolean {
  return /^\d+$/u.test(playlistId) && playlistId !== '0'
}

function assertPlaylistId(playlistId: string): void {
  if (!validPlaylistId(playlistId)) throw new TypeError('歌单 ID 必须是正整数')
}

function normalizedPlaylistName(name: string): string {
  const normalized = name.trim()
  if (normalized === '') throw new TypeError('歌单名称不能为空')
  return normalized.slice(0, 40)
}

function customPlaylists(preferences: PlaylistPreferenceSlice): SavedNeteasePlaylist[] {
  const playlists: SavedNeteasePlaylist[] = []
  const seen = new Set([DEFAULT_NETEASE_PLAYLIST_ID])
  for (const playlist of preferences.playlists ?? []) {
    const id = playlist.id.trim()
    if (!validPlaylistId(id) || seen.has(id)) continue
    const name = playlist.name.trim() || `歌单 ${id}`
    playlists.push({ id, name: name.slice(0, 40) })
    seen.add(id)
  }
  const legacyId = preferences.playlistId
  if (legacyId !== undefined && validPlaylistId(legacyId) && !seen.has(legacyId)) {
    playlists.push({ id: legacyId, name: `歌单 ${legacyId}` })
  }
  return playlists
}

/**
 *  Return the immutable default plus every valid saved or legacy playlist.
 * @param preferences - preferences value.
 * @returns The resulting value.
 */
export function resolveNeteasePlaylists(
  preferences: PlaylistPreferenceSlice,
): readonly SavedNeteasePlaylist[] {
  return [DEFAULT_NETEASE_PLAYLIST, ...customPlaylists(preferences)]
}

function activatePlaylist(draft: MusicPreferences, playlistId: string): void {
  draft.playlistId = playlistId
  delete draft.trackId
  draft.positionSeconds = 0
}

function saveCustomPlaylist(
  draft: MusicPreferences,
  name: string,
  playlistId: string,
): void {
  assertPlaylistId(playlistId)
  if (playlistId === DEFAULT_NETEASE_PLAYLIST_ID) {
    activatePlaylist(draft, playlistId)
    return
  }
  const playlists = customPlaylists(draft)
  const existing = playlists.find(playlist => playlist.id === playlistId)
  if (existing === undefined) {
    playlists.push({ id: playlistId, name: normalizedPlaylistName(name) })
  } else {
    const index = playlists.indexOf(existing)
    playlists[index] = { id: playlistId, name: normalizedPlaylistName(name) }
  }
  draft.playlists = playlists
  activatePlaylist(draft, playlistId)
}

/**
 *  Create the account-isolated, persisted music preference store.
 * @returns The resulting value.
 */
export function createMusicPreferenceStore(): MusicPreferenceStore {
  return defineStore({
    init: (): MusicPreferences => ({
      autoPlay: persistedMusicAutoplayPreference() ?? false,
      positionSeconds: 0,
      volume: 0.8,
      playbackMode: 'list',
      playlistId: DEFAULT_NETEASE_PLAYLIST_ID,
      playlists: [],
    }),
    persist: 'worldline.netease-music.preferences.v1',
    actions: {
      setAutoPlay: (draft, enabled: boolean) => {
        draft.autoPlay = enabled
        persistMusicAutoplayPreference(enabled)
      },
      selectTrack: (draft, trackId: string) => {
        draft.trackId = trackId
        draft.positionSeconds = 0
      },
      rememberProgress: (draft, trackId: string, positionSeconds: number) => {
        draft.trackId = trackId
        draft.positionSeconds = Math.max(0, positionSeconds)
      },
      setVolume: (draft, volume: number) => {
        draft.volume = Math.max(0, Math.min(1, volume))
      },
      setPlaybackMode: (draft, mode: PlaybackMode) => { draft.playbackMode = mode },
      savePlaylist: (draft, name: string, playlistId: string) => {
        saveCustomPlaylist(draft, name, playlistId)
      },
      removePlaylist: (draft, playlistId: string) => {
        assertPlaylistId(playlistId)
        if (playlistId === DEFAULT_NETEASE_PLAYLIST_ID) {
          throw new TypeError('默认歌单不可删除')
        }
        draft.playlists = customPlaylists(draft)
          .filter(playlist => playlist.id !== playlistId)
        if (draft.playlistId === playlistId) activatePlaylist(draft, DEFAULT_NETEASE_PLAYLIST_ID)
      },
      selectPlaylist: (draft, playlistId: string) => {
        assertPlaylistId(playlistId)
        if (!resolveNeteasePlaylists(draft).some(playlist => playlist.id === playlistId)) {
          throw new TypeError('请先保存这个歌单')
        }
        draft.playlists = customPlaylists(draft)
        activatePlaylist(draft, playlistId)
      },
      restoreDefaultPlaylist: (draft) => {
        draft.playlists = customPlaylists(draft)
        activatePlaylist(draft, DEFAULT_NETEASE_PLAYLIST_ID)
      },
      setPlaylistId: (draft, playlistId: string) => {
        saveCustomPlaylist(draft, `歌单 ${playlistId}`, playlistId)
      },
    },
  })
}
