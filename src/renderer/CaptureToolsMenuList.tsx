import type { Ref } from 'react';
import type { CaptureToolTask } from '../shared/capture-tools';
import { CAPTURE_TOOL_MENU_LABELS, CAPTURE_TOOL_MENU_TASKS } from '../shared/capture-tools-menu';
import { Icon, type IconName } from './Icons';
import { isImeKeyboardEvent } from './ime-safe-dismiss';
import './application-shell.css';

/** Both in-window and native-layer surfaces render this exact menu and CSS. */
export function CaptureToolsMenuList({ locale, onChoose, onDismiss, menuRef }: { locale: 'zh-CN' | 'en'; onChoose(task: CaptureToolTask): void; onDismiss(): void; menuRef?: Ref<HTMLDivElement> }) {
  const labels = CAPTURE_TOOL_MENU_LABELS[locale];
  return <div className="application-capture-menu" ref={menuRef} role="menu" data-modal-popover="true" data-escape-owned-popover="true" aria-label={labels.more} onKeyDown={event => {
    if (isImeKeyboardEvent(event.nativeEvent)) return;
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onDismiss(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  }}>{CAPTURE_TOOL_MENU_TASKS.map(task => <button key={task} role="menuitem" type="button" onClick={() => onChoose(task)}><Icon name={({ screenshot: 'camera', recording: 'video', 'long-screenshot': 'fit-window', ocr: 'scan-text', translate: 'languages', selection: 'message-circle' } as Record<CaptureToolTask, IconName>)[task]} size={17} />{labels[task]}</button>)}</div>;
}
