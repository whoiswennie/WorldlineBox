import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CompanionAttachment } from '../../shared/companions';
import type { WorldlineBoxShellApi } from '../../shared/external-url';
import { isMarkdownTextName } from '../../shared/text-media';
import { Icon } from '../Icons';
import { BrowserMarkdown } from '../browser/BrowserMarkdown';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { companionAttachmentKind, companionAttachmentSize, companionAttachmentSource } from './companion-attachment-presentation';
import './companion-document-preview.css';

const PdfViewer = lazy(() => import('../PdfViewerSurface').then(module => ({ default: module.PdfViewerSurface })));
const TEXT_LIMIT = 128 * 1024, PDF_LIMIT = 32 * 1024 * 1024;
export function CompanionDocumentPreview({ attachment, onClose, onReveal, onLaunch, embedded = false }: {
  attachment: CompanionAttachment; onClose(): void; onReveal(): void; onLaunch(): void; embedded?: boolean;
}) {
  // A different file never keeps the previous file's text or reading mode for
  // a render while its asynchronous read is being replaced.
  return <DocumentPreviewContent key={[attachment.id, attachment.name, attachment.mime, companionAttachmentSource(attachment)].join('\n')}
    attachment={attachment} onClose={onClose} onReveal={onReveal} onLaunch={onLaunch} embedded={embedded} />;
}

function DocumentPreviewContent({ attachment, onClose, onReveal, onLaunch, embedded }: {
  attachment: CompanionAttachment; onClose(): void; onReveal(): void; onLaunch(): void; embedded: boolean;
}) {
  const pdf = companionAttachmentKind(attachment) === 'pdf', tooLarge = pdf && attachment.size > PDF_LIMIT;
  const markdown = isMarkdownTextName(attachment.name) || /^text\/(?:x-)?markdown(?:;|$)/iu.test(attachment.mime);
  const source = companionAttachmentSource(attachment);
  const [text, setText] = useState<string>(), [error, setError] = useState('');
  const [view, setView] = useState<'reading' | 'source'>('reading'), [readVersion, setReadVersion] = useState(0), [linkError, setLinkError] = useState('');
  const close = useRef<HTMLButtonElement>(null);
  const alive = useRef(false);
  useDialogFocusTrap(!embedded, attachment.id);
  useEffect(() => { if (!embedded) close.current?.focus(); }, [attachment.id, embedded]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const openLink = useCallback((url: string) => {
    setLinkError('');
    const shell = (window as Window & { worldlinebox?: { shell?: Pick<WorldlineBoxShellApi, 'openExternalUrl'> } }).worldlinebox?.shell;
    if (!shell) { setLinkError('当前无法打开外部链接，可查看原文中的地址。'); return; }
    void Promise.resolve().then(() => shell.openExternalUrl(url)).then(result => {
      if (alive.current && !result.ok) setLinkError('此链接暂时无法打开，可查看原文中的地址。');
    }).catch(() => { if (alive.current) setLinkError('此链接暂时无法打开，可查看原文中的地址。'); });
  }, []);
  useEffect(() => {
    if (pdf) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(source, { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` }, signal: controller.signal });
      if (!response.ok) throw new Error('文件暂时无法读取。');
      // Bound even a remote server that ignores Range. Plain text is never HTML.
      const reader = response.body?.getReader(); if (!reader) throw new Error('文件暂时无法读取。');
      const decoder = new TextDecoder(); let bytes = 0, output = '';
      try { while (bytes < TEXT_LIMIT) { const item = await reader.read(); if (item.done) break; const part = item.value.subarray(0, TEXT_LIMIT - bytes); bytes += part.length; output += decoder.decode(part, { stream: true }); } output += decoder.decode(); }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (!controller.signal.aborted) setText(output);
    })().catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '文件暂时无法读取。'); });
    return () => controller.abort();
  }, [source, pdf, readVersion]);
  const format = pdf ? 'PDF 文档' : markdown ? 'Markdown 文档' : '纯文本';
  return <div className={embedded ? 'companions-document-embedded' : 'companions-modal-backdrop companions-document-backdrop'} onClick={event => { if (!embedded && event.target === event.currentTarget) onClose(); }} onKeyDown={event => { if (!embedded && event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); onClose(); } }}>
    <section role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true} aria-label={`文件预览：${attachment.name}`} className="companions-document-preview">
      {!embedded && <header className="companion-document-header">
        <span className="companion-document-icon" aria-hidden="true"><Icon name="file" /></span>
        <div className="companion-document-identity"><strong title={attachment.name}>{attachment.name}</strong><span>{format}<i aria-hidden="true">·</i>{companionAttachmentSize(attachment.size)}</span></div>
        <div className="companion-document-actions"><button type="button" className="companion-document-action" onClick={onLaunch}><Icon name="arrow-up-right" /><span>系统打开</span></button><button type="button" className="companion-document-action" onClick={onReveal}><Icon name="folder" /><span>文件位置</span></button></div>
        <button type="button" className="companion-document-close" ref={close} aria-label="关闭文件预览" data-dialog-initial-focus="true" onClick={onClose}><Icon name="close" /></button>
      </header>}
      {markdown && <div className="companion-document-toolbar"><div className="companion-document-view" role="group" aria-label="Markdown 显示方式"><button type="button" aria-pressed={view === 'reading'} onClick={() => setView('reading')}>阅读</button><button type="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>原文</button></div><span>Markdown · 支持表格、代码与 Mermaid 图表</span></div>}
      {linkError && <p className="companion-document-link-error" role="alert">{linkError}</p>}
      <div className={`companions-document-stage${pdf ? ' is-pdf' : ''}`}>
        {tooLarge ? <div className="companion-document-state"><Icon name="file" /><p>PDF 超过 32 MB 预览上限，请使用系统应用打开。</p><button type="button" className="companion-document-action" onClick={onLaunch}>系统打开</button></div>
          : pdf ? <Suspense fallback={<div className="companion-document-state" role="status"><Icon name="loader" /><p>正在读取 PDF…</p></div>}><PdfViewer sourceUrl={source} isFullscreen={false} /></Suspense>
            : error ? <div className="companion-document-state" role="alert"><Icon name="alert-circle" /><p>{error}</p><button type="button" className="companion-document-action" onClick={() => { setText(undefined); setError(''); setReadVersion(value => value + 1); }}>重新读取</button></div>
              : text === undefined ? <div className="companion-document-state" role="status"><Icon name="loader" /><p>正在读取文件…</p></div>
                : <><article className={`companion-document-paper${markdown && view === 'reading' ? ' is-markdown' : ' is-source'}`} aria-label={markdown && view === 'reading' ? 'Markdown 正文' : '文件原文'}>
                  {markdown && view === 'reading' ? <BrowserMarkdown text={text} open={openLink} /> : <pre className="companion-document-source">{text}</pre>}
                </article>{attachment.size > TEXT_LIMIT && <p className="companion-document-limit">仅预览前 128 KB，完整内容可使用系统应用打开。</p>}</>}
      </div>
    </section>
  </div>;
}
