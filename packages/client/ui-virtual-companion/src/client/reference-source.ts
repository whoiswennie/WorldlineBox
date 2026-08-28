import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ReferenceAsset } from '../contracts.ts'

export const REFERENCE_SOURCE = 'companion-reference-draft'

interface ReferenceValue {
  readonly id: string
  readonly title: string
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function encodeReference(asset: Pick<ReferenceAsset, 'id' | 'title'>): string {
  return JSON.stringify({ id: asset.id, title: asset.title } satisfies ReferenceValue)
}

function decodeReference(ref: string): ReferenceValue {
  const value = JSON.parse(ref) as Partial<ReferenceValue>
  if (typeof value.id !== 'string' || value.id.trim() === '') throw new Error('表情素材 ID 无效')
  if (typeof value.title !== 'string' || value.title.trim() === '') throw new Error('表情名称无效')
  return { id: value.id, title: value.title }
}

export function userReferenceProtocol(value: ReferenceValue): string {
  return `<user-reference asset-id="${escapeXml(value.id)}">${escapeXml(value.title)}</user-reference>`
}

/** Serializer owner for structured reference chips staged in the conversation composer. */
export const referenceSource: InputTriggerSource = {
  trigger: '/',
  name: REFERENCE_SOURCE,
  order: 1_000,
  showGroupTitle: false,
  candidates() {
    return Promise.resolve([])
  },
  onPick() {
    return undefined
  },
  codec: {
    clipboardText(ref) {
      const value = decodeReference(ref)
      return `[表情：${value.title}]`
    },
    serialize(ref, signal) {
      signal.throwIfAborted()
      return Promise.resolve(userReferenceProtocol(decodeReference(ref)))
    },
  },
}
