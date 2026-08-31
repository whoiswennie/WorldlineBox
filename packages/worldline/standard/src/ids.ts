/** Stable portable identities used by WWS documents and runs. */

export type WorldlineId<Kind extends string> = string & { readonly __worldlineKind: Kind }

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*:[a-zA-Z0-9][a-zA-Z0-9._~-]{5,127}$/u

/** Validate a namespaced stable identifier without treating a display name as identity. */
export function isWorldlineId(value: unknown): value is WorldlineId<string> {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** Assert and brand one external identifier. */
export function worldlineId<Kind extends string>(value: string): WorldlineId<Kind> {
  if (!isWorldlineId(value)) {
    throw new TypeError(`Invalid Worldline stable id: ${value}`)
  }
  return value as WorldlineId<Kind>
}

/** Allocate a collision-resistant project-local identity. */
export function allocateWorldlineId<Kind extends string>(namespace: string): WorldlineId<Kind> {
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u.test(namespace)) {
    throw new TypeError(`Invalid Worldline id namespace: ${namespace}`)
  }
  return worldlineId<Kind>(`${namespace}:${crypto.randomUUID()}`)
}

/** Stable, deterministic JSON used for hashes, replay comparisons, and revisions. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`
}

/** Synchronous portable content fingerprint (FNV-1a 64-bit, not a security digest). */
export function contentFingerprint(value: unknown): string {
  const source = typeof value === 'string' ? value : stableStringify(value)
  let hash = 0xcbf29ce484222325n
  for (const character of source) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}
