import { useEffect, useRef, useState } from 'react';
import type { CaptureToolTask, WorldlineBoxCaptureToolsApi } from '../shared/capture-tools';
import { CAPTURE_TOOL_MENU_LABELS, CAPTURE_TOOL_MENU_TASKS } from '../shared/capture-tools-menu';
import { Icon, type IconName } from './Icons';
import { useLocale } from './i18n';
import { isImeKeyboardEvent } from './ime-safe-dismiss';
import { createShellPortal } from './ui/ShellStyleScope';

export function CaptureToolsToolbar({ onOpen, nativeMenu, onError }: { onOpen(task: CaptureToolTask): void; nativeMenu?: Pick<WorldlineBoxCaptureToolsApi, 'request'>; onError?(error: string): void }) {
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);
  const nativePending = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const labels = CAPTURE_TOOL_MENU_LABELS[locale === 'zh-CN' ? 'zh-CN' : 'en'];
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKeyboardEvent(event)) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    };
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true); };
  }, [open]);
  const choose = (task: CaptureToolTask) => { setOpen(false); onOpen(task); };
  const showMenu = () => {
    if (!nativeMenu) { setOpen(!open); return; }
    if (nativePending.current) return;
    nativePending.current = true; setNativeOpen(true);
    const box = trigger.current!.getBoundingClientRect();
    void nativeMenu.request({ type: 'menu.popup', locale: locale === 'zh-CN' ? 'zh-CN' : 'en', x: Math.max(0, box.right + 6), y: Math.max(0, box.bottom) }).then(result => {
      if (!result.ok) onError?.(result.error); else if (result.menuTask) choose(result.menuTask);
    }).catch(error => onError?.(error instanceof Error ? error.message : String(error))).finally(() => { nativePending.current = false; setNativeOpen(false); trigger.current?.focus(); });
  };
  return <div className="application-capture-tools" ref={root}>
    <button className="application-navigation-item" type="button" aria-label={labels.screenshot} title={labels.screenshot} onClick={() => choose('screenshot')}><Icon name="camera" size={22} /><span className="application-navigation-item-label">{labels.screenshot}</span></button>
    <button ref={trigger} className="application-capture-more" type="button" aria-label={labels.more} title={labels.more} aria-haspopup="menu" aria-expanded={open || nativeOpen} onClick={showMenu}><Icon name="chevron-right" size={12} /></button>
    <button className="application-navigation-item" type="button" aria-label={labels.recording} title={labels.recording} onClick={() => choose('recording')}><Icon name="video" size={22} /><span className="application-navigation-item-label">{labels.recording}</span></button>
    {/* Keep the global menu above dialogs and let it own Escape before Settings. */}
    {open ? createShellPortal(<div className="application-capture-menu" ref={menu} role="menu" data-modal-popover="true" data-escape-owned-popover="true" aria-label={labels.more} onKeyDown={event => {
      if (event.key === 'Tab') { setOpen(false); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || isImeKeyboardEvent(event.nativeEvent)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }}>{CAPTURE_TOOL_MENU_TASKS.map(task => <button key={task} role="menuitem" type="button" onClick={() => choose(task)}><Icon name={({ screenshot: 'camera', recording: 'video', 'long-screenshot': 'fit-window', ocr: 'scan-text', translate: 'languages', selection: 'message-circle' } as Record<CaptureToolTask, IconName>)[task]} size={17} />{labels[task]}</button>)}</div>, document.body) : null}
  </div>;
}
