import { useState } from 'react';
import type { CompanionAction } from '../../shared/companions';
export type CompanionDelivery = 'auto' | 'steer' | 'queue' | 'parallel' | 'chat';
const modes: Array<{ value: CompanionDelivery; label: string; short: string; detail: string }> = [
  { value: 'auto', label: '自动安排', short: '自动', detail: '补充要求进入当前任务，新任务按顺序安排' },
  { value: 'steer', label: '引导正在做的事', short: '引导', detail: '补充会在当前 loop 的下一步生效' },
  { value: 'queue', label: '排队处理', short: '排队', detail: '等待当前轮次或任务结束' },
  { value: 'parallel', label: '同时做另一件事', short: '并行', detail: '独立启动另一条任务' },
  { value: 'chat', label: '继续聊天', short: '聊天', detail: '保持聊天，不安排新任务' },
];
export function CompanionModeMenu({ value, onChange, tasks, target, onTarget, authorName }: {
  value: CompanionDelivery; onChange(value: CompanionDelivery): void; tasks: CompanionAction[];
  target: string | null; onTarget(value: string | null): void; authorName(id: string): string;
}) {
  const [open, setOpen] = useState(false);
  return <div className="companions-mode-control"><button type="button" className="companions-mode-button" aria-label="消息模式" aria-expanded={open} onClick={() => setOpen(!open)}>{modes.find(mode => mode.value === value)?.short} <span>⌄</span></button>
    {open && <div className="companions-mode-popover" role="menu" aria-label="消息用途">{modes.map(mode => <button role="menuitemradio" aria-checked={value === mode.value} key={mode.value} onClick={() => {
      onChange(mode.value); if (mode.value === 'steer' && !target && tasks[0]) onTarget(tasks[0].id);
      if (mode.value !== 'steer' && mode.value !== 'queue') { onTarget(null); setOpen(false); }
      if (mode.value === 'auto' || mode.value === 'chat' || mode.value === 'parallel') setOpen(false);
    }}><span>{mode.label}</span><small>{mode.detail}</small></button>)}
      {(value === 'steer' || value === 'queue') && <label>目标任务<select aria-label="选择任务" value={target ?? ''} onChange={event => { onTarget(event.target.value || null); setOpen(false); }}>
        <option value="">{value === 'queue' ? '下一件新任务' : '选择正在进行的任务'}</option>{tasks.map(task => <option key={task.id} value={task.id}>{authorName(task.companionId)} · {task.title}</option>)}
      </select></label>}</div>}
  </div>;
}
