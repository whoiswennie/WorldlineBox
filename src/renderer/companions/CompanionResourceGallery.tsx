import { useEffect, useRef, useState } from 'react';
import type { CompanionAttachment, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { COMPANION_IMAGE_PREVIEW_MAX_BYTES, COMPANION_MEDIA_PREVIEW_MAX_BYTES } from '../../shared/companion-media';
import { Icon } from '../Icons';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { CompanionInlineMedia, stopCompanionMediaAttachments } from './CompanionMediaPlayer';
import { CompanionDocumentPreview } from './CompanionDocumentPreview';
import { animatedAttachment, attachmentKindLabels, attachmentCollectionSummary, companionAttachmentKind, companionAttachmentSize, companionAttachmentSource, companionAttachmentCoverSource } from './companion-attachment-presentation';

/** Covers never mount animated-image decoders. Only the selected resource is
 * allowed to load its full image, document or media preview. */
export function CompanionResourceThumbnail({ attachment }: { attachment: CompanionAttachment }) {
  const kind = companionAttachmentKind(attachment), animated = animatedAttachment(attachment);
  const source = companionAttachmentCoverSource(attachment), identity = JSON.stringify([attachment.id, attachment.url, attachment.mime, attachment.size]), [failedSource, setFailedSource] = useState<string>();
  return ((kind === 'image' && attachment.size <= COMPANION_IMAGE_PREVIEW_MAX_BYTES) || (kind === 'video' && attachment.size <= COMPANION_MEDIA_PREVIEW_MAX_BYTES)) && failedSource !== identity
    ? <img key={identity} loading="lazy" decoding="async" src={source} alt="" onError={() => setFailedSource(identity)} />
    : <span className="resource-gallery-file-symbol"><Icon name={kind === 'image' ? 'camera' : kind === 'audio' ? 'music' : kind === 'video' ? 'play' : kind === 'text' ? 'code' : 'file'} /><small>{animated ? '动图' : attachmentKindLabels[kind]}</small></span>;
}

export function CompanionResourceGallery({ attachments, ownerId, conversationId, onClose }: {
  attachments: readonly CompanionAttachment[]; ownerId?: string; conversationId?: string; onClose(): void;
}) {
  const [selectedId, setSelectedId] = useState(attachments[0]?.id), [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set()), [error, setError] = useState('');
  const selectedIndex = Math.max(0, attachments.findIndex(attachment => attachment.id === selectedId)), selected = attachments[selectedIndex];
  const close = useRef<HTMLButtonElement>(null);
  const resourceIds = useRef(new Set(attachments.map(attachment => attachment.id)));
  useDialogFocusTrap(true, selectedId);
  useEffect(() => { close.current?.focus(); const ids = resourceIds.current; return () => stopCompanionMediaAttachments(ids); }, []);
  if (!selected) return null;
  const kind = companionAttachmentKind(selected);
  const choose = (index: number) => { const attachment = attachments[index]; if (attachment) { setSelectedId(attachment.id); setError(''); } };
  async function openFile(type: 'attachment.open' | 'attachment.launch') {
    setError('');
    try {
      const api = (window as Window & { worldlinebox?: { companions?: WorldlineBoxCompanionsApi } }).worldlinebox?.companions;
      if (!api) throw new Error('文件操作暂时不可用。');
      const result = await api.request({ type, id: selected!.id });
      if (!result.ok) throw new Error(result.error || '文件暂时无法打开。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文件暂时无法打开。'); }
  }
  return <div className="companions-task-backdrop resource-gallery-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    if (isImeKeyboardEvent(event.nativeEvent)) return;
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !(event.target as HTMLElement).closest('input,textarea,[contenteditable="true"],audio,video')) { event.preventDefault(); choose(selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1)); }
  }}><section className="companions-resource-gallery" role="dialog" aria-modal="true" aria-label="消息资源画廊">
    <header><div><h2>这次分享的资源 <span>{attachments.length}</span></h2><p>{attachmentCollectionSummary(attachments)}</p></div><button ref={close} type="button" className="companion-icon-button" aria-label="关闭资源画廊" onClick={onClose}><Icon name="close" /></button></header>
    <div className="resource-gallery-layout"><nav className="resource-gallery-grid" aria-label="全部分享资源">{attachments.map((attachment, index) => <button key={attachment.id} type="button" aria-label={`选择资源：${attachment.name}`} aria-pressed={attachment.id === selected.id} onClick={() => choose(index)}><span className="resource-gallery-thumbnail"><CompanionResourceThumbnail attachment={attachment} /></span><strong title={attachment.name}>{attachment.name}</strong><small>{companionAttachmentSize(attachment.size)}</small></button>)}</nav>
      <main className="resource-gallery-preview" aria-label={`选中资源：${selected.name}`}><div className="resource-gallery-selected-heading"><div><strong>{selected.name}</strong><small>{attachmentKindLabels[kind]} · {companionAttachmentSize(selected.size)}</small></div><nav aria-label="切换分享资源"><button type="button" aria-label="上一个资源" disabled={selectedIndex === 0} onClick={() => choose(selectedIndex - 1)}><Icon name="chevron-left" /></button><span>{selectedIndex + 1} / {attachments.length}</span><button type="button" aria-label="下一个资源" disabled={selectedIndex === attachments.length - 1} onClick={() => choose(selectedIndex + 1)}><Icon name="chevron-right" /></button></nav></div>
        <div className={`resource-gallery-stage is-${kind}`} key={selected.id}>
          {kind === 'image' ? selected.size > COMPANION_IMAGE_PREVIEW_MAX_BYTES ? <p>这张图片较大，可使用系统应用打开。</p> : failedIds.has(selected.id) ? <p role="alert">图片暂时无法读取，可以查看文件位置。</p> : <img className="resource-gallery-full-image" src={companionAttachmentSource(selected)} alt={selected.name} onError={() => setFailedIds(current => new Set(current).add(selected.id))} />
            : kind === 'audio' || kind === 'video' ? selected.size > COMPANION_MEDIA_PREVIEW_MAX_BYTES ? <p>文件超过内置播放上限，可使用系统应用打开。</p> : <CompanionInlineMedia attachment={selected} ownerId={ownerId} conversationId={conversationId} />
              : kind === 'pdf' || kind === 'text' ? <CompanionDocumentPreview attachment={selected} embedded onClose={onClose} onReveal={() => void openFile('attachment.open')} onLaunch={() => void openFile('attachment.launch')} />
                : <div className="resource-gallery-file-preview"><Icon name="file" /><strong>{selected.name}</strong><p>使用系统应用查看这个文件。</p></div>}
        </div>
        {error && <p className="resource-gallery-error" role="alert">{error}</p>}
        <footer><button type="button" onClick={() => void openFile('attachment.open')}><Icon name="folder" />文件位置</button><button type="button" onClick={() => void openFile('attachment.launch')}><Icon name="arrow-up-right" />系统打开</button></footer>
      </main>
    </div>
  </section></div>;
}
