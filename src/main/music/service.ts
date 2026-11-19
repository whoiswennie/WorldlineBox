import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ipcMain, net, type BrowserWindow } from 'electron';
import { atomicJson } from '../dsh/files';
import { fetchNeteasePlaylistCatalog, fetchNeteaseTrackLyrics, resolveNeteaseTrackStream } from './netease';
import { configureDesktopLyricsWindow } from './lyrics-window';
import { MUSIC_CHANNEL, MUSIC_SAVE_CHANNEL, MUSIC_CONTROL_CHANNEL, MUSIC_CONTROL_RESULT_CHANNEL, MUSIC_CONTROL_CANCEL_CHANNEL, MUSIC_LYRICS_LAYOUT_CHANNEL, DEFAULT_MUSIC_PREFERENCES, DEFAULT_NETEASE_PLAYLIST_ID, DEFAULT_NETEASE_PLAYLIST_NAME, musicReplySchema, musicLyricsLayoutSchema, musicPreferencesSchema, musicRequestSchema, musicCatalogSchema, musicShareSchema, loadMusicQueue, type MusicCommand, type MusicReply, type MusicPreferences, type MusicExecution, type MusicShareInput, type NeteasePlaylistCatalog, type NeteaseTrackLyrics } from '../../shared/music';

export class MusicService {
  private writes = Promise.resolve();
  private readonly catalogs = new Map<string, { expires: number; value: Promise<NeteasePlaylistCatalog> }>();
  private readonly lyricCache = new Map<string, { expires: number; value: Promise<NeteaseTrackLyrics> }>();
  private readonly controls = new Map<string, (reply: MusicReply) => void>();
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
  private catalogFile(id: string): string {
    return path.join(this.userData, 'music-catalogs', `${id}.json`);
  }
  private async savedCatalog(id: string): Promise<NeteasePlaylistCatalog | undefined> {
    try {
      const saved = musicCatalogSchema.parse(JSON.parse(await readFile(this.catalogFile(id), 'utf8')));
      if (saved.id === id) return saved;
    } catch { /* A local catalog may not have been fetched yet. */ }
    return undefined;
  }
  async catalog(id: string, refresh = false): Promise<NeteasePlaylistCatalog> {
    const cached = this.catalogs.get(id);
    if (!refresh && cached && cached.expires > Date.now()) return cached.value;
    const value = this.network(async () => {
      try {
        const catalog = musicCatalogSchema.parse(await fetchNeteasePlaylistCatalog(id, publicFetch, AbortSignal.timeout(60_000)));
        await atomicJson(this.catalogFile(id), catalog); return catalog;
      } catch (error) {
        const saved = await this.savedCatalog(id);
        if (saved) return { ...saved, stale: true };
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
  async prepareShare(id: string, input: MusicShareInput, signal: AbortSignal) {
    const queue = await loadMusicQueue(input.queue, playlistId => this.catalog(playlistId), signal);
    if (!queue.tracks.length) throw Error('这个歌单没有歌曲。');
    return musicShareSchema.parse({ id, queue: input.queue, mode: input.mode,
      title: (input.title ?? (input.queue.kind === 'tracks' && queue.tracks.length > 1 ? '音乐选集' : queue.name)).trim().slice(0, 100) || '分享的音乐',
      trackCount: queue.tracks.length, preview: queue.tracks.slice(0, 3).map(track => track.name.slice(0, 200)) });
  }
  async companionControl(scope: Pick<MusicCommand, 'conversationId' | 'surface'>, input: MusicExecution, signal: AbortSignal, assertAllowed: () => void) {
    assertAllowed(); signal.throwIfAborted();
    if (input.action === 'tracks') {
      const catalog = await this.catalog(input.playlistId);
      signal.throwIfAborted(); assertAllowed();
      const query = input.query.toLocaleLowerCase();
      const matches = catalog.tracks.filter(track => !query || [track.name, ...track.artists, track.album].some(value => value.toLocaleLowerCase().includes(query)));
      const tracks = matches.slice(input.offset, input.offset + input.limit).map(({ id, name, artists, album, durationMs }) => ({ id, name, artists, album, durationMs }));
      return { playlistId: catalog.id, name: catalog.id === DEFAULT_NETEASE_PLAYLIST_ID ? DEFAULT_NETEASE_PLAYLIST_NAME : catalog.name,
        total: matches.length, trackCount: catalog.tracks.length, stale: !!catalog.stale, tracks,
        nextOffset: input.offset + tracks.length < matches.length ? input.offset + tracks.length : null };
    }
    if (input.action === 'save_playlist') {
      if (input.playlist.id === DEFAULT_NETEASE_PLAYLIST_ID) throw Error('内置歌单不可修改。');
      await this.catalog(input.playlist.id);
    }
    if (input.action === 'remove_playlist' && input.playlistId === DEFAULT_NETEASE_PLAYLIST_ID) throw Error('内置歌单不可删除。');
    signal.throwIfAborted(); assertAllowed();
    const owner = this.window();
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) throw Error('音乐播放器尚未打开。');
    if (this.controls.size >= 12) throw Error('音乐播放器正在处理操作，请稍后重试。');
    const command: MusicCommand = { id: randomUUID(), ...scope, control: input };
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); this.controls.delete(command.id);
        signal.removeEventListener('abort', abort);
      };
      const failure = (error: unknown) => { cleanup(); reject(error); };
      const cancel = (error: unknown) => {
        try {
          if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(MUSIC_CONTROL_CANCEL_CHANNEL, command.id);
        } finally { failure(error); }
      };
      const abort = () => cancel(signal.reason);
      const timer = setTimeout(() => cancel(Error('音乐播放器响应超时。')), 75_000);
      signal.addEventListener('abort', abort, { once: true });
      this.controls.set(command.id, reply => {
        cleanup();
        if (reply.ok) resolve(reply.value ?? {}); else reject(Error(reply.error ?? '音乐播放器操作失败。'));
      });
      try { owner.webContents.send(MUSIC_CONTROL_CHANNEL, command); } catch (error) { failure(error); }
    });
    if (input.action !== 'status' || input.target !== 'global' || result.trackCount !== undefined) return result;
    const playlist = musicRequestSchema.safeParse({ type: 'catalog', playlistId: result.playlistId });
    if (!playlist.success || playlist.data.type !== 'catalog') return result;
    const cached = await this.savedCatalog(playlist.data.playlistId);
    signal.throwIfAborted(); assertAllowed();
    const track = cached?.tracks.find(item => item.id === result.trackId);
    return { ...result, playlistName: result.playlistName ?? cached?.name, trackCount: cached?.trackCount,
      trackName: result.trackName ?? track?.name, artists: result.artists ?? track?.artists,
      durationSeconds: result.durationSeconds || (track ? track.durationMs / 1000 : undefined) };
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
    ipcMain.on(MUSIC_CONTROL_RESULT_CHANNEL, (event, input: unknown) => {
      if (!authorized(event)) return;
      const parsed = musicReplySchema.safeParse(input);
      if (parsed.success) this.controls.get(parsed.data.id)?.(parsed.data);
    });
    ipcMain.on(MUSIC_LYRICS_LAYOUT_CHANNEL, (event, input: unknown) => {
      const owner = this.window();
      if (!owner || !authorized(event)) return;
      const parsed = musicLyricsLayoutSchema.safeParse(input);
      if (parsed.success) configureDesktopLyricsWindow(owner, parsed.data);
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
