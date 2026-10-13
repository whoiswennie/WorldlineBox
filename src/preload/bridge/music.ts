import { ipcRenderer } from 'electron';
import { MUSIC_CHANNEL, MUSIC_SAVE_CHANNEL, musicPreferencesSchema, musicCatalogSchema, type WorldlineBoxMusicApi, type NeteasePlaylistCatalog, type NeteaseTrackStream, type NeteaseTrackLyrics } from '../../shared/music';
async function request<T>(input: unknown): Promise<T> {
  const response = await ipcRenderer.invoke(MUSIC_CHANNEL, input) as { ok: boolean; value?: T; error?: string };
  if (!response.ok) throw new Error(response.error ?? 'Music request failed.');
  return response.value as T;
}
export const music: WorldlineBoxMusicApi = Object.freeze({
  preferences: async () => musicPreferencesSchema.parse(await request({ type: 'preferences' })),
  savePreferences: (preferences: Parameters<WorldlineBoxMusicApi['savePreferences']>[0]) => ipcRenderer.send(MUSIC_SAVE_CHANNEL, musicPreferencesSchema.parse(preferences)),
  catalog: async (playlistId: string, refresh?: boolean) => musicCatalogSchema.parse(await request<NeteasePlaylistCatalog>({ type: 'catalog', playlistId, refresh })),
  stream: (playlistId: string, trackId: string) => request<NeteaseTrackStream>({ type: 'stream', playlistId, trackId }),
  lyrics: (playlistId: string, trackId: string) => request<NeteaseTrackLyrics>({ type: 'lyrics', playlistId, trackId }),
});
