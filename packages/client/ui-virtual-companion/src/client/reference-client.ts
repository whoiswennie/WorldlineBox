import type { ReferenceAsset, ReferencePage } from '../contracts.ts'

interface Envelope<T> {
  readonly ok?: boolean
  readonly value?: T
  readonly error?: string
}

async function request<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/virtual-companions/reference/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const envelope = await response.json().catch(() => ({})) as Envelope<T>
  if (!response.ok || envelope.ok !== true || envelope.value === undefined) {
    throw new Error(envelope.error ?? `引用库请求失败（${String(response.status)}）`)
  }
  return envelope.value
}

/**
 * Search references.
 * @param input - Input value to process.
 * @returns The resulting value.
 */
export function searchReferences(input: {
  readonly scopes: readonly string[]
  readonly query?: string
  readonly tags?: readonly string[]
  readonly cursor?: number
  readonly limit?: number
}): Promise<ReferencePage> {
  return request('search', { query: '', ...input })
}

/**
 * Get reference.
 * @param id - id value.
 * @returns The resulting value.
 */
export function getReference(id: string): Promise<ReferenceAsset> {
  return request('get', { id })
}
