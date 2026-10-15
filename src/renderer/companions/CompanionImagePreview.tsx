import { useEffect, useRef, useState } from 'react';
import type { CompanionAttachment } from '../../shared/companions';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { companionAttachmentSize, companionAttachmentSource } from './CompanionAttachments';

export function CompanionImagePreview({ attachment, images = [], onClose, onReveal }: { attachment: CompanionAttachment; images?: readonly CompanionAttachment[]; onClose: () => void; onReveal: (attachment: CompanionAttachment) => void }) {
  const gallery = images.some(image => image.id === attachment.id) ? images : [attachment];
  const [index, setIndex] = useState(() => Math.max(0, gallery.findIndex(image => image.id === attachment.id))), [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const selected = gallery[index] ?? attachment;
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocusTrap(true, attachment.id);
  // Native hidden windows may defer animation frames. Establish keyboard
  // focus when mounted as well as the shared trap's next-frame fallback.
  useEffect(() => { closeRef.current?.focus(); }, [attachment.id]);
  return <div className="companions-modal-backdrop companions-image-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } else if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex(current => Math.max(0, current - 1)); } else if (event.key === 'ArrowRight') { event.preventDefault(); setIndex(current => Math.min(gallery.length - 1, current + 1)); } }}>
    <section role="dialog" aria-modal="true" aria-label={`图片预览：${selected.name}`} className="companions-image-preview"><header><div><strong>{selected.name}</strong><span>{companionAttachmentSize(selected.size)}{gallery.length > 1 ? ` · ${index + 1} / ${gallery.length}` : ''}</span></div><button className="companions-image-reveal" onClick={() => onReveal(selected)}><Icon name="folder" />查看文件位置</button><button ref={closeRef} className="companion-icon-button" data-dialog-initial-focus="true" aria-label="关闭图片预览" onClick={onClose}>×</button></header><div className="companions-image-stage">{failedIds.has(selected.id) ? <p role="alert">图片读取失败，可以查看文件位置。</p> : <img src={companionAttachmentSource(selected)} alt={selected.name} onError={() => setFailedIds(current => new Set(current).add(selected.id))} />}{gallery.length > 1 && <nav className="companions-image-navigation" aria-label="浏览图片"><button type="button" aria-label="上一张图片" disabled={index === 0} onClick={() => setIndex(current => current - 1)}><Icon name="chevron-left" /></button><button type="button" aria-label="下一张图片" disabled={index === gallery.length - 1} onClick={() => setIndex(current => current + 1)}><Icon name="chevron-right" /></button></nav>}</div></section>
  </div>;
}
