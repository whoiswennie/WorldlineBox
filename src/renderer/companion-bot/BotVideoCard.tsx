import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import type { WorldlineBoxBotApi } from '../../shared/companion-bot';
import { BROWSER_PARTITION, videoPageUrl, videoPlayerUrl, type VideoShare } from '../../shared/bilibili';
import { BotIcon } from './BotIcon';
import './bot-video.css';

// Only a live publication or a click creates a playback request. Mounting a
// transcript is passive, including remounts of the card that last played.
export function useVideoSurface(api: WorldlineBoxBotApi | undefined, room: string, surface: 'chat'|'call', enabled: boolean, reveal?: () => void, autoPlay = true) {
  const [active, setActive] = useState('');
  const mounted = useRef(new Map<string,string>());
  const pending = useRef('');
  const play = useCallback((id: string) => {
    const instance = mounted.current.get(id);
    pending.current = instance ? '' : id;
    setActive(instance ?? '');
  }, []);
  const stop = useCallback(() => { pending.current = ''; setActive(''); }, []);
  const register = useCallback((id: string, instance: string, attached: boolean) => {
    if (attached) {
      mounted.current.set(id,instance);
      if (pending.current === id) play(id);
    } else if (mounted.current.get(id) === instance) mounted.current.delete(id);
  }, [play]);
  useLayoutEffect(() => {
    if (!enabled || !api || !autoPlay) return stop;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onEvent(event => {
      if (event.type !== 'video-present' || event.surface !== surface || event.conversationId !== room || document.hidden) return;
      reveal?.();
      play(event.cardId);
      clearTimeout(timer);
      timer = setTimeout(() => { if (pending.current === event.cardId) stop(); }, 5000);
    });
    return () => { clearTimeout(timer); off(); stop(); };
  }, [api,room,surface,enabled,play,stop,reveal,autoPlay]);
  return {active: enabled ? active : '', play, stop, register, enabled};
}
export type VideoSurface = ReturnType<typeof useVideoSurface>;

export function BotVideoCard({card, zh, playback, openUrl}: {card:VideoShare; zh:boolean; playback?:VideoSurface; openUrl:(url:string)=>void}) {
  const [error,setError] = useState('');
  const instance = useId();
  const player = useRef<Electron.WebviewTag>(null);
  const inline = playback?.active === instance;
  const register = playback?.register;
  const attach = useCallback((node: HTMLElement | null) => register?.(card.id,instance,!!node), [register,card.id,instance]);
  const stop = playback?.stop;
  useEffect(() => {
    const node = player.current;
    if (!inline || !node) return;
    const failed = (event: Event) => {
      const failure = event as Event & {isMainFrame?:boolean;errorCode?:number};
      if (failure.isMainFrame === false || failure.errorCode === -3) return;
      stop?.();
      setError(zh ? '播放器加载失败，可以重试或打开原页。' : 'Player unavailable. Try again or open the video page.');
    };
    node.addEventListener('did-fail-load',failed);
    node.addEventListener('render-process-gone',failed);
    return () => { node.removeEventListener('did-fail-load',failed); node.removeEventListener('render-process-gone',failed); };
  }, [inline,stop,zh]);
  const enterFullscreen = async () => {
    const guest = player.current;
    if (!guest) return;
    setError('');
    try {
      guest.focus();
      // Let Bilibili own the fullscreen transition so its control and Esc can exit it.
      const clicked = await guest.executeJavaScript(`(() => {
        const button = document.querySelector('.bpx-player-ctrl-full, [role="button"][aria-label="全屏"]');
        if (!button) return false;
        button.click();
        return true;
      })()`, true);
      if (!clicked && player.current === guest) setError(zh ? '播放器的全屏控件尚未就绪，请稍后再试。' : 'The player’s fullscreen control is not ready yet. Try again shortly.');
    } catch {
      if (player.current === guest) setError(zh ? '无法进入视频全屏，请稍后重试或打开原页。' : 'Fullscreen unavailable. Try again or open the video page.');
    }
  };
  const original = () => { if (inline) stop?.(); openUrl(videoPageUrl(card)); };
  return <section ref={attach} className="bot-video-card" data-video-card={card.id} aria-label={card.title}>
    {inline ? <div className="bot-video-frame"><webview ref={player} partition={BROWSER_PARTITION} src={videoPlayerUrl(card)} title={card.title} /></div> :
      <button type="button" className="bot-video-preview" aria-label={(zh ? '播放 ' : 'Play ') + card.title} onClick={() => {
        if (playback?.enabled) { setError(''); playback.play(card.id); }
        else original();
      }}>
        {card.cover && <img src={card.cover} loading="lazy" referrerPolicy="no-referrer" alt="" />}
        <span><BotIcon name="play" /></span>
      </button>}
    <div className="bot-video-caption"><strong>{card.title}</strong>
      <div className="bot-video-actions">
        {card.mid ? <button type="button" onClick={() => { if (inline) stop?.(); openUrl('https://space.bilibili.com/' + card.mid); }}>{card.author}</button> : <small>哔哩哔哩</small>}
        <div>{inline && <><button type="button" onClick={() => void enterFullscreen()}>{zh ? '全屏' : 'Fullscreen'}</button>
          <button type="button" onClick={stop}>{zh ? '收起' : 'Close player'}</button></>}
          <button type="button" onClick={original}>{zh ? '打开原页' : 'Open on Bilibili'}</button></div>
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  </section>;
}
