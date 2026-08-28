/** Explicit, per-model request-modality editor with a confirmation for image claims. */

import { useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type InputMode = 'inherit' | 'text' | 'image'

/** Resolve the small set of modality declarations this UI can safely author. */
function modeOf(input: unknown): InputMode {
  if (!Array.isArray(input) || input.length === 0) return 'inherit'
  return input.includes('image') ? 'image' : 'text'
}

/** Props for one model's provider-neutral input-capability field. */
export interface ModelInputCapabilityProps {
  /** Adapter-native input array currently stored or inherited. */
  input: unknown
  /** One-based row number used by accessible labels. */
  position: number
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable changes for read-only or pending settings. */
  disabled: boolean
  /** Write inheritance, explicit text-only, or explicit text-and-image input. */
  onChange: (input: readonly ['text'] | readonly ['text', 'image'] | undefined) => void
}

/** Render a tri-state model capability selector and confirm unverifiable image claims. */
export function ModelInputCapability(props: ModelInputCapabilityProps): ReactNode {
  const [confirmingImage, setConfirmingImage] = useState(false)
  const mode = modeOf(props.input)

  const changeMode = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value as InputMode
    if (next === 'inherit') {
      props.onChange(undefined)
      return
    }
    if (next === 'text') {
      props.onChange(['text'])
      return
    }
    setConfirmingImage(true)
  }

  const closeConfirmation = (): void => { setConfirmingImage(false) }
  const confirmImage = (): void => {
    props.onChange(['text', 'image'])
    setConfirmingImage(false)
  }

  return (
    <>
      <label className={`${styles['modelField']} ${styles['modelCapabilityField']}`}>
        <span className={styles['modelFieldLabel']}>{props.t('modelInputMode')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={mode}
          aria-label={`${props.t('modelInputMode')} ${String(props.position)}`}
          disabled={props.disabled}
          onChange={changeMode}
        >
          <option value="inherit">{props.t('modelInputInherit')}</option>
          <option value="text">{props.t('modelInputText')}</option>
          <option value="image">{props.t('modelInputImage')}</option>
        </select>
        <small className={styles['modelCapabilityHint']}>{props.t('modelInputHint')}</small>
      </label>
      <Modal
        open={confirmingImage}
        onClose={closeConfirmation}
        title={props.t('modelImageConfirmTitle')}
        closeLabel={props.t('close')}
        description={props.t('modelImageConfirmDescription')}
        footer={(
          <>
            <Button variant="outline" onClick={closeConfirmation}>{props.t('cancel')}</Button>
            <Button onClick={confirmImage}>{props.t('modelImageConfirm')}</Button>
          </>
        )}
      />
    </>
  )
}
