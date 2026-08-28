import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './VirtualCompanionNavItem.module.css'

/** Host-owned actions and observations used by the companion rail entry. */
export interface VirtualCompanionNavInjected {
  open(): void
  hooks: { activePage: HostObservable<string> }
}

/** Runtime props supplied to the companion rail entry through the slot registry. */
export type VirtualCompanionNavProps = PropsRuntime<'worldline.rail.primary'>
  & PropsLocale<'virtualCompanion'>
  & InjectFace<VirtualCompanionNavInjected>

/** Render the person-and-spark primary-rail entry for virtual companions. */
export function VirtualCompanionNavItem({ open, useActivePage, t }: VirtualCompanionNavProps) {
  const selected = useActivePage(page => page === 'virtual-companions')
  return <button
    type="button"
    className={css.button}
    aria-label={t('nav')}
    aria-current={selected ? 'page' : undefined}
    data-active={selected || undefined}
    title={t('nav')}
    onClick={open}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="8.5" r="3" />
      <path d="M4.5 19c.7-3.6 2.7-5.4 6-5.4s5.3 1.8 6 5.4" />
      <path d="m18.5 4 .55 1.45L20.5 6l-1.45.55L18.5 8l-.55-1.45L16.5 6l1.45-.55L18.5 4Z" />
    </svg>
  </button>
}
