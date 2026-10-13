import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { WorldlineBoxShellApi } from '../../shared/external-url';

import { DSH_BACKGROUND_MEDIA, isAnimatedTheme } from './dsh-background-media';
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

/** A decorative, silent video layer with an independent still-image fallback. */
function AnimatedBackgroundSurface({ src, poster, playing = true, active = true, fit = 'cover' }: AnimatedBackgroundProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
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
    const video = videoRef.current;
    // Restore the source when StrictMode replays effect setup after cleanup.
    if (video && active && !reducedMotion) video.src = src;
    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [active, reducedMotion, src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const shell = (window as Window & { worldlinebox?: { shell?: Pick<WorldlineBoxShellApi, 'onWindowFocusChanged'> } }).worldlinebox?.shell;
    let focused = shell ? document.hasFocus() : true;
    const synchronize = () => {
      if (active && playing && !reducedMotion && !failed && focused && document.visibilityState === 'visible') {
        video.muted = true;
        void video.play().catch(() => {
          // Autoplay may be blocked by the host; the poster stays available.
        });
      } else {
        video.pause();
      }
    };
    const onFocus = () => { focused = true; synchronize(); };
    const onBlur = () => { focused = false; synchronize(); };
    // Chromium may remain "visible" in a minimized, unthrottled Electron window.
    // Use the existing native focus bridge as well as web visibility events.
    const unsubscribeFocus = shell?.onWindowFocusChanged((value) => { focused = value; synchronize(); });
    synchronize();
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', synchronize);
    video.addEventListener('canplay', synchronize);
    return () => {
      document.removeEventListener('visibilitychange', synchronize);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      unsubscribeFocus?.();
      video.removeEventListener('canplay', synchronize);
      video.pause();
    };
  }, [active, failed, playing, reducedMotion, src]);

  return (
    <div aria-hidden="true" className="app-animated-background" style={{ '--animated-background-fit': fit } as CSSProperties}>
      <img alt="" className="app-animated-background-poster" src={poster} />
      <video
        className="app-animated-background-video"
        data-ready={ready && !failed && !reducedMotion && active && playing}
        disablePictureInPicture
        loop
        muted
        onError={() => setFailed(true)}
        onLoadedData={() => setReady(true)}
        playsInline
        poster={poster}
        preload={active && playing && !reducedMotion ? 'auto' : 'none'}
        ref={videoRef}
        src={reducedMotion || !active ? undefined : src}
      />
      <div className="app-animated-background-scrim" />
    </div>
  );
}

export function AnimatedBackground(props: AnimatedBackgroundProps) {
  return <AnimatedBackgroundSurface key={props.src} {...props} />;
}

/** One application-owned layer; render outside module Activity boundaries. */
export function ThemeBackground() {
  const { themeProfile, backgroundPreferences, backgroundMotion } = useTheme();
  // Personal wallpaper is also drawn here, rather than independently per module.
  // Module selection never changes this layer or the current media source.
  const media = backgroundPreferences.imageDataUrl === null && isAnimatedTheme(themeProfile.preset)
    ? DSH_BACKGROUND_MEDIA[themeProfile.preset]
    : null;
  const wallpaper = media ? 'animated' : backgroundPreferences.imageDataUrl !== null ? 'image' : undefined;
  return (
    <div aria-hidden="true" className="app-theme-background" data-wallpaper={wallpaper}>
      {media && (
        <AnimatedBackground
          fit={backgroundPreferences.mode === 'fill' ? 'fill' : 'cover'}
          key={themeProfile.preset}
          playing={backgroundMotion}
          poster={media.poster}
          src={media.video}
        />
      )}
    </div>
  );
}
