import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createLanguageRowStore } from './settings-store.ts'
import css from './LanguageRow.module.css'

/** Injected business face for writing the locale preference. */
export interface LanguageRowInjected {
  /** Switch the active locale. */
  setLocale(id: string): void
}

/** Full component props: runtime share, store share, locale seat, and injected face. */
export type LanguageRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createLanguageRowStore>>
  & PropsLocale<'settings.locale'> & LanguageRowInjected

/** Render the Language preference row. */
export function LanguageRow(props: LanguageRowComponentProps) {
  const { t, useStore } = props
  const active = useStore(state => state.active)
  const options = useStore(state => state.options)
  const [open, setOpen] = useState(false)
  const activeLabel = options.find(option => option.id === active)?.label ?? active

  return <div className={css.row}>
    <div className={css.rowText}>
      <div className={css.title}>{t('language.title')}</div>
    </div>
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={options.map(option => ({ id: option.id, label: option.label }))}
      selectedId={active}
      onSelect={(id) => {
        props.setLocale(id)
        setOpen(false)
      }}
      align="end"
      portal
      anchor={<button
        type="button"
        className={css.selector}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        {activeLabel}
        <IconChevronDownOutline14 className={css.chevron} />
      </button>}
    />
  </div>
}
