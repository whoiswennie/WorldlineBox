import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  NeteasePlaylistCatalog,
  NeteaseTrackLyrics,
  NeteaseTrackStream,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { NeteaseMusic } from './NeteaseMusic.tsx'
import { PlaylistSettingsRow } from './PlaylistSettingsRow.tsx'
import { createMusicPreferenceStore } from './store.ts'

export {
  DEFAULT_PLAYLIST_ID,
  findActiveLyricIndex,
  formatPlaybackTime,
  NeteaseMusic,
} from './NeteaseMusic.tsx'
export type { NeteaseMusicProps } from './NeteaseMusic.tsx'
export { PlaylistSettingsRow } from './PlaylistSettingsRow.tsx'
export type { PlaylistSettingsRowProps } from './PlaylistSettingsRow.tsx'
export {
  createMusicPreferenceStore,
  DEFAULT_NETEASE_PLAYLIST,
  DEFAULT_NETEASE_PLAYLIST_ID,
  resolveNeteasePlaylists,
} from './store.ts'
export type { MusicPreferences, PlaybackMode, SavedNeteasePlaylist } from './store.ts'

export const inject = ['slots', 'remote', 'remote.neteaseMusic']

async function remoteValue<T>(response: Promise<{
  readonly ok: true
  readonly value: T
} | {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}>): Promise<T> {
  const result = await response
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  return result.value
}

/** Register the built-in playlist in the stable global top-bar tool region. */
export function apply(ctx: ClientContext): void {
  const store = createMusicPreferenceStore()
  ctx.slots.inject('worldline.topbar.trailing', () => ctx.slots.register({
    name: 'worldline.topbar.trailing',
    id: 'netease-music',
    order: 100,
    store,
    inject: () => ({
      loadCatalog: (
        playlistId: string,
        signal: AbortSignal,
      ): Promise<NeteasePlaylistCatalog> => remoteValue(
        ctx.remote.neteaseMusic.catalog(playlistId, signal),
      ),
      resolveStream: (
        playlistId: string,
        trackId: string,
        signal: AbortSignal,
      ): Promise<NeteaseTrackStream> => (
        remoteValue(ctx.remote.neteaseMusic.stream(playlistId, trackId, signal))
      ),
      loadLyrics: (
        playlistId: string,
        trackId: string,
        signal: AbortSignal,
      ): Promise<NeteaseTrackLyrics> => (
        remoteValue(ctx.remote.neteaseMusic.lyrics(playlistId, trackId, signal))
      ),
    }),
  }, NeteaseMusic))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'netease-playlist',
    order: 30,
    store,
  }, PlaylistSettingsRow))
}
