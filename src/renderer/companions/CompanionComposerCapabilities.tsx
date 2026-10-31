import { useEffect, useRef, useState } from 'react';
import type { CompanionToolPolicy } from '../../shared/companion-tool-policy';
import { Icon } from '../Icons';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';

const choices: Array<{ key: keyof CompanionToolPolicy; title: string; detail: string }> = [
  { key: 'dsh', title: 'DSH', detail: '深度思考与执行，包含 DSH 内部浏览器' },
  { key: 'browser', title: '内置浏览器', detail: '伙伴自带的浏览能力，与 DSH 独立' },
  { key: 'world', title: '虚拟世界', detail: '了解环境，在自己的世界里活动' },
  { key: 'social', title: '伙伴交流', detail: '与其他伙伴沟通和协作' },
  { key: 'planning', title: '日程与任务', detail: '查看、安排与调整自己的计划' },
  { key: 'observation', title: '观察', detail: '查看获准的窗口，仍需已有观察授权' },
  { key: 'files', title: '文件', detail: '读取与交付本次获准的文件' },
];

/** Selection is a restriction on the next message, never a new device grant. */
export function CompanionComposerCapabilities({ policy, onChange, onOpen }: {
  policy: CompanionToolPolicy; onChange(value: CompanionToolPolicy): void; onOpen(): void;
}) {
  const [open, setOpen] = useState(false), host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !host.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const enabled = choices.filter(choice => policy[choice.key]).length;
  return <div className="companions-composer-capabilities" ref={host} onKeyDown={event => {
    if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); setOpen(false); host.current?.querySelector<HTMLButtonElement>('[aria-label="本次消息可用能力"]')?.focus(); }
  }}>
    <button type="button" className={`companion-icon-button${open ? ' is-active' : ''}`} aria-label="本次消息可用能力" title={`能力 · 已开启 ${enabled} 项`} aria-expanded={open}
      onClick={() => { if (!open) onOpen(); setOpen(!open); }}><Icon name="sliders" /></button>
    {open && <section className="companions-composer-capability-menu" aria-label="本次消息能力设置">
      <header><strong>本次消息可用能力</strong><small>沿用到本聊天的后续消息</small></header>
      <div>{choices.map(choice => <label key={choice.key} className="companions-composer-capability-choice"><span><strong>{choice.title}</strong><small>{choice.detail}</small></span>
        <input type="checkbox" role="switch" aria-label={choice.title} checked={policy[choice.key]} onChange={event => onChange({ ...policy, [choice.key]: event.target.checked })} />
      </label>)}</div>
    </section>}
  </div>;
}
