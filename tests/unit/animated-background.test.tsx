// @vitest-environment happy-dom
import { act, createElement, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnimatedBackground, ThemeBackground } from '../../src/renderer/theme/AnimatedBackground';
import { ApplicationShell } from '../../src/renderer/ApplicationShell';
import { LocaleProvider } from '../../src/renderer/i18n';
import { ThemeProvider, useTheme } from '../../src/renderer/theme/ThemeProvider';
import { BACKGROUND_PREFERENCES_KEY } from '../../src/renderer/theme/background-preferences';
import { THEME_PROFILE_PREF_KEY } from '../../src/renderer/theme/theme-profiles';
import { loadBackgroundMotion, saveBackgroundMotion } from '../../src/renderer/theme/animated-background-preferences';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('animated wallpaper lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let pause: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    play = vi.fn(() => Promise.resolve());
    pause = vi.fn(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    localStorage.clear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete document.documentElement.dataset.animatedBackground;
    vi.restoreAllMocks();
  });

  async function render(playing = true, active = true) {
    await act(async () => root.render(createElement(AnimatedBackground, {
      src: '/original.mp4', poster: '/cover.jpg', playing, active,
    })));
    return container.querySelector('video')!;
  }

  it('loops silently, pauses while hidden and resumes when visible', async () => {
    const video = await render();
    expect(play).toHaveBeenCalled();
    expect(video.loop).toBe(true);
    expect(video.muted).toBe(true);
    play.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pause).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(play).toHaveBeenCalled();
  });

  it('restores the source after React StrictMode replays effect cleanup', async () => {
    await act(async () => root.render(createElement(StrictMode, {}, createElement(AnimatedBackground, {
      src: '/original.mp4', poster: '/cover.jpg',
    }))));
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/original.mp4');
    expect(play).toHaveBeenCalled();
  });

  it('pauses on native loss of focus even when Chromium reports visible', async () => {
    let listener: ((focused: boolean) => void) | undefined;
    const unsubscribe = vi.fn();
    const renderer = window as Window & { worldlinebox?: unknown };
    renderer.worldlinebox = { shell: { onWindowFocusChanged: (callback: (focused: boolean) => void) => {
      listener = callback;
      return unsubscribe;
    } } };
    try {
      await render();
      listener?.(true);
      expect(play).toHaveBeenCalled();
      play.mockClear();
      listener?.(false);
      expect(document.visibilityState).toBe('visible');
      expect(pause).toHaveBeenCalled();
      expect(play).not.toHaveBeenCalled();
      listener?.(true);
      expect(play).toHaveBeenCalled();
      await act(async () => root.unmount());
      expect(unsubscribe).toHaveBeenCalled();
    } finally {
      delete renderer.worldlinebox;
    }
  });

  it('shows the poster when switched off or when decoding fails', async () => {
    let video = await render();
    await act(async () => video.dispatchEvent(new Event('loadeddata')));
    expect(video.dataset.ready).toBe('true');
    video = await render(false);
    expect(video.dataset.ready).toBe('false');
    video = await render(true);
    await act(async () => video.dispatchEvent(new Event('error')));
    expect(video.dataset.ready).toBe('false');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/cover.jpg');
  });

  it('unloads an inactive module and releases the media on unmount', async () => {
    const video = await render(true, false);
    expect(video.hasAttribute('src')).toBe(false);
    expect(play).not.toHaveBeenCalled();
    await render();
    await act(async () => root.unmount());
    expect(video.hasAttribute('src')).toBe(false);
    expect(pause).toHaveBeenCalled();
  });

  it('does not load video when reduced motion is requested', async () => {
    const query = new EventTarget();
    Object.assign(query, { matches: true });
    vi.spyOn(window, 'matchMedia').mockReturnValue(query as MediaQueryList);
    const video = await render();
    expect(video.hasAttribute('src')).toBe(false);
    expect(play).not.toHaveBeenCalled();
    Object.assign(query, { matches: false });
    await act(async () => query.dispatchEvent(new Event('change')));
    expect(video.getAttribute('src')).toBe('/original.mp4');
    expect(play).toHaveBeenCalled();
  });

  it('preserves a personal wallpaper instead of playing the theme video', async () => {
    localStorage.setItem(THEME_PROFILE_PREF_KEY, JSON.stringify({ version: 3, preset: 'whale-fantasy', overrides: {} }));
    localStorage.setItem(BACKGROUND_PREFERENCES_KEY, JSON.stringify({ version: 3, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', imageSource: null, mode: 'cover', imageOpacity: 0.8 }));
    await act(async () => root.render(createElement(ThemeProvider, { children: createElement(ThemeBackground) })));
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.app-theme-background')?.getAttribute('data-wallpaper')).toBe('image');
    expect(document.documentElement.dataset.animatedBackground).toBeUndefined();
  });

  it('hides and restores the animated wallpaper through the shared background switch', async () => {
    localStorage.setItem(THEME_PROFILE_PREF_KEY, JSON.stringify({ version: 3, preset: 'whale-fantasy', overrides: {} }));
    function Fixture() {
      const { backgroundPreferences, setBackgroundPreferences } = useTheme();
      return <>
        <ThemeBackground />
        <button onClick={() => setBackgroundPreferences({ ...backgroundPreferences, enabled: !backgroundPreferences.enabled })}>Toggle wallpaper</button>
      </>;
    }
    await act(async () => root.render(<ThemeProvider><Fixture /></ThemeProvider>));
    expect(container.querySelector('video')).not.toBeNull();
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.app-theme-background')?.hasAttribute('data-wallpaper')).toBe(false);
    expect(document.documentElement.dataset.animatedBackground).toBeUndefined();
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('video')).not.toBeNull();
    expect(document.documentElement.dataset.animatedBackground).toBe('whale-fantasy');
  });

  it('keeps a disabled personal wallpaper stored without exposing the theme video', async () => {
    localStorage.setItem(THEME_PROFILE_PREF_KEY, JSON.stringify({ version: 3, preset: 'whale-fantasy', overrides: {} }));
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    localStorage.setItem(BACKGROUND_PREFERENCES_KEY, JSON.stringify({ version: 3, imageDataUrl, imageSource: null, mode: 'cover', imageOpacity: 0.8, enabled: false }));
    await act(async () => root.render(<ThemeProvider><ThemeBackground /></ThemeProvider>));
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.app-theme-background')?.hasAttribute('data-wallpaper')).toBe(false);
    expect(JSON.parse(localStorage.getItem(BACKGROUND_PREFERENCES_KEY)!).imageDataUrl).toBe(imageDataUrl);
    expect(document.documentElement.getAttribute('data-bg-image')).toBeNull();
  });

  it('keeps one global video and its playback position through module switching', async () => {
    localStorage.setItem(THEME_PROFILE_PREF_KEY, JSON.stringify({ version: 3, preset: 'whale-fantasy', overrides: {} }));
    function Fixture() {
      const [activeModuleId, setActiveModuleId] = useState('launcher');
      return <div className="application-root">
        <ThemeBackground />
        <ApplicationShell
          activeModuleId={activeModuleId}
          modules={[
            { id: 'launcher', label: 'Launcher', icon: 'box', content: <p>Launcher</p> },
            { id: 'assets', label: 'Assets', icon: 'grid', content: <p>Assets</p> },
          ]}
          onOpenSettings={() => undefined}
          onSelectModule={setActiveModuleId}
        />
      </div>;
    }
    await act(async () => root.render(<LocaleProvider><ThemeProvider><Fixture /></ThemeProvider></LocaleProvider>));
    const video = container.querySelector('video')!;
    const wallpaper = container.querySelector('.app-theme-background')!;
    const source = video.getAttribute('src');
    video.currentTime = 12;
    await act(async () => video.dispatchEvent(new Event('loadeddata')));
    const pauseCount = pause.mock.calls.length;
    const loadCount = vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length;

    for (const module of ['assets', 'launcher', 'assets']) {
      await act(async () => container.querySelector<HTMLButtonElement>(`[data-application-module="${module}"]`)!.click());
      expect(container.querySelectorAll('video')).toHaveLength(1);
      expect(container.querySelector('video')).toBe(video);
      expect(container.querySelector('.app-theme-background')).toBe(wallpaper);
      expect(video.getAttribute('src')).toBe(source);
      expect(video.currentTime).toBe(12);
      expect(video.dataset.ready).toBe('true');
    }
    expect(pause).toHaveBeenCalledTimes(pauseCount);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(loadCount);
  });

  it('persists motion independently and survives malformed/blocked storage', () => {
    expect(loadBackgroundMotion()).toBe(true);
    expect(saveBackgroundMotion(false)).toBe(true);
    expect(loadBackgroundMotion()).toBe(false);
    const storage = { getItem: () => '{bad json', setItem: () => { throw new Error('unavailable'); }, removeItem: () => undefined };
    expect(loadBackgroundMotion(storage)).toBe(true);
    expect(saveBackgroundMotion(true, storage)).toBe(false);
  });
});
