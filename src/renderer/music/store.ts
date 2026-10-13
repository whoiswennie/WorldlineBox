import { useSyncExternalStore } from 'react';
import { DEFAULT_MUSIC_PREFERENCES, DEFAULT_NETEASE_PLAYLIST_ID, DEFAULT_NETEASE_PLAYLIST_NAME, musicPreferencesSchema, type MusicPreferences, type PlaybackMode } from '../../shared/music';

export { DEFAULT_NETEASE_PLAYLIST_ID } from '../../shared/music';
export type { PlaybackMode } from '../../shared/music';
export function resolveNeteasePlaylists(preferences: Pick<MusicPreferences, 'playlistId' | 'playlists'>) {
  return [{ id: DEFAULT_NETEASE_PLAYLIST_ID, name: DEFAULT_NETEASE_PLAYLIST_NAME }, ...preferences.playlists.filter(item => item.id !== DEFAULT_NETEASE_PLAYLIST_ID)];
}

/** One application-owned store. Audio and preferences survive every settings/tab remount. */
export function createMusicPreferenceStore(initial: MusicPreferences, persist: (value: MusicPreferences) => void) {
  let state = musicPreferencesSchema.parse(initial);
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const mutate = (update: (draft: MusicPreferences) => void) => {
    const draft = structuredClone(state); update(draft);
    state = musicPreferencesSchema.parse(draft);
    persist(state); for (const listener of listeners) listener();
  };
  const activate = (draft: MusicPreferences, id: string) => {
    if (draft.playlistId === id) return;
    draft.positions[draft.playlistId] = { trackId: draft.trackId, positionSeconds: draft.positionSeconds };
    const saved = draft.positions[id]; draft.playlistId = id;
    draft.trackId = saved?.trackId; draft.positionSeconds = saved?.positionSeconds ?? 0;
  };
  const actions = {
    setAutoPlay: (enabled: boolean) => mutate(draft => { draft.autoPlay = enabled; }),
    selectTrack: (id: string) => mutate(draft => { draft.trackId = id; draft.positionSeconds = 0; }),
    rememberProgress: (id: string, position: number) => mutate(draft => {
      // A pause event from an outgoing source must never resurrect that old song.
      if (draft.trackId !== id) return;
      draft.positionSeconds = Math.max(0, Math.min(604800, Number.isFinite(position) ? position : 0));
      draft.positions[draft.playlistId] = { trackId: id, positionSeconds: draft.positionSeconds };
    }),
    setVolume: (volume: number) => mutate(draft => { draft.volume = Math.max(0, Math.min(1, volume)); }),
    setPlaybackMode: (mode: PlaybackMode) => mutate(draft => { draft.playbackMode = mode; }),
    savePlaylist: (name: string, id: string) => mutate(draft => {
      if (id !== DEFAULT_NETEASE_PLAYLIST_ID) {
        draft.playlists = [...draft.playlists.filter(item => item.id !== id), { id, name: name.trim().slice(0, 40) }];
      }
      activate(draft, id);
    }),
    removePlaylist: (id: string) => mutate(draft => {
      if (id === DEFAULT_NETEASE_PLAYLIST_ID) return;
      if (draft.playlistId === id) activate(draft, DEFAULT_NETEASE_PLAYLIST_ID);
      draft.playlists = draft.playlists.filter(item => item.id !== id); delete draft.positions[id];
    }),
    selectPlaylist: (id: string) => mutate(draft => {
      if (!resolveNeteasePlaylists(draft).some(item => item.id === id)) throw new Error('请先保存这个歌单');
      activate(draft, id);
    }),
    restoreDefaultPlaylist: () => mutate(draft => { activate(draft, DEFAULT_NETEASE_PLAYLIST_ID); }),
  };
  return {
    actions, snapshot: () => state,
    useStore: <T,>(selector: (value: MusicPreferences) => T): T => selector(useSyncExternalStore(subscribe, () => state)),
  };
}
export type MusicPreferenceStore = ReturnType<typeof createMusicPreferenceStore>;
export const freshMusicPreferences = () => structuredClone(DEFAULT_MUSIC_PREFERENCES);
