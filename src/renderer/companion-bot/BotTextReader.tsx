import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { BotMediaTextPage } from '../../shared/companion-bot-media';
import { BrowserMarkdown } from '../browser/BrowserMarkdown';
import { BotIcon } from './BotIcon';
import { formatBotFileSize } from './media-presentation';
import './bot-text-reader.css';

interface Props {
  page?: BotMediaTextPage; loading: boolean; error?: string; locale: 'zh-CN' | 'en'; pageIndex: number;
  onPrevious(): void; onNext(): void; onRetry(): void; onOpenUrl(url: string): void;
}
const headingSelector = '.bot-attachment-document :is(h1,h2,h3,h4)';

/** Bounded, read-only document surface. The document owns its scroll container,
 * independently of the chat, outline, toolbar and byte-page navigation. */
export function BotTextReader({ page, loading, error, locale, pageIndex, onPrevious, onNext, onRetry, onOpenUrl }: Props) {
  const zh = locale === 'zh-CN', scroll = useRef<HTMLDivElement>(null), frame = useRef<number | undefined>(undefined);
  const [source, setSource] = useState(false), [fontSize, setFontSize] = useState(15);
  const [outlineOpen, setOutlineOpen] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  const [outline, setOutline] = useState<Array<{ title: string; level: number }>>([]), [active, setActive] = useState(0), [progress, setProgress] = useState(0);
  const positions = useRef(new Map<string, number>()), view = `${page?.offset ?? 0}:${source}`;
  const markdown = page?.format === 'markdown', showOutline = outlineOpen && markdown && !source && outline.length > 0;
  const updateScroll = () => {
    const node = scroll.current; if (!node) return;
    positions.current.set(view, node.scrollTop);
    const remaining = node.scrollHeight - node.clientHeight;
    setProgress(remaining > 0 ? Math.round(Math.min(1, node.scrollTop / remaining) * 100) : 100);
    const top = node.getBoundingClientRect().top + 64;
    const headings = [...node.querySelectorAll<HTMLElement>(headingSelector)];
    let current = 0; headings.forEach((heading, index) => { if (heading.getBoundingClientRect().top <= top) current = index; });
    setActive(current);
  };
  useLayoutEffect(() => {
    const node = scroll.current; if (!node) return;
    setOutline([...node.querySelectorAll<HTMLElement>(headingSelector)].map(heading => ({ title: heading.textContent ?? '', level: Number(heading.tagName.slice(1)) })));
    node.scrollTop = positions.current.get(view) ?? 0; updateScroll();
    return () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); };
    // A new byte page or display mode has its own reading position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.content, view, loading]);
  const jump = (index: number) => {
    const node = scroll.current, heading = node?.querySelectorAll<HTMLElement>(headingSelector)[index];
    if (!node || !heading) return;
    node.scrollTo({ top: heading.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop - 32, behavior: 'smooth' });
    setActive(index);
  };
  const segmented = markdown && !loading;
  const paged = pageIndex > 0 || page?.nextOffset !== undefined;
  const switchMode = (next: boolean) => {
    if (scroll.current) positions.current.set(view, scroll.current.scrollTop);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    setSource(next);
  };
  return <div className="bot-text-reader" style={{ '--reader-font-size': `${fontSize}px` } as CSSProperties}>
    <div className="bot-reader-toolbar">
      <div className="bot-reader-toolbar-start"><button type="button" className="bot-reader-outline-toggle" aria-label={zh ? '文档目录' : 'Document outline'} aria-expanded={showOutline} disabled={!markdown || source || !outline.length} onClick={() => setOutlineOpen(value => !value)}><BotIcon name="panel-collapse" /><span>{zh ? '目录' : 'Outline'}</span></button>
        {segmented && <nav className="bot-attachment-reading-tabs" aria-label={zh ? '文档显示方式' : 'Document display'}><button aria-pressed={!source} onClick={() => switchMode(false)}>{zh ? '阅读' : 'Read'}</button><button aria-pressed={source} onClick={() => switchMode(true)}>{zh ? '原文' : 'Source'}</button></nav>}</div>
      <div className="bot-reader-type-controls" aria-label={zh ? '阅读字号' : 'Reading font size'}><button type="button" aria-label={zh ? '缩小字号' : 'Decrease font size'} disabled={fontSize <= 12} onClick={() => setFontSize(value => value - 1)}>A−</button><span>{fontSize}</span><button type="button" aria-label={zh ? '放大字号' : 'Increase font size'} disabled={fontSize >= 22} onClick={() => setFontSize(value => value + 1)}>A+</button></div>
    </div>
    <div className={`bot-reader-layout${showOutline ? ' has-outline' : ''}`}>
      {showOutline && <aside className="bot-reader-outline"><div>{zh ? '本文目录' : 'ON THIS PAGE'}<small>{outline.length}</small></div><nav aria-label={zh ? '文档章节' : 'Document sections'}>{outline.map((item, index) => <button type="button" key={index} title={item.title} aria-current={active === index ? 'location' : undefined} style={{ '--heading-level': Math.min(3, item.level) } as CSSProperties} onClick={() => jump(index)}>{item.title}</button>)}</nav>{paged && <p>{zh ? '当前段落的章节' : 'Sections in this part'}</p>}</aside>}
      <div ref={scroll} className="bot-attachment-viewer-content bot-reader-scroll" role="region" aria-label={zh ? '文档正文' : 'Document content'} tabIndex={0} aria-busy={loading} onScroll={() => {
        if (frame.current !== undefined) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(updateScroll);
      }}>
        {loading ? <div className="bot-attachment-viewer-empty"><BotIcon name="file" /><strong>{zh ? '正在读取文件…' : 'Reading the file…'}</strong></div>
          : error ? <div className="bot-attachment-viewer-empty" role="alert"><BotIcon name="file" /><strong>{error}</strong><p>{zh ? '可以重新读取，或用系统应用打开原文件。' : 'Try again or open the original in a system app.'}</p><button onClick={onRetry}>{zh ? '重新读取' : 'Try again'}</button></div>
          : page?.content ? <article className={`bot-attachment-document${source || !markdown ? ' is-source' : ''}`}>{markdown && !source ? <BrowserMarkdown text={page.content} open={onOpenUrl} linkAppearance="chat" locale={locale} /> : <pre>{page.content}</pre>}</article>
          : <div className="bot-attachment-viewer-empty"><BotIcon name="file" /><strong>{zh ? '这是一份空文件' : 'This file is empty'}</strong></div>}
      </div>
    </div>
    <footer className="bot-reader-statusbar"><span>{zh ? '只读' : 'Read only'}<i />{markdown ? 'Markdown' : 'TXT'}<i />{page?.encoding?.toUpperCase() ?? 'UTF-8'}{page && <><i />{formatBotFileSize(page.totalBytes)}</>}</span>
      <div>{paged && <div className="bot-reader-pages"><button disabled={loading || !pageIndex} onClick={onPrevious}>{zh ? '上一段' : 'Previous'}</button><span>{zh ? `第 ${pageIndex + 1} 段` : `Part ${pageIndex + 1}`}</span><button disabled={loading || page?.nextOffset === undefined} onClick={onNext}>{zh ? '下一段' : 'Next'}</button></div>}<span className="bot-reader-progress" aria-label={zh ? '阅读进度' : 'Reading progress'}>{progress}%</span><button type="button" aria-label={zh ? '回到文档顶部' : 'Back to document top'} title={zh ? '回到顶部' : 'Back to top'} onClick={() => scroll.current?.scrollTo({ top: 0, behavior: 'smooth' })}><BotIcon name="arrow" /></button></div>
    </footer>
  </div>;
}
