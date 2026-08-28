import { useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginCenterNavItem.module.css'

/** Registration-side navigation action. */
export interface PluginCenterNavInjected {
  readonly pageId: string
  readonly open: () => void
  readonly activePage: () => string
  readonly subscribePage: (listener: () => void) => () => void
}

/** Full props of the sidebar first-level Plugin entry. */
export type PluginCenterNavProps =
  PropsRuntime<'worldline.rail.primary'>
  & PropsLocale<'pluginCenter'>
  & InjectFace<PluginCenterNavInjected>

/** First-level sidebar entry that opens the local Feature page. */
export function PluginCenterNavItem({ pageId, open, activePage, subscribePage, t }: PluginCenterNavProps) {
  const selected = useSyncExternalStore(subscribePage, activePage, activePage) === pageId
  return (
    <Tooltip label={t('nav')} delayMs={500}>
      <button
        type="button"
        className={`${css.entry} ${css.rail}`}
        aria-current={selected ? 'page' : undefined}
        aria-label={t('nav')}
        data-selected={selected || undefined}
        onClick={open}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.75" y="3.75" width="6.5" height="6.5" rx="1.6" />
          <rect x="13.75" y="3.75" width="6.5" height="6.5" rx="1.6" />
          <rect x="3.75" y="13.75" width="6.5" height="6.5" rx="1.6" />
          <path d="M17 13.75v6.5M13.75 17h6.5" />
        </svg>
      </button>
    </Tooltip>
  )
}
