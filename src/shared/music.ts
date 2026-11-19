import { z } from 'zod';

export const MUSIC_CHANNEL = 'worldlinebox:music';
export const MUSIC_SAVE_CHANNEL = 'worldlinebox:music-save';
export const MUSIC_CONTROL_CHANNEL = 'worldlinebox:music-control';
export const MUSIC_CONTROL_RESULT_CHANNEL = 'worldlinebox:music-control-result';
export const MUSIC_CONTROL_CANCEL_CHANNEL = 'worldlinebox:music-control-cancel';
export const MUSIC_LYRICS_LAYOUT_CHANNEL = 'worldlinebox:music-lyrics-layout';
export const MUSIC_LYRICS_WINDOW = 'wlb-music-lyrics';
export const MUSIC_LYRICS_LOCK_INSET = 8;
export const MUSIC_LYRICS_LOCK_SIZE = 28;
export const musicLyricsLayoutSchema = z.strictObject({
  locked: z.boolean(), orientation: z.enum(['horizontal', 'vertical']), fontSize: z.number().int().min(16).max(40),
});
export type MusicLyricsLayout = z.infer<typeof musicLyricsLayoutSchema>;
export const DEFAULT_MUSIC_LYRICS_LAYOUT: MusicLyricsLayout = { locked: false, orientation: 'horizontal', fontSize: 25 };
export const DEFAULT_NETEASE_PLAYLIST_ID = '18322613388';
export const DEFAULT_NETEASE_PLAYLIST_NAME = '幻酱的作品集';
export const DEFAULT_NETEASE_PLAYLIST_DESCRIPTION = '收录世界线盒子开发者「幻」的翻唱作品。白幻和黑幻是演唱者「幻」的两种形态。';
export const musicIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);
export const playbackModeSchema = z.enum(['list', 'single', 'shuffle', 'once']);
export type PlaybackMode = z.infer<typeof playbackModeSchema>;
const queuedTrack = z.strictObject({ playlistId: musicIdSchema, trackId: musicIdSchema });
export const musicQueueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('playlist'), playlistId: musicIdSchema }),
  z.strictObject({ kind: z.literal('tracks'), tracks: z.array(queuedTrack).min(1).max(100) }),
]);
export type MusicQueue = z.infer<typeof musicQueueSchema>;
const shareInputSchema = z.strictObject({
  action: z.literal('share'), queue: musicQueueSchema, title: z.string().trim().min(1).max(100).optional(),
  mode: playbackModeSchema.default('once'), autoPlay: z.boolean().default(true),
});
export type MusicShareInput = z.infer<typeof shareInputSchema>;
export const musicShareSchema = z.strictObject({
  id: z.string().min(1).max(100), title: z.string().min(1).max(100),
  queue: musicQueueSchema, mode: playbackModeSchema, trackCount: z.number().int().min(1).max(10000),
  preview: z.array(z.string().max(200)).min(1).max(3),
});
export type MusicShare = z.infer<typeof musicShareSchema>;
export type MusicQueuedTrack = NeteasePlaylistTrack & { playlistId: string };

export async function loadMusicQueue(queue: MusicQueue, load: (id: string) => Promise<NeteasePlaylistCatalog>, signal: AbortSignal) {
  const catalogs = new Map<string, NeteasePlaylistCatalog>();
  const catalog = async (id: string) => {
    signal.throwIfAborted();
    if (!catalogs.has(id)) catalogs.set(id, await load(id));
    signal.throwIfAborted();
    return catalogs.get(id)!;
  };
  if (queue.kind === 'playlist') {
    const value = await catalog(queue.playlistId);
    return { name: queue.playlistId === DEFAULT_NETEASE_PLAYLIST_ID ? DEFAULT_NETEASE_PLAYLIST_NAME : value.name,
      coverUrl: value.coverUrl, tracks: value.tracks.map(track => ({ ...track, playlistId: value.id })) };
  }
  const tracks: MusicQueuedTrack[] = [], used = new Set<string>();
  for (const ref of queue.tracks) {
    if (used.has(ref.trackId)) continue;
    const value = await catalog(ref.playlistId);
    const track = value.tracks.find(item => item.id === ref.trackId);
    if (!track) throw Error('歌曲 ' + ref.trackId + ' 不属于歌单 ' + ref.playlistId + '。');
    tracks.push({ ...track, playlistId: ref.playlistId }); used.add(ref.trackId);
  }
  return { name: tracks[0]?.name ?? '', coverUrl: tracks[0]?.coverUrl ?? '', tracks };
}
const positionSchema = z.object({ trackId: musicIdSchema.optional(), positionSeconds: z.number().finite().min(0).max(604800).default(0) });
export const savedPlaylistSchema = z.object({ id: musicIdSchema, name: z.string().trim().min(1).max(40), description: z.string().trim().max(500).default('') });
export const musicPreferencesSchema = positionSchema.extend({
  autoPlay: z.boolean().default(false), volume: z.number().finite().min(0).max(1).default(0.8),
  playbackMode: playbackModeSchema.default('list'),
  playlistId: musicIdSchema.default(DEFAULT_NETEASE_PLAYLIST_ID),
  playlists: z.array(savedPlaylistSchema).max(100).default([]).transform(items => items.filter(item => item.id !== DEFAULT_NETEASE_PLAYLIST_ID)),
  positions: z.record(musicIdSchema, positionSchema).default({}),
});
export type MusicPreferences = z.infer<typeof musicPreferencesSchema>;
export type SavedNeteasePlaylist = MusicPreferences['playlists'][number];
export const DEFAULT_MUSIC_PREFERENCES = musicPreferencesSchema.parse({});
export const savedNeteasePlaylists = (preferences: Pick<MusicPreferences, 'playlists'>): SavedNeteasePlaylist[] => [
  { id: DEFAULT_NETEASE_PLAYLIST_ID, name: DEFAULT_NETEASE_PLAYLIST_NAME, description: DEFAULT_NETEASE_PLAYLIST_DESCRIPTION },
  ...preferences.playlists.filter(item => item.id !== DEFAULT_NETEASE_PLAYLIST_ID),
];
const target = z.enum(['global', 'inline']).default('inline');
const playbackActions = <Target extends z.ZodType>(target: Target) => [
  z.strictObject({ action: z.literal('play'), target, playlistId: musicIdSchema.optional(), trackId: musicIdSchema.optional() }),
  z.strictObject({ action: z.literal(['status', 'pause', 'resume', 'previous', 'next']), target }),
  z.strictObject({ action: z.literal('seek'), target, seconds: z.number().min(0).max(604800) }),
  z.strictObject({ action: z.literal('volume'), target, volume: z.number().min(0).max(1) }),
  z.strictObject({ action: z.literal('mode'), target, mode: playbackModeSchema }),
  z.strictObject({ action: z.literal('lyrics'), target, visible: z.boolean() }),
] as const;
const playlistLibraryActions = [
  z.strictObject({ action: z.literal('playlists') }),
  z.strictObject({ action: z.literal('save_playlist'), playlist: savedPlaylistSchema }),
  z.strictObject({ action: z.literal('remove_playlist'), playlistId: musicIdSchema }),
] as const;
const selectPlaylistAction = z.strictObject({ action: z.literal('select_playlist'), playlistId: musicIdSchema });
const tracksAction = z.strictObject({
  action: z.literal('tracks'), playlistId: musicIdSchema.default(DEFAULT_NETEASE_PLAYLIST_ID),
  query: z.string().trim().max(200).default(''), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(100).default(35),
});
export const musicControlSchema = z.discriminatedUnion('action', [
  ...playbackActions(target),
  ...playlistLibraryActions, selectPlaylistAction,
]);
export const musicToolSchema = z.discriminatedUnion('action', [
  ...playbackActions(z.literal('inline').default('inline')),
  ...playlistLibraryActions, shareInputSchema, tracksAction,
]);
export const globalMusicToolSchema = z.discriminatedUnion('action', [
  ...playbackActions(z.literal('global').default('global')),
  selectPlaylistAction,
]);
const musicRendererControl = z.union([musicControlSchema, z.strictObject({ action: z.literal('present'), target: z.literal('inline'), card: musicShareSchema })]);
export type MusicControl = z.infer<typeof musicRendererControl>;
export type MusicExecution = MusicControl | z.infer<typeof tracksAction>;
export const musicCommandSchema = z.strictObject({ id: z.uuid(), conversationId: z.string().min(1).max(200), surface: z.enum(['chat', 'call']), control: musicRendererControl });
export type MusicCommand = z.infer<typeof musicCommandSchema>;
export const musicReplySchema = z.strictObject({ id: z.uuid(), ok: z.boolean(), value: z.record(z.string(), z.unknown()).optional(), error: z.string().max(1000).optional() });
export type MusicReply = z.infer<typeof musicReplySchema>;
export const musicRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preferences') }),
  z.object({ type: z.literal('save'), preferences: musicPreferencesSchema }),
  z.object({ type: z.literal('catalog'), playlistId: musicIdSchema, refresh: z.boolean().optional() }),
  z.object({ type: z.literal('stream'), playlistId: musicIdSchema, trackId: musicIdSchema }),
  z.object({ type: z.literal('lyrics'), playlistId: musicIdSchema, trackId: musicIdSchema }),
]);
export interface NeteasePlaylistTrack {
  readonly id: string; readonly name: string; readonly artists: readonly string[];
  readonly album: string; readonly coverUrl: string; readonly durationMs: number;
}
export interface NeteasePlaylistCatalog {
  readonly id: string; readonly name: string; readonly coverUrl: string;
  readonly trackCount: number; readonly tracks: readonly NeteasePlaylistTrack[];
  readonly stale?: boolean;
}
export interface NeteaseTrackStream { readonly trackId: string; readonly url: string }
export interface NeteaseLyricLine { readonly timeMs: number; readonly text: string; readonly translatedText?: string }
export interface NeteaseTrackLyrics { readonly trackId: string; readonly lines: readonly NeteaseLyricLine[] }
export interface WorldlineBoxMusicApi {
  preferences(): Promise<MusicPreferences>;
  savePreferences(value: MusicPreferences): void;
  catalog(playlistId: string, refresh?: boolean): Promise<NeteasePlaylistCatalog>;
  stream(playlistId: string, trackId: string): Promise<NeteaseTrackStream>;
  lyrics(playlistId: string, trackId: string): Promise<NeteaseTrackLyrics>;
  onCommand?(listener: (command: MusicCommand) => void): () => void;
  onCommandCancelled?(listener: (id: string) => void): () => void;
  reply?(reply: MusicReply): void;
  configureLyrics?(layout: MusicLyricsLayout): void;
}
export const musicCatalogSchema = z.object({
  id: musicIdSchema, name: z.string().max(1000), coverUrl: z.string().max(4096),
  trackCount: z.number().int().min(0).max(10000), stale: z.boolean().optional(),
  tracks: z.array(z.object({ id: musicIdSchema, name: z.string().max(1000),
    artists: z.array(z.string().max(1000)).max(100), album: z.string().max(1000),
    coverUrl: z.string().max(4096), durationMs: z.number().finite().min(0).max(604800000),
  })).max(10000),
});
