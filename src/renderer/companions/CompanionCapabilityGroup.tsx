import { useState } from 'react';
import type { CompanionAction } from '../../shared/companions';
import { Icon } from '../Icons';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { CompanionCapabilityLink } from './CompanionCapabilityLink';
import { companionCapabilityTitle } from './companion-capability-presentation';

/** A single chronological entry for a run of actual tool-only steps. Details
 * open in a dialog and select the original action, never a second execution. */
export function CompanionCapabilityGroup({ actionIds, actions, now, onOpen }: {
  actionIds: string[]; actions: CompanionAction[]; now: number; onOpen(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  useDialogFocusTrap(open, actionIds[0]);
  const entries = actionIds.map(id => ({ id, action: actions.find(action => action.id === id) }));
  const titles = [...new Set(entries.flatMap(entry => entry.action ? [companionCapabilityTitle(entry.action)] : []))];
  const working = entries.filter(entry => entry.action?.status === 'queued' || entry.action?.status === 'running').length;
  const failed = entries.filter(entry => ['failed', 'cancelled', 'interrupted'].includes(entry.action?.status ?? '')).length;
  const title = titles.length ? titles.join('、') : '查看这段行动过程';
  return <>
    <button type="button" className="companions-capability-group" aria-label={`查看 ${actionIds.length} 次能力调用`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Icon name="activity" /><span>{title}</span><small>{working ? `${working} 次进行中` : failed ? `${failed} 次未完成` : `${actionIds.length} 次调用`}</small><Icon name="chevron" />
    </button>
    {open && <div className="companions-task-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}
      onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); setOpen(false); } }}>
      <section className="companions-capability-group-dialog" role="dialog" aria-modal="true" aria-label="这段行动过程">
        <header><div><h2>这段行动过程</h2><p>{actionIds.length} 次实际调用 · 选择查看输入与结果</p></div><button type="button" className="companion-icon-button" aria-label="关闭行动过程" onClick={() => setOpen(false)}><Icon name="close" /></button></header>
        <ol>{entries.map(({ id, action }) => <li key={id}><CompanionCapabilityLink action={action} actionId={id} now={now} onOpen={id => { setOpen(false); onOpen(id); }} /></li>)}</ol>
      </section>
    </div>}
  </>;
}
