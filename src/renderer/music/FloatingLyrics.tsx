import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_MUSIC_LYRICS_LAYOUT, MUSIC_LYRICS_CAPTION_METRICS, MUSIC_LYRICS_LOCK_INSET, MUSIC_LYRICS_LOCK_SIZE, MUSIC_LYRICS_WINDOW, musicLyricsLayoutSchema, type MusicLyricsLayout, type MusicLyricsWindowConfig } from '../../shared/music';
import { BotIcon } from '../companion-bot/BotIcon';

const layoutKey = 'worldlinebox.desktop-lyrics-layout.v1';

function readLayout(): MusicLyricsLayout {
  try {
    return musicLyricsLayoutSchema.parse(JSON.parse(localStorage.getItem(layoutKey) ?? 'null'));
  } catch { return DEFAULT_MUSIC_LYRICS_LAYOUT; }
}

const chineseScript = /[\p{Script=Han}\p{Script=Bopomofo}]/u;
const kanaOrHangul = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const eastAsianRun = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3099-\u309aー]+)/u;

function captionProps(text: string, vertical: boolean) {
  if (!vertical) return { children: text };
  if (!chineseScript.test(text)) return { 'data-sideways': true, children: text };
  if (!kanaOrHangul.test(text)) return { children: text };

  // Kanji adjacent to kana belongs to the same Japanese run. Separate Han-only fragments stay upright.
  const runs = text.split(eastAsianRun);
  if (runs.every(run => !chineseScript.test(run) || kanaOrHangul.test(run))) {
    return { 'data-sideways': true, children: text };
  }
  return { children: runs.map((run, index) => kanaOrHangul.test(run)
    ? <span key={index} data-sideways>{run}</span> : run) };
}

export function useFloatingLyrics({ restore, rememberVisibility, reportError, configure }: {
  restore: boolean;
  rememberVisibility(visible: boolean): void;
  reportError(error: unknown): void;
  configure?(config: MusicLyricsWindowConfig): void;
}) {
  const popup = useRef<Window | null>(null);
  const pendingRestore = useRef(restore);
  const captions = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState(readLayout);
  const { orientation, locked, fontSize } = layout;
  useEffect(() => () => {
    const child = popup.current;
    popup.current = null;
    child?.close();
  }, []);
  useEffect(() => {
    if (!target) return;
    try { localStorage.setItem(layoutKey, JSON.stringify(layout)); } catch { /* The overlay can still be used in this session. */ }
  }, [layout, target]);
  useEffect(() => {
    const content = captions.current;
    const viewport = content?.parentElement;
    if (!target || !content || !viewport) return;
    const vertical = orientation === 'vertical';
    let lastExtent = 0;
    const measure = () => {
      const bounds = content.getBoundingClientRect();
      const captionExtent = Math.ceil(vertical ? bounds.width : bounds.height);
      if (captionExtent > 0 && captionExtent !== lastExtent) {
        lastExtent = captionExtent;
        configure?.({ orientation, locked, fontSize, captionExtent });
      }
      viewport.toggleAttribute('data-scrollable', vertical
        ? viewport.scrollWidth > viewport.clientWidth
        : viewport.scrollHeight > viewport.clientHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(viewport);
    measure();
    const scrollColumns = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaX || !event.deltaY || !viewport.hasAttribute('data-scrollable')) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? fontSize
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientWidth : 1;
      viewport.scrollBy(-event.deltaY * unit, 0);
    };
    if (vertical) viewport.addEventListener('wheel', scrollColumns, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('wheel', scrollColumns);
    };
  }, [configure, fontSize, locked, orientation, target]);
  const open = useCallback(() => {
    if (popup.current && !popup.current.closed) return;
    const child = window.open('about:blank', MUSIC_LYRICS_WINDOW);
    if (!child) throw Error('暂时无法打开桌面歌词。');
    popup.current = child;
    const doc = child.document;
    doc.documentElement.lang = 'zh-CN';
    doc.title = 'WorldlineBox · 桌面歌词';
    const style = doc.createElement('style');
    const { toolbarSpace, edgeSpace, lineHeight } = MUSIC_LYRICS_CAPTION_METRICS;
    style.textContent = `
      html,body,#lyrics { width:100%; height:100%; margin:0; }
      body { font-family:"Segoe UI","Microsoft YaHei UI",sans-serif; color:#fff; background:transparent; }
      .card { box-sizing:border-box; height:100%; display:grid; place-items:center;
        grid-template: minmax(0,1fr) / minmax(0,1fr); padding-top:${toolbarSpace}px;
        text-align:center; position:relative; overflow:hidden; user-select:none; -webkit-app-region:drag; }
      .card:not([data-locked]) { background:rgba(225,231,241,.28); border-radius:12px;
        box-shadow:inset 0 0 0 1px rgba(120,137,166,.6); }
      .card[data-locked] { -webkit-app-region:no-drag; }
      .card[data-orientation=vertical] { padding-bottom:${toolbarSpace}px; }
      .caption-viewport { max-width:100%; max-height:100%; overflow:auto;
        scrollbar-width:thin; scrollbar-color:#888a transparent; }
      .caption-viewport[data-scrollable] { -webkit-app-region:no-drag; }
      [data-orientation=vertical] .caption-viewport { writing-mode:vertical-rl; text-orientation:mixed; }
      .captions { padding:${edgeSpace}px; color:var(--lyric-fill);
        text-shadow:0 1px 2px #000,0 0 5px #000b; overflow-wrap:anywhere; }
      .captions b,.captions small { display:block; line-height:${lineHeight}; text-wrap:balance;
        paint-order:stroke fill; -webkit-text-stroke:1.5px var(--lyric-stroke); }
      .captions b { font-size:var(--lyric-font); font-weight:700; }
      .captions small { margin-block-start:4px; font-size:calc(var(--lyric-font) * .63); }
      [data-orientation=vertical] .captions { display:flex; flex-direction:column; align-items:center; }
      [data-orientation=vertical] .captions > * { max-inline-size:100%; text-align:start; text-wrap:wrap; }
      [data-orientation=vertical] .captions [data-sideways] { text-orientation:sideways; }
      button { -webkit-app-region:no-drag; display:grid; place-items:center; box-sizing:border-box; border:0;
        border-radius:7px; background:transparent; color:#fff; padding:0; cursor:pointer; font:inherit; }
      button:hover,button:focus-visible { outline:1px solid #fff; }
      button:disabled { opacity:.45; cursor:default; }
      button svg { width:17px; height:17px; filter:drop-shadow(0 0 2px #000) drop-shadow(0 1px 1px #000); }
      .lock { position:absolute; right:${MUSIC_LYRICS_LOCK_INSET}px; top:${MUSIC_LYRICS_LOCK_INSET}px;
        width:${MUSIC_LYRICS_LOCK_SIZE}px; height:${MUSIC_LYRICS_LOCK_SIZE}px; }
      .editing,.transport,.colors { position:absolute; top:${MUSIC_LYRICS_LOCK_INSET}px; display:flex; align-items:center; gap:2px; }
      .editing { left:7px; }
      .editing button { width:23px; height:28px; }
      .transport { left:50%; transform:translateX(-50%); }
      .transport button { width:28px; height:28px; }
      .colors { right:${MUSIC_LYRICS_LOCK_INSET + MUSIC_LYRICS_LOCK_SIZE + 6}px; }
      .color-picker { position:relative; width:23px; height:28px; display:grid; place-items:center;
        border-radius:7px; -webkit-app-region:no-drag; }
      .color-picker:hover,.color-picker:focus-within { outline:1px solid #fff; }
      .color-picker input { position:absolute; inset:0; width:100%; height:100%; padding:0; opacity:0; cursor:pointer; }
      .color-picker span { box-sizing:border-box; width:13px; height:13px; border-radius:50%;
        outline:1px solid #fff; box-shadow:0 1px 4px 1px #000; }
      .fill-swatch { background:var(--lyric-fill); }
      .stroke-swatch { border:3px solid var(--lyric-stroke); }
      [data-orientation=vertical] .transport,[data-orientation=vertical] .colors { top:auto; bottom:${MUSIC_LYRICS_LOCK_INSET}px; }
      [data-orientation=vertical] .transport { left:5px; transform:none; }
      [data-orientation=vertical] .colors { right:5px; }
    `;
    const root = doc.createElement('div');
    root.id = 'lyrics';
    doc.head.append(style);
    doc.body.replaceChildren(root);
    child.addEventListener('pagehide', () => {
      if (popup.current === child) { popup.current = null; setTarget(null); }
    }, { once: true });
    setTarget(root);
  }, []);
  const show = (visible: boolean) => {
    pendingRestore.current = false;
    if (visible) {
      open();
    } else {
      const child = popup.current;
      popup.current = null;
      child?.close();
      setTarget(null);
    }
    rememberVisibility(visible);
  };
  useEffect(() => {
    if (!pendingRestore.current) return;
    // Defer opening so Strict Mode can replay the initial effect before creating the native window.
    const timer = window.setTimeout(() => {
      if (!pendingRestore.current) return;
      pendingRestore.current = false;
      try { open(); } catch (error) { reportError(error); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, reportError]);
  return { target, show, layout, setLayout, captions };
}

export function FloatingLyrics({ target, text, translation, close, layout, captions, change, playing, canPlay, canSkip, togglePlayback, skip }: {
  target: HTMLElement; text: string; translation?: string; close(): void;
  layout: MusicLyricsLayout; captions: Ref<HTMLDivElement>;
  change(layout: MusicLyricsLayout): void;
  playing: boolean; canPlay: boolean; canSkip: boolean;
  togglePlayback(): void; skip(offset: -1 | 1): void;
}) {
  const lockLabel = layout.locked ? '解锁桌面歌词' : '锁定桌面歌词';
  const rotateLabel = layout.orientation === 'horizontal' ? '切换竖排' : '切换横排';
  const playbackLabel = playing ? '暂停' : '播放';
  const viewport = useRef<HTMLDivElement>(null);
  const vertical = layout.orientation === 'vertical';
  useLayoutEffect(() => { viewport.current?.scrollTo(0, 0); }, [text, translation, layout.orientation]);
  const resize = (delta: number) => change({ ...layout, fontSize: Math.max(16, Math.min(40, layout.fontSize + delta)) });
  const colors = { '--lyric-fill': layout.fillColor, '--lyric-stroke': layout.strokeColor } as CSSProperties;
  return createPortal(<div className="card" style={colors} data-orientation={layout.orientation} data-locked={layout.locked || undefined}>
    <div className="caption-viewport" ref={viewport}>
      <div className="captions" ref={captions} style={{ '--lyric-font': `${layout.fontSize}px` } as CSSProperties}>
        <b dir="auto" {...captionProps(text, vertical)} />
        {translation && <small dir="auto" {...captionProps(translation, vertical)} />}
      </div>
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
    {!layout.locked && <div className="transport" role="group" aria-label="桌面歌词播放控制">
      <button type="button" title="上一首" aria-label="上一首" disabled={!canSkip} onClick={() => skip(-1)}><BotIcon name="skip-back" /></button>
      <button type="button" title={playbackLabel} aria-label={playbackLabel} disabled={!canPlay} onClick={togglePlayback}><BotIcon name={playing ? 'pause' : 'play'} /></button>
      <button type="button" title="下一首" aria-label="下一首" disabled={!canSkip} onClick={() => skip(1)}><BotIcon name="skip-forward" /></button>
    </div>}
    {!layout.locked && <div className="colors" role="group" aria-label="桌面歌词颜色">
      <label className="color-picker" title="歌词描边颜色">
        <input type="color" aria-label="歌词描边颜色" value={layout.strokeColor}
          onChange={event => change({ ...layout, strokeColor: event.currentTarget.value })} />
        <span className="stroke-swatch" aria-hidden="true" />
      </label>
      <label className="color-picker" title="歌词填充颜色">
        <input type="color" aria-label="歌词填充颜色" value={layout.fillColor}
          onChange={event => change({ ...layout, fillColor: event.currentTarget.value })} />
        <span className="fill-swatch" aria-hidden="true" />
      </label>
    </div>}
  </div>, target);
}
