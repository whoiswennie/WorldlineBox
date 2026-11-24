import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { WorldlineBoxShellApi } from '../../shared/external-url';

import { DSH_BACKGROUND_MEDIA, isAnimatedTheme, type WallpaperClip } from './dsh-background-media';
import { useTheme } from './ThemeProvider';
import './animated-background.css';

export type AnimatedBackgroundProps = {
  readonly src: string;
  readonly poster: string;
  readonly playing?: boolean;
  /** Embedded previews may release decoding; the application wallpaper stays active. */
  readonly active?: boolean;
  readonly fit?: 'cover' | 'fill';
};

const PLAYBACK_CHECK_INTERVAL_MS = 1000;
const STALLED_PLAYBACK_CHECKS = 4;
const HEALTHY_PLAYBACK_CHECKS = 3;
const MAX_RECOVERY_RELOADS = 2;

/** One decoder with an independent still-image fallback. */
function AnimatedBackgroundSurface({ src, poster, playing = true, active = true, fit = 'cover', volume, muted, advance }: AnimatedBackgroundProps & { volume?: number; muted: boolean; advance?(failed: boolean): void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const nativeFocus = useRef<boolean | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume ?? 1;
  }, [volume]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !active || reducedMotion) return;
    // Pair source attachment with cleanup so StrictMode can replay both.
    video.src = src;
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [active, reducedMotion, src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const shell = (window as Window & { worldlinebox?: { shell?: Pick<WorldlineBoxShellApi, 'onWindowFocusChanged'> } }).worldlinebox?.shell;
    const canCheckFrames = typeof video.requestVideoFrameCallback === 'function';
    let domFocused = shell?.onWindowFocusChanged ? document.hasFocus() : true;
    let shouldPlay = false;
    let timer: number | undefined;
    let frameRequest: number | undefined;
    let framePresented = false;
    let lastTime = video.currentTime;
    let stalledChecks = 0;
    let healthyChecks = 0;
    let reloads = 0;
    let resumeAt: number | undefined;

    const playVideo = () => {
      void video.play().catch(() => {
        // The watchdog handles interrupted starts while playback is still requested.
      });
    };

    const requestFrame = () => {
      if (!canCheckFrames || frameRequest !== undefined) return;
      frameRequest = video.requestVideoFrameCallback(() => {
        frameRequest = undefined;
        framePresented = true;
      });
    };

    const clearFrameRequest = () => {
      if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest);
      frameRequest = undefined;
      framePresented = false;
    };

    const stopPlayback = () => {
      window.clearInterval(timer);
      timer = undefined;
      clearFrameRequest();
      video.pause();
    };

    const checkPlayback = () => {
      const time = video.currentTime;
      // The media clock can advance while Chromium is still showing the same frame.
      const progressed = canCheckFrames ? framePresented : time !== lastTime;
      lastTime = time;
      framePresented = false;
      requestFrame();
      if (!video.error && !video.paused && progressed) {
        stalledChecks = 0;
        if (reloads > 0 && ++healthyChecks >= HEALTHY_PLAYBACK_CHECKS) reloads = 0;
        return;
      }
      healthyChecks = 0;
      stalledChecks++;
      if (stalledChecks === 1 && video.paused && !video.error) playVideo();
      if (stalledChecks < STALLED_PLAYBACK_CHECKS) return;

      setReady(false);
      if (reloads >= MAX_RECOVERY_RELOADS) {
        stopPlayback();
        advance?.(true);
        return;
      }
      reloads++;
      stalledChecks = 0;
      resumeAt ??= time;
      clearFrameRequest();
      video.load();
      lastTime = video.currentTime;
      playVideo();
      requestFrame();
    };

    const restorePosition = () => {
      if (resumeAt === undefined) return;
      if (resumeAt > 0 && Number.isFinite(video.duration) && resumeAt < video.duration - 0.1) {
        video.currentTime = resumeAt;
      }
      resumeAt = undefined;
    };

    const synchronize = () => {
      const focused = nativeFocus.current ?? domFocused;
      const eligible = active && playing && !reducedMotion && focused && document.visibilityState === 'visible';
      if (eligible === shouldPlay) return;
      shouldPlay = eligible;
      if (!shouldPlay) {
        stopPlayback();
        return;
      }
      reloads = stalledChecks = healthyChecks = 0;
      lastTime = video.currentTime;
      playVideo();
      requestFrame();
      timer = window.setInterval(checkPlayback, PLAYBACK_CHECK_INTERVAL_MS);
    };

    const resumeIfPaused = () => {
      if (timer !== undefined && video.paused && !video.ended && !video.error) playVideo();
    };
    const onFocusChange = (event: FocusEvent) => { domFocused = event.type === 'focus'; synchronize(); };
    // DOM focus can move between WebContents inside a still-focused BrowserWindow.
    const unsubscribeFocus = shell?.onWindowFocusChanged?.((focused) => {
      nativeFocus.current = focused;
      synchronize();
    });
    synchronize();
    window.addEventListener('focus', onFocusChange);
    window.addEventListener('blur', onFocusChange);
    document.addEventListener('visibilitychange', synchronize);
    video.addEventListener('canplay', resumeIfPaused);
    video.addEventListener('pause', resumeIfPaused);
    video.addEventListener('loadedmetadata', restorePosition);
    return () => {
      document.removeEventListener('visibilitychange', synchronize);
      window.removeEventListener('focus', onFocusChange);
      window.removeEventListener('blur', onFocusChange);
      unsubscribeFocus?.();
      video.removeEventListener('canplay', resumeIfPaused);
      video.removeEventListener('pause', resumeIfPaused);
      video.removeEventListener('loadedmetadata', restorePosition);
      stopPlayback();
    };
  }, [active, playing, reducedMotion, advance]);

  return (
    <div aria-hidden="true" className="app-animated-background" style={{ '--animated-background-fit': fit } as CSSProperties}>
      <img alt="" className="app-animated-background-poster" src={poster} />
      <video
        className="app-animated-background-video"
        data-ready={ready && !reducedMotion && active && playing}
        disablePictureInPicture
        loop={!advance}
        muted={muted}
        onEmptied={() => setReady(false)}
        onError={() => setReady(false)}
        onEnded={advance ? () => advance(false) : undefined}
        onLoadedData={() => setReady(true)}
        onPlaying={() => setReady(true)}
        playsInline
        poster={poster}
        preload={active && playing && !reducedMotion ? 'auto' : 'none'}
        ref={videoRef}
      />
      <div className="app-animated-background-scrim" />
    </div>
  );
}

export function AnimatedBackground({ src, soundEnabled = true, ...props }: Omit<AnimatedBackgroundProps, 'src'> & { src: string | readonly [WallpaperClip, ...WallpaperClip[]]; soundEnabled?: boolean }) {
  const [index, setIndex] = useState(0);
  const failures = useRef(0);
  const count = typeof src === 'string' ? 1 : src.length;
  const advance = useCallback((failed: boolean) => {
    failures.current = failed ? failures.current + 1 : 0;
    // A playlist with no decodable clips stays on its poster after one pass.
    if (failures.current < count) setIndex(previous => (previous + 1) % count);
  }, [count]);
  const clip: WallpaperClip = typeof src === 'string' ? { src } : src[index % count]!;
  return <AnimatedBackgroundSurface key={clip.src} src={clip.src} volume={clip.volume} muted={!soundEnabled || clip.volume === undefined} advance={count > 1 ? advance : undefined} {...props} />;
}

/** One application-owned layer; render outside module Activity boundaries. */
export function ThemeBackground() {
  const { themeProfile, backgroundPreferences, backgroundMotion } = useTheme();
  // Personal wallpaper is also drawn here, rather than independently per module.
  // Module selection never changes this layer or the current media source.
  const media = backgroundPreferences.enabled && backgroundPreferences.imageDataUrl === null && isAnimatedTheme(themeProfile.preset)
    ? DSH_BACKGROUND_MEDIA[themeProfile.preset]
    : null;
  const wallpaper = media ? 'animated' : backgroundPreferences.enabled && backgroundPreferences.imageDataUrl !== null ? 'image' : undefined;
  return (
    <div aria-hidden="true" className="app-theme-background" data-wallpaper={wallpaper}>
      {media && (
        <AnimatedBackground
          fit={backgroundPreferences.mode === 'fill' ? 'fill' : 'cover'}
          key={themeProfile.preset}
          playing={backgroundMotion}
          poster={media.poster}
          src={media.clips}
          soundEnabled={backgroundPreferences.soundEnabled !== false}
        />
      )}
    </div>
  );
}
