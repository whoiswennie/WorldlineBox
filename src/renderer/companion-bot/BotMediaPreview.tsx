import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BotMediaRef, WorldlineBoxBotMediaApi, BotMediaTextPage } from '../../shared/companion-bot-media';
import { BrowserMarkdown } from '../browser/BrowserMarkdown';
import { BotIcon } from './BotIcon';
import { formatBotFileSize } from './media-presentation';
import './bot-attachment.css';

const ignoreLink = () => undefined;
interface Props { media: BotMediaRef; api?: WorldlineBoxBotMediaApi; conversationId: string; locale: 'zh-CN' | 'en'; kind: 'image' | 'video' | 'audio' | 'text'; imageUrl?: string; onClose(): void; onOpenUrl?(url: string): void; onSave?(): Promise<void>; onSystemOpen?(): Promise<void>; busy?: boolean; actionError?: string }
export function BotMediaPreview({ media, api, conversationId, locale, kind, imageUrl, onClose, onOpenUrl = ignoreLink, onSave, onSystemOpen, busy, actionError }: Props) {
  const zh = locale === 'zh-CN', box = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  const [cursors, setCursors] = useState([0]), [pageIndex, setPageIndex] = useState(0), [retry, setRetry] = useState(0), [source, setSource] = useState(false);
  const [read, setRead] = useState<{ key: string; page?: BotMediaTextPage; error?: string }>(), [decodeFailed, setDecodeFailed] = useState(false);
  const offset = cursors[pageIndex] ?? 0, key = `${conversationId}:${media.id}:${offset}:${retry}`, loading = kind === 'text' && read?.key !== key;
  useEffect(() => {
    const previous = document.activeElement; close.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (kind !== 'text') return;
    let current = true;
    void Promise.resolve().then(async () => {
      try {
        if (!api) throw Error(zh ? '附件服务尚未连接。' : 'The attachment service is not connected.');
        const result = await api.request({ type: 'media.text.read', conversationId, id: media.id, offset, limit: 65536 });
        if (!current) return;
        setRead(result.ok && result.textPage && result.textPage.offset === offset ? { key, page: result.textPage } : { key, error: result.error ?? (zh ? '暂时无法读取这份文件。' : 'The file could not be read.') });
      } catch (failure) { if (current) setRead({ key, error: failure instanceof Error ? failure.message : zh ? '文件读取失败。' : 'The file could not be read.' }); }
    });
    return () => { current = false; };
  }, [api, kind, conversationId, media.id, offset, key, zh]);
  const page = read?.key === key ? read.page : undefined, readError = read?.key === key ? read.error : undefined;
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...box.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],video,audio,[tabindex="0"]') ?? []];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const next = () => { if (!page?.nextOffset || loading) return; const nextOffset = page.nextOffset; setCursors(current => [...current.slice(0, pageIndex + 1), nextOffset]); setPageIndex(pageIndex + 1); };
  const openDocumentLink = useCallback((url: string) => { onClose(); onOpenUrl(url); }, [onClose, onOpenUrl]);
  const unavailable = decodeFailed || kind === 'image' && !imageUrl;
  return createPortal(<div className="bot-attachment-viewer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`bot-attachment-viewer is-${kind}`} ref={box} role="dialog" aria-modal="true" aria-label={media.name} onKeyDown={keyboard}>
      <header className="bot-attachment-viewer-header"><span className="bot-attachment-viewer-icon"><BotIcon name="file" /></span><div><h2 title={media.name}>{media.name}</h2><span>{formatBotFileSize(media.size)}{kind === 'text' && (page?.format === 'markdown' ? ' · Markdown' : ' · TXT')}</span></div><nav aria-label={zh ? '文件操作' : 'File actions'}>{onSave && <button disabled={busy} onClick={() => void onSave()}><BotIcon name="download" />{zh ? '保存' : 'Save'}</button>}{onSystemOpen && <button disabled={busy} onClick={() => void onSystemOpen()}><BotIcon name="external" />{zh ? '系统打开' : 'System app'}</button>}<button ref={close} className="bot-attachment-viewer-close" aria-label={zh ? '关闭预览' : 'Close preview'} onClick={onClose}>×</button></nav></header>
      {kind === 'text' && page?.format === 'markdown' && <nav className="bot-attachment-reading-tabs" aria-label={zh ? '文档显示方式' : 'Document display'}><button aria-pressed={!source} onClick={() => setSource(false)}>{zh ? '阅读' : 'Read'}</button><button aria-pressed={source} onClick={() => setSource(true)}>{zh ? '原文' : 'Source'}</button><span>{pageIndex > 0 || page.nextOffset !== undefined ? zh ? '当前分页渲染 · 跨页内容可查看原文' : 'Current part · use Source for split blocks' : 'Markdown'}</span></nav>}
      <div className="bot-attachment-viewer-content" aria-busy={loading}>
        {loading ? <div className="bot-attachment-viewer-empty"><BotIcon name="file" /><strong>{zh ? '正在读取文件…' : 'Reading the file…'}</strong></div>
          : readError || unavailable ? <div className="bot-attachment-viewer-empty" role="alert"><BotIcon name="file" /><strong>{readError ?? (zh ? '暂时无法在此预览这个格式' : 'This format cannot be previewed here')}</strong><p>{zh ? '可以用系统应用打开原文件。' : 'You can open the original file with your system app.'}</p>{readError && <button onClick={() => setRetry(value => value + 1)}>{zh ? '重新读取' : 'Try again'}</button>}</div>
          : kind === 'text' && page ? page.content ? <div className="bot-attachment-document">{page.format === 'markdown' && !source ? <BrowserMarkdown text={page.content} open={openDocumentLink} linkAppearance="chat" locale={locale} /> : <pre>{page.content}</pre>}</div> : <div className="bot-attachment-viewer-empty"><strong>{zh ? '这是一份空文件' : 'This file is empty'}</strong></div>
          : kind === 'image' ? <figure className="bot-attachment-picture"><img alt={media.name} src={imageUrl} onError={() => setDecodeFailed(true)} /></figure>
          : kind === 'video' ? <div className="bot-attachment-player"><video controls preload="metadata" playsInline src={media.url} aria-label={media.name} onError={() => setDecodeFailed(true)} /></div>
          : <div className="bot-attachment-audio-player"><span>♫</span><strong>{media.name}</strong><audio controls preload="metadata" src={media.url} aria-label={media.name} onError={() => setDecodeFailed(true)} /></div>}
      </div>
      {kind === 'text' && <footer className="bot-attachment-viewer-pagination"><span>{zh ? `第 ${pageIndex + 1} 段` : `Part ${pageIndex + 1}`}<small>{page ? `${formatBotFileSize(page.offset)} / ${formatBotFileSize(page.totalBytes)}` : formatBotFileSize(media.size)}</small></span><div><button disabled={loading || !pageIndex} onClick={() => setPageIndex(value => value - 1)}>{zh ? '上一段' : 'Previous'}</button><button disabled={loading || page?.nextOffset === undefined} onClick={next}>{zh ? '下一段' : 'Next'}</button></div></footer>}
      {actionError && <div className="bot-attachment-viewer-error" role="alert">{actionError}</div>}
    </section>
  </div>, document.body);
}
