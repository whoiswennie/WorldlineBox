import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ipcMain, net, type BrowserWindow } from 'electron';
import { atomicJson } from '../dsh/files';
import { fetchNeteasePlaylistCatalog, fetchNeteaseTrackLyrics, resolveNeteaseTrackStream } from './netease';
import { MUSIC_CHANNEL, MUSIC_SAVE_CHANNEL, DEFAULT_MUSIC_PREFERENCES, musicPreferencesSchema, musicRequestSchema, musicCatalogSchema, type MusicPreferences, type NeteasePlaylistCatalog, type NeteaseTrackLyrics } from '../../shared/music';

export class MusicService {
  private writes = Promise.resolve();
  private readonly catalogs = new Map<string, { expires: number; value: Promise<NeteasePlaylistCatalog> }>();
  private readonly lyricCache = new Map<string, { expires: number; value: Promise<NeteaseTrackLyrics> }>();
  private active = 0;
  constructor(private readonly userData: string, private readonly window: () => BrowserWindow | null,
    private readonly report: (error: unknown) => void) {}
  async preferences(): Promise<MusicPreferences> {
    await this.writes;
    try { return musicPreferencesSchema.parse(JSON.parse(await readFile(path.join(this.userData, 'music-player.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(error);
      return structuredClone(DEFAULT_MUSIC_PREFERENCES);
    }
  }
  save(value: unknown): Promise<void> {
    const preferences = musicPreferencesSchema.parse(value);
    // Bound old progress bookmarks to saved playlists; no arbitrary file/path input crosses IPC.
    const ids = new Set([preferences.playlistId, ...preferences.playlists.map(item => item.id), DEFAULT_MUSIC_PREFERENCES.playlistId]);
    preferences.positions = Object.fromEntries(Object.entries(preferences.positions).filter(([id]) => ids.has(id)));
    this.writes = this.writes.catch(() => undefined).then(() => atomicJson(path.join(this.userData, 'music-player.json'), preferences));
    return this.writes;
  }
  async catalog(id: string, refresh = false): Promise<NeteasePlaylistCatalog> {
    const cached = this.catalogs.get(id);
    if (!refresh && cached && cached.expires > Date.now()) return cached.value;
    const file = path.join(this.userData, 'music-catalogs', `${id}.json`);
    const value = this.network(async () => {
      try {
        const catalog = musicCatalogSchema.parse(await fetchNeteasePlaylistCatalog(id, publicFetch, AbortSignal.timeout(60_000)));
        await atomicJson(file, catalog); return catalog;
      } catch (error) {
        try {
          const saved = musicCatalogSchema.parse(JSON.parse(await readFile(file, 'utf8')));
          if (saved.id === id && Array.isArray(saved.tracks) && saved.tracks.length <= 10000) return { ...saved, stale: true };
        } catch { /* Offline cache is optional. */ }
        throw error;
      }
    });
    this.catalogs.set(id, { expires: Date.now() + 300_000, value });
    this.trim(this.catalogs, 16);
    try { return await value; } catch (error) { if (this.catalogs.get(id)?.value === value) this.catalogs.delete(id); throw error; }
  }
  private async network<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 6) throw new Error('音乐请求正在处理中，请稍后重试');
    this.active++; try { return await work(); } finally { this.active--; }
  }
  private trim<T>(map: Map<string, T>, max: number) { while (map.size > max) map.delete(map.keys().next().value!); }
  async track(playlistId: string, trackId: string, kind: 'stream' | 'lyrics') {
    const catalog = await this.catalog(playlistId);
    if (!catalog.tracks.some(track => track.id === trackId)) throw new Error('歌曲不属于当前歌单');
    if (kind === 'stream') return this.network(() => resolveNeteaseTrackStream(trackId, publicFetch, AbortSignal.timeout(25_000)));
    const cached = this.lyricCache.get(trackId);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = this.network(() => fetchNeteaseTrackLyrics(trackId, publicFetch, AbortSignal.timeout(25_000)));
    this.lyricCache.set(trackId, { expires: Date.now() + 1800_000, value }); this.trim(this.lyricCache, 100);
    try { return await value; } catch (error) { this.lyricCache.delete(trackId); throw error; }
  }
  registerIpc() {
    const authorized = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
      const window = this.window(); return !!window && !window.isDestroyed()
        && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
    };
    ipcMain.on(MUSIC_SAVE_CHANNEL, (event, input: unknown) => {
      if (!authorized(event)) return;
      void this.save(input).catch(this.report);
    });
    ipcMain.handle(MUSIC_CHANNEL, async (event, input: unknown) => {
      if (!authorized(event)) return { ok: false, error: 'Unauthorized music sender.' };
      const parsed = musicRequestSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Invalid music request.' };
      try {
        const request = parsed.data;
        if (request.type === 'preferences') return { ok: true, value: await this.preferences() };
        if (request.type === 'save') { await this.save(request.preferences); return { ok: true }; }
        if (request.type === 'catalog') return { ok: true, value: await this.catalog(request.playlistId, request.refresh) };
        return { ok: true, value: await this.track(request.playlistId, request.trackId, request.type) };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
  }
  flush(): Promise<void> { return this.writes; }
}
const publicFetch = (input: string | URL, init?: RequestInit): Promise<Response> => init?.redirect === 'manual'
  ? publicRedirect(String(input), init) : net.fetch(String(input), { ...init, credentials: 'omit' });

/** Electron fetch rejects some manual redirects. Capture only the redirect headers,
 * then abort without following or downloading the media; the resolver verifies the CDN. */
function publicRedirect(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'manual', useSessionCookies: false });
    let finished = false;
    const finish = (response?: Response, error?: unknown) => {
      if (finished) return; finished = true;
      init.signal?.removeEventListener('abort', abort); request.abort();
      if (response) resolve(response); else reject(error);
    };
    const abort = () => finish(undefined, init.signal?.reason ?? new Error('Music request cancelled.'));
    request.on('redirect', (status, _method, target) => finish(new Response(null, { status, headers: { location: target } })));
    request.on('response', response => finish(new Response(null, { status: response.statusCode })));
    request.on('error', error => finish(undefined, error));
    for (const [key, value] of new Headers(init.headers)) request.setHeader(key, value);
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort(); else request.end();
  });
}
