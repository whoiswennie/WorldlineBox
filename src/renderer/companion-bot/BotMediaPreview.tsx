import { useBotCallDocument } from './call-pet';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BotMediaRef, WorldlineBoxBotMediaApi, BotMediaTextPage } from '../../shared/companion-bot-media';
import { BotTextReader } from './BotTextReader';
import { BotIcon } from './BotIcon';
import { formatBotFileSize } from './media-presentation';
import { BOT_TEXT_EDIT_BYTES, type AttachmentEdit } from '../../shared/companion-bot-media';
import type { BotAttachmentKind } from './attachment-presentation';
import { BotImageStudio } from './BotImageStudio';
import { BotOfficeReader } from './BotOfficeReader';
import { BotPlaybackStudio } from './BotPlaybackStudio';
import { BotTextEditor } from './BotTextEditor';
import './bot-attachment.css';
import './attachment-studio.css';

const PdfReader = lazy(() => import('../PdfViewerSurface').then(module => ({ default: module.PdfViewerSurface })));

const ignoreLink = () => undefined;
interface Props { media: BotMediaRef; api?: WorldlineBoxBotMediaApi; conversationId: string; locale: 'zh-CN' | 'en'; kind: Exclude<BotAttachmentKind, 'file'>; imageUrl?: string; onClose(): void; onOpenUrl?(url: string): void; onSave?(): Promise<void>; onSystemOpen?(): Promise<void>; busy?: boolean; actionError?: string }
export function BotMediaPreview(props: Props) {
  return <PreviewSession key={JSON.stringify([props.conversationId, props.media.id, props.media.url])} {...props}/>;
}
function PreviewSession({ media, api, conversationId, locale, kind, imageUrl, onClose, onOpenUrl = ignoreLink, onSave, onSystemOpen, busy, actionError }: Props) {
  const surface = useBotCallDocument();
  const zh = locale === 'zh-CN', box = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  const [cursors, setCursors] = useState([0]), [pageIndex, setPageIndex] = useState(0), [retry, setRetry] = useState(0);
  const [read, setRead] = useState<{ key: string; page?: BotMediaTextPage; error?: string }>(), [decodeFailed, setDecodeFailed] = useState(false);
  const [expanded, setExpanded] = useState(false), [editing, setEditing] = useState(false), [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState<'close' | 'read'>(), [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(''), [notice, setNotice] = useState('');
  const name = media.originalName || media.name;
  const locked = busy || exporting;
  const exportLock = useRef<string | undefined>(undefined);
  const exportCopy = async (edit: AttachmentEdit) => {
    if (!api || locked || exportLock.current) return false;
    const exportId = crypto.randomUUID();
    exportLock.current = exportId; setExporting(true); setExportError(''); setNotice('');
    try {
      const result = await api.request({ type: 'attachment.export', conversationId, id: media.id, edit, exportId });
      if (!result.ok) throw Error(result.error || (zh ? '导出失败。' : 'Export failed.'));
      setNotice(result.cancelled ? zh ? '已取消导出' : 'Export cancelled' : (zh ? '已保存副本 ' : 'Saved copy ') + (result.savedPath || ''));
      return !result.cancelled;
    } catch (err) { setExportError(err instanceof Error ? err.message : String(err)); return false; }
    finally { exportLock.current = undefined; setExporting(false); }
  };
  const cancelExport = async () => {
    const exportId = exportLock.current;
    if (!api || !exportId) return;
    try {
      const result = await api.request({ type: 'attachment.export.cancel', conversationId, id: media.id, exportId });
      if (!result.ok) throw Error(result.error);
    } catch { setExportError(zh ? '无法取消导出，请重试。' : 'Could not cancel export. Try again.'); }
  };
  const leave = (destination: 'close' | 'read') => {
    if (locked) return;
    if (dirty) { setDiscard(destination); return; }
    if (destination === 'close') onClose(); else setEditing(false);
  };
  const offset = cursors[pageIndex] ?? 0, key = `${conversationId}:${media.id}:${offset}:${retry}`, loading = kind === 'text' && read?.key !== key;
  useEffect(() => {
    const previous = surface.activeElement; close.current?.focus();
    return () => { if (previous && previous.isConnected && typeof (previous as HTMLElement).focus === 'function') (previous as HTMLElement).focus(); };
  }, [surface]);
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
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (discard) setDiscard(undefined); else leave('close'); return; }
    if (event.key !== 'Tab') return;
    const controls = [...box.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],video,audio,textarea,select:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && surface.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && surface.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const next = () => { if (!page?.nextOffset || loading) return; const nextOffset = page.nextOffset; setCursors(current => [...current.slice(0, pageIndex + 1), nextOffset]); setPageIndex(pageIndex + 1); };
  const openDocumentLink = useCallback((url: string) => { onClose(); onOpenUrl(url); }, [onClose, onOpenUrl]);
  const unavailable = decodeFailed || kind === 'image' && !imageUrl;
  const play=(current:HTMLMediaElement)=>{for(const other of surface.querySelectorAll<HTMLMediaElement>('[data-bot-attachment-player]'))if(other!==current)other.pause();};
  const category = { image: zh ? '图片' : 'Image', audio: zh ? '音频' : 'Audio', video: zh ? '视频' : 'Video', pdf: 'PDF', office: zh ? '办公文档' : 'Office document', text: page?.format === 'markdown' ? 'Markdown' : zh ? '文本' : 'Text' }[kind];
  return createPortal(<div className="bot-attachment-viewer-backdrop" data-expanded={expanded} onMouseDown={e => { if (e.target === e.currentTarget) leave('close'); }}>
    <section className={'bot-attachment-viewer is-' + kind} ref={box} role="dialog" aria-modal="true" aria-label={name} onKeyDown={keyboard}>
      <header className="bot-attachment-viewer-header">
        <span className="bot-attachment-viewer-icon"><BotIcon name={kind === 'audio' ? 'music' : kind === 'image' || kind === 'video' ? kind : 'file'}/></span>
        <div><h2 title={name}>{name}</h2><span>{category} · {formatBotFileSize(media.size)}</span></div>
        <nav aria-label={zh ? '文件操作' : 'File actions'}>
          {onSave && <button disabled={locked} onClick={() => void onSave()}><BotIcon name="download"/>{zh ? '保存原件' : 'Save original'}</button>}
          {onSystemOpen && <button disabled={locked} onClick={() => void onSystemOpen()}><BotIcon name="external"/>{zh ? '系统打开' : 'System app'}</button>}
          <button aria-label={zh ? '最大化预览' : 'Maximize viewer'} title={zh ? '最大化预览' : 'Maximize viewer'} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><BotIcon name="screen"/></button>
          <button ref={close} disabled={locked} className="bot-attachment-viewer-close" aria-label={zh ? '关闭预览' : 'Close preview'} onClick={() => leave('close')}><BotIcon name="close"/></button>
        </nav>
      </header>
      {discard && <div className="attachment-tools attachment-discard" role="alert"><strong>{zh ? '放弃尚未保存的文字修改？' : 'Discard unsaved text changes?'}</strong><div className="attachment-spacer"/>
        <button autoFocus onClick={() => setDiscard(undefined)}>{zh ? '继续编辑' : 'Keep editing'}</button><button onClick={() => { setDirty(false); setDiscard(undefined); if (discard === 'close') onClose(); else setEditing(false); }}>{zh ? '放弃修改' : 'Discard changes'}</button></div>}
      {kind === 'text' && (editing && api && page ? <BotTextEditor api={api} conversationId={conversationId} id={media.id} first={page} zh={zh} busy={!!locked} setDirty={setDirty} onBack={() => leave('read')} onExport={content => exportCopy({ kind: 'text', content })}/>
        : <BotTextReader page={page} loading={loading} error={readError} locale={locale} pageIndex={pageIndex} onPrevious={() => setPageIndex(value => value - 1)} onNext={next} onRetry={() => setRetry(value => value + 1)} onOpenUrl={openDocumentLink} onEdit={api && page && page.totalBytes <= BOT_TEXT_EDIT_BYTES ? () => setEditing(true) : undefined}/>)}
      {kind === 'office' && <BotOfficeReader media={media} conversationId={conversationId} api={api} zh={zh}/>}
      {kind === 'pdf' && <Suspense fallback={<div className="bot-attachment-viewer-empty">{zh ? '正在打开 PDF…' : 'Opening PDF…'}</div>}><PdfReader sourceUrl={media.url} isFullscreen={expanded}/></Suspense>}
      {(kind === 'image' || kind === 'audio' || kind === 'video') && (unavailable ? <div className="bot-attachment-viewer-empty" role="alert"><BotIcon name="file"/><strong>{zh ? '暂时无法在此预览这个格式' : 'Unable to preview this format'}</strong><p>{zh ? '可以用系统应用打开原文件。' : 'You can open the original file with your system app.'}</p>{(imageUrl || kind !== 'image') && <button onClick={() => setDecodeFailed(false)}>{zh ? '重新载入' : 'Retry'}</button>}</div>
        : kind === 'image' ? <BotImageStudio src={imageUrl!} name={name} zh={zh} busy={!!locked} onError={() => setDecodeFailed(true)} onExport={api ? exportCopy : undefined}/>
        : <BotPlaybackStudio kind={kind} src={media.url} name={name} zh={zh} busy={!!locked} onPlay={play} onError={() => setDecodeFailed(true)} onExport={api ? exportCopy : undefined}/>)}
      {(exporting || notice) && <div className="attachment-notice" role="status">{exporting ? zh ? '正在导出…' : 'Exporting…' : notice}{exporting && <button onClick={() => void cancelExport()}>{zh ? '取消导出' : 'Cancel export'}</button>}</div>}
      {(actionError || exportError) && <div className="bot-attachment-viewer-error" role="alert">{actionError || exportError}</div>}
    </section>
  </div>, surface.body);
}
