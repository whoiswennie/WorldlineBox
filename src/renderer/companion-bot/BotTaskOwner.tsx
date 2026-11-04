import type { BotCompanion, BotTask } from '../../shared/companion-bot';
import { BotAvatar } from './BotAvatar';

export function BotTaskOwner({ task, companion, locale, compact = false }: { task: BotTask; companion?: BotCompanion; locale: 'zh-CN' | 'en'; compact?: boolean }) {
  const name = task.companionName ?? companion?.name ?? task.companionId;
  return <span className={`bot-task-owner${compact ? ' is-compact' : ''}`} data-task-owner={task.companionId} aria-label={`${locale === 'zh-CN' ? '负责伙伴' : 'Responsible companion'} · ${name}`}>
    <BotAvatar companion={companion} name={name} /><span>{!compact && <small>{locale === 'zh-CN' ? '负责伙伴' : 'Responsible companion'}</small>}<strong>{name}</strong></span>
  </span>;
}
