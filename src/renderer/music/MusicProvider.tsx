import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createMusicPreferenceStore, type MusicPreferenceStore } from './store';
import { NeteaseMusic } from './NeteaseMusic';
import type { WorldlineBoxMusicApi } from '../../shared/music';

const MusicSlotContext = createContext<((element: HTMLDivElement | null) => void) | null>(null);

export function MusicSettingsSlot() {
  const attach = useContext(MusicSlotContext);
  return <div className="music-settings-slot" ref={attach} data-music-settings-slot />;
}

export function MusicProvider({ children, api }: { children: ReactNode; api?: WorldlineBoxMusicApi }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [store, setStore] = useState<MusicPreferenceStore | null>(null);
  const [error, setError] = useState('');
  const attach = useCallback((element: HTMLDivElement | null) => setTarget(element), []);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.preferences().then(value => {
      if (!cancelled) setStore(createMusicPreferenceStore(value, next => api.savePreferences(next)));
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [api]);
  const callbacks = useMemo(() => ({
    loadCatalog: (id: string, signal: AbortSignal, refresh = false) => { signal.throwIfAborted(); return api!.catalog(id, refresh); },
    resolveStream: (id: string, track: string, signal: AbortSignal) => { signal.throwIfAborted(); return api!.stream(id, track); },
    loadLyrics: (id: string, track: string, signal: AbortSignal) => { signal.throwIfAborted(); return api!.lyrics(id, track); },
  }), [api]);
  return <MusicSlotContext.Provider value={attach}>
    {children}
    {store && api ? <NeteaseMusic {...callbacks} useStore={store.useStore} actions={store.actions} target={target} /> : null}
    {target && error ? createPortal(<p role="alert" className="music-initialization-error">音乐设置暂不可用：{error}</p>, target) : null}
  </MusicSlotContext.Provider>;
}
