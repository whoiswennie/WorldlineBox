import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_MUSIC_LYRICS_LAYOUT, MUSIC_LYRICS_LOCK_INSET, MUSIC_LYRICS_LOCK_SIZE, MUSIC_LYRICS_WINDOW, musicLyricsLayoutSchema, type MusicLyricsLayout, type NeteaseLyricLine } from '../../shared/music';
import { BotIcon } from '../companion-bot/BotIcon';

const layoutKey = 'worldlinebox.desktop-lyrics-layout.v1';

function readLayout(): MusicLyricsLayout {
  try {
    return musicLyricsLayoutSchema.parse(JSON.parse(localStorage.getItem(layoutKey) ?? 'null'));
  } catch { return DEFAULT_MUSIC_LYRICS_LAYOUT; }
}

export function useFloatingLyrics(configure?: (layout: MusicLyricsLayout) => void) {
  const popup = useRef<Window | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState(readLayout);
  useEffect(() => () => { popup.current?.close(); }, []);
  useEffect(() => {
    if (!target) return;
    configure?.(layout);
    try { localStorage.setItem(layoutKey, JSON.stringify(layout)); } catch { /* The overlay can still be used in this session. */ }
  }, [configure, layout, target]);
  const show = (visible: boolean) => {
    if (!visible) { popup.current?.close(); popup.current = null; setTarget(null); return; }
    if (popup.current && !popup.current.closed) return;
    const child = window.open('about:blank', MUSIC_LYRICS_WINDOW);
    if (!child) throw Error('暂时无法打开桌面歌词。');
    popup.current = child;
    const doc = child.document;
    doc.documentElement.lang = 'zh-CN';
    doc.title = 'WorldlineBox · 桌面歌词';
    const style = doc.createElement('style');
    style.textContent = `
      html,body,#lyrics { width:100%; height:100%; margin:0; }
      body { font-family:"Segoe UI","Microsoft YaHei UI",sans-serif; color:#fff; background:transparent; }
      .card { box-sizing:border-box; height:100%; display:grid; place-items:center; padding:26px 32px 8px;
        text-align:center; position:relative; overflow:hidden; user-select:none; -webkit-app-region:drag; }
      .card[data-locked] { -webkit-app-region:no-drag; }
      .card[data-orientation=vertical] { padding:38px 10px 12px; }
      .captions { min-width:0; max-width:100%; max-height:100%; overflow:hidden;
        text-shadow:0 1px 2px #000,0 0 5px #000b; }
      .captions b,.captions small { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2;
        overflow:hidden; overflow-wrap:anywhere; paint-order:stroke fill; -webkit-text-stroke:1.5px #151920c7; }
      .captions b { font-size:var(--lyric-font); line-height:1.25; font-weight:700; }
      .captions small { margin-top:3px; color:#e1ebff; font-size:calc(var(--lyric-font) * .63); line-height:1.3; }
      [data-orientation=vertical] .captions { writing-mode:vertical-rl; text-orientation:mixed; }
      [data-orientation=vertical] .captions small { margin:0 5px 0 0; }
      button { -webkit-app-region:no-drag; display:grid; place-items:center; box-sizing:border-box; border:0;
        border-radius:7px; background:transparent; color:#fff; padding:0; cursor:pointer; font:inherit; }
      button:hover,button:focus-visible { outline:1px solid #fff; }
      button svg { width:17px; height:17px; filter:drop-shadow(0 0 2px #000) drop-shadow(0 1px 1px #000); }
      .lock { position:absolute; right:${MUSIC_LYRICS_LOCK_INSET}px; top:${MUSIC_LYRICS_LOCK_INSET}px;
        width:${MUSIC_LYRICS_LOCK_SIZE}px; height:${MUSIC_LYRICS_LOCK_SIZE}px; }
      .editing { position:absolute; left:7px; top:8px; display:flex; align-items:center; gap:2px; }
      .editing button { width:23px; height:28px; }
      .editing button:disabled { opacity:.45; }
    `;
    const root = doc.createElement('div');
    root.id = 'lyrics';
    doc.head.append(style);
    doc.body.replaceChildren(root);
    child.addEventListener('pagehide', () => {
      if (popup.current === child) { popup.current = null; setTarget(null); }
    }, { once: true });
    setTarget(root);
  };
  return { target, show, layout, setLayout };
}

export function FloatingLyrics({ target, line, fallback, close, layout, change }: {
  target: HTMLElement; line?: NeteaseLyricLine; fallback: string; close(): void;
  layout: MusicLyricsLayout; change(layout: MusicLyricsLayout): void;
}) {
  const lockLabel = layout.locked ? '解锁桌面歌词' : '锁定桌面歌词';
  const rotateLabel = layout.orientation === 'horizontal' ? '切换竖排' : '切换横排';
  const resize = (delta: number) => change({ ...layout, fontSize: Math.max(16, Math.min(40, layout.fontSize + delta)) });
  return createPortal(<div className="card" data-orientation={layout.orientation} data-locked={layout.locked || undefined}>
    <div className="captions" style={{ '--lyric-font': `${layout.fontSize}px` } as React.CSSProperties}>
      <b>{line?.text ?? fallback}</b>
      {line?.translatedText && <small>{line.translatedText}</small>}
    </div>
    <button className="lock" type="button" title={lockLabel} aria-label={lockLabel} onClick={() => change({ ...layout, locked: !layout.locked })}>
      <BotIcon name={layout.locked ? 'lock' : 'unlock'} />
    </button>
    {!layout.locked && <div className="editing" role="group" aria-label="桌面歌词布局">
      <button type="button" title={rotateLabel} aria-label={rotateLabel} onClick={() => change({ ...layout, orientation: layout.orientation === 'horizontal' ? 'vertical' : 'horizontal' })}><BotIcon name="rotate-layout" /></button>
      <button type="button" title="缩小歌词" aria-label="缩小歌词" disabled={layout.fontSize === 16} onClick={() => resize(-2)}><BotIcon name="minus" /></button>
      <button type="button" title="放大歌词" aria-label="放大歌词" disabled={layout.fontSize === 40} onClick={() => resize(2)}><BotIcon name="plus" /></button>
      <button type="button" title="关闭桌面歌词" aria-label="关闭桌面歌词" onClick={close}><BotIcon name="close" /></button>
    </div>}
  </div>, target);
}
