import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildCallCaptionPages, callCaptionPageAt } from './call-caption-pages';

/** The current spoken page stays small; original Markdown remains in chat history. */
export function BotCallCaption({ text, revealedText, waiting, speaking, locale, onOpenFull, forceFull = false }: {
  text: string; revealedText?: string; waiting?: string; speaking: boolean; locale: 'zh-CN' | 'en'; onOpenFull(): void; forceFull?: boolean;
}) {
  const zh = locale === 'zh-CN', viewport = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(76), [selectedPage, setSelectedPage] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width, font = parseFloat(getComputedStyle(element).fontSize);
      if (width > 0 && font > 0) setCapacity(Math.max(24, Math.floor(width / font * 1.9)));
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const pages = useMemo(() => buildCallCaptionPages(text, capacity), [text, capacity]);
  const revealed = Math.max(0, Math.min(text.length, revealedText?.length ?? text.length));
  const following = callCaptionPageAt(pages, revealed), pageIndex = Math.max(0, Math.min(selectedPage ?? following, following));
  const page = pages[pageIndex], content = page ? page.text.slice(0, Math.max(0, revealed - page.start)) : '';
  const manual = selectedPage !== null;
  return <div className="bot-message-bubble bot-call-caption">
    <div ref={viewport} className="bot-message-text bot-call-caption-text" data-caption-page={pageIndex + 1} data-caption-pages={pages.length}>
      {waiting ? <p className="bot-call-pending" role="status">{waiting}</p> : <p>{content || (zh ? '…' : '…')}</p>}
    </div>
    {(pages.length > 1 || forceFull) && !waiting && <nav className="bot-call-caption-controls" aria-label={zh ? '回应分页' : 'Reply pages'}>
      {pages.length > 1 && <><button type="button" aria-label={zh ? '上一段回应' : 'Previous reply page'} disabled={pageIndex === 0} onClick={() => setSelectedPage(pageIndex - 1)}>‹</button><span>{pageIndex + 1} / {pages.length}</span><button type="button" aria-label={zh ? '下一段回应' : 'Next reply page'} disabled={pageIndex >= following} onClick={() => setSelectedPage(pageIndex + 1)}>›</button></>}
      {manual && speaking && <button type="button" className="bot-call-caption-follow" onClick={() => setSelectedPage(null)}>{zh ? '跟随语音' : 'Follow speech'}</button>}
      <button type="button" className="bot-call-caption-full" onClick={onOpenFull}>{zh ? '查看完整回复' : 'View full reply'}</button>
    </nav>}
  </div>;
}
