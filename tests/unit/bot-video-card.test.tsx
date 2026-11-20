// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { BotEvent, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { BILIBILI_LOGIN_URL } from '../../src/shared/bilibili';
import { BotVideoCard, useVideoSurface } from '../../src/renderer/companion-bot/BotVideoCard';
import { VideoLoginDialog } from '../../src/renderer/companion-bot/VideoLoginDialog';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true});
it('plays a live publication once and keeps remounted, restored and background cards silent', () => {
  let send: ((event:BotEvent)=>void) | undefined;
  const api = {onEvent(listener: typeof send) {send=listener; return () => {send=undefined;};}} as WorldlineBoxBotApi;
  function Transcript({show,enabled}:{show:boolean;enabled:boolean}) {
    const playback = useVideoSurface(api,'room','chat',enabled);
    return show && <BotVideoCard card={{id:'card',videoId:'BV1B7411m7LV',page:1,title:'作品'}} zh playback={playback} openUrl={()=>undefined} />;
  }
  const host = document.createElement('div'), root = createRoot(host);
  const render = (show:boolean,enabled=true) => act(() => root.render(<Transcript show={show} enabled={enabled} />));
  const present = () => act(() => send?.({type:'video-present',cardId:'card',surface:'chat',conversationId:'room'}));
  try {
    render(true);
    expect(host.querySelector('webview')).toBeNull();
    render(false); present(); render(true);
    expect(host.querySelector('webview')?.getAttribute('partition')).toBe('persist:worldlinebox-browser');
    render(false); render(true);
    expect(host.querySelector('webview')).toBeNull();
    act(() => host.querySelector('button')!.click());
    expect(host.querySelector('webview')).toBeTruthy();
    render(true,false); present(); render(true);
    expect(host.querySelector('webview')).toBeNull();
  } finally { act(() => root.unmount()); }
});

it('offers the official login page in the browser, and lets a guest skip it', () => {
  const host = document.createElement('div'), root = createRoot(host);
  document.body.append(host);
  const dismiss=vi.fn(), open=vi.fn();
  try {
    act(() => root.render(<VideoLoginDialog zh state="guest" dismiss={dismiss} openUrl={open} />));
    const dialog = host.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('同一账号');
    act(() => dialog.querySelector('button')!.click());
    expect(dismiss).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    act(() => dialog.querySelector<HTMLButtonElement>('button.is-primary')!.click());
    expect(open).toHaveBeenCalledWith(BILIBILI_LOGIN_URL);
  } finally { act(() => root.unmount()); host.remove(); }
});
