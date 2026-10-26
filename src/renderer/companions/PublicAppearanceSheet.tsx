import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import './public-appearance-sheet.css';

/** One public front/side/back reference board; the full image is always preserved. */
export function PublicAppearanceSheet({ attachmentId, fallbackSource, ownerSource, name, title = '公开三视图', description = '一张包含正面、侧面和背面的标准设定板，用于帮助伙伴了解公开形象。', chooseLabel = attachmentId ? '更换三视图' : '上传三视图', removeLabel = fallbackSource ? '恢复内置三视图' : '移除三视图', emptyLabel = '还没有添加三视图', previewLabel = '预览公开三视图', closeLabel = '关闭三视图预览', unavailableLabel = '图片暂时无法读取，请重新选择。', disabled = false, onChoose, onRemove }: {
  attachmentId?: string; fallbackSource?: string; ownerSource?: { url?: string }; name: string; title?: string; description?: string; chooseLabel?: string; removeLabel?: string; emptyLabel?: string; previewLabel?: string; closeLabel?: string; unavailableLabel?: string;
  disabled?: boolean; onChoose?: () => void; onRemove?: () => void;
}) {
  const [preview, setPreview] = useState(false), [failedSource, setFailedSource] = useState<string>();
  const previewRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(preview, 'public-appearance-sheet');
  useEffect(() => {
    if (!preview) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKeyboardEvent(event)) return;
      const topmost = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')].filter(dialog => !dialog.closest('[hidden], [inert], [aria-hidden="true"]')).at(-1);
      if (!topmost || !previewRef.current?.contains(topmost)) return;
      event.preventDefault(); event.stopImmediatePropagation(); setPreview(false);
    };
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [preview]);
  const source = ownerSource ? ownerSource.url : attachmentId ? `worldlinebox-companion://attachment/${encodeURIComponent(attachmentId)}` : fallbackSource;
  const failed = !!source && failedSource === source;
  return <section className="public-appearance-sheet" aria-label={title}>
    <header><div><h4>{title}</h4><p>{description}</p></div>{onChoose && <button type="button" className="companion-secondary-button" disabled={disabled} onClick={onChoose}><Icon name="upload" />{chooseLabel}</button>}</header>
    {source ? <><button type="button" className="public-appearance-thumbnail" aria-label={previewLabel} onClick={() => setPreview(true)}>{failed ? <span>{unavailableLabel}</span> : <img src={source} alt={name + ' · ' + title} onError={() => setFailedSource(source)} />}<span><Icon name="fullscreen" />{previewLabel}</span></button>{attachmentId && onRemove && <button type="button" className="public-appearance-remove" disabled={disabled} onClick={onRemove}>{removeLabel}</button>}</> : <div className="public-appearance-empty"><Icon name="shapes" /><span>{emptyLabel}</span></div>}
    {preview && source && <div ref={previewRef} className="public-appearance-preview-backdrop" data-escape-owned-popover="true" onClick={event => { if (event.target === event.currentTarget) setPreview(false); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPreview(false); } }}><section className="public-appearance-preview" role="dialog" aria-modal="true" aria-label={previewLabel}><header><div><strong>{name}</strong><span>{title}</span></div><button type="button" className="companion-icon-button" data-dialog-initial-focus="true" aria-label={closeLabel} onClick={() => setPreview(false)}><Icon name="close" /></button></header><div>{failed ? <p role="alert">{unavailableLabel}</p> : <img src={source} alt={name + ' · ' + title} onError={() => setFailedSource(source)} />}</div></section></div>}
  </section>;
}
