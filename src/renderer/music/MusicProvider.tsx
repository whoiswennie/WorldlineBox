import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createMusicPreferenceStore, freshMusicPreferences, type MusicPreferenceStore } from './store';
import { createMusicEndpoint, type MusicEndpoint } from './music-endpoint';
import './NeteaseMusic.module.css';
const NeteaseMusic = lazy(() => import('./NeteaseMusic').then(module => ({ default: module.NeteaseMusic })));
import { savedNeteasePlaylists, type MusicControl, type MusicShare, type WorldlineBoxMusicApi } from '../../shared/music';

const MusicSlotContext = createContext<((element: HTMLDivElement | null) => void) | null>(null);
type MusicSurface = 'chat' | 'call';
type InlineSurface = {
  cards: Map<string, HTMLDivElement>;
  changed: EventTarget;
  lifetime: AbortController;
  reveal?: () => void;
};
type InlineSession = {
  key: string;
  surface: InlineSurface;
  cardId: string;
  target: HTMLDivElement | null;
  endpoint: MusicEndpoint;
  store: MusicPreferenceStore;
  lifetime: AbortController;
};
const InlineMusicContext = createContext<{
  registerSurface(key: string, reveal?: () => void): () => void;
  registerCard(key: string, id: string, target: HTMLDivElement): () => void;
  play(key: string, card: MusicShare): Promise<unknown>;
} | null>(null);

function surfaceKey(conversationId: string, surface: MusicSurface) { return surface + ':' + conversationId; }

export function useInlineMusicSurface(conversationId: string, surface: MusicSurface, enabled: boolean, reveal?: () => void) {
  const register = useContext(InlineMusicContext)?.registerSurface;
  // Register before the message cards' layout effects, including on the initial view.
  useLayoutEffect(() => {
    if (enabled && conversationId) return register?.(surfaceKey(conversationId, surface), reveal);
  }, [register, conversationId, surface, enabled, reveal]);
}

export function useInlineMusicCard(conversationId: string, surface: MusicSurface, id: string, enabled: boolean) {
  const context = useContext(InlineMusicContext);
  const key = surfaceKey(conversationId, surface);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const register = context?.registerCard;
  useEffect(() => {
    if (enabled && target) return register?.(key, id, target);
  }, [register, key, id, target, enabled]);
  return { targetRef: setTarget, play: context && enabled ? (card: MusicShare) => context.play(key, card) : undefined };
}

function waitForMusicCard(surface: InlineSurface, cardId: string, signal: AbortSignal): Promise<HTMLDivElement> {
  const ready = AbortSignal.any([signal, surface.lifetime.signal, AbortSignal.timeout(5000)]);
  ready.throwIfAborted();
  const target = surface.cards.get(cardId);
  if (target) return Promise.resolve(target);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ready.removeEventListener('abort', abort);
      surface.changed.removeEventListener('card', check);
    };
    const abort = () => { cleanup(); reject(Error('当前对话里暂未显示这条音乐消息。')); };
    const check = () => {
      const element = surface.cards.get(cardId);
      if (element) { cleanup(); resolve(element); }
    };
    ready.addEventListener('abort', abort, { once: true });
    surface.changed.addEventListener('card', check);
  });
}

function useMusicSources(api?: WorldlineBoxMusicApi) {
  return useMemo(() => ({
    loadCatalog: (id: string, signal: AbortSignal, refresh = false) => { signal.throwIfAborted(); return api!.catalog(id, refresh); },
    resolveStream: (id: string, track: string, signal: AbortSignal) => { signal.throwIfAborted(); return api!.stream(id, track); },
    loadLyrics: (id: string, track: string, signal: AbortSignal) => { signal.throwIfAborted(); return api!.lyrics(id, track); },
  }), [api]);
}

export function MusicSettingsSlot() {
  const attach = useContext(MusicSlotContext);
  return <div className="music-settings-slot" ref={attach} data-music-settings-slot />;
}

export function MusicProvider({ children, api }: { children: ReactNode; api?: WorldlineBoxMusicApi }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [store, setStore] = useState<MusicPreferenceStore | null>(null);
  const [error, setError] = useState('');
  const [activated, setActivated] = useState(false);
  const [endpoint] = useState(createMusicEndpoint);
  const [surfaces] = useState(() => new Map<string, InlineSurface>());
  const [session, setSession] = useState<InlineSession>();
  const activeInline = useRef<InlineSession | undefined>(undefined);
  const sequence = useRef(0);
  const globalStore = useRef(store);
  useLayoutEffect(() => { globalStore.current = store; }, [store]);
  if (target && !activated) setActivated(true);
  const attach = useCallback((element: HTMLDivElement | null) => setTarget(element), []);
  const closeInline = useCallback(() => {
    activeInline.current?.lifetime.abort(new DOMException('对话卡片播放器已关闭。', 'AbortError'));
    activeInline.current = undefined;
    setSession(undefined);
  }, []);
  const registerSurface = useCallback((key: string, reveal?: () => void) => {
    const surface: InlineSurface = { cards: new Map(), changed: new EventTarget(), lifetime: new AbortController(), reveal };
    surfaces.set(key, surface);
    return () => {
      if (surfaces.get(key) === surface) surfaces.delete(key);
      surface.lifetime.abort(new DOMException('已离开这个对话或会面。', 'AbortError'));
      if (activeInline.current?.surface === surface) closeInline();
    };
  }, [surfaces, closeInline]);
  const registerCard = useCallback((key: string, id: string, element: HTMLDivElement) => {
    const surface = surfaces.get(key);
    if (!surface) return () => {};
    const syncTarget = (target: HTMLDivElement | null) => {
      const current = activeInline.current;
      if (current?.surface === surface && current.cardId === id && current.target !== target) {
        const updated = { ...current, target };
        activeInline.current = updated;
        setSession(updated);
      }
    };
    surface.cards.set(id, element);
    syncTarget(element);
    surface.changed.dispatchEvent(new Event('card'));
    return () => {
      if (surface.cards.get(id) === element) {
        surface.cards.delete(id);
        syncTarget(null);
      }
    };
  }, [surfaces]);
  const runInline = useCallback(async (key: string, control: MusicControl, signal: AbortSignal) => {
    const surface = surfaces.get(key);
    if (!surface) throw Error('请先打开这个对话或会面，再播放音乐消息。');
    if (control.action === 'present') {
      const request = ++sequence.current;
      const element = await waitForMusicCard(surface, control.card.id, signal);
      signal.throwIfAborted();
      surface.lifetime.signal.throwIfAborted();
      if (request !== sequence.current) throw Error('已切换到另一条音乐消息。');
      const current = activeInline.current;
      if (current?.surface === surface && current.cardId === control.card.id) return current.endpoint.run(control, AbortSignal.any([signal, current.lifetime.signal]));
      const saved = globalStore.current?.snapshot();
      const initial = freshMusicPreferences();
      if (saved) initial.volume = saved.volume;
      const next: InlineSession = { key: key + ':' + control.card.id, surface, cardId: control.card.id, target: element,
        endpoint: createMusicEndpoint(), store: createMusicPreferenceStore(initial, () => undefined), lifetime: new AbortController() };
      current?.lifetime.abort(new DOMException('已切换到另一张音乐卡片。', 'AbortError'));
      activeInline.current = next;
      surface.reveal?.();
      setSession(next);
      try {
        return await next.endpoint.run(control, AbortSignal.any([signal, next.lifetime.signal]));
      } catch (error) {
        if (activeInline.current?.lifetime === next.lifetime) closeInline();
        throw error;
      }
    }
    const current = activeInline.current;
    if (control.action === 'status' && (current?.surface !== surface || !current.target)) {
      return { playing: false, loading: false };
    }
    if (current?.surface !== surface || !current.target) throw Error('请先在消息中播放一首歌或一个歌单。');
    return current.endpoint.run(control, AbortSignal.any([signal, current.lifetime.signal]));
  }, [surfaces, closeInline]);
  const playShared = useCallback((key: string, card: MusicShare) =>
    runInline(key, { action: 'present', target: 'inline', card }, AbortSignal.timeout(75_000)), [runInline]);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.preferences().then(value => {
      if (!cancelled) {
        setStore(createMusicPreferenceStore(value, next => api.savePreferences(next)));
        if (value.autoPlay) setActivated(true);
      }
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [api]);
  const callbacks = useMusicSources(api);
  useEffect(() => {
    if (!api?.onCommand) return;
    const pending = new Map<string, AbortController>();
    const unsubscribeCancel = api.onCommandCancelled?.(id => pending.get(id)?.abort());
    const unsubscribe = api.onCommand(command => {
      const controller = new AbortController();
      const { signal } = controller;
      pending.set(command.id, controller);
      const run = async () => {
        const { control } = command;
        if ('target' in control && control.target === 'inline') {
          const key = surfaceKey(command.conversationId, command.surface);
          const alternate = surfaceKey(command.conversationId, command.surface === 'call' ? 'chat' : 'call');
          return runInline(!surfaces.has(key) && surfaces.has(alternate) ? alternate : key, control, signal);
        }
        if (control.action === 'playlists' || control.action === 'status' && !endpoint.isReady()) {
          const preferences = globalStore.current?.snapshot() ?? await api.preferences();
          signal.throwIfAborted();
          const playlists = savedNeteasePlaylists(preferences);
          if (control.action === 'playlists') return { activePlaylistId: preferences.playlistId, playlists };
          return { playlistId: preferences.playlistId, playlistName: playlists.find(item => item.id === preferences.playlistId)?.name,
            trackId: preferences.trackId, positionSeconds: preferences.positionSeconds, playing: false, loading: false,
            volume: preferences.volume, mode: preferences.playbackMode, lyricsVisible: false };
        }
        if (control.action === 'status') return endpoint.run(control, signal);
        setActivated(true);
        return endpoint.run(control, signal);
      };
      void run().then(value => {
        if (!signal.aborted) api.reply?.({ id: command.id, ok: true, value });
      }, cause => {
        if (!signal.aborted) api.reply?.({ id: command.id, ok: false, error: String(cause instanceof Error ? cause.message : cause).slice(0, 1000) });
      }).finally(() => pending.delete(command.id));
    });
    return () => { unsubscribe(); unsubscribeCancel?.(); for (const controller of pending.values()) controller.abort(); };
  }, [api, endpoint, runInline, surfaces]);
  const inline = useMemo(() => api ? { registerSurface, registerCard, play: playShared } : null, [api, registerSurface, registerCard, playShared]);
  return <MusicSlotContext.Provider value={attach}>
    <InlineMusicContext.Provider value={inline}>{children}</InlineMusicContext.Provider>
    {session && api && <Suspense fallback={null}><NeteaseMusic key={session.key} {...callbacks}
      useStore={session.store.useStore} actions={session.store.actions} endpoint={session.endpoint}
      target={session.target} inline onClose={closeInline} /></Suspense>}
    {store && api && activated ? <Suspense fallback={null}><NeteaseMusic {...callbacks} useStore={store.useStore} actions={store.actions} endpoint={endpoint} target={target} configureLyrics={api.configureLyrics} /></Suspense> : null}
    {target && error ? createPortal(<p role="alert" className="music-initialization-error">音乐设置暂不可用：{error}</p>, target) : null}
  </MusicSlotContext.Provider>;
}
