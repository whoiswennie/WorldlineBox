import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { CompanionAttachment } from '../../shared/companions';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { companionAttachmentKind, companionAttachmentSize, companionAttachmentSource } from './CompanionAttachments';

const PdfViewer = lazy(() => import('../PdfViewerSurface').then(module => ({ default: module.PdfViewerSurface })));
const TEXT_LIMIT = 128 * 1024, PDF_LIMIT = 32 * 1024 * 1024;
export function CompanionDocumentPreview({ attachment, onClose, onReveal, onLaunch }: {
  attachment: CompanionAttachment; onClose(): void; onReveal(): void; onLaunch(): void;
}) {
  const pdf = companionAttachmentKind(attachment) === 'pdf', tooLarge = pdf && attachment.size > PDF_LIMIT;
  const [text, setText] = useState<string>(), [error, setError] = useState('');
  const close = useRef<HTMLButtonElement>(null);
  useDialogFocusTrap(true, attachment.id);
  useEffect(() => { close.current?.focus(); }, [attachment.id]);
  useEffect(() => {
    if (pdf) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(companionAttachmentSource(attachment), { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` }, signal: controller.signal });
      if (!response.ok) throw new Error('文件暂时无法读取。');
      // Bound even a remote server that ignores Range. Plain text is never HTML.
      const reader = response.body?.getReader(); if (!reader) throw new Error('文件暂时无法读取。');
      const decoder = new TextDecoder(); let bytes = 0, output = '';
      try { while (bytes < TEXT_LIMIT) { const item = await reader.read(); if (item.done) break; const part = item.value.subarray(0, TEXT_LIMIT - bytes); bytes += part.length; output += decoder.decode(part, { stream: true }); } output += decoder.decode(); }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (!controller.signal.aborted) setText(output);
    })().catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '文件暂时无法读取。'); });
    return () => controller.abort();
  }, [attachment, pdf]);
  return <div className="companions-modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <section role="dialog" aria-modal="true" aria-label={`文件预览：${attachment.name}`} className="companions-document-preview">
      <header><div><strong>{attachment.name}</strong><small>{companionAttachmentSize(attachment.size)}</small></div><button onClick={onLaunch}><Icon name="arrow-up-right" />系统打开</button><button onClick={onReveal}><Icon name="folder" />文件位置</button><button ref={close} aria-label="关闭文件预览" data-dialog-initial-focus="true" onClick={onClose}>×</button></header>
      <div className="companions-document-stage">{tooLarge ? <p>PDF 超过 32 MB 预览上限，请使用系统应用打开。</p> : pdf ? <Suspense fallback={<p role="status">正在读取 PDF…</p>}><PdfViewer sourceUrl={companionAttachmentSource(attachment)} isFullscreen={false} /></Suspense> : error ? <p role="alert">{error}</p> : text === undefined ? <p role="status">正在读取文件…</p> : <><pre>{text}</pre>{attachment.size > TEXT_LIMIT && <p>仅预览前 128 KB，完整内容可使用系统应用打开。</p>}</>}</div>
    </section>
  </div>;
}
