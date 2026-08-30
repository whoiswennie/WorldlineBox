import { IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../theme-settings.ts'
import type { createFontSizeRowStore } from './settings-store.ts'
import css from './FontSizeRow.module.css'

export interface FontSizeRowInjected {
  setFontSize: (px: number) => void
}

export type FontSizeRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createFontSizeRowStore>>
  & PropsLocale<'settings.theme'> & FontSizeRowInjected

/** Render the persisted conversation font-size setting. */
export function FontSizeRow({ t, setFontSize, useStore }: FontSizeRowComponentProps) {
  const fontSize = useStore(state => state.fontSize)
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('fontSize.title')}</div>
        <div className={css.desc}>{t('fontSize.description')}</div>
      </div>
      <div className={css.control}>
        <div className={css.stepper}>
          <span className={css.value}>{fontSize}</span>
          <span className={css.arrows}>
            <button
              type="button"
              className={css.arrow}
              aria-label={t('fontSize.increase')}
              disabled={fontSize >= FONT_SIZE_MAX}
              onClick={() => { setFontSize(fontSize + 1) }}
            >
              <IconChevronUpOutline14 size={9} />
            </button>
            <button
              type="button"
              className={css.arrow}
              aria-label={t('fontSize.decrease')}
              disabled={fontSize <= FONT_SIZE_MIN}
              onClick={() => { setFontSize(fontSize - 1) }}
            >
              <IconChevronDownOutline14 size={9} />
            </button>
          </span>
        </div>
        <span className={css.unit}>{t('fontSize.unit')}</span>
      </div>
    </div>
  )
}
