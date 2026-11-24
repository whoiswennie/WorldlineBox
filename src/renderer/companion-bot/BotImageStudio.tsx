import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { imageCropArea, type CropRegion, type ImageEdit } from '../../shared/companion-bot-media';
import { BotIcon } from './BotIcon';

const original: ImageEdit = { kind: 'image', turns: 0, mirror: false, crop: 'original' };
type Props = { src: string; name: string; zh: boolean; busy: boolean; onError(): void; onExport?(edit: ImageEdit): Promise<boolean> };
export function BotImageStudio({ src, name, zh, busy, onError, onExport }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 }), [image, setImage] = useState({ width: 0, height: 0 });
  const [edit, setEdit] = useState(original), [zoom, setZoom] = useState<number | null>(null);
  const figure = useRef<HTMLElement>(null), [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<CropRegion>();
  const start = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; pointer: number } | null>(null);
  const anchor = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const shown = selecting ? original : edit;
  const crop = imageCropArea(image.width, image.height, shown), rotated = shown.turns % 2 === 1;
  const width = rotated ? crop.height : crop.width, height = rotated ? crop.width : crop.height;
  const fit = width && height ? Math.min(1, Math.max(1, frame.width - 32) / width, Math.max(1, frame.height - 32) / height) : 1;
  const scale = zoom ?? fit, ready = image.width > 0;
  const imagePoint = (x: number, y: number) => {
    const rect = figure.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (x - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (y - rect.top) / rect.height)) };
  };
  const selectedArea = (x: number, y: number) => {
    const p = imagePoint(x, y), a = start.current!;
    return { x: Math.min(a.x, p.x), right: Math.max(a.x, p.x), y: Math.min(a.y, p.y), bottom: Math.max(a.y, p.y) };
  };
  useLayoutEffect(() => {
    const el = stage.current!;
    const measure = () => setFrame({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  function changeZoom(value: number | null, x = frame.width / 2, y = frame.height / 2) {
    const el = stage.current;
    if (!el || !ready) return;
    const left = Math.max(0, (el.clientWidth - width * scale) / 2), top = Math.max(0, (el.clientHeight - height * scale) / 2);
    anchor.current = { x: (x + el.scrollLeft - left) / scale, y: (y + el.scrollTop - top) / scale, px: x, py: y };
    setZoom(value === null ? null : Math.min(8, Math.max(Math.min(0.05, fit), value)));
  }
  useLayoutEffect(() => {
    const at = anchor.current, el = stage.current;
    if (!at || !el) return;
    el.scrollLeft = at.x * scale + Math.max(0, (el.clientWidth - width * scale) / 2) - at.px;
    el.scrollTop = at.y * scale + Math.max(0, (el.clientHeight - height * scale) / 2) - at.py;
    anchor.current = null;
  }, [scale, width, height]);
  const wheelZoom = useEffectEvent((e: WheelEvent) => {
    if (!ready || (!e.ctrlKey && !e.metaKey)) return;
    e.preventDefault(); e.stopPropagation();
    const rect = stage.current!.getBoundingClientRect();
    changeZoom(scale * Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) / 350), e.clientX - rect.left, e.clientY - rect.top);
  });
  useEffect(() => {
    const el = stage.current!;
    el.addEventListener('wheel', wheelZoom, { passive: false });
    return () => el.removeEventListener('wheel', wheelZoom);
  }, []);
  const button = (label: string, icon: Parameters<typeof BotIcon>[0]['name'], action: () => void, disabled = false) =>
    <button type="button" title={label} aria-label={label} disabled={!ready || disabled} onClick={action}><BotIcon name={icon}/></button>;
  return <>
    <div className="attachment-tools" aria-label={zh ? '图片工具' : 'Image tools'}>
      <div className="attachment-control-group">{button(zh ? '缩小' : 'Zoom out', 'minus', () => changeZoom(scale / 1.25))}
        <output>{Math.round(scale * 100)}%</output>{button(zh ? '放大' : 'Zoom in', 'plus', () => changeZoom(scale * 1.25), scale >= 8)}</div>
      <button aria-pressed={zoom === null} disabled={!ready} onClick={() => changeZoom(null)}>{zh ? '适应窗口' : 'Fit'}</button>
      <button disabled={!ready} onClick={() => changeZoom(1)}>1:1</button><i/>
      {button(zh ? '顺时针旋转 90°' : 'Rotate clockwise', 'rotate-right', () => setEdit({ ...edit, turns: (edit.turns + 1) % 4 }), busy || selecting)}
      <button disabled={!ready || busy || selecting} aria-pressed={edit.mirror} onClick={() => setEdit({ ...edit, mirror: !edit.mirror })}>{zh ? '镜像' : 'Mirror'}</button>
      <label>{zh ? '裁切' : 'Crop'} <select aria-label={zh ? '裁切' : 'Crop'} disabled={!ready || busy} value={selecting ? 'select' : edit.crop} onChange={e => {
        if (e.target.value === 'select') { setSelecting(true); setSelection(undefined); setZoom(null); stage.current?.focus(); }
        else { setSelecting(false); setEdit({ ...edit, crop: e.target.value as ImageEdit['crop'] }); }
      }}>
        <option value="original">{zh ? '完整图像' : 'Full image'}</option><option value="square">1:1</option><option value="landscape">16:9</option><option value="portrait">3:4</option>
        <option value="select">{zh ? '拖动框选…' : 'Draw selection…'}</option>{edit.crop === 'custom' && <option value="custom">{zh ? '已框选区域' : 'Selected region'}</option>}</select></label>
      <button disabled={busy || (!selecting && !edit.turns && !edit.mirror && edit.crop === 'original')} onClick={() => { setSelecting(false); setEdit(original); }}>{zh ? '重置' : 'Reset'}</button>
      <div className="attachment-spacer"/>{onExport && <button className="attachment-primary" disabled={!ready || busy || selecting} onClick={() => void onExport(edit)}><BotIcon name="download"/>{zh ? '导出静态 PNG' : 'Export still PNG'}</button>}
    </div>
    <div className="attachment-image-stage" data-selecting={selecting} ref={stage} tabIndex={0} aria-label={zh ? '图片画布' : 'Image canvas'}
      onDoubleClick={e => { const r = e.currentTarget.getBoundingClientRect(); changeZoom(zoom === 1 ? null : 1, e.clientX - r.left, e.clientY - r.top); }}
      onKeyDown={e => {
        if (selecting && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); start.current = null; setSelecting(false); return; }
        if (['+', '=', '-', '0', '1'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); changeZoom(e.key === '0' ? null : e.key === '1' ? 1 : scale * (e.key === '-' ? 0.8 : 1.25)); }
      }}
      onPointerDown={e => {
        if (!ready || e.button !== 0) return;
        const el = e.currentTarget; el.focus(); el.setPointerCapture(e.pointerId);
        if (selecting) {
          start.current = { ...imagePoint(e.clientX, e.clientY), pointer: e.pointerId };
          return;
        }
        drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, pointer: e.pointerId };
      }}
      onPointerMove={e => {
        if (selecting && start.current?.pointer === e.pointerId) { setSelection(selectedArea(e.clientX, e.clientY)); return; }
        const d = drag.current; if (!d || d.pointer !== e.pointerId) return;
        e.currentTarget.scrollLeft = d.left + d.x - e.clientX; e.currentTarget.scrollTop = d.top + d.y - e.clientY;
      }} onPointerUp={e => {
        if (!selecting || start.current?.pointer !== e.pointerId) return;
        const region = selectedArea(e.clientX, e.clientY);
        if ((region.right - region.x) * image.width >= 1 && (region.bottom - region.y) * image.height >= 1) {
          setEdit({ ...edit, crop: 'custom', region }); setSelecting(false);
        }
      }} onLostPointerCapture={() => { drag.current = null; start.current = null; setSelection(undefined); }}>
      <div className="attachment-image-bed" style={{ width: width * scale, height: height * scale }}>
        <figure ref={figure} className="bot-attachment-picture attachment-crop" style={{ width: crop.width * scale, height: crop.height * scale, transform: 'translate(-50%, -50%) rotate(' + shown.turns * 90 + 'deg) scaleX(' + (shown.mirror ? -1 : 1) + ')' }}>
          <img alt={name} src={src} draggable={false} onError={onError} onLoad={e => setImage({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} style={{ width: image.width * scale, height: image.height * scale, left: -crop.left * scale, top: -crop.top * scale }}/>
          {selecting && selection && <span className="attachment-crop-selection" style={{ left: selection.x * 100 + '%', top: selection.y * 100 + '%', width: (selection.right - selection.x) * 100 + '%', height: (selection.bottom - selection.y) * 100 + '%' }}/>}
        </figure>
      </div>
      {!ready && <span className="attachment-image-loading" role="status">{zh ? '正在载入图像…' : 'Loading image…'}</span>}
    </div>
    <footer className="attachment-tools attachment-status"><span>{ready ? width + ' × ' + height + ' px' : '—'}</span><div className="attachment-spacer"/><span>{selecting ? zh ? '拖动选取保留区域 · Esc 取消' : 'Drag to select a region · Esc to cancel' : zh ? '双击切换原大 · 放大后可拖动' : 'Double-click for actual size · Drag to pan'}</span></footer>
  </>;
}

