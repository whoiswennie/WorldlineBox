import { z } from 'zod';

export const MUSIC_CHANNEL = 'worldlinebox:music';
export const MUSIC_SAVE_CHANNEL = 'worldlinebox:music-save';
export const DEFAULT_NETEASE_PLAYLIST_ID = '18322613388';
export const DEFAULT_NETEASE_PLAYLIST_NAME = '默认';
export const musicIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);
export const playbackModeSchema = z.enum(['list', 'single', 'shuffle']);
export type PlaybackMode = z.infer<typeof playbackModeSchema>;
const positionSchema = z.object({ trackId: musicIdSchema.optional(), positionSeconds: z.number().finite().min(0).max(604800).default(0) });
export const musicPreferencesSchema = positionSchema.extend({
  autoPlay: z.boolean().default(false), volume: z.number().finite().min(0).max(1).default(0.8),
  playbackMode: playbackModeSchema.default('list'),
  playlistId: musicIdSchema.default(DEFAULT_NETEASE_PLAYLIST_ID),
  playlists: z.array(z.object({ id: musicIdSchema, name: z.string().trim().min(1).max(40) })).max(100).default([]),
  positions: z.record(musicIdSchema, positionSchema).default({}),
});
export type MusicPreferences = z.infer<typeof musicPreferencesSchema>;
export type SavedNeteasePlaylist = MusicPreferences['playlists'][number];
export const DEFAULT_MUSIC_PREFERENCES = musicPreferencesSchema.parse({});
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
}
export const musicCatalogSchema = z.object({
  id: musicIdSchema, name: z.string().max(1000), coverUrl: z.string().max(4096),
  trackCount: z.number().int().min(0).max(10000), stale: z.boolean().optional(),
  tracks: z.array(z.object({ id: musicIdSchema, name: z.string().max(1000),
    artists: z.array(z.string().max(1000)).max(100), album: z.string().max(1000),
    coverUrl: z.string().max(4096), durationMs: z.number().finite().min(0).max(604800000),
  })).max(10000),
});
