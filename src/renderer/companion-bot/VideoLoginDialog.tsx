import { useEffect, useId, useRef } from 'react';
import { BILIBILI_LOGIN_URL, type BilibiliLoginState } from '../../shared/bilibili';

export function VideoLoginDialog({state, zh, dismiss, openUrl}: {
  state: Exclude<BilibiliLoginState,'signed-in'>; zh:boolean; dismiss():void; openUrl(url:string):void;
}) {
  const ref = useRef<HTMLDialogElement>(null), title = useId(), description = useId();
  useEffect(() => {
    const node = ref.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return <dialog ref={ref} className="bot-video-login" aria-labelledby={title} aria-describedby={description}
    onCancel={event => { event.preventDefault(); dismiss(); }}>
    <h3 id={title}>{state === 'guest' ? (zh ? '尚未登录哔哩哔哩' : 'Sign in to Bilibili') : (zh ? '暂时无法确认哔哩哔哩登录状态' : 'Couldn’t check your Bilibili sign-in')}</h3>
    <p id={description}>{zh ? '在内置浏览器登录后，回到对话即可用同一账号观看视频。会员内容和清晰度取决于你的账号权益。也可以先跳过，观看公开内容。' : 'Sign in in the built-in browser, then return to this chat. Video cards use the same account for playback, quality and membership access. You can also skip this step and watch public videos.'}</p>
    <footer><button type="button" onClick={dismiss}>{zh ? '暂时跳过' : 'Skip for now'}</button>
      <button type="button" className="is-primary" onClick={() => { dismiss(); openUrl(BILIBILI_LOGIN_URL); }}>{zh ? '前往内置浏览器登录' : 'Sign in in the built-in browser'}</button></footer>
  </dialog>;
}
