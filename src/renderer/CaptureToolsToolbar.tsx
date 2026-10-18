import { useEffect, useRef, useState } from 'react';
import type { CaptureToolTask } from '../shared/capture-tools';
import { Icon, type IconName } from './Icons';
import { useLocale } from './i18n';

export function CaptureToolsToolbar({ onOpen }: { onOpen(task: CaptureToolTask): void }) {
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const labels = locale === 'zh-CN' ? { screenshot: '截图', recording: '录屏', 'long-screenshot': '滚动长截图', ocr: '提取文字', translate: '屏幕翻译', selection: '划词助手', more: '全局工具' } : { screenshot: 'Screenshot', recording: 'Record screen', 'long-screenshot': 'Scrolling screenshot', ocr: 'Extract text', translate: 'Translate screen', selection: 'Selection assistant', more: 'Global tools' };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  const choose = (task: CaptureToolTask) => { setOpen(false); onOpen(task); };
  return <div className="application-capture-tools" ref={root}>
    <button className="application-navigation-item" type="button" aria-label={labels.screenshot} title={labels.screenshot} onClick={() => choose('screenshot')}><Icon name="camera" size={22} /><span className="application-navigation-item-label">{labels.screenshot}</span></button>
    <button className="application-capture-more" type="button" aria-label={labels.more} title={labels.more} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chevron-right" size={12} /></button>
    <button className="application-navigation-item" type="button" aria-label={labels.recording} title={labels.recording} onClick={() => choose('recording')}><Icon name="video" size={22} /><span className="application-navigation-item-label">{labels.recording}</span></button>
    {open ? <div className="application-capture-menu" role="menu" aria-label={labels.more}>{(['screenshot', 'recording', 'long-screenshot', 'ocr', 'translate', 'selection'] as const).map(task => <button key={task} role="menuitem" type="button" onClick={() => choose(task)}><Icon name={({ screenshot: 'camera', recording: 'video', 'long-screenshot': 'fit-window', ocr: 'scan-text', translate: 'languages', selection: 'message-circle' } as Record<CaptureToolTask, IconName>)[task]} size={17} />{labels[task]}</button>)}</div> : null}
  </div>;
}
