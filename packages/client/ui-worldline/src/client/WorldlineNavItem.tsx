import { useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './WorldlineNavItem.module.css'

export interface WorldlineNavInjected {
  readonly pageId: string
  open(): void
  activePage(): string
  subscribePage(listener: () => void): () => void
}

export type WorldlineNavProps = PropsRuntime<'worldline.rail.primary'>
  & PropsLocale<'worldlineStudio'>
  & InjectFace<WorldlineNavInjected>

export function WorldlineNavItem(props: WorldlineNavProps) {
  const subscribe = (listener: () => void): (() => void) => props.subscribePage(listener)
  const active = (): string => props.activePage()
  const selected = useSyncExternalStore(subscribe, active, active)
    === props.pageId
  return <Tooltip label={props.t('nav')} delayMs={500}>
    <button
      type="button"
      className={css.entry}
      aria-current={selected ? 'page' : undefined}
      aria-label={props.t('nav')}
      data-selected={selected || undefined}
      onClick={() => { props.open() }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.25" />
        <path d="M4.3 12h15.4M12 3.75c2.3 2.2 3.5 4.95 3.5 8.25S14.3 18.05 12 20.25M12 3.75C9.7 5.95 8.5 8.7 8.5 12S9.7 18.05 12 20.25" />
        <path d="m17.1 5.8 2.15-.45-.45 2.15" />
      </svg>
    </button>
  </Tooltip>
}
