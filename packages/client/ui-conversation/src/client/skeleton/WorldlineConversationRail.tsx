import { useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './WorldlineConversationRail.module.css'

export interface WorldlineConversationRailInjected {
  activate: () => void
  activePage: () => string
  subscribePage: (listener: () => void) => () => void
}

export type WorldlineConversationRailProps =
  PropsRuntime<'worldline.rail.primary'> & WorldlineConversationRailInjected

/** Navigation contribution owned by the Conversation plugin. */
export function WorldlineConversationRail({ activate, activePage, subscribePage }: WorldlineConversationRailProps) {
  const active = useSyncExternalStore(subscribePage, activePage, activePage) === 'conversation'
  return (
    <button
      type="button"
      className={css.button}
      aria-label="对话"
      aria-current={active ? 'page' : undefined}
      data-active={active || undefined}
      title="对话"
      onClick={activate}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5.8 4.75h12.4c1.13 0 2.05.92 2.05 2.05v7.85c0 1.13-.92 2.05-2.05 2.05h-6.45l-4.4 3.05v-3.05H5.8a2.05 2.05 0 0 1-2.05-2.05V6.8c0-1.13.92-2.05 2.05-2.05Z" />
      </svg>
    </button>
  )
}
