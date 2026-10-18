import { useRef, type PointerEvent } from 'react';
import { type CaptureRegion, normalizeCaptureRegion } from './recording-media';
import { useCaptureWords } from './messages';
import { Button } from '../ui';

export function RecordingRegionPicker({ thumbnail, enabled, value, onChange }: { thumbnail: string; enabled: boolean; value: CaptureRegion; onChange(value: CaptureRegion): void }) {
  const words = useCaptureWords();
  const start = useRef<{ x: number; y: number; pointer: number } | undefined>(undefined);
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.pointer !== event.pointerId) return;
    const current = point(event), anchor = start.current;
    onChange(normalizeCaptureRegion({ x: Math.min(current.x, anchor.x), y: Math.min(current.y, anchor.y), width: Math.abs(current.x - anchor.x), height: Math.abs(current.y - anchor.y) }));
  };
  return <div className="capture-region-picker">
    <div className={'capture-source-preview' + (enabled ? ' is-selecting' : '')} onPointerDown={event => {
      if (!enabled || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      start.current = { ...point(event), pointer: event.pointerId };
    }} onPointerMove={move} onPointerUp={event => { move(event); start.current = undefined; }} onPointerCancel={() => { start.current = undefined; }}>
      {thumbnail ? <img src={thumbnail} alt={words.source} draggable={false} /> : <div className="capture-source-placeholder" />}
      {enabled ? <span aria-hidden="true" className="capture-region-box" style={{ left: value.x * 100 + '%', top: value.y * 100 + '%', width: value.width * 100 + '%', height: value.height * 100 + '%' }} /> : null}
    </div>
    {enabled ? <><p className="capture-tools-muted">{words.regionHint}</p><div className="capture-region-fields">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}><span>{words[key]}</span><input aria-label={words[key]} type="number" min={key === 'width' || key === 'height' ? 1 : 0} max={100} step={1} value={Math.round(value[key] * 100)} onChange={event => onChange(normalizeCaptureRegion({ ...value, [key]: event.target.valueAsNumber / 100 }))} /></label>)}</div><Button size="sm" variant="quiet" onClick={() => onChange({ x: 0, y: 0, width: 1, height: 1 })}>{words.regionFull}</Button></> : null}
  </div>;
}
