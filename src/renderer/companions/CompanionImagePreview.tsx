import { useState } from 'react';
import type { CompanionAttachment } from '../../shared/companions';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';

export function CompanionImagePreview({ attachment, onClose, onReveal }: { attachment: CompanionAttachment; onClose: () => void; onReveal: () => void }) {
  const [failed, setFailed] = useState(false);
  useDialogFocusTrap(true, attachment.id);
  const source = attachment.url || `worldlinebox-companion://attachment/${encodeURIComponent(attachment.id)}`;
  return <div className="companions-modal-backdrop companions-image-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <section role="dialog" aria-modal="true" aria-label={`图片预览：${attachment.name}`} className="companions-image-preview"><header><div><strong>{attachment.name}</strong><span>{(attachment.size / 1024).toFixed(1)} KB</span></div><button className="companions-image-reveal" onClick={onReveal}><Icon name="folder" />查看文件位置</button><button className="companion-icon-button" data-dialog-initial-focus="true" aria-label="关闭图片预览" onClick={onClose}>×</button></header><div className="companions-image-stage">{failed ? <p role="alert">图片读取失败，可以查看文件位置。</p> : <img src={source} alt={attachment.name} onError={() => setFailed(true)} />}</div></section>
  </div>;
}
