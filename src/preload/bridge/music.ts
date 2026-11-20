import { ipcRenderer } from 'electron';
import { MUSIC_CHANNEL, MUSIC_SAVE_CHANNEL, MUSIC_CONTROL_CHANNEL, MUSIC_CONTROL_RESULT_CHANNEL, MUSIC_CONTROL_CANCEL_CHANNEL, MUSIC_LYRICS_LAYOUT_CHANNEL, musicCommandSchema, musicReplySchema, musicLyricsWindowConfigSchema, musicPreferencesSchema, musicCatalogSchema, type MusicCommand, type MusicReply, type MusicLyricsWindowConfig, type WorldlineBoxMusicApi, type NeteasePlaylistCatalog, type NeteaseTrackStream, type NeteaseTrackLyrics } from '../../shared/music';
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
  onCommand(listener: (command: MusicCommand) => void) {
    const handle = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = musicCommandSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(MUSIC_CONTROL_CHANNEL, handle);
    return () => { ipcRenderer.removeListener(MUSIC_CONTROL_CHANNEL, handle); };
  },
  onCommandCancelled(listener: (id: string) => void) {
    const handle = (_event: Electron.IpcRendererEvent, id: unknown) => { if (typeof id === 'string') listener(id); };
    ipcRenderer.on(MUSIC_CONTROL_CANCEL_CHANNEL, handle);
    return () => { ipcRenderer.removeListener(MUSIC_CONTROL_CANCEL_CHANNEL, handle); };
  },
  reply: (reply: MusicReply) => ipcRenderer.send(MUSIC_CONTROL_RESULT_CHANNEL, musicReplySchema.parse(reply)),
  configureLyrics: (config: MusicLyricsWindowConfig) => ipcRenderer.send(MUSIC_LYRICS_LAYOUT_CHANNEL, musicLyricsWindowConfigSchema.parse(config)),
});
