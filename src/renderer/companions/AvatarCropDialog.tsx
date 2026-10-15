import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { CompanionAttachment, CompanionsRequest, CompanionsResponse } from '../../shared/companions';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { companionAttachmentSource } from './CompanionAttachments';
import { INITIAL_AVATAR_CROP, avatarCropGeometry, avatarCropImageStyle, clampAvatarCrop, rotateAvatarCrop, type AvatarCrop, type AvatarImageSize } from './avatar-crop';
import './avatar-crop.css';

export function AvatarCropDialog({ attachment, name, request, onCancel, onConfirm, returnFocusRef }: {
  attachment: CompanionAttachment; name: string;
  request: (request: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
  onCancel: () => void; onConfirm: (attachment: CompanionAttachment) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [size, setSize] = useState<AvatarImageSize>(), [crop, setCrop] = useState<AvatarCrop>({ ...INITIAL_AVATAR_CROP }), [grid, setGrid] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const scope = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), alive = useRef(true), dragging = useRef<{ pointerId: number; x: number; y: number; crop: AvatarCrop; diameter: number } | null>(null);
  const source = companionAttachmentSource(attachment);
  useDialogFocusTrap(true, 'avatar-crop-' + attachment.id);
  useEffect(() => () => {
    // The native picker disables its trigger and can blur it before this
    // dialog mounts, so the generic focus trap cannot recover that element.
    const target = returnFocusRef?.current;
    queueMicrotask(() => { if (target?.isConnected && !target.closest('[hidden], [inert], [aria-hidden="true"]')) target.focus(); });
  }, [returnFocusRef]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const element = stage.current; if (!element || !size) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); if (busy) return; dragging.current = null; setCrop(current => clampAvatarCrop(size, { ...current, zoom: current.zoom * Math.exp(-event.deltaY * .002) })); };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, [size, busy]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKeyboardEvent(event)) return;
      const topmost = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')].filter(dialog => !dialog.closest('[hidden], [inert], [aria-hidden="true"]')).at(-1);
      if (!topmost || !scope.current?.contains(topmost)) return;
      event.preventDefault(); event.stopImmediatePropagation(); onCancel();
    };
    document.addEventListener('keydown', dismiss, true); return () => document.removeEventListener('keydown', dismiss, true);
  }, [onCancel]);
  function change(next: AvatarCrop) { if (size && !busy) setCrop(clampAvatarCrop(size, next)); }
  function zoom(value: number) { dragging.current = null; change({ ...crop, zoom: value }); }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!size || busy || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus();
    dragging.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, crop, diameter: event.currentTarget.getBoundingClientRect().width * .75 };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragging.current; if (!size || !drag || drag.pointerId !== event.pointerId || drag.diameter <= 0 || busy) return;
    const geometry = avatarCropGeometry(size, drag.crop);
    change({ ...drag.crop, centerX: drag.crop.centerX - (event.clientX - drag.x) / drag.diameter * geometry.side / geometry.width, centerY: drag.crop.centerY - (event.clientY - drag.y) / drag.diameter * geometry.side / geometry.height });
  }
  async function confirm() {
    if (!size || busy) return; setBusy(true); setError('');
    try {
      const result = await request({ type: 'avatar.crop', attachmentId: attachment.id, crop });
      if (!alive.current) return;
      const output = result?.attachments?.[0]; if (!result?.ok || !output || !output.mime.startsWith('image/')) throw new Error(result?.error || '头像未能处理，请重试。');
      onConfirm(output);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '头像未能处理，请重试。'); }
    finally { if (alive.current) setBusy(false); }
  }
  const image = size ? avatarCropImageStyle(size, crop) : undefined;
  return createPortal(<div ref={scope} className="avatar-crop-backdrop" data-escape-owned-popover="avatar-crop" onClick={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="avatar-crop-dialog" role="dialog" aria-modal="true" aria-label="调整头像" onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); void confirm(); } }}>
      <header><div className="avatar-crop-heading"><div className="avatar-crop-heading-icon" aria-hidden="true"><Icon name="edit" /></div><div><h2>调整头像</h2><p>拖动、缩放，调整头像的最佳位置。</p></div></div><button type="button" className="companion-icon-button avatar-crop-close" data-dialog-initial-focus="true" aria-label="关闭头像裁剪" onClick={onCancel}><Icon name="close" /></button></header>
      <div className="avatar-crop-body"><div className="avatar-crop-workspace">
        <div className="avatar-crop-canvas-heading"><span><Icon name="shapes" />裁剪画布</span><span>{size ? `${size.width} × ${size.height}` : '正在加载'}</span></div>
        <div ref={stage} className={`avatar-crop-stage${busy ? ' is-busy' : ''}`} role="group" aria-label="拖动或用方向键调整头像位置" tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => { if (dragging.current?.pointerId === event.pointerId) dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }} onLostPointerCapture={() => { dragging.current = null; }} onKeyDown={event => {
          if (!size || busy || isImeKeyboardEvent(event.nativeEvent)) return;
          const direction = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
          if (!direction) return; event.preventDefault(); const geometry = avatarCropGeometry(size, crop), distance = geometry.side * (event.shiftKey ? .1 : .01);
          change({ ...crop, centerX: crop.centerX + direction[0]! * distance / geometry.width, centerY: crop.centerY + direction[1]! * distance / geometry.height });
        }}>
          <img draggable={false} src={source} alt="待调整的头像原图" style={size ? avatarCropImageStyle(size, crop, .75) : { visibility: 'hidden' }} onLoad={event => { const { naturalWidth: width, naturalHeight: height } = event.currentTarget; if (width && height) { setSize({ width, height }); setError(''); } }} onError={() => { setSize(undefined); setError('原图无法读取，请取消并重新选择图片。'); }} />
          <div className="avatar-crop-circle" aria-hidden="true">{grid && <div className="avatar-crop-grid" />}</div>{!size && !error && <span className="avatar-crop-loading" role="status">正在读取图片…</span>}
        </div>
        <div className="avatar-crop-controls">
          <div className="avatar-crop-zoom-heading"><span>缩放</span><output aria-label="当前缩放">{Math.round(crop.zoom * 100)}%</output></div>
          <div className="avatar-crop-zoom"><button type="button" className="companion-icon-button" aria-label="缩小头像" disabled={!size || busy || crop.zoom <= 1} onClick={() => zoom(crop.zoom - .25)}>−</button><input type="range" aria-label="头像缩放" min={1} max={8} step={.05} value={crop.zoom} style={{ backgroundSize: `${(crop.zoom - 1) / 7 * 100}% 100%` }} disabled={!size || busy} onChange={event => zoom(Number(event.target.value))} /><button type="button" className="companion-icon-button" aria-label="放大头像" disabled={!size || busy || crop.zoom >= 8} onClick={() => zoom(crop.zoom + .25)}>+</button></div>
          <div className="avatar-crop-tools"><button type="button" disabled={!size || busy} onClick={() => { if (size) change(rotateAvatarCrop(size, crop)); }}><Icon name="rotate-cw" />旋转 90°</button><button type="button" disabled={!size || busy} onClick={() => { dragging.current = null; setCrop({ ...INITIAL_AVATAR_CROP }); }}><Icon name="undo" />重置</button><label className={grid ? 'is-active' : undefined}><input type="checkbox" checked={grid} onChange={event => setGrid(event.target.checked)} /><Icon name="grid" /><span>辅助网格</span></label></div>
        </div>
        <p className="avatar-crop-canvas-hint">拖动调整位置<span>·</span>滚轮缩放</p>
      </div><aside className="avatar-crop-previews">
        <div className="avatar-crop-preview-heading"><h3>实时预览</h3><span><i />随调整更新</span></div>
        <div className="avatar-crop-profile-preview"><div className="avatar-crop-preview-halo"><div className="avatar-crop-preview is-large" aria-label="大头像预览">{size && <img src={source} alt="" style={image} />}</div></div><strong title={name || '头像'}>{name || '头像'}</strong><span>资料页头像</span></div>
        <div className="avatar-crop-context-previews"><div className="avatar-crop-context-row"><div className="avatar-crop-preview is-medium">{size && <img src={source} alt="" style={image} />}</div><div><strong>聊天消息</strong><span>对话中的显示效果</span></div></div><div className="avatar-crop-context-row"><div className="avatar-crop-contact-frame"><div className="avatar-crop-preview is-small">{size && <img src={source} alt="" style={image} />}</div></div><div><strong>联系人列表</strong><span>列表中的显示效果</span></div></div></div>
        <div className="avatar-crop-shortcuts"><Icon name="info" /><p><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 微调位置<br /><span>按住 <kbd>Shift</kbd> 快速移动</span></p></div>
      </aside></div>
      <footer><div>{error ? <p role="alert">{error}</p> : <p><Icon name="check" /><span>原图保留<span className="avatar-crop-footer-dot">·</span>512 × 512 PNG{attachment.mime === 'image/gif' ? ' · 使用动图首帧' : ''}</span></p>}</div><button type="button" className="companion-secondary-button" onClick={onCancel}>取消</button><button type="button" className="companion-primary-button" disabled={!size || busy} onClick={() => void confirm()}>{busy ? <><Icon name="loader" />正在生成…</> : <><Icon name="check" />使用此头像</>}</button></footer>
    </section>
  </div>, document.body);
}
