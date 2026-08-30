import { useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranscriptViewMode } from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import css from './EnterBehaviorRow.module.css'

export interface TranscriptViewRowInjected {
  hooks: { transcriptView: SnapshotStore<TranscriptViewMode> }
  setTranscriptView: (mode: TranscriptViewMode) => void
}

export type TranscriptViewRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'> & InjectFace<TranscriptViewRowInjected>

const options: readonly { id: TranscriptViewMode; label: ConversationKey }[] = [
  { id: 'normal', label: 'settings.transcript.normal' },
  { id: 'compact', label: 'settings.transcript.compact' },
]

/** Completed-turn process display selector. */
export function TranscriptViewRow({
  useTranscriptView, setTranscriptView, t,
}: TranscriptViewRowProps) {
  const mode = useTranscriptView(value => value)
  const [open, setOpen] = useState(false)
  const selected = mode === 'normal' ? 'settings.transcript.normal' : 'settings.transcript.compact'
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.transcript.title')}</div>
        <div className={css.desc}>{t('settings.transcript.description')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={options.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={mode}
        onSelect={(id) => {
          setOpen(false)
          setTranscriptView(id as TranscriptViewMode)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {t(selected)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
