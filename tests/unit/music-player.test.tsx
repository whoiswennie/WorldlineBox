// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { NeteaseMusic } from '../../src/renderer/music/NeteaseMusic';
import { createMusicPreferenceStore, freshMusicPreferences } from '../../src/renderer/music/store';
import { parseNeteaseLyrics, parseNeteaseWordLyrics, fetchNeteasePlaylistCatalog, resolveNeteaseTrackStream } from '../../src/main/music/netease';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(content: ReactNode) {
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  act(() => { root.render(content); });
  return { rerender: (next: ReactNode) => act(() => root.render(next)), unmount: () => { act(() => root.unmount()); element.remove(); } };
}
function button(name: string) {
  const result = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === name || item.textContent === name);
  if (!result) throw new Error(`Missing music control ${name}`); return result;
}
const fireEvent = {
  click: (element: HTMLElement) => act(() => element.click()),
  loadedMetadata: (element: HTMLElement) => act(() => element.dispatchEvent(new Event('loadedmetadata'))),
  ended: (element: HTMLElement) => act(() => element.dispatchEvent(new Event('ended'))),
};
const waitFor = vi.waitFor;

describe('persistent settings music player', () => {
  it('defaults paused and restores independent progress for saved playlists', () => {
    const store = createMusicPreferenceStore(freshMusicPreferences(), vi.fn());
    expect(store.snapshot().autoPlay).toBe(false);
    expect(store.snapshot().playlistId).toBe('18322613388');
    store.actions.selectTrack('101'); store.actions.rememberProgress('101', 41);
    store.actions.savePlaylist('另一个歌单', '202');
    store.actions.selectTrack('303'); store.actions.rememberProgress('303', 9);
    store.actions.restoreDefaultPlaylist();
    expect(store.snapshot()).toMatchObject({ trackId: '101', positionSeconds: 41 });
    store.actions.rememberProgress('303', 0);
    expect(store.snapshot().positionSeconds).toBe(41);
    store.actions.selectPlaylist('202');
    expect(store.snapshot()).toMatchObject({ trackId: '303', positionSeconds: 9 });
    store.actions.removePlaylist('202');
    expect(store.snapshot()).toMatchObject({ playlistId: '18322613388', trackId: '101', positionSeconds: 41 });
  });
  it('keeps one audio element and source while controls detach and reattach', async () => {
    let paused = true;
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) { paused = true; this.dispatchEvent(new Event('pause')); });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) { paused = false; this.dispatchEvent(new Event('play')); });
    const saved = { ...freshMusicPreferences(), trackId: '101', positionSeconds: 33, volume: 0.35 };
    const store = createMusicPreferenceStore(saved, vi.fn());
    const catalog = { id: saved.playlistId, name: '测试歌单', coverUrl: '', trackCount: 2, tracks: ['101','102'].map(id => ({ id, name: `歌曲 ${id}`, artists: ['测试艺术家'], album: '', coverUrl: '', durationMs: 180000 })) };
    const props = { useStore: store.useStore, actions: store.actions, loadCatalog: vi.fn(async () => catalog), resolveStream: vi.fn(async (_id: string, trackId: string) => ({ trackId, url: `https://test.music.126.net/${trackId}.mp3` })), loadLyrics: vi.fn(async (_id: string, trackId: string) => ({ trackId, lines: [{ timeMs: 10000, text: '十秒歌词' }] })) };
    const target = document.createElement('div'); document.body.append(target);
    const view = render(<NeteaseMusic {...props} target={target} />);
    const audio = document.querySelector('[data-global-music-audio]') as HTMLAudioElement;
    Object.defineProperty(audio, 'paused', { get: () => paused });
    Object.defineProperty(audio, 'duration', { get: () => 180 });
    await waitFor(() => expect(audio.src).toContain('101.mp3'));
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(33); expect(audio.volume).toBe(0.35); expect(paused).toBe(true);
    fireEvent.click(button('播放'));
    await waitFor(() => expect(paused).toBe(false));
    view.rerender(<NeteaseMusic {...props} target={null} />);
    expect(document.querySelector('[data-global-music-audio]')).toBe(audio);
    expect(paused).toBe(false);
    view.rerender(<NeteaseMusic {...props} target={target} />);
    expect(document.querySelector('[data-global-music-audio]')).toBe(audio);
    expect(props.resolveStream).toHaveBeenCalledTimes(1);
    fireEvent.click(button('打开滚动歌词'));
    fireEvent.click(button('十秒歌词'));
    expect(audio.currentTime).toBe(10); expect(store.snapshot().positionSeconds).toBe(10);
    act(() => { store.actions.setPlaybackMode('single'); });
    fireEvent.ended(audio);
    expect(audio.currentTime).toBe(0);
    view.unmount(); target.remove(); vi.restoreAllMocks();
  });
  it('parses multiple LRC timestamps, offsets, translations and YRC fallback', () => {
    expect(parseNeteaseLyrics('[offset:250]\n[00:01.5][00:03.00]Hello | 你好')).toEqual([{ timeMs: 1750, text: 'Hello', translatedText: '你好' }, { timeMs: 3250, text: 'Hello', translatedText: '你好' }]);
    expect(parseNeteaseWordLyrics('[1200,800](1200,400,0)Hello(1600,400,0) world')).toEqual([{ timeMs: 1200, text: 'Hello world' }]);
  });
  it('fetches every ordered playlist ID and rejects streams outside the official CDN', async () => {
    const fetcher = vi.fn(async (input: string | URL) => new Response(JSON.stringify(String(input).includes('playlist/detail')
      ? { code: 200, playlist: { id: '18322613388', name: '公开歌单', trackIds: [{id:'102'},{id:'101'}] } }
      : { code: 200, songs: [{id:'101',name:'第一首',dt:1000},{id:'102',name:'第二首',dt:2000}] })));
    const catalog = await fetchNeteasePlaylistCatalog(undefined, fetcher);
    expect(catalog.tracks.map(track => track.id)).toEqual(['102','101']);
    await expect(resolveNeteaseTrackStream('101', async () => new Response(null, {status:302,headers:{location:'https://evil.example/audio'}}))).rejects.toThrow('不受信任');
    await expect(resolveNeteaseTrackStream('101', async () => new Response(null, {status:302,headers:{location:'http://m10.music.126.net/free.mp3'}}))).resolves.toEqual({trackId:'101',url:'https://m10.music.126.net/free.mp3'});
  });
});
