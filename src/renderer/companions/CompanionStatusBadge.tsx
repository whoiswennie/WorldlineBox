import type { ReactNode } from 'react';
import type { Companion } from '../../shared/companions';
import { COMPANION_PRESENCE_LABELS } from '../../shared/companion-presence';
import './companion-status-badge.css';

type Presence = NonNullable<Companion['availability']>;
/** Activation is authoritative even while a previous work update is still arriving. */
export function CompanionStatusBadge({ companion, status, children, className = '', showCount = false }: {
  companion?: Pick<Companion, 'active' | 'availability' | 'availabilityReason' | 'activeCount'>;
  status?: Presence; children?: ReactNode; className?: string; showCount?: boolean;
}) {
  const current = companion?.active === false ? 'dormant' : companion?.availability ?? status ?? 'offline';
  return <span className={'companion-status-badge' + (className ? ' ' + className : '')} data-status={current}
    title={current === 'dormant' ? '伙伴未激活，后台活动已暂停。' : companion?.availabilityReason || undefined}>
    <i aria-hidden="true" /><span>{children ?? COMPANION_PRESENCE_LABELS[current]}{showCount && current === 'working' && !!companion?.activeCount ? ` · ${companion.activeCount}` : ''}</span>
  </span>;
}
